/**
 * Deployment health probe checks for the real /api/health route handler.
 *
 * The probe exists so a half-configured production deployment cannot look healthy:
 * every Supabase client in this app silently falls back to
 * `https://demo-placeholder.supabase.co` when its env vars are missing.
 *
 * These checks pin three properties:
 *   1. no secret material ever appears in the response body,
 *   2. a missing/placeholder deployment is reported as not ready (HTTP 503),
 *   3. a configured deployment with a reachable Supabase is reported healthy (HTTP 200).
 *
 * Local stand-ins only; no provider or production service is contacted.
 * Run: node_modules/.bin/tsx test/health-probe-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { GET } from '../app/api/health/route.ts';

const SENTINELS = {
  anon: 'SENTINEL-anon-key-value',
  service: 'SENTINEL-service-role-value',
  najikiKey: 'SENTINEL-najiki-api-value',
  najikiSecret: 'SENTINEL-najiki-webhook-value',
};

const ENV_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'NAJIKI_API_URL', 'NAJIKI_API_KEY', 'NAJIKI_WEBHOOK_SECRET',
  'NAJIKI_APPLICATION_CODE', 'APP_URL', 'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_URL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ENFORCE_REDIS_RATELIMIT',
  'INNGEST_EVENT_KEY', 'PAYMENT_PROVIDER_TYPE',
];

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ok  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

const clearEnv = () => ENV_KEYS.forEach((k) => { delete process.env[k]; });

const setHealthyEnv = (supabaseUrl, najikiUrl = 'http://127.0.0.1:1') => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SENTINELS.anon;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SENTINELS.service;
  process.env.NAJIKI_API_URL = najikiUrl;
  process.env.NAJIKI_API_KEY = SENTINELS.najikiKey;
  process.env.NAJIKI_WEBHOOK_SECRET = SENTINELS.najikiSecret;
  process.env.NAJIKI_APPLICATION_CODE = 'sacco';
  process.env.APP_URL = 'https://kunity.example.test';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  process.env.ENFORCE_REDIS_RATELIMIT = 'true';
  process.env.INNGEST_EVENT_KEY = 'inngest-key';
  process.env.PAYMENT_PROVIDER_TYPE = 'najiki';
};

/** Stand-in Supabase: answers the auth health endpoint when healthy. */
let supabaseHealthy = true;
const supabase = http.createServer((req, res) => {
  if (req.url === '/auth/v1/health' && supabaseHealthy) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ version: 'test', name: 'GoTrue' }));
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'unavailable' }));
});
await new Promise((resolve) => supabase.listen(0, '127.0.0.1', resolve));
const supabaseUrl = `http://127.0.0.1:${supabase.address().port}`;

/**
 * Stand-in NaJiki. A configured URL is no longer enough for the probe to pass:
 * the route actually asks `/api/health`, because a stale deployment answers that
 * path with an HTML login redirect rather than JSON.
 */
let najikiMode = 'healthy';
const najiki = http.createServer((req, res) => {
  if (req.url === '/api/health' && najikiMode === 'healthy') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: 'test-abc1234', checks: {} }));
  }
  if (najikiMode === 'html') {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><html><head><meta charSet="utf-8"/></head><body>error</body></html>');
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'degraded', checks: { database: { ok: false } } }));
});
await new Promise((resolve) => najiki.listen(0, '127.0.0.1', resolve));
const najikiUrl = `http://127.0.0.1:${najiki.address().port}`;

const call = async () => {
  const res = await GET();
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, text, body };
};

// ---------------------------------------------------------------- unconfigured
clearEnv();
const blank = await call();

check('a blank environment reports not_ready with HTTP 503', () => {
  assert.equal(blank.status, 503);
  assert.equal(blank.body.status, 'not_ready');
});

check('missing Supabase config is named, not hidden behind a placeholder', () => {
  assert.equal(blank.body.checks.supabaseUrl, false);
  assert.equal(blank.body.checks.supabaseAnonKey, false);
  assert.equal(blank.body.checks.supabaseServiceRoleKey, false);
  assert.equal(blank.body.checks.supabaseReachable, null);
  assert.ok(
    blank.body.warnings.some((w) => /demo placeholder/.test(w)),
    'expected a warning that clients fall back to the demo placeholder'
  );
});

check('strict rate limiting and background jobs are surfaced as warnings', () => {
  assert.equal(blank.body.checks.rateLimitBackend, 'memory');
  assert.equal(blank.body.checks.rateLimitFailClosed, false);
  assert.ok(blank.body.warnings.some((w) => /ENFORCE_REDIS_RATELIMIT/.test(w)));
  assert.ok(blank.body.warnings.some((w) => /INNGEST_EVENT_KEY/.test(w)));
});

// ------------------------------------------------------------------ stub values
clearEnv();
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://demo-placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE';
const stubs = await call();

check('the .env.example stub values do not count as configured', () => {
  assert.equal(stubs.status, 503);
  assert.equal(stubs.body.checks.supabaseUrl, false);
  assert.equal(stubs.body.checks.supabaseAnonKey, false);
  assert.equal(stubs.body.checks.supabaseServiceRoleKey, false);
});

// --------------------------------------------------------------------- healthy
clearEnv();
setHealthyEnv(supabaseUrl, najikiUrl);
const healthy = await call();

check('a fully configured environment with a reachable Supabase is ok (HTTP 200)', () => {
  assert.equal(healthy.body.checks.supabaseReachable, true, JSON.stringify(healthy.body.warnings));
  assert.equal(healthy.status, 200, JSON.stringify(healthy.body.warnings));
  assert.equal(healthy.body.status, 'ok');
  assert.deepEqual(healthy.body.warnings, []);
});

check('the reported application code is the deployed one', () => {
  assert.equal(healthy.body.checks.najikiApplicationCode, 'sacco');
});

check('the probe reports that NaJiki itself answered', () => {
  assert.equal(healthy.body.checks.najikiReachable, true, JSON.stringify(healthy.body.warnings));
  assert.equal(healthy.body.checks.najikiVersion, 'test-abc1234');
});

check('NO SECRET VALUE APPEARS ANYWHERE IN THE RESPONSE', () => {
  for (const [label, sentinel] of Object.entries(SENTINELS)) {
    assert.ok(
      !healthy.text.includes(sentinel),
      `the ${label} secret leaked into the health response`
    );
  }
  // Neither may a prefix or a fragment that would let an attacker fingerprint it.
  assert.ok(!healthy.text.includes('SENTINEL'), 'a secret fragment leaked into the health response');
  assert.ok(!healthy.text.includes('upstash-token'), 'the Upstash token leaked into the health response');
});

// ------------------------------------------------------- provider misconfigured
// The exact production failure of 2026-10-19: NAJIKI_API_URL is present, but the
// origin answers payment calls with an HTML page. This must never look healthy.
clearEnv();
setHealthyEnv(supabaseUrl, najikiUrl);
najikiMode = 'html';
const staleProvider = await call();
najikiMode = 'healthy';

check('a NaJiki origin that answers with HTML is degraded, with an actionable warning', () => {
  assert.equal(staleProvider.status, 503, JSON.stringify(staleProvider.body));
  assert.equal(staleProvider.body.status, 'degraded');
  assert.equal(staleProvider.body.checks.najikiReachable, false);
  assert.ok(
    staleProvider.body.warnings.some((w) => /NaJiki is not usable at the configured NAJIKI_API_URL/.test(w)),
    'expected the provider warning'
  );
  assert.ok(
    staleProvider.body.warnings.some((w) => /no trailing slash and no \/api suffix/.test(w)),
    'the warning should say how to fix the origin'
  );
  assert.ok(!staleProvider.text.includes('<!DOCTYPE'), 'the upstream HTML leaked into health');
});

// -------------------------------------------------------------------- degraded
supabaseHealthy = false;
const degraded = await call();

check('a configured but unreachable Supabase is degraded, not ok', () => {
  assert.equal(degraded.status, 503);
  assert.equal(degraded.body.checks.supabaseReachable, false);
  assert.ok(degraded.body.warnings.some((w) => /did not answer the auth health probe/.test(w)));
  assert.ok(!degraded.text.includes('SENTINEL'), 'a secret fragment leaked while degraded');
});
supabaseHealthy = true;

// ------------------------------------------------- legacy webhook secret misuse
clearEnv();
setHealthyEnv(supabaseUrl, najikiUrl);
process.env.NAJIKI_WEBHOOK_SECRET = process.env.NAJIKI_API_KEY;
const legacySecret = await call();

check('a webhook secret equal to the API key is flagged', () => {
  assert.ok(
    legacySecret.body.warnings.some((w) => /equals NAJIKI_API_KEY/.test(w)),
    'expected the legacy fallback warning'
  );
  assert.ok(!legacySecret.text.includes(process.env.NAJIKI_API_KEY));
});

await (async () => {
  process.env.NAJIKI_WEBHOOK_SECRET = 'nk_live_abcdef123456';
  const res = await call();
  check('a webhook secret that is really an API key is flagged', () => {
    assert.ok(res.body.warnings.some((w) => /looks like an API key/.test(w)));
    assert.ok(!res.text.includes('nk_live_abcdef123456'));
  });
})();

// -------------------------------------------------------------- provider guard
await (async () => {
  process.env.PAYMENT_PROVIDER_TYPE = 'livepay';
  const res = await call();
  check('a non-NaJiki payment provider is flagged', () => {
    assert.ok(res.body.warnings.some((w) => /PAYMENT_PROVIDER_TYPE/.test(w)));
  });
})();

clearEnv();
supabase.close();
najiki.close();

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
