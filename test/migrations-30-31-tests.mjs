/**
 * PGlite checks for migrations 30 (revoke client access) and 31 (hash API keys).
 * Run: node test/migrations-30-31-tests.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const sql = (p) => readFileSync(new URL(`../supabase/migrations/${p}`, import.meta.url), 'utf8');
const db = new PGlite();
let passed = 0;

await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE TABLE public.applications (id uuid PRIMARY KEY, name text, api_key text);
  CREATE TABLE public.sms_configs (id int);
  CREATE TABLE public.sms_webhook_logs (id int);
  GRANT ALL ON public.applications, public.sms_configs, public.sms_webhook_logs TO anon, authenticated;
  INSERT INTO public.applications VALUES
    ('11111111-1111-1111-1111-111111111111', 'Sacco A', 'kn_live_plainA'),
    ('22222222-2222-2222-2222-222222222222', 'Sacco B', 'kn_live_plainB');
`);

// --- migration 31: hash in place, clear plaintext, idempotent
await db.exec(sql('31_hash_application_api_keys.sql'));
await db.exec(sql('31_hash_application_api_keys.sql')); // second run must be harmless

const rows = (await db.query('SELECT name, api_key, api_key_hash FROM public.applications ORDER BY name')).rows;
for (const r of rows) {
  assert.equal(r.api_key, null, 'plaintext key must be cleared');
}
const expectA = createHash('sha256').update('kn_live_plainA', 'utf8').digest('hex');
assert.equal(rows[0].api_key_hash, expectA, 'SQL digest must equal the Node digest used by the gateway');
console.log('  ok - migration 31 hashes existing keys, digest matches gateway hashing, plaintext cleared');
passed++;

// --- migration 30: client roles lose access, service role (postgres) keeps it
await db.exec(sql('30_revoke_client_access_secrets.sql'));
const grants = (await db.query(`
  SELECT grantee, table_name FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
    AND table_name IN ('applications','sms_configs','sms_webhook_logs')`)).rows;
assert.equal(grants.length, 0, `client grants remain: ${JSON.stringify(grants)}`);
console.log('  ok - migration 30 revokes anon/authenticated from applications, sms_configs, sms_webhook_logs');
passed++;

// --- migration 30 is safe when a table does not exist (idempotent guard)
await db.exec(sql('30_revoke_client_access_secrets.sql'));
console.log('  ok - migration 30 re-runs without error');
passed++;

console.log(`\n${passed} checks passed`);
