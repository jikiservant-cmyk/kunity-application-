/**
 * Migration re-apply (idempotency) regression suite.
 *
 * Operational question this answers: "if a deploy pipeline, a retried job, or an
 * operator reapplies the migration folder, does anything break?"
 *
 * It applies the real migrations to a real PostgreSQL engine (PGlite / Postgres 17
 * WASM) TWICE and asserts that the second pass introduces no failure that the
 * first pass did not already have. A migration that is not re-runnable (for
 * example a bare `ADD CONSTRAINT` or an `ALTER FUNCTION ... RENAME`) fails here.
 *
 * Run: node test/migrations-reapply-tests.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(ROOT, 'supabase', 'migrations');

const read = (p) => readFileSync(p, 'utf8');
const migrationNumber = (f) => parseInt(String(f).match(/^(\d+)/)?.[1] ?? '0', 10);

const migrations = readdirSync(MIG)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));

// The minimal pentest harness (financial-base-schema.sql) is deliberately missing
// objects that only exist in the live Supabase project: public.admin_profiles,
// public.applications, the auth schema, kunity.profiles, ... Migrations that touch
// those objects cannot run here at all. They are excluded from the harness run and
// must be judged by their first-pass failures staying identical on the second pass.
const HARNESS_BASELINE = new Set([
  '23_tenant_row_isolation.sql', // needs public.admin_profiles / kunity.profiles
  '29_product_access_and_loan_terms.sql', // needs the auth schema
  '31_hash_application_api_keys.sql', // needs public.applications
]);

// Original RPC migrations the financial work builds on top of, applied once so the
// 21+ hardening migrations have something to replace (mirrors financial-tests.mjs).
const PREREQUISITES = [
  '02_livepay_webhook_rpc.sql',
  '03_najiki_webhook_rpc.sql',
  '09_credit_sms_wallet_rpc.sql',
  '10_debit_sms_wallet_rpc.sql',
  '15_loan_disbursement_rpc.sql',
  '16_member_transactions_rpc.sql',
  '18_credit_sms_idempotent.sql',
];

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

const db = new PGlite();

/**
 * Apply every file in `list`, one per transaction, returning { file -> error }.
 * A ROLLBACK after a failure keeps an aborted transaction from poisoning the
 * files that follow it.
 */
async function applyAll(list) {
  const failures = {};
  for (const file of list) {
    try {
      await db.exec(read(join(MIG, file)));
    } catch (e) {
      failures[file] = firstLine(e);
      try {
        await db.exec('ROLLBACK;');
      } catch {
        /* the failing transaction may already be closed */
      }
    }
  }
  return failures;
}

async function main() {
  console.log('Migration re-apply (idempotency) checks\n');

  await db.exec(read(join(ROOT, 'test/financial-base-schema.sql')));
  await db.exec(`
    DO $$ BEGIN
      BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
      BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
      BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
      BEGIN CREATE ROLE supabase_auth_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
    END $$;
  `);

  await applyAll(PREREQUISITES);

  const targets = migrations.filter((f) => migrationNumber(f) >= 21);
  const first = await applyAll(targets);
  const second = await applyAll(targets);

  // --- 1. the second pass must not break anything the first pass survived -------
  const newlyBroken = Object.keys(second).filter((f) => !(f in first));
  record(
    're-applying the migration folder does not break a previously successful migration',
    newlyBroken.length === 0,
    newlyBroken.length
      ? newlyBroken.map((f) => `${f}: ${second[f]}`).join(' | ')
      : `${targets.length} migrations applied twice`
  );

  // --- 2. failures must be identical across passes ------------------------------
  const firstKeys = Object.keys(first).sort();
  const secondKeys = Object.keys(second).sort();
  const sameFailures = JSON.stringify(firstKeys) === JSON.stringify(secondKeys)
    && firstKeys.every((f) => first[f] === second[f]);
  record(
    'the same migrations fail on both passes (no state-dependent new failures)',
    sameFailures,
    `pass 1: [${firstKeys.join(', ') || 'none'}] / pass 2: [${secondKeys.join(', ') || 'none'}]`
  );

  // --- 3. residual failures are harness artifacts only --------------------------
  const unexpected = Object.keys(first).filter((f) => !HARNESS_BASELINE.has(f));
  record(
    'migrations 21+ apply cleanly on the pentest harness (only known missing-object files differ)',
    unexpected.length === 0,
    unexpected.length ? unexpected.map((f) => `${f}: ${first[f]}`).join(' | ') : 'no unexpected failures'
  );

  // --- 4. the hardening objects really exist after the double apply -------------
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const columnPresent = await one(`
    SELECT 1 AS ok FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wallet_transactions'
      AND column_name = 'sms_refund_debit_id'`);
  record('migration 36 left wallet_transactions.sms_refund_debit_id in place', !!columnPresent?.ok);

  const functionPresent = async (schema, name, args) => {
    const row = await one(`
      SELECT 1 AS ok FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3`,
      [schema, name, args]);
    return !!row?.ok;
  };
  record(
    'refund_sms_wallet keeps both signatures after the double apply (4-arg hardened + 3-arg rolling wrapper)',
    (await functionPresent('public', 'refund_sms_wallet', 'p_wallet_id text, p_amount numeric, p_reference text, p_debit_reference text'))
      && (await functionPresent('public', 'refund_sms_wallet', 'p_wallet_id text, p_amount numeric, p_reference text'))
  );
  record(
    'process_najiki_webhook is the currency-hardening wrapper after the double apply',
    await functionPresent('kunity', 'process_najiki_webhook_pre_currency_hardening',
      'p_reference text, p_status text, p_amount numeric, p_external_entity_id text, p_payment_type text, p_payload jsonb, p_fee numeric')
  );
  record(
    'migration 33 left the payment-request/member composite FK in place',
    !!(await one(`
      SELECT 1 AS ok FROM pg_constraint
      WHERE conrelid = 'kunity.payment_requests'::regclass
        AND conname = 'payment_requests_member_org_match_fkey'`))?.ok
  );

  // --- 5. the wrapper still routes to the original ledger function ---------------
  const wrapperCalls = await one(`
    SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'kunity' AND p.proname = 'process_najiki_webhook'`);
  record(
    'the process_najiki_webhook wrapper still delegates to the pre-hardening implementation',
    /process_najiki_webhook_pre_currency_hardening/.test(wrapperCalls?.def ?? '')
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

await main();
