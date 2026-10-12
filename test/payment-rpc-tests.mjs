/**
 * Migration 27: atomic process_najiki_webhook. Verified against the stored request,
 * activation posts a balanced ledger entry, deposits post balanced entries, holds
 * unknown/mismatched payments. Runs with the enum AND the text status column.
 * Run: node test/payment-rpc-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORG = '11111111-0000-0000-0000-00000000000a';
const M = '22222222-0000-0000-0000-0000000000e1';
const ACC = '44444444-0000-0000-0000-0000000000e1';
const CASH = '44444444-0000-0000-0000-0000000000c1';
const FEE = '44444444-0000-0000-0000-0000000000f1';
const results = [];
const record = (name, pass, detail = '') => { results.push(pass); console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

async function setup(textStatus) {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
  await db.exec(read('test/financial-base-schema.sql'));
  if (textStatus) await db.exec(`ALTER TABLE kunity.payment_requests ALTER COLUMN status TYPE text USING status::text`);
  await db.exec(read('supabase/migrations/25_activation_fee_is_membership.sql'));
  await db.exec(`
    INSERT INTO kunity.organizations (id,name,code) VALUES ('${ORG}','Sacco','S');
    INSERT INTO kunity.members (id,organization_id,status) VALUES ('${M}','${ORG}','pending');
    INSERT INTO kunity.accounts (id,organization_id,member_id,name,code,account_category,is_active,is_system) VALUES
      ('${ACC}','${ORG}','${M}','Member Savings','SAV-E1','liability',false,false),
      ('${CASH}','${ORG}',NULL,'Main Cash','CASH-MAIN','asset',true,true),
      ('${FEE}','${ORG}',NULL,'Gateway Fee Income','FEE-GW','income',true,true);
    INSERT INTO kunity.member_savings (organization_id,member_id,account_id,status) VALUES ('${ORG}','${M}','${ACC}','frozen');
  `);
  await db.exec(read('supabase/migrations/27_atomic_payment_rpc.sql')); // includes ACT_FEE backfill
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];
const intent = (db, ref, type, amount, currency = 'UGX') => db.exec(`INSERT INTO kunity.payment_requests (organization_id,member_id,amount,currency,status,payment_type,internal_reference) VALUES ('${ORG}','${M}',${amount},'${currency}','pending',${type===null?'NULL':`'${type}'`},'${ref}')`);
const call = async (db, { ref, status = 'success', amount, type = null, fee = 0, currency = null }) => {
  const payload = currency ? `'{"currency":"${currency}"}'::jsonb` : `'{}'::jsonb`;
  const t = type === null ? 'NULL' : `'${type}'`;
  try {
    return (await db.query(`SELECT kunity.process_najiki_webhook('${ref}','${status}',${amount},NULL,${t},${payload},${fee}) AS r`)).rows[0].r;
  } catch (e) { return { raised: e.message }; }
};
const status = async (db, ref) => (await one(db, `SELECT status::text s FROM kunity.payment_requests WHERE internal_reference='${ref}'`)).s;

async function suite(textStatus) {
  const label = textStatus ? 'text status column' : 'enum status column';
  console.log(`\n== ${label} ==`);
  let db = await setup(textStatus);

  await intent(db, 'ACT-1', 'account_activation', 5000);
  let r = await call(db, { ref: 'ACT-1', amount: 5000, type: 'account_activation' });
  record(`[${label}] activation 5,000 succeeds`, r.message === 'Account activation successful', r.raised || r.message);
  record(`[${label}] activation payment status is success`, (await status(db, 'ACT-1')) === 'success');
  record(`[${label}] activation posts a balanced ledger entry (Dr cash 5,000 / Cr ACT_FEE 5,000)`,
    (await one(db, `SELECT COALESCE(SUM(debit),0)::text d, COALESCE(SUM(credit),0)::text c FROM kunity.journal_lines`)).d === '5000.00' &&
    (await one(db, `SELECT COALESCE(SUM(credit),0)::text c FROM kunity.journal_lines`)).c === '5000.00');
  record(`[${label}] activation credits the fee income account, not the member balance`,
    (await one(db, `SELECT cached_balance::text b FROM kunity.accounts WHERE id='${ACC}'`)).b === '0.00');
  record(`[${label}] activation activates the member's account`, (await one(db, `SELECT is_active FROM kunity.accounts WHERE id='${ACC}'`)).is_active === true);
  record(`[${label}] activation moves membership to active (trigger 25)`, (await one(db, `SELECT status FROM kunity.members`)).status === 'active');

  await intent(db, 'ACT-2', 'account_activation', 1000);
  r = await call(db, { ref: 'ACT-2', amount: 1000, type: 'account_activation' });
  record(`[${label}] underpaid activation (1,000) is refused and stays pending`, r.success === false && (await status(db, 'ACT-2')) === 'pending', r.error || JSON.stringify(r));

  await intent(db, 'AMT-1', 'deposit', 5000);
  r = await call(db, { ref: 'AMT-1', amount: 1, type: 'deposit' });
  record(`[${label}] webhook amount 1 vs intent 5,000 is refused, status stays pending`, r.success === false && (await status(db, 'AMT-1')) === 'pending', r.error || JSON.stringify(r));

  await intent(db, 'CUR-1', 'deposit', 5000);
  r = await call(db, { ref: 'CUR-1', amount: 5000, type: 'deposit', currency: 'USD' });
  record(`[${label}] payload in USD against a UGX intent is refused`, r.success === false && (await status(db, 'CUR-1')) === 'pending', r.error || JSON.stringify(r));

  await intent(db, 'TYP-1', 'deposit', 5000);
  r = await call(db, { ref: 'TYP-1', amount: 5000, type: 'account_activation' });
  record(`[${label}] webhook type differing from the stored type is refused`, r.success === false && (await status(db, 'TYP-1')) === 'pending', r.error || JSON.stringify(r));

  await intent(db, 'UNK-1', 'loan_disbursement_x', 5000);
  r = await call(db, { ref: 'UNK-1', amount: 5000, type: 'loan_disbursement_x' });
  record(`[${label}] unknown payment type is held, never marked success`, r.success === false && (await status(db, 'UNK-1')) === 'pending', r.error || JSON.stringify(r));

  // Member is now active; a deposit posts a balanced entry and credits the member.
  await intent(db, 'DEP-1', 'deposit', 20000);
  r = await call(db, { ref: 'DEP-1', amount: 20000, type: 'deposit' });
  record(`[${label}] deposit 20,000 succeeds`, r.message === 'Success recorded. Journal entries created.', r.raised || r.message);
  record(`[${label}] deposit credits the member account by the net amount`,
    (await one(db, `SELECT cached_balance::text b FROM kunity.accounts WHERE id='${ACC}'`)).b === '20000.00');
  const bal = await one(db, `SELECT COALESCE(SUM(debit),0)::text d, COALESCE(SUM(credit),0)::text c FROM kunity.journal_lines WHERE journal_entry_id = (SELECT journal_entry_id FROM kunity.payment_requests WHERE internal_reference='DEP-1')`);
  record(`[${label}] deposit journal is balanced`, bal.d === bal.c && bal.d === '20000.00', `Dr ${bal.d} Cr ${bal.c}`);

  r = await call(db, { ref: 'DEP-1', amount: 20000, type: 'deposit' });
  record(`[${label}] replaying the same webhook does not post twice`, r.message === 'Already processed', r.message || r.raised);

  await intent(db, 'FAIL-1', 'deposit', 5000);
  r = await call(db, { ref: 'FAIL-1', status: 'failed', amount: 5000, type: 'deposit' });
  record(`[${label}] failed payment is recorded as failed`, (await status(db, 'FAIL-1')) === 'failed');

  // Fee case: a fee with no fee account must not post an unbalanced journal.
  await db.exec(`UPDATE kunity.accounts SET is_active = false WHERE id='${FEE}'`);
  await intent(db, 'FEE-1', 'deposit', 10000);
  r = await call(db, { ref: 'FEE-1', amount: 10000, type: 'deposit', fee: 300 });
  record(`[${label}] fee charged without a fee account raises and posts nothing`, !!r.raised && (await status(db, 'FEE-1')) === 'pending', r.raised || JSON.stringify(r));
  await db.exec(`UPDATE kunity.accounts SET is_active = true WHERE id='${FEE}'`);

  // Activation without the ACT_FEE account raises and leaves the request pending.
  await db.exec(`UPDATE kunity.accounts SET is_active = false WHERE organization_id='${ORG}' AND code='ACT_FEE'`);
  await db.exec(`UPDATE kunity.members SET status='pending'`);
  await db.exec(`UPDATE kunity.accounts SET is_active=false WHERE id='${ACC}'`);
  await intent(db, 'ACT-3', 'account_activation', 5000);
  r = await call(db, { ref: 'ACT-3', amount: 5000, type: 'account_activation' });
  record(`[${label}] activation without an ACT_FEE account raises and stays pending`,
    !!r.raised && (await status(db, 'ACT-3')) === 'pending' && (await one(db, `SELECT is_active FROM kunity.accounts WHERE id='${ACC}'`)).is_active === false,
    r.raised ? r.raised.slice(0, 80) : JSON.stringify(r));
  await db.close();
}

async function main() {
  await suite(false);
  await suite(true);
  const failed = results.filter(p => !p).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('ALL PAYMENT-RPC CHECKS PASSED');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
