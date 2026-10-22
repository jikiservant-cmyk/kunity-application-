/**
 * Join-code conformance: the DB generator and the app validator MUST speak the
 * same alphabet. Regression for the migration-24 bug: codes minted from UUID hex
 * (0-9A-F) contained '0'/'1', which lib/join-code.ts normalizeJoinCode() rejects,
 * so ~74% of join links were dead on arrival ("This join link is not valid").
 *
 * Migration 38 fixes the generator and, per DB review 2026-10-21, snapshots the
 * replaced codes into kunity.join_code_aliases so links already shared still
 * resolve (closed mapping — the alphabet stays strict).
 *
 * Run: node test/join-code-conformance-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeJoinCode, generateJoinCode, legacyJoinCodeCandidate } from '../lib/join-code.ts';

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
  await db.exec(`
    ALTER TABLE kunity.organizations ADD COLUMN IF NOT EXISTS api_key VARCHAR(100) UNIQUE;
    GRANT USAGE ON SCHEMA kunity TO anon, authenticated, service_role;
    ALTER TABLE kunity.organizations ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON kunity.organizations TO anon, authenticated;
    CREATE POLICY organizations_read_active ON kunity.organizations
      FOR SELECT TO anon, authenticated USING (is_active = true);
    GRANT ALL ON kunity.organizations TO service_role;
    -- migration 05's default privileges toward anon/authenticated (reproduced so
    -- the alias-table lockdown below is actually exercised)
    ALTER DEFAULT PRIVILEGES IN SCHEMA kunity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
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
  console.log('PHASE 1 — reproduce the bug (migration 24 generator vs app validator)');
  let db = await setup();
  await db.exec(read('supabase/migrations/24_sacco_join_codes.sql'));

  // Deterministic repro of both sides of the mismatch:
  //  - 'AB01CD23EF' is exactly what migration 24's SQL generator can mint
  //  - 'ABCDEF2345' is a "lucky" hex code with no 0/1 that DID work
  await db.exec(`
    INSERT INTO kunity.organizations (id, name, code, is_active, api_key, join_code) VALUES
      ('22222222-0000-0000-0000-00000000000a', 'Legacy Sacco', 'LS', true, 'K-LEGACY', 'AB01CD23EF'),
      ('22222222-0000-0000-0000-00000000000b', 'Lucky Sacco', 'LU', true, 'K-LUCKY', 'ABCDEF2345');
  `);
  record('legacy hex code with 0/1 is rejected by normalizeJoinCode (dead link)', normalizeJoinCode('AB01CD23EF') === null);
  record('legacy hex code without 0/1 is accepted (link that worked)', normalizeJoinCode('ABCDEF2345') === 'ABCDEF2345');

  // Monte Carlo against the REAL SQL generator expression from migration 24.
  let dead = 0;
  for (let i = 0; i < 200; i++) {
    const c = (await db.query(`SELECT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)) AS c`)).rows[0].c;
    if (!normalizeJoinCode(c)) dead++;
  }
  record('migration 24 generator produces dead links (mismatch reproduced)', dead > 0, `${dead}/200 rejected`);

  console.log('\nPHASE 2 — apply migration 38 (alphabet fix + legacy alias preservation)');
  await db.exec(read('supabase/migrations/38_join_code_alphabet_fix.sql'));

  const legacy = (await db.query(`SELECT join_code FROM kunity.organizations WHERE id = '22222222-0000-0000-0000-00000000000a'`)).rows[0].join_code;
  const lucky = (await db.query(`SELECT join_code FROM kunity.organizations WHERE id = '22222222-0000-0000-0000-00000000000b'`)).rows[0].join_code;
  record('non-conforming legacy code was replaced', legacy !== 'AB01CD23EF' && !!normalizeJoinCode(legacy), `now ${legacy}`);
  record('conforming code left untouched (working link stays live)', lucky === 'ABCDEF2345');
  record('replaced code resolves through normalizeJoinCode', normalizeJoinCode(legacy) === legacy);

  // The missing bridge: codes minted by the DB must pass the app validator.
  let sqlDead = 0;
  for (let i = 0; i < 200; i++) {
    const c = (await db.query(`SELECT kunity.generate_join_code() AS c`)).rows[0].c;
    if (!normalizeJoinCode(c)) sqlDead++;
  }
  record('DB generator codes all pass normalizeJoinCode (200 draws)', sqlDead === 0, `${sqlDead} rejected`);

  let jsDead = 0;
  for (let i = 0; i < 200; i++) {
    if (!normalizeJoinCode(generateJoinCode())) jsDead++;
  }
  record('TS generator codes all pass normalizeJoinCode (200 draws)', jsDead === 0);

  // DEFAULT for rows created without an explicit code (seed scripts, admin flows).
  await db.exec(`INSERT INTO kunity.organizations (id, name, code, is_active, api_key) VALUES
    ('22222222-0000-0000-0000-00000000000c', 'Fresh Sacco', 'FS', true, 'K-FRESH')`);
  const fresh = (await db.query(`SELECT join_code FROM kunity.organizations WHERE code = 'FS'`)).rows[0].join_code;
  record('new SACCO default code passes normalizeJoinCode', normalizeJoinCode(fresh) === fresh, `default ${fresh}`);

  // NOT NULL re-asserted (DB review: CHECK treats NULL as satisfied).
  const nullWrite = await db.exec(`INSERT INTO kunity.organizations (name, code, api_key, join_code)
    VALUES ('Null', 'NL', 'K-NULL', NULL)`).then(() => false, () => true);
  record('NOT NULL rejects an explicit NULL join_code', nullWrite);

  // CHECK constraint enforces the invariant for every future write.
  const badWrite = await db.exec(`INSERT INTO kunity.organizations (name, code, api_key, join_code)
    VALUES ('Bad', 'BD', 'K-BAD1', 'AB01CD23EF')`).then(() => false, () => true);
  record('CHECK rejects non-conforming code (contains 0/1)', badWrite);
  const shortWrite = await db.exec(`INSERT INTO kunity.organizations (name, code, api_key, join_code)
    VALUES ('Short', 'SH', 'K-BAD2', 'ABC')`).then(() => false, () => true);
  record('CHECK rejects wrong length', shortWrite);

  console.log('\nPHASE 3 — legacy alias mapping (already-shared links keep working)');
  const alias = (await db.query(`SELECT organization_id FROM kunity.join_code_aliases WHERE legacy_code = 'AB01CD23EF'`)).rows;
  record('replaced code was snapshotted to the alias table before replacement',
    alias.length === 1 && alias[0].organization_id === '22222222-0000-0000-0000-00000000000a');

  // Exactly what resolveJoinCodeToOrg does for a legacy link.
  const cand = legacyJoinCodeCandidate('ab01cd23ef'); // user-typed/lowercase variant
  const viaAlias = cand
    ? (await db.query(`SELECT o.name FROM kunity.join_code_aliases a JOIN kunity.organizations o ON o.id = a.organization_id WHERE a.legacy_code = '${cand}'`)).rows
    : [];
  record('resolve path: legacy shared link finds its SACCO via alias', viaAlias.length === 1 && viaAlias[0].name === 'Legacy Sacco');

  // legacyJoinCodeCandidate is a pure format check for what migration 24 minted.
  // (resolveJoinCodeToOrg consults it ONLY when the strict alphabet check fails.)
  record('legacy candidate: accepts migration-24 format (incl. case/space variants)',
    legacyJoinCodeCandidate('ab01cd23ef') === 'AB01CD23EF' && legacyJoinCodeCandidate('AB01-CD23 EF') === 'AB01CD23EF');
  record('legacy candidate: rejects non-hex, wrong length, non-strings',
    legacyJoinCodeCandidate('ZZ01CD23EF') === null && legacyJoinCodeCandidate('AB01CD23') === null && legacyJoinCodeCandidate(null) === null);

  // Alias table must not leak through migration 05's default privileges.
  const anonAlias = await asRole(db, 'anon', 'SELECT * FROM kunity.join_code_aliases');
  record('alias table is NOT readable by anon', !!anonAlias.error && /permission denied/i.test(anonAlias.error), anonAlias.error || 'readable!');
  const authAlias = await asRole(db, 'authenticated', 'SELECT * FROM kunity.join_code_aliases');
  record('alias table is NOT readable by authenticated', !!authAlias.error, authAlias.error || 'readable!');

  // End-to-end: strict path (exactly what /api/organizations/resolve does).
  const urlCode = lucky.toLowerCase(); // user-typed/lowercase variant of the shared link
  const resolved = normalizeJoinCode(urlCode);
  const row = resolved
    ? (await db.query(`SELECT name FROM kunity.organizations WHERE join_code = '${resolved}'`)).rows
    : [];
  record('resolve path: lowercase link input finds its SACCO', row.length === 1 && row[0].name === 'Lucky Sacco');

  // Idempotency (also covered globally by migrations-reapply-tests.mjs).
  let reapplied = true;
  try { await db.exec(read('supabase/migrations/38_join_code_alphabet_fix.sql')); } catch { reapplied = false; }
  record('migration 38 is idempotent (re-applies cleanly)', reapplied);
  const aliasCount = (await db.query(`SELECT count(*)::int AS n FROM kunity.join_code_aliases`)).rows[0].n;
  record('re-run does not duplicate or drop aliases', aliasCount === 1, `${aliasCount} alias row(s)`);

  await db.close();
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('ALL JOIN-CODE CONFORMANCE CHECKS PASSED');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
