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
 * These checks pin the three things that would have prevented / shortened it:
 *   1. no money path carries a built-in provider origin,
 *   2. a missing or malformed `NAJIKI_API_URL` fails loudly with guidance,
 *   3. an HTML / non-JSON answer is reported as a configuration problem and
 *      never echoed back to the caller.
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
      /najiki\.vercel\.app/.test(error.message),
    'expected an actionable NajikiConfigError'
  );
});

check('a blank NAJIKI_API_URL is treated as missing', () => {
  assert.throws(() => resolveNajikiBaseUrl({ NAJIKI_API_URL: '   ' }), NajikiConfigError);
});

check('trailing slashes are trimmed so paths cannot become //api/...', () => {
  assert.equal(resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://najiki.vercel.app/' }), 'https://najiki.vercel.app');
  assert.equal(resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://najiki.vercel.app///' }), 'https://najiki.vercel.app');
});

check('a URL without a scheme is rejected instead of failing inside fetch', () => {
  assert.throws(
    () => resolveNajikiBaseUrl({ NAJIKI_API_URL: 'najiki.vercel.app' }),
    /not a valid absolute URL/
  );
});

check('a configured /api suffix is rejected (Kunity appends /api itself)', () => {
  assert.throws(
    () => resolveNajikiBaseUrl({ NAJIKI_API_URL: 'https://najiki.vercel.app/api' }),
    /without the \/api suffix/
  );
});

check('non-http protocols are rejected', () => {
  assert.throws(() => normalizeNajikiBaseUrl('ftp://najiki.example'), /must use http or https/);
});

check('the host label never includes credentials or a path', () => {
  assert.equal(najikiHostLabel('https://user:pass@najiki.vercel.app/base'), 'najiki.vercel.app');
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
