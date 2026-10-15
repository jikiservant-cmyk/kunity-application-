/**
 * Migration 26: the legacy "activate everything on any success" trigger is gone,
 * deposits no longer activate members, and status updates on the enum column work.
 * Run: node test/unlock-trigger-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORG = '11111111-0000-0000-0000-00000000000a';
const M = '22222222-0000-0000-0000-0000000000d1';
const ACC = '44444444-0000-0000-0000-0000000000d1';
const results = [];
const record = (name, pass, detail = '') => { results.push(pass); console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// The legacy function exactly as it was found live, including its comparisons.
const LEGACY = `
CREATE OR REPLACE FUNCTION kunity.handle_payment_success_unlock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'kunity', 'pg_temp' AS $f$
DECLARE v_org uuid; v_member uuid;
BEGIN
  IF (NEW.status IS DISTINCT FROM 'success' AND NEW.status IS DISTINCT FROM 'successful') THEN RETURN NEW; END IF;
  IF (OLD.status IS NOT DISTINCT FROM 'success' OR OLD.status IS NOT DISTINCT FROM 'successful') THEN RETURN NEW; END IF;
  v_org := NEW.organization_id; v_member := NEW.member_id;
  IF v_member IS NULL THEN RETURN NEW; END IF;
  UPDATE kunity.accounts a SET is_active = true WHERE a.deleted_at IS NULL AND a.organization_id = v_org AND a.member_id = v_member;
  UPDATE kunity.member_savings ms SET status = 'active' WHERE ms.deleted_at IS NULL AND ms.organization_id = v_org AND ms.member_id = v_member;
  RETURN NEW;
END; $f$;
CREATE TRIGGER trg_handle_payment_success_unlock AFTER UPDATE OF status ON kunity.payment_requests FOR EACH ROW EXECUTE FUNCTION kunity.handle_payment_success_unlock();
`;

async function setup(withLegacy, textStatus = false) {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`);
  await db.exec(read('test/financial-base-schema.sql'));
  if (textStatus) await db.exec(`ALTER TABLE kunity.payment_requests ALTER COLUMN status TYPE text USING status::text`);
  await db.exec(read('supabase/migrations/25_activation_fee_is_membership.sql'));
  await db.exec(`ALTER TABLE kunity.accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz; ALTER TABLE kunity.member_savings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`);
  if (withLegacy) await db.exec(LEGACY);
  await db.exec(`
    INSERT INTO kunity.organizations (id,name,code) VALUES ('${ORG}','S','S');
    INSERT INTO kunity.members (id,organization_id,status) VALUES ('${M}','${ORG}','pending');
    INSERT INTO kunity.accounts (id,organization_id,member_id,name,code,account_category,is_active) VALUES ('${ACC}','${ORG}','${M}','W','W1','liability',false);
    INSERT INTO kunity.member_savings (organization_id,member_id,account_id,status) VALUES ('${ORG}','${M}','${ACC}','frozen');
    INSERT INTO kunity.payment_requests (organization_id,member_id,amount,status,payment_type,internal_reference) VALUES ('${ORG}','${M}',2000,'pending','deposit','DEP-1');
  `);
  return db;
}
const one = async (db, sql) => (await db.query(sql)).rows[0];

async function main() {
  console.log('PHASE 1 — with the legacy trigger (reproduces the hole and the enum error)');
  let db = await setup(true);
  let err = null;
  try { await db.exec(`UPDATE kunity.payment_requests SET status='failed' WHERE internal_reference='DEP-1'`); }
  catch (e) { err = e.message; }
  record('legacy: a pending -> failed update errors on the enum column (reproduced)', !!err && /payment_status/.test(err), err || 'no error');
  db = await setup(true);
  let successErr = null;
  try { await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='DEP-1'`); }
  catch (e) { successErr = e.message; }
  record('legacy: a successful payment update also errors on the enum column', !!successErr, successErr || 'no error');
  await db.close();

  // Where the status column is plain text, the same trigger activates everyone.
  db = await setup(false, true);
  await db.exec(LEGACY.replace(/NEW\.status IS/g,'NEW.status::text IS').replace(/OLD\.status IS/g,'OLD.status::text IS'));
  await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='DEP-1'`);
  const legacyActive = (await one(db, `SELECT is_active FROM kunity.accounts`)).is_active;
  record('legacy (text column): a successful 2,000 deposit activates the account (reproduced)', legacyActive === true);
  await db.close();

  console.log('\nPHASE 2 — after migration 26');
  db = await setup(true);
  await db.exec(read('supabase/migrations/26_drop_payment_success_unlock.sql'));
  const trg = await one(db, `SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'trg_handle_payment_success_unlock'`);
  const fn = await one(db, `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='kunity' AND p.proname='handle_payment_success_unlock'`);
  record('trigger removed', trg.n === 0);
  record('function removed', fn.n === 0);

  await db.exec(`UPDATE kunity.payment_requests SET status='failed' WHERE internal_reference='DEP-1'`);
  record('pending -> failed update works on the enum column', (await one(db, `SELECT status::text s FROM kunity.payment_requests`)).s === 'failed');

  db = await setup(false);
  await db.exec(read('supabase/migrations/26_drop_payment_success_unlock.sql'));
  await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='DEP-1'`);
  record('after 26: a successful deposit does NOT activate the account', (await one(db, `SELECT is_active FROM kunity.accounts`)).is_active === false);
  record('after 26: a successful deposit does NOT activate the membership', (await one(db, `SELECT status FROM kunity.members`)).status === 'pending');

  // Activation still works through migration 25.
  await db.exec(`INSERT INTO kunity.payment_requests (organization_id,member_id,amount,status,payment_type,internal_reference) VALUES ('${ORG}','${M}',5000,'pending','account_activation','ACT-1')`);
  await db.exec(`UPDATE kunity.payment_requests SET status='success' WHERE internal_reference='ACT-1'`);
  record('after 26: a successful 5,000 activation still activates the member', (await one(db, `SELECT status FROM kunity.members`)).status === 'active');
  await db.close();

  const failed = results.filter(p => !p).length;
  console.log(`\nRESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('ALL UNLOCK-TRIGGER CHECKS PASSED');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
