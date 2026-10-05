/**
 * Financial integrity verification — runs the REAL SQL migrations against a
 * REAL PostgreSQL engine (PGlite / Postgres 17 WASM) and proves both the
 * original bugs and the fixes.
 *
 *   Phase 1: apply the ORIGINAL financial RPC migrations -> demonstrate bugs
 *   Phase 2: apply 21_financial_integrity.sql -> verify every fix
 *
 * Run: node test/financial-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(ROOT, 'supabase', 'migrations');

const read = (p) => readFileSync(p, 'utf8');

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Fixed UUIDs for fixtures
const ORG = '11111111-0000-0000-0000-000000000001';
const M_ACTIVE  = '22222222-0000-0000-0000-000000000001'; // active member
const M_SUSP    = '22222222-0000-0000-0000-000000000002'; // suspended member
const M_FROZEN  = '22222222-0000-0000-0000-000000000003'; // active member, frozen account
const ACC_MAIN  = '33333333-0000-0000-0000-000000000001'; // M_ACTIVE savings account (active)
const ACC_SUSP  = '33333333-0000-0000-0000-000000000002'; // M_SUSP account
const ACC_FROZ  = '33333333-0000-0000-0000-000000000003'; // M_FROZEN account (inactive)
const ACC_CASH  = '33333333-0000-0000-0000-000000000009'; // org system cash asset account
const ACC_FEE   = '33333333-0000-0000-0000-000000000010'; // org system fee income account
const LOAN_1    = '44444444-0000-0000-0000-000000000001';
const W_A       = '55555555-0000-0000-0000-000000000001'; // sms wallet A (tenant A)
const W_B       = '55555555-0000-0000-0000-000000000002'; // sms wallet B (tenant B)
const TX_B      = '66666666-0000-0000-0000-000000000001'; // wallet transaction owned by W_B

async function q(db, sql, params = []) {
  return db.query(sql, params);
}
async function one(db, sql, params = []) {
  const r = await q(db, sql, params);
  return r.rows[0];
}
async function scalar(db, sql, params = []) {
  const r = await q(db, sql, params);
  const v = r.rows[0];
  return v ? Object.values(v)[0] : null;
}

async function seedFixtures(db) {
  await db.exec(`
    DELETE FROM kunity.journal_lines;
    DELETE FROM kunity.journal_entries;
    DELETE FROM kunity.payment_requests;
    DELETE FROM kunity.loans;
    DELETE FROM kunity.member_savings;
    DELETE FROM public.wallet_transactions;
    DELETE FROM public.wallets;
    DELETE FROM kunity.accounts;
    DELETE FROM kunity.members;
    DELETE FROM kunity.sacco_wallets;
    DELETE FROM kunity.organizations;

    INSERT INTO kunity.organizations (id, name, code, is_active) VALUES
      ('${ORG}', 'Sacco Test', 'TEST', true);

    INSERT INTO kunity.members (id, organization_id, status, first_name) VALUES
      ('${M_ACTIVE}', '${ORG}', 'active',   'Active'),
      ('${M_SUSP}',  '${ORG}', 'suspended', 'Suspended'),
      ('${M_FROZEN}', '${ORG}', 'active',  'FrozenAcc');

    INSERT INTO kunity.accounts (id, organization_id, member_id, name, code, account_category, cached_balance, is_active, is_system, created_at) VALUES
      ('${ACC_CASH}', '${ORG}', NULL,       'Org Mobile Money Wallet', 'SYS-WALLET-01', 'asset',    500000, true,  true,  NOW() - INTERVAL '30 days'),
      ('${ACC_FEE}',  '${ORG}', NULL,       'Gateway Fees',            'SYS-FEE-01',    'income',   0,      true,  true,  NOW() - INTERVAL '30 days'),
      ('${ACC_MAIN}', '${ORG}', '${M_ACTIVE}', 'Active Member Savings','SAV-1',         'liability',200000, true,  false, NOW() - INTERVAL '5 days'),
      ('${ACC_SUSP}', '${ORG}', '${M_SUSP}',  'Suspended Member Savings','SAV-2',       'liability',200000, true,  false, NOW() - INTERVAL '5 days'),
      ('${ACC_FROZ}','${ORG}', '${M_FROZEN}','Frozen Member Savings', 'SAV-3',         'liability',200000, false, false, NOW() - INTERVAL '5 days');

    INSERT INTO kunity.member_savings (id, organization_id, member_id, account_id, status, created_at) VALUES
      ('77777777-0000-0000-0000-000000000001', '${ORG}', '${M_ACTIVE}', '${ACC_MAIN}', 'active',   NOW() - INTERVAL '5 days'),
      ('77777777-0000-0000-0000-000000000002', '${ORG}', '${M_SUSP}',  '${ACC_SUSP}', 'active',   NOW() - INTERVAL '5 days'),
      ('77777777-0000-0000-0000-000000000003', '${ORG}', '${M_FROZEN}','${ACC_FROZ}', 'frozen',   NOW() - INTERVAL '5 days');

    INSERT INTO kunity.sacco_wallets (organization_id, balance) VALUES ('${ORG}', 100000);

    INSERT INTO kunity.loans (id, organization_id, member_id, principal, interest_rate, status) VALUES
      ('${LOAN_1}', '${ORG}', '${M_ACTIVE}', 100000, 10, 'pending');

    INSERT INTO public.wallets (id, tenant_id, balance, sms_rate) VALUES
      ('${W_A}', '99999999-0000-0000-0000-000000000001', 100,  50),
      ('${W_B}', '99999999-0000-0000-0000-000000000002', 5000, 50);

    INSERT INTO public.wallet_transactions (id, wallet_id, tenant_id, direction, amount, note, reference) VALUES
      ('${TX_B}', '${W_B}', '99999999-0000-0000-0000-000000000002', 'credit', 5000, 'pending', 'topup-b-1');
  `);
  // loan_repayments only exists after B1b creates it (FIN-01a) / migration 21
  try {
    await db.exec('DELETE FROM kunity.loan_repayments;');
  } catch { /* table not created yet (phase 1, before B1b) */ }
}

async function seedPaymentRequest(db, ref, type, amount, member = M_ACTIVE) {
  await q(db,
    `INSERT INTO kunity.payment_requests (id, organization_id, member_id, amount, status, internal_reference, payment_type, provider)
     VALUES (gen_random_uuid(), $1, $2, $3, 'pending', $4, $5, 'najiki')`,
    [ORG, member, amount, ref, type]);
}

async function entryBalanced(db, entryId) {
  const r = await one(db,
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
     FROM kunity.journal_lines WHERE journal_entry_id = $1`, [entryId]);
  return Math.abs(parseFloat(r.d) - parseFloat(r.c)) < 0.000001 && parseFloat(r.d) > 0;
}

// ===========================================================================
async function phase1_bugs(db) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('PHASE 1 — ORIGINAL financial RPCs: demonstrate the bugs');
  console.log('══════════════════════════════════════════════════════');

  // Apply the original RPC migrations
  const originalMigrations = [
    '02_livepay_webhook_rpc.sql',
    '03_najiki_webhook_rpc.sql',
    '15_loan_disbursement_rpc.sql',
    '16_member_transactions_rpc.sql',
    '09_credit_sms_wallet_rpc.sql',
    '10_debit_sms_wallet_rpc.sql',
    '18_credit_sms_idempotent.sql',
  ];
  for (const m of originalMigrations) {
    await db.exec(read(join(MIG, m)));
  }

  // --- FIN-01a: loan_repayments table does not exist anywhere
  await seedFixtures(db);
  let err = null;
  try {
    await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 10000)`);
  } catch (e) { err = e; }
  record('B1a FIN-01: repayment fails — loan_repayments table missing',
    !!err && /loan_repayments.*does not exist/i.test(err.message), err ? err.message.slice(0, 80) : 'no error');

  // Create the table manually to expose the SECOND repayment bug
  await db.exec(`
    CREATE TABLE IF NOT EXISTS kunity.loan_repayments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL, loan_id UUID NOT NULL, journal_entry_id UUID,
      member_id UUID NOT NULL, principal_paid NUMERIC(20,2) DEFAULT 0,
      created_by UUID, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  err = null;
  try {
    await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 10000)`);
  } catch (e) { err = e; }
  record('B1b FIN-01: repayment fails — FOR UPDATE + GROUP BY is invalid SQL',
    !!err && /FOR UPDATE is not allowed with GROUP BY/i.test(err.message), err ? err.message.slice(0, 70) : 'no error');

  // --- FIN-17: with an enum-typed status column the original najiki UPDATE crashes
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-crash', 'deposit', 50000);
  let crashErr = null;
  try {
    await q(db, `SELECT kunity.process_najiki_webhook('ref-crash','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0)`);
  } catch (e) { crashErr = e; }
  record('B2a FIN-17: najiki webhook CRASHES when status column is the payment_status enum (42804)',
    !!crashErr && /column "status" is of type/i.test(crashErr.message),
    crashErr ? crashErr.message.slice(0, 70) : 'no error');

  // --- FIN-02 (text-typed status variant): amount drift re-rates the payment
  await db.exec(`ALTER TABLE kunity.payment_requests ALTER COLUMN status TYPE TEXT;`);
  await db.exec(read(join(MIG, '03_najiki_webhook_rpc.sql'))); // re-resolve %ROWTYPE for text column
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-drift', 'deposit', 50000);
  const drift = await one(db, `SELECT kunity.process_najiki_webhook('ref-drift','success',5000000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const balAfterDrift = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id = '${ACC_MAIN}'`);
  record('B2b FIN-02: webhook amount drift OVERWRITES intent amount (50000 -> 5000000 credited)',
    drift.r?.message !== undefined && parseFloat(balAfterDrift) === 5200000,
    `member credited ${balAfterDrift} (expected 200000 + 50000 only)`);

  // --- FIN-03: activation payment bypasses the ledger (text variant: fn runs)
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-act', 'account_activation', 5000, M_FROZEN);
  const act = await one(db, `SELECT kunity.process_najiki_webhook('ref-act','success',5000,'${M_FROZEN}','account_activation','{}'::jsonb, 0) AS r`);
  const actJournals = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_entries`);
  const actBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id = '${ACC_FROZ}'`);
  const actFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id = '${ORG}'`);
  record('B3 FIN-03: activation payment collected but NOTHING recorded',
    act.r?.message === 'Account activation successful' && String(actJournals) === '0' &&
    parseFloat(actBal) === 200000 && parseFloat(actFloat) === 100000,
    `journals=${actJournals} memberBal=${actBal} float=${actFloat}`);

  // --- FIN-10: intermediate status poisons the request to 'failed'
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-int', 'deposit', 50000);
  await q(db, `SELECT kunity.process_najiki_webhook('ref-int','pending',NULL,'${M_ACTIVE}','deposit','{}'::jsonb, 0)`);
  const intStatus = await scalar(db, `SELECT status::text FROM kunity.payment_requests WHERE internal_reference='ref-int'`);
  const final = await one(db, `SELECT kunity.process_najiki_webhook('ref-int','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  record('B4 FIN-10: pending webhook poisons request; final success dropped',
    intStatus === 'failed' && /Already processed/i.test(final.r?.message || ''),
    `afterPending=${intStatus}, afterSuccess=${final.r?.message}`);

  // restore enum-typed status column for the remaining checks
  await db.exec(`ALTER TABLE kunity.payment_requests ALTER COLUMN status TYPE kunity.payment_status USING status::kunity.payment_status;`);
  await db.exec(read(join(MIG, '03_najiki_webhook_rpc.sql'))); // re-resolve %ROWTYPE for enum column

  // --- FIN-05: LivePay deposit never credits member balance
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-lp', 'deposit', 50000);
  await q(db, `SELECT kunity.process_livepay_webhook('ref-lp','success',50000,0,'UGX','{}'::jsonb)`);
  const lpBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id = '${ACC_MAIN}'`);
  const lpJournals = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_entries`);
  record('B5 FIN-05: LivePay deposit ignores member spendable balance',
    parseFloat(lpBal) === 200000 && String(lpJournals) === '1',
    `memberBal=${lpBal} (stayed 200000) while journals=${lpJournals}`);

  // --- FIN-18a: uuid-id wallets -> original debit_sms_wallet cannot run at all
  await seedFixtures(db);
  let debitErr = null;
  try {
    await q(db, `SELECT * FROM public.debit_sms_wallet('${W_A}', 500, 'deb-key-1', 't1', 'test')`);
  } catch (e) { debitErr = e; }
  const wABal = await scalar(db, `SELECT balance FROM public.wallets WHERE id = '${W_A}'`);
  record('B6a FIN-18: debit_sms_wallet ERRORS on uuid-id wallets (uuid = text) -> SMS dispatch dead',
    !!debitErr && /operator does not exist: uuid = text/i.test(debitErr.message),
    debitErr ? debitErr.message.slice(0, 60) : `no error, walletA=${wABal}`);

  // --- FIN-18b: text-id wallets -> original credit_sms_wallet_idempotent cannot run
  await db.exec(`
    DROP TABLE public.wallet_transactions CASCADE;
    DROP TABLE public.wallets CASCADE;
    CREATE TABLE public.wallets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, balance NUMERIC(20,2) DEFAULT 0, sms_rate NUMERIC(10,2) DEFAULT 50, currency TEXT DEFAULT 'UGX', updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE public.wallet_transactions (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, wallet_id TEXT NOT NULL, tenant_id TEXT, direction TEXT NOT NULL, amount NUMERIC(20,2) NOT NULL, currency TEXT DEFAULT 'UGX', note TEXT, status TEXT, reference TEXT, description TEXT, type TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX wallets_debit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'debit';
    INSERT INTO public.wallets (id, tenant_id, balance) VALUES ('wallet_text_1', 'tenant_t', 5000);
    INSERT INTO public.wallet_transactions (id, wallet_id, tenant_id, direction, amount, note, reference) VALUES ('tx_text_1', 'wallet_text_1', 'tenant_t', 'credit', 2000, 'pending', 'ref-t-1');
  `);
  // CASCADE dropped the wallet RPCs — recreate the ORIGINALS against the text tables
  await db.exec(read(join(MIG, '09_credit_sms_wallet_rpc.sql')));
  await db.exec(read(join(MIG, '10_debit_sms_wallet_rpc.sql')));
  await db.exec(read(join(MIG, '18_credit_sms_idempotent.sql')));
  let creditTypeErr = null;
  try {
    await q(db, `SELECT * FROM public.credit_sms_wallet_idempotent('wallet_text_1', 'tx_text_1', 2000)`);
  } catch (e) { creditTypeErr = e; }
  record('B6b FIN-18: credit_sms_wallet_idempotent ERRORS on text-id wallets (text = uuid) -> topups dead',
    !!creditTypeErr && /operator does not exist|invalid input syntax for type uuid/i.test(creditTypeErr.message),
    creditTypeErr ? creditTypeErr.message.slice(0, 60) : 'no error');

  // --- FIN-19: original debit uses ON CONFLICT ON CONSTRAINT against a unique
  //     INDEX (not a constraint) -> it errors even on text-id wallets
  await db.exec(`INSERT INTO public.wallets (id, tenant_id, balance) VALUES ('wallet_text_2', 'tenant_t', 100);`);
  let conflictErr = null;
  try {
    await q(db, `SELECT * FROM public.debit_sms_wallet('wallet_text_2', 10, 'deb-key-c', 'tenant_t', 'c test')`);
  } catch (e) { conflictErr = e; }
  record('B6c FIN-19: debit_sms_wallet always errors — ON CONFLICT ON CONSTRAINT names an INDEX',
    !!conflictErr && /constraint "wallets_debit_idempotency_uq".*does not exist/i.test(conflictErr.message),
    conflictErr ? conflictErr.message.slice(0, 70) : 'no error');

  // --- FIN-07 (no funds check): the ON CONFLICT bug masks it; add a real
  //     UNIQUE CONSTRAINT with the same name so the original debit can run,
  //     then prove the balance can go negative.
  await db.exec(`DROP INDEX wallets_debit_idempotency_uq;`);
  await db.exec(`ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallets_debit_idempotency_uq UNIQUE (wallet_id, reference);`);
  await db.exec(`DELETE FROM public.wallet_transactions WHERE reference = 'deb-key-neg';`);
  let negErr = null;
  try {
    await q(db, `SELECT * FROM public.debit_sms_wallet('wallet_text_2', 500, 'deb-key-neg', 'tenant_t', 'neg test')`);
  } catch (e) { negErr = e; }
  const wNegBal = await scalar(db, `SELECT balance FROM public.wallets WHERE id = 'wallet_text_2'`);
  record('B6d FIN-07: SMS wallet debited below zero (no funds check)',
    !negErr && parseFloat(wNegBal) === -400, `wallet=${wNegBal} err=${negErr ? negErr.message.slice(0,40) : 'none'}`);

  // restore uuid-id wallet tables + original RPCs for the remaining checks
  await db.exec(`
    DROP TABLE public.wallet_transactions CASCADE;
    DROP TABLE public.wallets CASCADE;
    CREATE TABLE public.wallets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, balance NUMERIC(20,2) DEFAULT 0, sms_rate NUMERIC(10,2) DEFAULT 50, currency TEXT DEFAULT 'UGX', updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE public.wallet_transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), wallet_id UUID NOT NULL REFERENCES public.wallets(id), tenant_id UUID, direction TEXT NOT NULL, amount NUMERIC(20,2) NOT NULL, currency TEXT DEFAULT 'UGX', note TEXT, status TEXT, reference TEXT, description TEXT, type TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX wallets_debit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'debit';
    CREATE UNIQUE INDEX wallets_credit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'credit';
  `);
  await db.exec(read(join(MIG, '09_credit_sms_wallet_rpc.sql')));
  await db.exec(read(join(MIG, '10_debit_sms_wallet_rpc.sql')));
  await db.exec(read(join(MIG, '18_credit_sms_idempotent.sql')));

  // --- FIN-04: withdrawal posts an UNBALANCED journal entry
  await seedFixtures(db);
  const wd = await one(db, `SELECT kunity.member_withdraw_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}', 10000) AS r`);
  const wdEntry = await one(db, `SELECT id FROM kunity.journal_entries ORDER BY created_at DESC LIMIT 1`);
  const wdBalanced = wdEntry ? await entryBalanced(db, wdEntry.id) : false;
  const wdFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  record('B7 FIN-04: withdrawal journal unbalanced + float never decremented',
    wd.r?.success === true && !wdBalanced && parseFloat(wdFloat) === 100000,
    `balanced=${wdBalanced} float=${wdFloat}`);

  // --- FIN-04b: disbursement single-line + wrong direction + float untouched
  await seedFixtures(db);
  const db1 = await one(db, `SELECT kunity.disburse_loan_atomic('${LOAN_1}','${ORG}','${M_ACTIVE}', 100000) AS r`);
  const dbEntry = await one(db, `SELECT id FROM kunity.journal_entries ORDER BY created_at DESC LIMIT 1`);
  const dbBalanced = dbEntry ? await entryBalanced(db, dbEntry.id) : false;
  const dbFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  record('B8 FIN-04: disbursement journal unbalanced + float never decremented',
    db1.r?.success === true && !dbBalanced && parseFloat(dbFloat) === 100000,
    `balanced=${dbBalanced} float=${dbFloat}`);

  // --- FIN-13: idempotent credit doesn't check transaction ownership
  await seedFixtures(db);
  let creditErr = null;
  try {
    await q(db, `SELECT * FROM public.credit_sms_wallet_idempotent('${W_A}', '${TX_B}', 5000)`);
  } catch (e) { creditErr = e; }
  const wABal2 = await scalar(db, `SELECT balance FROM public.wallets WHERE id = '${W_A}'`);
  record('B9 FIN-13: wallet A credited from wallet B\'s transaction (no ownership check)',
    !creditErr && parseFloat(wABal2) === 5100, `walletA=${wABal2} (was 100)`);

  // --- FIN-08: frozen account & suspended member can withdraw
  await seedFixtures(db);
  let frozenErr = null;
  try { await q(db, `SELECT kunity.member_withdraw_atomic('${M_FROZEN}','${ORG}','${ACC_FROZ}', 10000)`); }
  catch (e) { frozenErr = e; }
  let suspErr = null;
  try { await q(db, `SELECT kunity.member_withdraw_atomic('${M_SUSP}','${ORG}','${ACC_SUSP}', 10000)`); }
  catch (e) { suspErr = e; }
  record('B10 FIN-08: frozen account & suspended member withdrawals allowed',
    !frozenErr && !suspErr, `frozenErr=${!!frozenErr} suspendedErr=${!!suspErr}`);

  // --- FIN-06: the app refund call signature (demonstrated at SQL level)
  let refundSigErr = null;
  try {
    await q(db, `SELECT * FROM public.credit_sms_wallet('${W_B}', 100, 'refund-key')`);
  } catch (e) { refundSigErr = e; }
  record('B11 FIN-06: app refund call (credit_sms_wallet + 3rd param) cannot resolve',
    !!refundSigErr && /function.*does not exist/i.test(refundSigErr.message),
    refundSigErr ? refundSigErr.message.slice(0, 70) : 'no error');
}

// ===========================================================================
async function phase2_fixes(db) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('PHASE 2 — Apply 21_financial_integrity.sql, verify fixes');
  console.log('══════════════════════════════════════════════════════');

  // Drop the manually created loan_repayments so the fix migration creates it
  await db.exec(`DROP TABLE IF EXISTS kunity.loan_repayments CASCADE;`);
  await db.exec(read(join(MIG, '21_financial_integrity.sql')));

  const tableExists = await scalar(db, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='kunity' AND table_name='loan_repayments'`);
  record('F0 FIN-01b: fix migration creates loan_repayments', String(tableExists) === '1', `exists=${tableExists}`);

  // --- F1: repayment now works, is balanced, and completes loans
  //     (FIN-26: only DISBURSED loans are repayable — pending loans rejected)
  await seedFixtures(db);
  let pendingErr = null;
  try { await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 60000)`); }
  catch (e) { pendingErr = e; }
  record('F1a FIN-26: repayment rejected on a PENDING (not yet disbursed) loan',
    !!pendingErr && /not in a repayable state/i.test(pendingErr.message),
    pendingErr ? pendingErr.message.slice(0, 50) : 'no error');

  await seedFixtures(db);
  await q(db, `SELECT kunity.disburse_loan_atomic('${LOAN_1}','${ORG}','${M_ACTIVE}', 100000)`);
  const r1 = await one(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 60000) AS r`);
  const bal1 = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const e1 = await one(db, `SELECT id FROM kunity.journal_entries ORDER BY created_at DESC LIMIT 1`);
  const paid1 = await scalar(db, `SELECT COALESCE(SUM(principal_paid),0) FROM kunity.loan_repayments WHERE loan_id='${LOAN_1}'`);
  let overErr = null;
  try { await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 60000)`); }
  catch (e) { overErr = e; }
  const r2 = await one(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 50000) AS r`);
  const loanStatus = await scalar(db, `SELECT status FROM kunity.loans WHERE id='${LOAN_1}'`);
  let completedErr = null;
  try { await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 1000)`); }
  catch (e) { completedErr = e; }
  record('F1b FIN-01: repayment works end-to-end, balanced, completes loan',
    r1.r?.success === true && r2.r?.success === true &&
    parseFloat(bal1) === 240000 &&
    await entryBalanced(db, e1.id) &&
    parseFloat(paid1) === 60000 &&
    loanStatus === 'completed' &&
    !!overErr && /exceeds remaining/i.test(overErr.message) &&
    !!completedErr && /not in a repayable state/i.test(completedErr.message),
    `balAfter1st=${bal1} loan=${loanStatus} overpayErr=${!!overErr} completedErr=${!!completedErr}`);

  // --- F2: amount drift rejected (fail closed), correct amount credited, idempotent
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fix-drift', 'deposit', 50000);
  const driftRej = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-drift','success',5000000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const driftStatus = await scalar(db, `SELECT status::text FROM kunity.payment_requests WHERE internal_reference='ref-fix-drift'`);
  const driftJournals = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_entries`);
  const driftBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F2a FIN-02: amount drift REJECTED, stays pending, nothing recorded',
    driftRej.r?.success === false && /amount mismatch/i.test(driftRej.r?.error || '') &&
    driftStatus === 'pending' && String(driftJournals) === '0' && parseFloat(driftBal) === 200000,
    `status=${driftStatus} journals=${driftJournals} bal=${driftBal}`);

  const ok = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-drift','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const okBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const okFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const okEntry = await one(db, `SELECT journal_entry_id FROM kunity.payment_requests WHERE internal_reference='ref-fix-drift'`);
  const replay = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-drift','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const replayBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F2b FIN-02: exact amount credited (member net, float gross), balanced, replay idempotent',
    /Success recorded/i.test(ok.r?.message || '') &&
    parseFloat(okBal) === 250000 &&
    parseFloat(okFloat) === 150000 &&
    await entryBalanced(db, okEntry.journal_entry_id) &&
    /Already processed/i.test(replay.r?.message || '') &&
    parseFloat(replayBal) === 250000,
    `bal=${okBal} float=${okFloat} replay=${replay.r?.message}`);

  // --- F2c: fee handling — member credited net, fee line posted, balanced
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fee', 'deposit', 50000);
  const feeRes = await one(db, `SELECT kunity.process_najiki_webhook('ref-fee','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 500) AS r`);
  const feeBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const feeEntry = await one(db, `SELECT journal_entry_id FROM kunity.payment_requests WHERE internal_reference='ref-fee'`);
  const feeLines = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_lines WHERE journal_entry_id='${feeEntry.journal_entry_id}'`);
  record('F2c FIN-11: fee posted as balanced third line; member credited net',
    feeRes.r?.net_amount == 49500 && parseFloat(feeBal) === 249500 && String(feeLines) === '3' &&
    await entryBalanced(db, feeEntry.journal_entry_id),
    `net=${feeRes.r?.net_amount} bal=${feeBal} lines=${feeLines}`);

  // --- F3: activation now posts the ledger AND activates
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fix-act', 'account_activation', 5000, M_FROZEN);
  const actRes = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-act','success',5000,'${M_FROZEN}','account_activation','{}'::jsonb, 0) AS r`);
  const actBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_FROZ}'`);
  const actActive = await scalar(db, `SELECT is_active FROM kunity.accounts WHERE id='${ACC_FROZ}'`);
  const msStatus = await scalar(db, `SELECT status FROM kunity.member_savings WHERE member_id='${M_FROZEN}'`);
  const actFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const actEntry = await one(db, `SELECT journal_entry_id FROM kunity.payment_requests WHERE internal_reference='ref-fix-act'`);
  record('F3 FIN-03: activation payment recorded (ledger + balances) AND account activated',
    /Success recorded/i.test(actRes.r?.message || '') &&
    parseFloat(actBal) === 205000 && actActive === true && msStatus === 'active' &&
    parseFloat(actFloat) === 105000 &&
    await entryBalanced(db, actEntry.journal_entry_id),
    `bal=${actBal} active=${actActive} savings=${msStatus} float=${actFloat}`);

  // --- F4: intermediate status no longer poisons
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fix-int', 'deposit', 50000);
  const intRes = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-int','pending',NULL,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const intStatus = await scalar(db, `SELECT status::text FROM kunity.payment_requests WHERE internal_reference='ref-fix-int'`);
  const finRes = await one(db, `SELECT kunity.process_najiki_webhook('ref-fix-int','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const finBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F4 FIN-10: intermediate status kept pending; final success credited',
    /Intermediate/i.test(intRes.r?.message || '') && intStatus === 'pending' &&
    /Success recorded/i.test(finRes.r?.message || '') && parseFloat(finBal) === 250000,
    `afterPending=${intStatus} finalBal=${finBal}`);

  // --- F5: LivePay deposits credit the member + drift rejected
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fix-lp', 'deposit', 50000);
  const lpDrift = await one(db, `SELECT kunity.process_livepay_webhook('ref-fix-lp','success',999999,0,'UGX','{}'::jsonb) AS r`);
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-fix-lp2', 'deposit', 50000);
  const lpOk = await one(db, `SELECT kunity.process_livepay_webhook('ref-fix-lp2','success',50000,0,'UGX','{}'::jsonb) AS r`);
  const lpBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const lpFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const lpEntry = await one(db, `SELECT journal_entry_id FROM kunity.payment_requests WHERE internal_reference='ref-fix-lp2'`);
  record('F5 FIN-05/02: LivePay credits member balance, float updated, drift rejected',
    lpDrift.r?.success === false && /amount mismatch/i.test(lpDrift.r?.error || '') &&
    /Success recorded/i.test(lpOk.r?.message || '') &&
    parseFloat(lpBal) === 250000 && parseFloat(lpFloat) === 150000 &&
    await entryBalanced(db, lpEntry.journal_entry_id),
    `driftRejected=${lpDrift.r?.success === false} bal=${lpBal} float=${lpFloat}`);

  // --- F6: SMS wallet debit cannot go negative; idempotent
  await seedFixtures(db);
  let insufficient = null;
  try { await q(db, `SELECT * FROM public.debit_sms_wallet('${W_A}', 500, 'k1', 't1')`); }
  catch (e) { insufficient = e; }
  const d1 = await one(db, `SELECT * FROM public.debit_sms_wallet('${W_A}', 50, 'k2', 't1')`);
  await q(db, `SELECT * FROM public.debit_sms_wallet('${W_A}', 50, 'k2', 't1')`); // replay
  const wABal = await scalar(db, `SELECT balance FROM public.wallets WHERE id='${W_A}'`);
  record('F6 FIN-07: debit fails on insufficient funds; idempotent replay does not double-debit',
    !!insufficient && /Insufficient/i.test(insufficient.message) &&
    parseFloat(wABal) === 50,
    `walletA=${wABal}`);

  // --- F7: withdrawals — balanced, float decremented, eligibility enforced
  await seedFixtures(db);
  const wd = await one(db, `SELECT kunity.member_withdraw_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}', 10000) AS r`);
  const wdEntry = await one(db, `SELECT id FROM kunity.journal_entries ORDER BY created_at DESC LIMIT 1`);
  const wdFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const wdBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  let frozenErr = null;
  try { await q(db, `SELECT kunity.member_withdraw_atomic('${M_FROZEN}','${ORG}','${ACC_FROZ}', 10000)`); }
  catch (e) { frozenErr = e; }
  let suspErr = null;
  try { await q(db, `SELECT kunity.member_withdraw_atomic('${M_SUSP}','${ORG}','${ACC_SUSP}', 10000)`); }
  catch (e) { suspErr = e; }
  let negErr = null;
  try { await q(db, `SELECT kunity.member_withdraw_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}', 0)`); }
  catch (e) { negErr = e; }
  record('F7 FIN-04/08: withdrawal balanced + float down + frozen/suspended/zero rejected',
    wd.r?.success === true && await entryBalanced(db, wdEntry.id) &&
    parseFloat(wdFloat) === 90000 && parseFloat(wdBal) === 190000 &&
    !!frozenErr && !!suspErr && !!negErr,
    `float=${wdFloat} bal=${wdBal} frozen=${!!frozenErr} susp=${!!suspErr} zero=${!!negErr}`);

  // --- F8: disbursement = internal transfer (FIN-20): balanced journal via
  //     loan receivable, member credited, float UNTOUCHED, NO cash-account line
  await seedFixtures(db);
  const disb = await one(db, `SELECT kunity.disburse_loan_atomic('${LOAN_1}','${ORG}','${M_ACTIVE}', 100000) AS r`);
  const disbEntry = await one(db, `SELECT id FROM kunity.journal_entries ORDER BY created_at DESC LIMIT 1`);
  const disbFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const disbBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const disbLoan = await scalar(db, `SELECT status FROM kunity.loans WHERE id='${LOAN_1}'`);
  const cashLines = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_lines WHERE journal_entry_id='${disbEntry.id}' AND account_id='${ACC_CASH}'`);
  const recvLines = await one(db, `SELECT COALESCE(SUM(debit),0) AS d FROM kunity.journal_lines WHERE journal_entry_id='${disbEntry.id}' AND line_type='loan_disbursement' AND member_id IS NULL`);
  record('F8 FIN-20: disbursement internal — receivable debited, float & cash UNTOUCHED, member credited',
    disb.r?.success === true && await entryBalanced(db, disbEntry.id) &&
    parseFloat(disbFloat) === 100000 && parseFloat(disbBal) === 300000 &&
    disbLoan === 'approved' && String(cashLines) === '0' && parseFloat(recvLines.d) === 100000,
    `float=${disbFloat} bal=${disbBal} loan=${disbLoan} cashLines=${cashLines} recvDebit=${recvLines.d}`);

  // --- F14: FULL LIFECYCLE invariant — float == external cash only.
  //     deposit 150k in -> disburse 100k loan (internal) -> withdraw 100k out
  //     -> repay 110k (internal). Float must equal deposits - withdrawals
  //     exactly (no double-drain), and the journal's cash-account net must
  //     equal the float.
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-life', 'deposit', 150000);
  await q(db, `SELECT kunity.process_najiki_webhook('ref-life','success',150000,'${M_ACTIVE}','deposit','{}'::jsonb, 0)`);
  await q(db, `SELECT kunity.disburse_loan_atomic('${LOAN_1}','${ORG}','${M_ACTIVE}', 100000)`);
  await q(db, `SELECT kunity.member_withdraw_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}', 100000)`);
  await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 110000)`);
  const lifeFloat = await scalar(db, `SELECT balance FROM kunity.sacco_wallets WHERE organization_id='${ORG}'`);
  const lifeBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  // cash journal net (debits - credits) + seeded opening float (100000) == float
  const lifeCashNet = await scalar(db, `SELECT COALESCE(SUM(debit - credit),0) FROM kunity.journal_lines WHERE account_id='${ACC_CASH}'`);
  const lifeRecvNet = await one(db, `SELECT COALESCE(SUM(debit - credit),0) AS n FROM kunity.journal_lines WHERE member_id IS NULL AND loan_id='${LOAN_1}' AND line_type IN ('loan_disbursement','repayment')`);
  record('F14 FIN-20/21: lifecycle — float == external cash (no double drain); cash journal == float',
    parseFloat(lifeFloat) === 150000 &&
    parseFloat(lifeBal) === 240000 &&
    parseFloat(lifeCashNet) + 100000 === parseFloat(lifeFloat) &&
    parseFloat(lifeRecvNet.n) === 0,
    `float=${lifeFloat} memberBal=${lifeBal} cashNet=${lifeCashNet} recvNet=${lifeRecvNet.n}`);

  // --- F15: repayment journal settles the receivable and recognizes interest
  //     (loan 100k @10% -> repay 60k then 50k: 40k to receivable + 10k interest)
  await seedFixtures(db);
  await q(db, `SELECT kunity.disburse_loan_atomic('${LOAN_1}','${ORG}','${M_ACTIVE}', 100000)`);
  await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 60000)`);
  await q(db, `SELECT kunity.member_repay_loan_atomic('${M_ACTIVE}','${ORG}','${ACC_MAIN}','${LOAN_1}', 50000)`);
  const repayCashLines = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_lines WHERE loan_id='${LOAN_1}' AND account_id='${ACC_CASH}'`);
  const repayInterest = await one(db, `SELECT COALESCE(SUM(credit),0) AS c FROM kunity.journal_lines WHERE loan_id='${LOAN_1}' AND line_type='interest'`);
  const repayRecv = await one(db, `SELECT COALESCE(SUM(credit),0) AS c FROM kunity.journal_lines WHERE loan_id='${LOAN_1}' AND line_type='repayment' AND member_id IS NULL`);
  const split = await one(db, `SELECT COALESCE(SUM(principal_paid),0) AS p, COALESCE(SUM(interest_paid),0) AS i FROM kunity.loan_repayments WHERE loan_id='${LOAN_1}'`);
  record('F15 FIN-21: repayment settles receivable + interest income; NO cash lines',
    String(repayCashLines) === '0' &&
    parseFloat(repayInterest.c) === 10000 &&
    parseFloat(repayRecv.c) === 100000 &&
    parseFloat(split.p) === 100000 && parseFloat(split.i) === 10000,
    `cashLines=${repayCashLines} interest=${repayInterest.c} recvSettled=${repayRecv.c} p/i=${split.p}/${split.i}`);

  // --- F16: FIN-22 — org with ONLY member asset accounts: cash pick must
  //     self-provision a system wallet, NEVER use a member's personal account
  await seedFixtures(db);
  await db.exec(`DELETE FROM kunity.accounts WHERE member_id IS NULL;`);
  await seedPaymentRequest(db, 'ref-noorg', 'deposit', 50000);
  const noorg = await one(db, `SELECT kunity.process_najiki_webhook('ref-noorg','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const sysWallet = await one(db, `SELECT id FROM kunity.accounts WHERE member_id IS NULL AND code='SYS-WALLET-01'`);
  const memberAccUsed = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_lines WHERE account_id IN ('${ACC_MAIN}','${ACC_SUSP}','${ACC_FROZ}') AND line_type='deposit' AND member_id IS NULL`);
  record('F16 FIN-22: org cash NEVER resolves to a member account (self-provisions system wallet)',
    /Success recorded/i.test(noorg.r?.message || '') && !!sysWallet &&
    String(memberAccUsed) === '0',
    `msg=${noorg.r?.message} sysWallet=${!!sysWallet} memberAccUsedAsCash=${memberAccUsed}`);

  // --- F17: FIN-23 — unknown payment type on success is HELD (fail closed)
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-unknown', 'mystery_type', 50000);
  const unknown = await one(db, `SELECT kunity.process_najiki_webhook('ref-unknown','success',50000,'${M_ACTIVE}','mystery_type','{}'::jsonb, 0) AS r`);
  const unknownStatus = await scalar(db, `SELECT status::text FROM kunity.payment_requests WHERE internal_reference='ref-unknown'`);
  const unknownJournals = await scalar(db, `SELECT COUNT(*) FROM kunity.journal_entries`);
  const unknownBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F17 FIN-23: unknown paymentType HELD (stays pending, nothing recorded, member not credited)',
    unknown.r?.success === false && /Unrecognized payment type/i.test(unknown.r?.error || '') &&
    unknownStatus === 'pending' && String(unknownJournals) === '0' && parseFloat(unknownBal) === 200000,
    `status=${unknownStatus} journals=${unknownJournals} bal=${unknownBal}`);

  // --- F18: FIN-24 — currency mismatch rejected, matching currency accepted
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-cur', 'deposit', 50000);
  const curRej = await one(db, `SELECT kunity.process_najiki_webhook('ref-cur','success',50000,'${M_ACTIVE}','deposit','{"currency":"KES"}'::jsonb, 0) AS r`);
  const curStatus = await scalar(db, `SELECT status::text FROM kunity.payment_requests WHERE internal_reference='ref-cur'`);
  const curBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const curOk = await one(db, `SELECT kunity.process_najiki_webhook('ref-cur','success',50000,'${M_ACTIVE}','deposit','{"currency":"UGX"}'::jsonb, 0) AS r`);
  const curOkBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F18 FIN-24: currency mismatch rejected (stays pending); matching currency credits',
    curRej.r?.success === false && /Currency mismatch/i.test(curRej.r?.error || '') &&
    curStatus === 'pending' && parseFloat(curBal) === 200000 &&
    /Success recorded/i.test(curOk.r?.message || '') && parseFloat(curOkBal) === 250000,
    `mismatchRejected=${curRej.r?.success === false} status=${curStatus} finalBal=${curOkBal}`);

  // --- F9: cross-wallet credit refused
  await seedFixtures(db);
  let crossErr = null;
  try { await q(db, `SELECT * FROM public.credit_sms_wallet_idempotent('${W_A}', '${TX_B}', 5000)`); }
  catch (e) { crossErr = e; }
  const wABal3 = await scalar(db, `SELECT balance FROM public.wallets WHERE id='${W_A}'`);
  record('F9 FIN-13: crediting wallet A from wallet B\'s transaction refused',
    !!crossErr && /does not belong/i.test(crossErr.message) && parseFloat(wABal3) === 100,
    `err=${!!crossErr} walletA=${wABal3}`);

  // --- F10: refund RPC idempotent
  await seedFixtures(db);
  const ref1 = await one(db, `SELECT * FROM public.refund_sms_wallet('${W_B}', 100, 'refund-test-1')`);
  await q(db, `SELECT * FROM public.refund_sms_wallet('${W_B}', 100, 'refund-test-1')`);
  const wBBal = await scalar(db, `SELECT balance FROM public.wallets WHERE id='${W_B}'`);
  const refTx = await scalar(db, `SELECT COUNT(*) FROM public.wallet_transactions WHERE reference='refund-test-1' AND direction='credit'`);
  record('F10 FIN-06: refund RPC credits once (idempotent), ledger recorded',
    parseFloat(ref1.balance) === 5100 && parseFloat(wBBal) === 5100 && String(refTx) === '1',
    `walletB=${wBBal} refundTxs=${refTx}`);

  // --- F11: suspended member cannot apply for a loan
  await seedFixtures(db);
  let loanErr = null;
  try { await q(db, `SELECT kunity.member_apply_loan('${M_SUSP}','${ORG}', 50000)`); }
  catch (e) { loanErr = e; }
  let okLoan = null;
  try { okLoan = await one(db, `SELECT kunity.member_apply_loan('${M_ACTIVE}','${ORG}', 50000) AS r`); } catch { }
  record('F11 FIN-08: suspended member cannot apply for a loan; active member can',
    !!loanErr && /not active/i.test(loanErr.message) && okLoan?.r?.success === true,
    `suspErr=${!!loanErr} activeOk=${okLoan?.r?.success === true}`);

  // --- F12: FIN-17 — fixed webhook functions work with a TEXT status column too
  await db.exec(`ALTER TABLE kunity.payment_requests ALTER COLUMN status TYPE TEXT;`);
  await db.exec(read(join(MIG, '21_financial_integrity.sql'))); // re-resolve %TYPE against text
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-text', 'deposit', 50000);
  const textRes = await one(db, `SELECT kunity.process_najiki_webhook('ref-text','success',50000,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  const textBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  const textStatus = await scalar(db, `SELECT status FROM kunity.payment_requests WHERE internal_reference='ref-text'`);
  const textDrift = await one(db, `SELECT kunity.process_najiki_webhook('ref-text','success',999999,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-text-drift', 'deposit', 50000);
  const textDrift2 = await one(db, `SELECT kunity.process_najiki_webhook('ref-text-drift','success',999999,'${M_ACTIVE}','deposit','{}'::jsonb, 0) AS r`);
  await seedFixtures(db);
  await seedPaymentRequest(db, 'ref-text-lp', 'deposit', 50000);
  const textLp = await one(db, `SELECT kunity.process_livepay_webhook('ref-text-lp','success',50000,0,'UGX','{}'::jsonb) AS r`);
  const textLpBal = await scalar(db, `SELECT cached_balance FROM kunity.accounts WHERE id='${ACC_MAIN}'`);
  record('F12 FIN-17: fixed webhooks work on enum AND text status columns (no 42804)',
    /Success recorded/i.test(textRes.r?.message || '') && parseFloat(textBal) === 250000 &&
    textStatus === 'success' &&
    (textDrift.r?.success === false || textDrift2.r?.success === false) &&
    /Success recorded/i.test(textLp.r?.message || '') && parseFloat(textLpBal) === 250000,
    `najiki=${textRes.r?.message} status=${textStatus} lpBal=${textLpBal}`);

  // --- F13: FIN-18/19 — fixed wallet RPCs work on BOTH uuid-id and text-id tables
  await db.exec(`
    DROP TABLE public.wallet_transactions CASCADE;
    DROP TABLE public.wallets CASCADE;
    CREATE TABLE public.wallets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, balance NUMERIC(20,2) DEFAULT 0, sms_rate NUMERIC(10,2) DEFAULT 50, currency TEXT DEFAULT 'UGX', updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE public.wallet_transactions (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, wallet_id TEXT NOT NULL, tenant_id TEXT, direction TEXT NOT NULL, amount NUMERIC(20,2) NOT NULL, currency TEXT DEFAULT 'UGX', note TEXT, status TEXT, reference TEXT, description TEXT, type TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE UNIQUE INDEX wallets_debit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'debit';
    CREATE UNIQUE INDEX wallets_credit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'credit';
  `);
  await db.exec(read(join(MIG, '21_financial_integrity.sql'))); // re-resolve %ROWTYPE for text tables
  await db.exec(`
    INSERT INTO public.wallets (id, tenant_id, balance) VALUES ('w_txt_1', 'tenant_t', 5000);
    INSERT INTO public.wallet_transactions (id, wallet_id, tenant_id, direction, amount, note, reference)
      VALUES ('tx_txt_1', 'w_txt_1', 'tenant_t', 'credit', 2000, 'pending', 'ref-txt-1');
    INSERT INTO public.wallets (id, tenant_id, balance) VALUES ('w_txt_2', 'tenant_t', 100);
  `);
  const txtDebit = await one(db, `SELECT * FROM public.debit_sms_wallet('w_txt_1', 100, 'deb-txt-1', 'tenant_t')`);
  await q(db, `SELECT * FROM public.debit_sms_wallet('w_txt_1', 100, 'deb-txt-1', 'tenant_t')`); // replay
  let txtInsufficient = null;
  try { await q(db, `SELECT * FROM public.debit_sms_wallet('w_txt_2', 500, 'deb-txt-2', 'tenant_t')`); }
  catch (e) { txtInsufficient = e; }
  const txtCredit = await one(db, `SELECT * FROM public.credit_sms_wallet_idempotent('w_txt_1', 'tx_txt_1', 2000)`);
  const txtRefund = await one(db, `SELECT * FROM public.refund_sms_wallet('w_txt_1', 50, 'ref-txt-refund')`);
  await q(db, `SELECT * FROM public.refund_sms_wallet('w_txt_1', 50, 'ref-txt-refund')`); // replay
  const w1 = await scalar(db, `SELECT balance FROM public.wallets WHERE id='w_txt_1'`);
  record('F13 FIN-18/19: fixed wallet RPCs run on TEXT-id wallets (debit/credit/refund, idempotent, funds-checked)',
    parseFloat(txtDebit.balance) === 4900 && parseFloat(w1) === 6950 &&
    !!txtInsufficient && /Insufficient/i.test(txtInsufficient.message) &&
    parseFloat(txtCredit.balance) === 6900 &&
    parseFloat(txtRefund.balance) === 6950,
    `afterDebit=${txtDebit.balance} afterCredit=${txtCredit.balance} final=${w1} insuffErr=${!!txtInsufficient}`);
}

// ===========================================================================
(async () => {
  console.log('Starting real-PostgreSQL financial verification (PGlite / PG 17)...');
  const db = new PGlite();
  await db.exec(read(join(ROOT, 'test', 'financial-base-schema.sql')));

  await phase1_bugs(db);
  await phase2_fixes(db);

  const failed = results.filter(r => !r.pass);
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`RESULTS: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILURES:');
    failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
  console.log('ALL FINANCIAL CHECKS PASSED — original bugs reproduced, all fixes verified.');
  await db.close().catch(() => {});
})();
