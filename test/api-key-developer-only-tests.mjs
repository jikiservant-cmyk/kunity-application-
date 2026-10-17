/**
 * Application API key — developer-only access.
 *
 * Requirement: a SACCO admin must never see the tenant application API key and
 * must never be able to rotate it. The key is the bearer credential for
 * POST /api/messaging/send (SMS billed to the tenant), so it is a developer /
 * deployment secret. Provisioning happens out of band via
 * scripts/rotate-api-key.mjs, run with a service-role key.
 *
 * These checks cover the whole surface, not just the removed button:
 *   1. the admin console renders no API-key UI and holds no key state,
 *   2. the admin data endpoint returns no key and no "is one set" flag,
 *   3. no admin route can rotate or reveal a key,
 *   4. the gateway still authenticates by digest (engine untouched),
 *   5. the developer script matches lib/api-keys exactly and never persists a key.
 *
 * Run: node test/api-key-developer-only-tests.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { hashApiKey, generateApiKey } from '../lib/api-keys.ts';
import * as script from '../scripts/rotate-api-key.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p) => existsSync(new URL(`../${p}`, import.meta.url));

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

console.log('Application API key — developer-only checks');

const console_ = read('app/admin/AdminConsole.tsx');
const dataRoute = read('app/api/admin/data/route.ts');
const gateway = read('app/api/messaging/send/route.ts');

// ── 1. Admin console: no UI, no state, no handler ───────────────────────────
check('the admin console renders no API-key box, copy button or rotate button', () => {
  for (const text of [
    'Tenant Application API Secret Key',
    'Rotate Key',
    'Issue Key',
    'Copy Key',
    'Rotate Key',
  ]) {
    assert.ok(!console_.includes(text), `admin console still renders "${text}"`);
  }
});

check('the admin console holds no API-key state and calls no key endpoint', () => {
  for (const pattern of [/\bapiKey\b/, /\bapiKeySet\b/, /\brotatingKey\b/, /\brotateApiKey\b/, /\/api\/admin\/api-key/]) {
    assert.doesNotMatch(console_, pattern, `admin console still references ${pattern}`);
  }
});

check('the settings tab no longer mentions issuing or seeing a key', () => {
  const settings = console_.slice(console_.indexOf("TAB 6: TENANT CONFIGURATION"), console_.indexOf('MODAL: MEMBER FULL DOSSIER'));
  assert.ok(settings.length > 200, 'settings tab slice not found');
  assert.doesNotMatch(settings, /api key/i);
  assert.doesNotMatch(settings, /rotate/i);
});

// ── 2. Admin data endpoint: no key, not even a presence flag ─────────────────
check('the admin data endpoint returns neither the key nor an "is set" flag', () => {
  assert.doesNotMatch(dataRoute, /apiKey/);
  assert.doesNotMatch(dataRoute, /apiKeySet/);
  assert.doesNotMatch(dataRoute, /api_key_hash/);
  assert.doesNotMatch(dataRoute, /select\('api_key/);
});

check('the admin data endpoint does not even query the applications table for keys', () => {
  assert.doesNotMatch(dataRoute, /from\('applications'\)/);
});

// ── 3. No admin route can rotate or reveal a key ────────────────────────────
check('the admin api-key route is gone', () => {
  assert.equal(exists('app/api/admin/api-key/route.ts'), false);
});

check('no route under app/api/admin touches api_key at all', () => {
  const adminRoutes = [
    'app/api/admin/data/route.ts',
    'app/api/admin/join-code/route.ts',
    'app/api/admin/loans/route.ts',
    'app/api/admin/members/route.ts',
    'app/api/admin/products/route.ts',
    'app/api/admin/sms/send/route.ts',
    'app/api/admin/sms/templates/route.ts',
    'app/api/admin/sms/topup/route.ts',
    'app/api/admin/sms/topup/confirm/route.ts',
  ];
  for (const route of adminRoutes) {
    assert.ok(exists(route), `${route} missing`);
    const src = read(route);
    assert.doesNotMatch(src, /api_key_hash|api_key:/, `${route} still touches the application api key`);
  }
});

// ── 4. Engine untouched: the gateway still authenticates by digest ──────────
check('the SMS gateway still authenticates by SHA-256 digest only', () => {
  assert.match(gateway, /eq\('api_key_hash', hashApiKey\(apiKey\)\)/);
  assert.doesNotMatch(gateway, /eq\('api_key', apiKey\)/);
});

check('the gateway still bills the resolved application and returns 401 without a key', () => {
  assert.match(gateway, /Bearer/);
  assert.match(gateway, /status: 401/);
});

// ── 5. Developer script: correct crypto, no persistence ─────────────────────
check('the developer script generates keys in the same format as lib/api-keys', () => {
  const key = script.generateApiKey();
  assert.match(key, /^kn_live_[A-Za-z0-9_-]{40,}$/);
});

check('the developer script hashes exactly like lib/api-keys', () => {
  for (const sample of ['kn_live_abc', 'some-other-key', '']) {
    assert.equal(script.hashApiKey(sample), hashApiKey(sample), `hash mismatch for "${sample}"`);
  }
});

check('the developer script never writes the key to disk or logs it', () => {
  const src = read('scripts/rotate-api-key.mjs');
  for (const sink of ['writeFile', 'appendFile', 'createWriteStream', 'console.error(newKey', 'fs.write']) {
    assert.ok(!src.includes(sink), `script persists the key via ${sink}`);
  }
  assert.match(src, /shown once/i);
});

check('the developer script refuses to run without a service-role key', () => {
  const src = read('scripts/rotate-api-key.mjs');
  assert.match(src, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(src, /usage\('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set/);
});

check('the developer script is wired into package.json for discoverability', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['rotate-api-key'], 'node scripts/rotate-api-key.mjs');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
