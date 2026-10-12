/**
 * Migration 28: admin-managed loan products. Loans applied through a product take
 * the product's rate and limits; other SACCOs' and inactive products are refused.
 * Run: node test/products-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORG = '11111111-0000-0000-0000-00000000000a';
const ORG_B = '11111111-0000-0000-0000-00000000000b';
const M = '22222222-0000-0000-0000-0000000000e1';
const M_PENDING = '22222222-0000-0000-0000-0000000000e2';
const P_OK = '33333333-0000-0000-0000-0000000000a1';
const P_INACTIVE = '33333333-0000-0000-0000-0000000000a2';
const P_OTHER_ORG = '33333333-0000-0000-0000-0000000000b1';

const results = [];
const record = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
await db.exec(read('test/financial-base-schema.sql'));
await db.exec(read('supabase/migrations/28_admin_products.sql'));
await db.exec(`
  INSERT INTO kunity.organizations (id,name,code) VALUES ('${ORG}','Sacco A','A'), ('${ORG_B}','Sacco B','B');
  INSERT INTO kunity.members (id,organization_id,status) VALUES
    ('${M}','${ORG}','active'), ('${M_PENDING}','${ORG}','pending');
  INSERT INTO kunity.loan_products (id,organization_id,name,interest_rate,min_amount,max_amount,is_active) VALUES
    ('${P_OK}','${ORG}','Development Loan',12.5,100000,2000000,true),
    ('${P_INACTIVE}','${ORG}','Retired Loan',8,0,500000,false),
    ('${P_OTHER_ORG}','${ORG_B}','Other SACCO Loan',3,0,9000000,true);
`);

const apply = async (member, product, amount) => {
  try {
    const r = await db.query(`SELECT kunity.member_apply_loan_for_product('${member}','${ORG}','${product}',${amount}) AS r`);
    return { ok: true, r: r.rows[0].r };
  } catch (e) { return { ok: false, err: e.message }; }
};
const loanCount = async () => (await db.query(`SELECT COUNT(*)::int AS n FROM kunity.loans`)).rows[0].n;

// 1. Product loan takes the product's rate, not 10%
let res = await apply(M, P_OK, 500000);
record('product loan succeeds for an active member', res.ok, res.err);
const row = res.ok ? (await db.query(`SELECT interest_rate::float AS rate, loan_product_id, status FROM kunity.loans WHERE id='${res.r.loan_id}'`)).rows[0] : null;
record('loan carries the product interest rate (12.5)', row && row.rate === 12.5, row ? `rate=${row.rate}` : 'no row');
record('loan is linked to the product and pending', row && row.loan_product_id === P_OK && row.status === 'pending');

// 2. Amount limits
res = await apply(M, P_OK, 50000);
record('amount below product minimum is refused', !res.ok && /between/.test(res.err), res.err);
res = await apply(M, P_OK, 2000001);
record('amount above product maximum is refused', !res.ok && /between/.test(res.err), res.err);
res = await apply(M, P_OK, 100000);
record('amount exactly at minimum is accepted', res.ok, res.err);
res = await apply(M, P_OK, 2000000);
record('amount exactly at maximum is accepted', res.ok, res.err);

// 3. Inactive and other-SACCO products are refused
res = await apply(M, P_INACTIVE, 100000);
record('inactive product is refused', !res.ok && /not available/.test(res.err), res.err);
res = await apply(M, P_OTHER_ORG, 100000);
record('another SACCO\'s product is refused', !res.ok && /not available/.test(res.err), res.err);

// 4. Membership still required
res = await apply(M_PENDING, P_OK, 100000);
record('pending (not active) member cannot apply', !res.ok && /not active/.test(res.err), res.err);

// 5. Nothing was written for refused attempts
const before = await loanCount();
await apply(M, P_INACTIVE, 100000);
await apply(M, P_OK, 1);
record('refused attempts write no loan rows', (await loanCount()) === before);

// 6. Savings product columns exist and accept the values the admin route writes
try {
  await db.exec(`INSERT INTO kunity.savings_products (organization_id,name,interest_rate,min_balance,allows_withdrawals,deposit_frequency,is_active)
                 VALUES ('${ORG}','Standard Savings',5,0,true,'monthly',true)`);
  record('savings product insert with admin fields succeeds', true);
} catch (e) { record('savings product insert with admin fields succeeds', false, e.message); }

// 7. Constraints: max below min refused at the table level
try {
  await db.exec(`INSERT INTO kunity.loan_products (organization_id,name,interest_rate,min_amount,max_amount) VALUES ('${ORG}','Bad',5,500,100)`);
  record('loan product with max < min is rejected by the table', false);
} catch { record('loan product with max < min is rejected by the table', true); }

const passed = results.filter(Boolean).length;
console.log(`\nRESULTS: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
