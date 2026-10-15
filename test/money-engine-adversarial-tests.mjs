/**
 * Adversarial regression tests for the money-engine hardening migration.
 * Former exploit inputs must now be refused with no wallet/ledger mutation.
 * Run: node test/money-engine-adversarial-tests.mjs
 * No external services or real money are used.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ORG = '11111111-0000-0000-0000-00000000000a';
const ORG_OTHER = '11111111-0000-0000-0000-00000000000b';
const M = '22222222-0000-0000-0000-0000000000e1';
const ACC = '44444444-0000-0000-0000-0000000000e1';
const CASH = '44444444-0000-0000-0000-0000000000c1';
const FEE = '44444444-0000-0000-0000-0000000000f1';
const TENANT_A = '33333333-0000-0000-0000-00000000000a';
const TENANT_B = '33333333-0000-0000-0000-00000000000b';
const WALLET_A = '55555555-0000-0000-0000-00000000000a';
const WALLET_B = '55555555-0000-0000-0000-00000000000b';

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ FAIL  ${name} — ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
  }
};
const one = async (db, sql) => (await db.query(sql)).rows[0];
const balance = async (db, wallet) => Number((await one(db, `SELECT balance FROM public.wallets WHERE id='${wallet}'`)).balance);
const txCount = async (db, ref) => Number((await one(db, `SELECT COUNT(*)::int c FROM public.wallet_transactions WHERE reference='${ref}'`)).c);
/** Runs a statement expected to be refused. Resolves with the error text, rejects if it succeeded. */
const refused = async (db, sql, params = []) => {
  try {
    await db.query(sql, params);
  } catch (e) {
    return String(e.message);
  }
  throw new Error('statement succeeded but must be refused');
};

async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
  await db.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END $$;`);
  await db.exec(read('test/financial-base-schema.sql'));
  await db.exec(`
    INSERT INTO kunity.organizations (id,name,code) VALUES ('${ORG}','Sacco A','SA'), ('${ORG_OTHER}','Sacco B','SB');
    INSERT INTO kunity.members (id,organization_id,status) VALUES ('${M}','${ORG}','active');
    INSERT INTO kunity.accounts (id,organization_id,member_id,name,code,account_category,is_active,is_system) VALUES
      ('${ACC}','${ORG}','${M}','Member Savings','SAV-E1','liability',true,false),
      ('${CASH}','${ORG}',NULL,'Main Cash','CASH-MAIN','asset',true,true),
      ('${FEE}','${ORG}',NULL,'Gateway Fee Income','FEE-GW','income',true,true);
    INSERT INTO public.wallets (id, tenant_id, balance) VALUES ('${WALLET_A}','${TENANT_A}', 1000), ('${WALLET_B}','${TENANT_B}', 1000);
  `);
  // Live wallet ids are text (the live debit_sms_wallet compares wallets.id = p_wallet_id as text).
  await db.exec(`ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_wallet_id_fkey; ALTER TABLE public.wallet_transactions ALTER COLUMN wallet_id TYPE text USING wallet_id::text; ALTER TABLE public.wallets ALTER COLUMN id TYPE text USING id::text; ALTER TABLE public.wallets ALTER COLUMN tenant_id TYPE text USING tenant_id::text; ALTER TABLE public.wallet_transactions ALTER COLUMN tenant_id TYPE text USING tenant_id::text;`);
  // The live debit function uses ON CONFLICT (wallet_id, reference) WHERE ... direction = 'debit'.
  // That needs this partial unique index (the same one financial-tests.mjs creates).
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS wallets_debit_idempotency_uq ON public.wallet_transactions(wallet_id, reference) WHERE reference IS NOT NULL AND direction = 'debit';`);
  for (const m of ['21_financial_integrity.sql', '25_activation_fee_is_membership.sql', '27_atomic_payment_rpc.sql', '32_sms_idempotency_keys.sql', '34_debit_sms_wallet_tenant_match.sql', '35_debit_sms_wallet_replay_safe.sql', '36_money_engine_hardening.sql']) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
  return db;
}


const db = await setup();
const assertSafe = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS: ${name}`); }
  catch (e) { failed++; console.error(`FAIL: ${name}: ${e.message}`); }
};
const insertTx = async (id, direction, amount, ref, type = 'sms_topup') => db.query(
  `INSERT INTO public.wallet_transactions (id,wallet_id,tenant_id,direction,amount,reference,note,type)
   VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
  [id,WALLET_A,TENANT_A,direction,amount,ref,type]);

await assertSafe('credit amount drift is rejected without changing wallet or transaction', async () => {
  const id = '66666666-0000-0000-0000-000000000001';
  await insertTx(id, 'credit', 10, 'probe-drift');
  const before = await balance(db, WALLET_A);
  const error = await refused(db, `SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,10000)`, [WALLET_A, id]);
  assert.match(error, /amount/i);
  assert.equal(await balance(db, WALLET_A), before);
  assert.equal((await one(db, `SELECT note FROM public.wallet_transactions WHERE id='${id}'`)).note, 'pending');
});
await assertSafe('debit transaction cannot be credited as a top-up', async () => {
  const id = '66666666-0000-0000-0000-000000000002';
  await insertTx(id, 'debit', 50, 'probe-direction');
  const before = await balance(db, WALLET_A);
  await refused(db, `SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,50)`, [WALLET_A, id]);
  assert.equal(await balance(db, WALLET_A), before);
});
await assertSafe('refund without a matching debit is rejected', async () => {
  const before = await balance(db, WALLET_A);
  await refused(db, `SELECT * FROM public.refund_sms_wallet($1,777,'refund_nonexistent_debit')`, [WALLET_A]);
  assert.equal(await balance(db, WALLET_A), before);
});
await assertSafe('nested USD currency mismatching a stored UGX intent stays pending', async () => {
  await db.query(`INSERT INTO kunity.payment_requests (organization_id,member_id,amount,currency,status,payment_type,internal_reference)
    VALUES ($1,$2,5000,'UGX','pending','deposit','probe-nested-currency')`, [ORG, M]);
  const result = await one(db, `SELECT kunity.process_najiki_webhook('probe-nested-currency','success',5000,NULL,'deposit','{"data":{"currency":"USD"}}'::jsonb,0) AS r`);
  assert.equal(result.r.success, false);
  assert.equal((await one(db, `SELECT status::text s FROM kunity.payment_requests WHERE internal_reference='probe-nested-currency'`)).s, 'pending');
  assert.equal(Number((await one(db, `SELECT COUNT(*)::int c FROM kunity.journal_entries WHERE reference='probe-nested-currency'`)).c), 0);
});
await assertSafe('NaN refund is rejected without poisoning the wallet balance', async () => {
  const before = await balance(db, WALLET_B);
  const error = await refused(db, `SELECT * FROM public.refund_sms_wallet($1,'NaN'::numeric,'refund_probe_nan')`, [WALLET_B]);
  assert.match(error, /finite/i);
  assert.equal(await balance(db, WALLET_B), before);
});
await assertSafe('refund is bound to one debit, amount-checked, and idempotent', async () => {
  const id = '66666666-0000-0000-0000-000000000003';
  await insertTx(id, 'debit', 123, 'debit-refund-once', 'sms_debit');
  const before = await balance(db, WALLET_A);
  const error = await refused(db, `SELECT * FROM public.refund_sms_wallet($1,124,'refund_debit-refund-once','debit-refund-once')`, [WALLET_A]);
  assert.match(error, /amount/i);
  await db.query(`SELECT * FROM public.refund_sms_wallet($1,123,'refund_debit-refund-once','debit-refund-once')`, [WALLET_A]);
  await db.query(`SELECT * FROM public.refund_sms_wallet($1,123,'refund_debit-refund-once','debit-refund-once')`, [WALLET_A]);
  assert.equal(await balance(db, WALLET_A), before + 123);
  await refused(db, `SELECT * FROM public.refund_sms_wallet($1,123,'refund-another-key','debit-refund-once')`, [WALLET_A]);
  assert.equal(await balance(db, WALLET_A), before + 123);
});

await db.close();
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
