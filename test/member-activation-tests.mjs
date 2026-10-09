/**
 * Migration 25: successful activation payment => member active (no admin approval).
 * Run: node test/member-activation-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const results = [];
const record = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ORG = '11111111-0000-0000-0000-00000000000a';
const M = {
  join: '22222222-0000-0000-0000-000000000001',     // pending, pays activation
  depositOnly: '22222222-0000-0000-0000-000000000002', // pending, pays a deposit only
  suspended: '22222222-0000-0000-0000-000000000003',   // suspended, pays activation
  backfill: '22222222-0000-0000-0000-000000000004',   // pending, ALREADY paid before migration
  refStyle: '22222222-0000-0000-0000-000000000005',   // pending, PAY-ACT- reference
};

async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
  await db.exec(read('test/financial-base-schema.sql'));
  await db.exec(`
    INSERT INTO kunity.organizations (id, name, code) VALUES ('${ORG}', 'Sacco A', 'SA');
    INSERT INTO kunity.members (id, organization_id, status, first_name) VALUES
      ('${M.join}', '${ORG}', 'pending', 'Join'),
      ('${M.depositOnly}', '${ORG}', 'pending', 'Dep'),
      ('${M.suspended}', '${ORG}', 'suspended', 'Sus'),
      ('${M.backfill}', '${ORG}', 'pending', 'Old'),
      ('${M.refStyle}', '${ORG}', 'pending', 'Ref');
  `);
  return db;
}

async function main() {
  console.log('PHASE 1 — backfill (payments recorded before migration 25)');
  let db = await setup();
  await db.exec(`
    INSERT INTO kunity.payment_requests (organization_id, member_id, amount, status, payment_type, internal_reference)
    VALUES ('${ORG}', '${M.backfill}', 5000, 'success', 'account_activation', 'PAY-OLD-1');
  `);
  await db.exec(read('supabase/migrations/25_activation_fee_is_membership.sql'));
  let st = (await db.query(`SELECT status FROM kunity.members WHERE id='${M.backfill}'`)).rows[0].status;
  record('backfill: pending member who already paid becomes active', st === 'active', `status=${st}`);
  await db.close();

  console.log('\nPHASE 2 — live behaviour');
  db = await setup();
  await db.exec(read('supabase/migrations/25_activation_fee_is_membership.sql'));
  const status = async (id) => (await db.query(`SELECT status FROM kunity.members WHERE id='${id}'`)).rows[0].status;

  // Pending intent created, then the webhook marks it success.
  await db.exec(`INSERT INTO kunity.payment_requests (organization_id, member_id, amount, status, payment_type, internal_reference)
                 VALUES ('${ORG}', '${M.join}', 5000, 'pending', 'account_activation', 'PAY-J1')`);
  record('pending intent does not activate the member', (await status(M.join)) === 'pending');
  await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='PAY-J1'`);
  record('successful activation payment activates a pending member', (await status(M.join)) === 'active');

  await db.exec(`INSERT INTO kunity.payment_requests (organization_id, member_id, amount, status, payment_type, internal_reference)
                 VALUES ('${ORG}', '${M.depositOnly}', 20000, 'success', 'deposit', 'DEP-1')`);
  record('a deposit payment does NOT activate a pending member', (await status(M.depositOnly)) === 'pending');

  await db.exec(`INSERT INTO kunity.payment_requests (organization_id, member_id, amount, status, payment_type, internal_reference)
                 VALUES ('${ORG}', '${M.suspended}', 5000, 'success', 'account_activation', 'PAY-S1')`);
  record('a suspended member is NOT reactivated by a payment', (await status(M.suspended)) === 'suspended');

  await db.exec(`INSERT INTO kunity.payment_requests (organization_id, member_id, amount, status, payment_type, internal_reference)
                 VALUES ('${ORG}', '${M.refStyle}', 5000, 'success', NULL, 'PAY-ACT-XYZ')`);
  record('PAY-ACT- reference also activates', (await status(M.refStyle)) === 'active');

  // Stored-request rules (the trigger never trusts anything else).
  const pendingCase = '22222222-0000-0000-0000-000000000009';
  await db.exec(`INSERT INTO kunity.members (id, organization_id, status, first_name) VALUES ('${pendingCase}', '${ORG}', 'pending', 'Rules')`);
  const attempt = async (ref, type, amount, currency, direction) => {
    await db.exec(`INSERT INTO kunity.payment_requests (organization_id, member_id, amount, currency, status, payment_type, internal_reference, direction)
                   VALUES ('${ORG}', '${pendingCase}', ${amount}, '${currency}', 'pending', '${type}', '${ref}', '${direction}')`);
    await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='${ref}'`);
    const st = await status(pendingCase);
    return st;
  };
  record('underpaid activation (1,000 < 5,000) does NOT activate', (await attempt('U-1', 'account_activation', 1000, 'UGX', 'inbound')) === 'pending');
  record('activation in USD does NOT activate', (await attempt('U-2', 'account_activation', 5000, 'USD', 'inbound')) === 'pending');
  record('outbound activation does NOT activate', (await attempt('U-3', 'account_activation', 5000, 'UGX', 'outbound')) === 'pending');
  record('qualifying activation (5,000 UGX inbound) activates', (await attempt('U-4', 'account_activation', 5000, 'UGX', 'inbound')) === 'active');

  await db.exec(`UPDATE kunity.payment_requests SET status='failed' WHERE internal_reference='PAY-J1'`);
  // (member already active; the trigger must not touch anything else)
  record('a later status change does not re-run activation on other members', (await status(M.depositOnly)) === 'pending');

  await db.close();
  const failed = results.filter(p => !p).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('ALL MEMBER-ACTIVATION CHECKS PASSED');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
