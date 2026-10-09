/**
 * Row-level-security tenant isolation — runs the REAL policy migration
 * (supabase/migrations/23_tenant_row_isolation.sql) on PostgreSQL 17 (PGlite).
 *
 *   Phase 1: recreate the ORIGINAL (pre-fix) policies and show the leak.
 *   Phase 2: apply 23_tenant_row_isolation.sql and verify isolation.
 *
 * Run: node test/rls-tests.mjs   (requires: npm install --no-save @electric-sql/pglite)
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const ORG_A = '11111111-0000-0000-0000-00000000000a';
const ORG_B = '11111111-0000-0000-0000-00000000000b';
const M_A1 = '22222222-0000-0000-0000-0000000000a1'; // Sacco A member (victim)
const M_A2 = '22222222-0000-0000-0000-0000000000a2'; // Sacco A member (attacker)
const M_B1 = '22222222-0000-0000-0000-0000000000b1'; // Sacco B member
const ADM_A = '33333333-0000-0000-0000-0000000000aa'; // sacco_admin of Sacco A
const ADM_B = '33333333-0000-0000-0000-0000000000bb'; // sacco_admin of Sacco B
const SUPER = '33333333-0000-0000-0000-0000000000ff'; // super_admin
const ACC_A1 = '44444444-0000-0000-0000-0000000000a1';
const ACC_A2 = '44444444-0000-0000-0000-0000000000a2';
const ACC_B1 = '44444444-0000-0000-0000-0000000000b1';
const LOAN_A1 = '55555555-0000-0000-0000-0000000000a1';
const LOAN_B1 = '55555555-0000-0000-0000-0000000000b1';
const JE_A1 = '66666666-0000-0000-0000-0000000000a1';
const JE_A2 = '66666666-0000-0000-0000-0000000000a2';
const JE_B1 = '66666666-0000-0000-0000-0000000000b1';

// Policies exactly as the pre-fix migrations created them (01, 04, 07).
const LEGACY_POLICIES = `
  ALTER TABLE kunity.accounts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view accounts in their organization" ON kunity.accounts
    FOR SELECT USING (organization_id = kunity.get_user_organization_id());
  ALTER TABLE kunity.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view members of their own organization" ON kunity.profiles
    FOR SELECT USING (organization_id = kunity.get_user_organization_id() OR id = auth.uid());
  ALTER TABLE kunity.journal_entries ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view journal entries in their organization" ON kunity.journal_entries
    FOR SELECT USING (organization_id = kunity.get_user_organization_id());
  ALTER TABLE kunity.loans ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view their own loans" ON kunity.loans FOR SELECT USING (member_id = auth.uid());
  CREATE POLICY "Organization admins can view all loans in org" ON kunity.loans
    FOR SELECT USING (organization_id = kunity.get_user_organization_id());
  ALTER TABLE kunity.sacco_wallets ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view sacco wallets in their organization" ON kunity.sacco_wallets
    FOR SELECT USING (organization_id IN (SELECT organization_id FROM kunity.profiles WHERE id = auth.uid()));
  ALTER TABLE kunity.journal_lines ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view journal lines of their accounts" ON kunity.journal_lines
    FOR SELECT USING (account_id IN (SELECT id FROM kunity.accounts WHERE member_id = auth.uid()));
`;

async function setupDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await db.exec(read('test/financial-base-schema.sql'));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS kunity.profiles (
      id UUID PRIMARY KEY, organization_id UUID, full_name TEXT, phone TEXT);
    CREATE TABLE IF NOT EXISTS public.admin_profiles (
      id UUID PRIMARY KEY, role TEXT NOT NULL, tenant_id UUID);
    CREATE OR REPLACE FUNCTION kunity.get_user_organization_id() RETURNS UUID
      LANGUAGE sql SECURITY DEFINER AS
      $$ SELECT organization_id FROM kunity.profiles WHERE id = auth.uid() LIMIT 1 $$;
    GRANT USAGE ON SCHEMA kunity, public, auth TO anon, authenticated, service_role;
    GRANT SELECT ON ALL TABLES IN SCHEMA kunity TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA kunity TO service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
    GRANT EXECUTE ON FUNCTION kunity.get_user_organization_id() TO authenticated;
    GRANT USAGE ON SCHEMA kunity TO authenticated;
  `);
  await db.exec(`
    INSERT INTO kunity.organizations (id, name, code, is_active) VALUES
      ('${ORG_A}', 'Sacco A', 'SA', true), ('${ORG_B}', 'Sacco B', 'SB', true);
    INSERT INTO kunity.members (id, organization_id, status, first_name) VALUES
      ('${M_A1}', '${ORG_A}', 'active', 'A1'), ('${M_A2}', '${ORG_A}', 'active', 'A2'),
      ('${M_B1}', '${ORG_B}', 'active', 'B1');
    INSERT INTO kunity.profiles (id, organization_id, full_name, phone) VALUES
      ('${M_A1}', '${ORG_A}', 'Alice Victim', '+256700111111'),
      ('${M_A2}', '${ORG_A}', 'Mallory Attacker', '+256700222222'),
      ('${M_B1}', '${ORG_B}', 'Bob Other', '+256700333333'),
      ('${ADM_A}', '${ORG_A}', 'Admin A', NULL), ('${ADM_B}', '${ORG_B}', 'Admin B', NULL),
      ('${SUPER}', '${ORG_A}', 'Super', NULL);
    INSERT INTO public.admin_profiles (id, role, tenant_id) VALUES
      ('${ADM_A}', 'sacco_admin', '${ORG_A}'),
      ('${ADM_B}', 'sacco_admin', '${ORG_B}'),
      ('${SUPER}', 'super_admin', NULL);
    INSERT INTO kunity.accounts (id, organization_id, member_id, name, code, account_category, cached_balance, is_active) VALUES
      ('${ACC_A1}', '${ORG_A}', '${M_A1}', 'A1 savings', 'S-A1', 'asset', 750000, true),
      ('${ACC_A2}', '${ORG_A}', '${M_A2}', 'A2 savings', 'S-A2', 'asset', 120000, true),
      ('${ACC_B1}', '${ORG_B}', '${M_B1}', 'B1 savings', 'S-B1', 'asset', 999999, true);
    INSERT INTO kunity.loans (id, organization_id, member_id, principal, interest_rate, status) VALUES
      ('${LOAN_A1}', '${ORG_A}', '${M_A1}', 300000, 10, 'approved'),
      ('${LOAN_B1}', '${ORG_B}', '${M_B1}', 500000, 10, 'approved');
    INSERT INTO kunity.journal_entries (id, organization_id, description) VALUES
      ('${JE_A1}', '${ORG_A}', 'Savings deposit A1'),
      ('${JE_A2}', '${ORG_A}', 'Savings deposit A2'),
      ('${JE_B1}', '${ORG_B}', 'Savings deposit B1');
    INSERT INTO kunity.journal_lines (journal_entry_id, account_id, member_id, line_type, debit, credit) VALUES
      ('${JE_A1}', '${ACC_A1}', '${M_A1}', 'deposit', 0, 1000),
      ('${JE_A2}', '${ACC_A2}', '${M_A2}', 'deposit', 0, 500),
      ('${JE_B1}', '${ACC_B1}', '${M_B1}', 'deposit', 0, 2000);
    INSERT INTO kunity.sacco_wallets (organization_id, balance) VALUES
      ('${ORG_A}', 5000000), ('${ORG_B}', 7000000);
  `);
  return db;
}

async function asUser(db, uid, sql) {
  await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${uid}';`);
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('RESET ROLE; RESET request.jwt.claim.sub;');
  }
}

const count = async (db, uid, table, where = 'TRUE') =>
  Number((await asUser(db, uid, `SELECT COUNT(*)::int AS n FROM kunity.${table} WHERE ${where}`))[0].n);

async function runChecks(db, phase) {
  // Member A1 (victim) must see only their own rows; A2 must not see A1's.
  const accA = await asUser(db, M_A2, `SELECT id::text FROM kunity.accounts`);
  record(`${phase} accounts: member A2 can read A1's balance row`,
    phase === 'after' ? !accA.some(r => r.id === ACC_A1) : accA.some(r => r.id === ACC_A1),
    `A2 sees ${accA.length} account row(s), includes A1=${accA.some(r => r.id === ACC_A1)}`);

  const loansA2 = await asUser(db, M_A2, `SELECT id::text FROM kunity.loans`);
  record(`${phase} loans: member A2 can read A1's loan`,
    phase === 'after' ? !loansA2.some(r => r.id === LOAN_A1) : loansA2.some(r => r.id === LOAN_A1),
    `A2 sees ${loansA2.length} loan row(s)`);

  const profA2 = await asUser(db, M_A2, `SELECT id::text FROM kunity.profiles`);
  record(`${phase} profiles: member A2 can read A1's profile (name/phone)`,
    phase === 'after' ? !profA2.some(r => r.id === M_A1) : profA2.some(r => r.id === M_A1),
    `A2 sees ${profA2.length} profile row(s)`);

  const jeA2 = await asUser(db, M_A2, `SELECT id::text FROM kunity.journal_entries`);
  record(`${phase} journal: member A2 can read A1's journal entry`,
    phase === 'after' ? !jeA2.some(r => r.id === JE_A1) : jeA2.some(r => r.id === JE_A1),
    `A2 sees ${jeA2.length} journal entr(y/ies)`);

  const walletA2 = await count(db, M_A2, 'sacco_wallets');
  record(`${phase} SACCO float: member A2 can read the institutional float`,
    phase === 'after' ? walletA2 === 0 : walletA2 > 0, `rows visible=${walletA2}`);

  if (phase === 'after') {
    // Positive controls: members keep their OWN data.
    const own = await asUser(db, M_A1, `SELECT id::text FROM kunity.accounts`);
    record('after own data: member A1 still sees own account', own.length === 1 && own[0].id === ACC_A1, `rows=${own.length}`);
    const ownLoan = await asUser(db, M_A1, `SELECT id::text FROM kunity.loans`);
    record('after own data: member A1 still sees own loan', ownLoan.length === 1 && ownLoan[0].id === LOAN_A1, `rows=${ownLoan.length}`);
    const ownJe = await asUser(db, M_A1, `SELECT id::text FROM kunity.journal_entries`);
    record('after own data: member A1 sees only own journal entry', ownJe.length === 1 && ownJe[0].id === JE_A1, `rows=${ownJe.length}`);
    const ownProf = await asUser(db, M_A1, `SELECT id::text FROM kunity.profiles`);
    record('after own data: member A1 sees only own profile', ownProf.length === 1 && ownProf[0].id === M_A1, `rows=${ownProf.length}`);

    // Cross-tenant still blocked.
    const crossAcc = await count(db, M_A1, 'accounts', `organization_id = '${ORG_B}'`);
    record('after cross-SACCO: member A1 sees no Sacco B accounts', crossAcc === 0, `rows=${crossAcc}`);

    // Admins: scoped to their own tenant only.
    const adminA = await count(db, ADM_A, 'accounts');
    record('after admin: Sacco A admin sees all Sacco A accounts (2) and no B account',
      adminA === 2 && (await count(db, ADM_A, 'accounts', `organization_id = '${ORG_B}'`)) === 0,
      `visible=${adminA}`);
    const adminAWallet = await asUser(db, ADM_A, `SELECT balance::text FROM kunity.sacco_wallets`);
    record('after admin: Sacco A admin sees only Sacco A float',
      adminAWallet.length === 1 && Number(adminAWallet[0].balance) === 5000000, `rows=${adminAWallet.length}`);
    const adminBLoans = await count(db, ADM_B, 'loans', `organization_id = '${ORG_A}'`);
    record('after admin: Sacco B admin cannot read Sacco A loans', adminBLoans === 0, `rows=${adminBLoans}`);
    const superAccounts = await count(db, SUPER, 'accounts');
    record('after admin: super_admin reads all accounts across tenants (3 fixture accounts)', superAccounts === 3, `rows=${superAccounts}`);
  }
}

async function main() {
  console.log('Starting RLS tenant-isolation verification (PGlite / PG 17)...\n');
  console.log('══════════════════════════════════════════════════════');
  console.log('PHASE 1 — pre-fix policies: demonstrate the exposure');
  console.log('══════════════════════════════════════════════════════');
  let db = await setupDb();
  await db.exec(LEGACY_POLICIES);
  await runChecks(db, 'before');
  await db.close();

  console.log('\n══════════════════════════════════════════════════════');
  console.log('PHASE 2 — apply 23_tenant_row_isolation.sql');
  console.log('══════════════════════════════════════════════════════');
  db = await setupDb();
  await db.exec(LEGACY_POLICIES);
  await db.exec(read('supabase/migrations/23_tenant_row_isolation.sql'));
  await runChecks(db, 'after');
  await db.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\nRESULTS: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
  console.log('ALL TENANT-ISOLATION CHECKS PASSED');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
