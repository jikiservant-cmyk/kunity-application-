/**
 * Join-code migration (24) + organization column lockdown, verified on PG17 (PGlite).
 *   Phase 1: legacy grants — shows anon can read api_key (the exposure).
 *   Phase 2: apply 24 — anon can read public columns only; codes backfilled, unique.
 * Run: node test/join-code-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
  `);
  await db.exec(read('test/financial-base-schema.sql'));
  // api_key was added by migration 08; legacy lockdown (14) = table-level grant + active-row policy.
  await db.exec(`
    ALTER TABLE kunity.organizations ADD COLUMN IF NOT EXISTS api_key VARCHAR(100) UNIQUE;
    GRANT USAGE ON SCHEMA kunity TO anon, authenticated, service_role;
    ALTER TABLE kunity.organizations ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON kunity.organizations TO anon, authenticated;
    CREATE POLICY organizations_read_active ON kunity.organizations
      FOR SELECT TO anon, authenticated USING (is_active = true);
    GRANT ALL ON kunity.organizations TO service_role;
    INSERT INTO kunity.organizations (id, name, code, is_active, api_key) VALUES
      ('11111111-0000-0000-0000-00000000000a', 'Sacco A', 'SA', true, 'SECRET-KEY-A'),
      ('11111111-0000-0000-0000-00000000000b', 'Sacco B', 'SB', true, 'SECRET-KEY-B'),
      ('11111111-0000-0000-0000-00000000000c', 'Old Sacco', 'OS', false, 'SECRET-KEY-C');
  `);
  return db;
}

async function asRole(db, role, sql) {
  await db.exec(`SET ROLE ${role};`);
  try { return { rows: (await db.query(sql)).rows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('RESET ROLE;'); }
}

async function main() {
  console.log('PHASE 1 — before migration 24');
  let db = await setup();
  let r = await asRole(db, 'anon', 'SELECT api_key FROM kunity.organizations');
  record('before: anon can read api_key (exposure reproduced)', !!r.rows && r.rows.length > 0, r.error || `${r.rows.length} rows`);
  await db.close();

  console.log('\nPHASE 2 — after migration 24');
  db = await setup();
  await db.exec(read('supabase/migrations/24_sacco_join_codes.sql'));

  const codes = (await db.query('SELECT join_code FROM kunity.organizations')).rows.map(x => x.join_code);
  record('backfill: every existing SACCO has a join code', codes.length === 3 && codes.every(c => typeof c === 'string' && c.length === 10), `${codes.length} rows`);
  record('backfill: codes are unique', new Set(codes).size === codes.length);

  await db.exec(`INSERT INTO kunity.organizations (name, code) VALUES ('New Sacco', 'NS')`);
  const nw = (await db.query(`SELECT join_code FROM kunity.organizations WHERE name = 'New Sacco'`)).rows[0];
  record('default: new SACCO gets a join code automatically', !!nw && nw.join_code?.length === 10);

  r = await asRole(db, 'anon', 'SELECT api_key FROM kunity.organizations');
  record('after: anon CANNOT read api_key', !!r.error && /permission denied/i.test(r.error), r.error || 'readable!');
  r = await asRole(db, 'anon', 'SELECT join_code FROM kunity.organizations');
  record('after: anon CANNOT read join_code', !!r.error && /permission denied/i.test(r.error), r.error || 'readable!');
  r = await asRole(db, 'authenticated', 'SELECT join_code FROM kunity.organizations');
  record('after: authenticated CANNOT read join_code', !!r.error, r.error || 'readable!');
  r = await asRole(db, 'anon', 'SELECT id, name, code, is_active, currency FROM kunity.organizations');
  record('after: anon can still read public columns', !r.error && r.rows.length === 3, r.error || `${r.rows.length} active rows (inactive hidden)`);
  r = await asRole(db, 'anon', 'SELECT name FROM kunity.organizations WHERE id = \'11111111-0000-0000-0000-00000000000c\'');
  record('after: anon cannot see inactive SACCO', !r.error && r.rows.length === 0);
  r = await asRole(db, 'anon', 'SELECT name FROM kunity.organizations WHERE id = \'11111111-0000-0000-0000-00000000000a\'');
  record('after: member/anon embed of organization name still works', !r.error && r.rows.length === 1);

  // service_role (used by the server routes) still reads the code.
  r = await asRole(db, 'service_role', `SELECT id FROM kunity.organizations WHERE join_code = '${codes[0]}'`);
  record('service role can resolve a join code to its SACCO', !r.error && r.rows.length === 1, r.error || '');

  const dup = await db.exec(`INSERT INTO kunity.organizations (name, code, join_code) VALUES ('Dup', 'D', '${codes[0]}')`).then(() => false, () => true);
  record('unique: duplicate join code rejected', dup);

  await db.close();
  const failed = results.filter(x => !x.pass).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('ALL JOIN-CODE CHECKS PASSED');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
