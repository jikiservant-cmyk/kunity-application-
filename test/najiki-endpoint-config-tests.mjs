/**
 * NaJiki endpoint configuration and failure-reporting checks.
 *
 * Incident (2026-10-19): every production deposit failed with
 *
 *   NaJiki gateway error (Status 500).
 *   Response: <!DOCTYPE html><html><head><meta charSet="utf-8" data-next-head/>…
 *
 * The code had a hardcoded fallback origin (`najiki.netlify.app`) and the
 * deployment behind it was stale, so `/api/payments` answered with a Next.js
 * HTML error page. The live API is `najiki.vercel.app`.
 *
 * These checks pin the things that would have prevented / shortened it:
 *   1. no money path carries a built-in provider origin (NaJiki moves hosts —
 *      Netlify and Vercel have both been "the live one" — so the origin is
 *      always read from the environment),
 *   2. a missing or malformed `NAJIKI_API_URL` fails loudly with guidance,
 *   3. an HTML / non-JSON answer is reported as a configuration problem and
 *      never echoed back to the caller,
 *   4. a provider that is down is caught by a cached preflight probe before a
 *      PIN prompt is ever requested, and the member is told no money was taken.
 *
 * Local stand-ins only. Run: node_modules/.bin/tsx test/najiki-endpoint-config-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import {
  NajikiConfigError,
  normalizeNajikiBaseUrl,
  resolveNajikiBaseUrl,
  najikiHostLabel,
} from '../lib/najiki-url.ts';
import {
  checkNajikiAvailability,
  providerUnavailableMessage,
  resetNajikiAvailabilityCache,
} from '../lib/najiki-health.ts';
import { NajikiProvider } from '../lib/payments/najiki-provider.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
    console.log(`  FAIL ${name} — ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
    console.log(`  FAIL ${name} — ${error.message}`);
  }
};

console.log('NaJiki endpoint configuration checks');

// ── 1. No provider origin is baked into the money paths ─────────────────────
const MONEY_FILES = [
  'lib/payments/najiki-provider.ts',
  'app/api/payments/intent/route.ts',
  'app/api/payments/[intentId]/route.ts',
  'app/api/admin/sms/topup/route.ts',
  'app/api/admin/sms/topup/confirm/route.ts',
];

check('no money path hardcodes a NaJiki origin', () => {
  for (const file of MONEY_FILES) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /najiki\.(netlify|vercel)\.app/,
      `${file} still contains a hardcoded provider origin`
    );
  }
});

check('every money path resolves the origin from the environment', () => {
  for (const file of MONEY_FILES) {
    const source = read(file);
    assert.match(source, /resolveNajikiBaseUrl\(/, `${file} does not use resolveNajikiBaseUrl`);
  }
});

// ── 2. Configuration is validated, not guessed ──────────────────────────────
check('a missing NAJIKI_API_URL is a configuration error that names the variable', () => {
  assert.throws(
    () => resolveNajikiBaseUrl({}),
    (error) =>
      error instanceof NajikiConfigError &&
      /NAJIKI_API_URL is not set/.test(error.message) &&
      /no trailing slash and no \/api suffix/.test(error.message),
    'expected an actionable NajikiConfigError'
  );
});

check('a blank NAJIKI_API_URL is treated as missing', () => {
  assert.throws(() => resolveNajikiBaseUrl({ NAJIKI_API_URL: '   ' }), NajikiConfigError);
});

check('trailing slashes are trimmed so paths cannot become //api/...', () => {
  assert.equal(resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://provider.example.test/' }), 'https://provider.example.test');
  assert.equal(resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://provider.example.test///' }), 'https://provider.example.test');
});

check('a URL without a scheme is rejected instead of failing inside fetch', () => {
  assert.throws(
    () => resolveNajikiBaseUrl({ NAJIKI_API_URL: 'provider.example.test' }),
    /not a valid absolute URL/
  );
});

check('a configured /api suffix is rejected (Kunity appends /api itself)', () => {
  assert.throws(
    () => resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://provider.example.test/api' }),
    /without the \/api suffix/
  );
});

check('non-http protocols are rejected', () => {
  assert.throws(() => normalizeNajikiBaseUrl('ftp://najiki.example'), /must use http or https/);
});

check('the host label never includes credentials or a path', () => {
  assert.equal(najikiHostLabel('https://user:pass@provider.example.test/base'), 'provider.example.test');
});

// ── 3. The money path preflights the provider ───────────────────────────────
check('the payment-intent route probes NaJiki before creating an intent', () => {
  const route = read('app/api/payments/intent/route.ts');
  assert.match(route, /checkNajikiAvailability\(\)/);
  assert.match(route, /providerUnavailableMessage\(/, 'the preflight failure is not explained to the member');
  assert.match(route, /status: 503/, 'an unavailable provider should not look like a server crash');
});

check('a member never sees the provider name, a status code, or raw upstream text', () => {
  const route = read('app/api/payments/intent/route.ts');
  // The old shape: `NaJiki Error (${response.status}): ${errorMessage}`
  assert.doesNotMatch(
    route,
    /NaJiki Error \(\$\{response\.status\}\)/,
    'the raw provider error is still returned to the caller'
  );
  const member = read('app/member/page.tsx');
  assert.doesNotMatch(member, /alert\("Error: " \+ e\.message\)/, 'the member UI still prefixes errors with "Error:"');
  assert.match(member, /paymentFailureMessage\(/, 'the member UI does not parse payment failures defensively');
});

check('the member-facing unavailable message promises no money was taken', () => {
  const message = providerUnavailableMessage();
  assert.match(message, /no money was taken/i);
  assert.doesNotMatch(message, /NaJiki|HTTP|\b5\d\d\b/, 'provider internals leaked into a member-facing string');
});

// ── 3. Upstream failures are reported honestly ──────────────────────────────
const provider = new NajikiProvider();
const withEnv = async (env, fn) => {
  const saved = { NAJIKI_API_URL: process.env.NAJIKI_API_URL, NAJIKI_API_KEY: process.env.NAJIKI_API_KEY };
  try {
    if (env.NAJIKI_API_URL === undefined) delete process.env.NAJIKI_API_URL;
    else process.env.NAJIKI_API_URL = env.NAJIKI_API_URL;
    process.env.NAJIKI_API_KEY = 'test-key';
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// ── 4. The availability probe itself ────────────────────────────────────────
const startStub = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};

const healthStub = await startStub((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', version: 'abc1234', checks: {} }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
resetNajikiAvailabilityCache();
await withEnv({ NAJIKI_API_URL: healthStub.url }, async () => {
  await checkAsync('a healthy provider passes the probe and reports its version', async () => {
    const result = await checkNajikiAvailability();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.version, 'abc1234');
  });
});
healthStub.server.close();

const htmlHealth = await startStub((req, res) => {
  res.writeHead(500, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><body>error</body></html>');
});
resetNajikiAvailabilityCache();
await withEnv({ NAJIKI_API_URL: htmlHealth.url }, async () => {
  await checkAsync('a provider serving HTML fails the probe with a reason', async () => {
    const result = await checkNajikiAvailability();
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTML page/);
  });

  await checkAsync('the failure is cached briefly so a retry burst does not hammer the provider', async () => {
    const cached = await checkNajikiAvailability();
    assert.equal(cached.ok, false);
    assert.equal(cached.cached, true);
  });
});
htmlHealth.server.close();
resetNajikiAvailabilityCache();

const degradedHealth = await startStub((req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'degraded', checks: { database: { ok: false } } }));
});
resetNajikiAvailabilityCache();
await withEnv({ NAJIKI_API_URL: degradedHealth.url }, async () => {
  await checkAsync('a provider reporting itself unhealthy fails the probe', async () => {
    const result = await checkNajikiAvailability();
    assert.equal(result.ok, false);
    assert.match(result.reason, /unhealthy \(HTTP 503\)/);
  });
});
degradedHealth.server.close();
resetNajikiAvailabilityCache();

const noHealthRoute = await startStub((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
resetNajikiAvailabilityCache();
await withEnv({ NAJIKI_API_URL: noHealthRoute.url }, async () => {
  await checkAsync('an older deployment without /api/health is allowed through', async () => {
    const result = await checkNajikiAvailability();
    assert.equal(result.ok, true, 'a missing health route must not block a working provider');
  });
});
noHealthRoute.server.close();
resetNajikiAvailabilityCache();

await withEnv({}, async () => {
  await checkAsync('an unconfigured provider fails the probe instead of guessing', async () => {
    const result = await checkNajikiAvailability();
    assert.equal(result.ok, false);
    assert.match(result.reason, /NAJIKI_API_URL/);
  });
});
resetNajikiAvailabilityCache();

// A stale deployment: `/api/payments` answers 500 with a Next.js HTML page.
const stale = http.createServer((req, res) => {
  res.writeHead(500, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><meta charSet="utf-8" data-next-head/></head><body>error</body></html>');
});
await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve));
const staleUrl = `http://127.0.0.1:${stale.address().port}`;

await withEnv({ NAJIKI_API_URL: staleUrl }, async () => {
  await checkAsync('an HTML error page is reported as a broken/stale deployment, not leaked', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent(2000, 'UGX', { phoneNumber: '0772123456', memberId: 'm1' }),
      (error) => {
        assert.match(error.message, /HTML page \(HTTP 500\)/);
        assert.match(error.message, /broken or stale/i);
        assert.ok(!error.message.includes('<!DOCTYPE'), 'the upstream HTML was echoed to the caller');
        return true;
      }
    );
  });
});

// A redirect to a login screen is the other stale-deployment shape: fetch
// follows the 302 and hands us the dashboard's HTML instead of an API result.
const redirecting = http.createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!DOCTYPE html><html><body><form>Sign in</form></body></html>');
  }
  res.writeHead(302, { Location: '/login' });
  res.end();
});
await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
const redirectUrl = `http://127.0.0.1:${redirecting.address().port}`;

await withEnv({ NAJIKI_API_URL: redirectUrl }, async () => {
  await checkAsync('a login redirect is reported as an HTML page, never as a payment result', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent(2000, 'UGX', { phoneNumber: '0772123456', memberId: 'm1' }),
      (error) => {
        assert.match(error.message, /HTML page \(HTTP 200\)/);
        assert.ok(!error.message.includes('Sign in'), 'the login page leaked into the error');
        return true;
      }
    );
  });
});

await withEnv({ NAJIKI_API_URL: 'http://127.0.0.1:1' }, async () => {
  await checkAsync('an unreachable provider says where it tried to connect', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent(2000, 'UGX', { phoneNumber: '0772123456', memberId: 'm1' }),
      (error) => {
        assert.match(error.message, /could not be reached at 127\.0\.0\.1:1/);
        assert.match(error.message, /NAJIKI_API_URL/);
        return true;
      }
    );
  });
});

await withEnv({}, async () => {
  await checkAsync('with no NAJIKI_API_URL the provider refuses before any network call', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent(2000, 'UGX', { phoneNumber: '0772123456' }),
      (error) => error instanceof NajikiConfigError && /NAJIKI_API_URL is not set/.test(error.message)
    );
  });
});

// A well-formed JSON error is still reported as the provider's own rejection.
const rejecting = http.createServer((req, res) => {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Invalid or inactive tenant' }));
});
await new Promise((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
const rejectingUrl = `http://127.0.0.1:${rejecting.address().port}`;

await withEnv({ NAJIKI_API_URL: rejectingUrl }, async () => {
  await checkAsync('a JSON error from NaJiki is surfaced as-is', async () => {
    await assert.rejects(
      () => provider.createPaymentIntent(2000, 'UGX', { phoneNumber: '0772123456', memberId: 'm1' }),
      /Invalid or inactive tenant/
    );
  });
});

stale.close();
redirecting.close();
rejecting.close();

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
