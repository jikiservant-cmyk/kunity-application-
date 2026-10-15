/**
 * Adversarial regression tests for money webhook edge cases.
 * Runs the real Najiki webhook handler against a local Supabase REST/RPC stand-in
 * backed by PGlite, applying the repository's actual financial migrations.
 * Former exploit inputs must now be rejected; the valid-payment control must work.
 * No production database, provider credentials, or real funds are used.
 * Run: node_modules/.bin/tsx test/money-engine-webhook-adversarial-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SECRET = 'local-test-webhook-secret';
const ORG = '11111111-0000-0000-0000-00000000000a';
const M = '22222222-0000-0000-0000-0000000000e1';
const ACC = '44444444-0000-0000-0000-0000000000e1';
const CASH = '44444444-0000-0000-0000-0000000000c1';
const FEE = '44444444-0000-0000-0000-0000000000f1';
const TENANT_A = '33333333-0000-0000-0000-00000000000a';
const WALLET_A = '55555555-0000-0000-0000-00000000000a';

const db = new PGlite();
await db.exec(`CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;`);
await db.exec(read('test/financial-base-schema.sql'));
await db.exec(`
  INSERT INTO kunity.organizations (id,name,code) VALUES ('${ORG}','Probe SACCO','PROBE');
  INSERT INTO kunity.members (id,organization_id,status) VALUES ('${M}','${ORG}','active');
  INSERT INTO kunity.accounts (id,organization_id,member_id,name,code,account_category,is_active,is_system) VALUES
    ('${ACC}','${ORG}','${M}','Member Savings','SAV-P1','liability',true,false),
    ('${CASH}','${ORG}',NULL,'Main Cash','CASH-MAIN','asset',true,true),
    ('${FEE}','${ORG}',NULL,'Gateway Fee Income','FEE-GW','income',true,true);
  INSERT INTO kunity.member_savings (organization_id,member_id,account_id,status)
    VALUES ('${ORG}','${M}','${ACC}','active');
  INSERT INTO public.wallets (id,tenant_id,balance) VALUES ('${WALLET_A}','${TENANT_A}',1000);
`);
await db.exec(`ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_wallet_id_fkey;
ALTER TABLE public.wallet_transactions ALTER COLUMN wallet_id TYPE text USING wallet_id::text;
ALTER TABLE public.wallets ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.wallets ALTER COLUMN tenant_id TYPE text USING tenant_id::text;
ALTER TABLE public.wallet_transactions ALTER COLUMN tenant_id TYPE text USING tenant_id::text;
CREATE UNIQUE INDEX IF NOT EXISTS wallets_debit_idempotency_uq
  ON public.wallet_transactions(wallet_id,reference)
  WHERE reference IS NOT NULL AND direction='debit';`);
for (const migration of [
  '21_financial_integrity.sql',
  '25_activation_fee_is_membership.sql',
  '27_atomic_payment_rpc.sql',
  '32_sms_idempotency_keys.sql',
  '34_debit_sms_wallet_tenant_match.sql',
  '35_debit_sms_wallet_replay_safe.sql',
  '36_money_engine_hardening.sql',
]) await db.exec(read(`supabase/migrations/${migration}`));

const rpcCalls = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, 'http://local.test');
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const rpcPrefix = '/rest/v1/rpc/';
  if (url.pathname.startsWith(rpcPrefix) && req.method === 'POST') {
    const fn = url.pathname.slice(rpcPrefix.length);
    rpcCalls.push({ fn, body });
    try {
      let result;
      if (fn === 'credit_sms_wallet_idempotent') {
        result = await db.query(
          'SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)',
          [body.p_wallet_id, body.p_transaction_id, body.p_amount],
        );
        return json(200, result.rows);
      }
      if (fn === 'process_najiki_webhook') {
        result = await db.query(
          `SELECT kunity.process_najiki_webhook($1,$2,$3,$4,$5,$6::jsonb,$7) AS r`,
          [body.p_reference, body.p_status, body.p_amount, body.p_external_entity_id,
            body.p_payment_type, JSON.stringify(body.p_payload), body.p_fee],
        );
        return json(200, result.rows[0].r);
      }
      if (fn === 'refund_sms_wallet') {
        result = await db.query(
          'SELECT * FROM public.refund_sms_wallet($1,$2,$3,$4)',
          [body.p_wallet_id, body.p_amount, body.p_reference, body.p_debit_reference],
        );
        return json(200, result.rows);
      }
      return json(404, { message: `unknown RPC ${fn}` });
    } catch (error) {
      return json(400, { message: error.message, code: error.code || 'P0001' });
    }
  }

  const table = url.pathname.replace('/rest/v1/', '');
  if (table === 'wallet_transactions' && req.method === 'GET') {
    const filters = [...url.searchParams.entries()]
      .filter(([key]) => !['select', 'order', 'limit', 'offset'].includes(key))
      .map(([key, value]) => [key, value.replace(/^eq\./, '')]);
    const columns = (url.searchParams.get('select') || '*').split(',');
    const matches = await db.query('SELECT * FROM public.wallet_transactions');
    const row = matches.rows.find((candidate) => filters.every(([key, value]) => String(candidate[key]) === value));
    if (!row) {
      if (String(req.headers.accept || '').includes('pgrst.object')) {
        return json(406, { message: 'Not found', code: 'PGRST116' });
      }
      return json(200, []);
    }
    const selected = columns.includes('*') ? row : Object.fromEntries(columns.map((key) => [key, row[key]]));
    return json(200, String(req.headers.accept || '').includes('pgrst.object') ? selected : [selected]);
  }

  return json(404, { message: `stand-in has no handler for ${req.method} ${url.pathname}` });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-test-key';
process.env.NAJIKI_API_KEY = SECRET;
delete process.env.NAJIKI_WEBHOOK_SECRET;

const { POST } = await import('../app/api/webhooks/najiki/route.ts');
function signedHeaders(body, timestamp = Date.now()) {
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-najiki-timestamp': String(timestamp),
    'x-najiki-signature': `t=${timestamp},v=${signature}`,
  };
}
async function sendWebhook(value) {
  const raw = JSON.stringify(value);
  const request = new NextRequest('http://localhost:3000/api/webhooks/najiki', {
    method: 'POST', headers: signedHeaders(raw), body: raw,
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}
async function insertPayment(reference, amount, type = 'deposit') {
  await db.query(
    `INSERT INTO kunity.payment_requests
      (organization_id,member_id,amount,currency,status,payment_type,internal_reference)
     VALUES ($1,$2,$3,'UGX','pending',$4,$5)`,
    [ORG, M, amount, type, reference],
  );
}
async function insertWalletTransaction({ id, reference, direction, type, amount }) {
  await db.query(
    `INSERT INTO public.wallet_transactions
      (id,wallet_id,tenant_id,direction,amount,currency,note,status,type,reference)
     VALUES ($1,$2,$3,$4,$5,'UGX','pending','pending',$6,$7)`,
    [id, WALLET_A, TENANT_A, direction, amount, type, reference],
  );
}
async function walletBalance() {
  return Number((await db.query('SELECT balance FROM public.wallets WHERE id=$1', [WALLET_A])).rows[0].balance);
}
let passed = 0;
let failed = 0;
async function verifyFix(name, test) {
  try {
    await test();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}

await verifyFix('nested USD deposit against UGX intent is rejected and stays pending', async () => {
  await insertPayment('PROBE-NESTED-CURRENCY', 5000, 'deposit');
  const result = await sendWebhook({ data: {
    reference: 'PROBE-NESTED-CURRENCY', status: 'success', amount: 5000,
    currency: 'USD', paymentType: 'deposit',
  } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /Currency mismatch/);
  assert.equal((await db.query(
    `SELECT status::text AS status FROM kunity.payment_requests WHERE internal_reference=$1`,
    ['PROBE-NESTED-CURRENCY'],
  )).rows[0].status, 'pending');
  assert.equal(Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM kunity.journal_entries WHERE reference=$1`,
    ['PROBE-NESTED-CURRENCY'],
  )).rows[0].n), 0);
});

await verifyFix('USD BUY_SMS callback cannot credit a UGX wallet', async () => {
  const ref = 'PROBE-BUY-SMS-USD';
  await insertWalletTransaction({
    id: '66666666-0000-0000-0000-000000000010',
    reference: ref, direction: 'credit', type: 'sms_topup', amount: 250,
  });
  const before = await walletBalance();
  const result = await sendWebhook({ data: {
    reference: ref, status: 'success', amount: 250,
    currency: 'USD', paymentType: 'BUY_SMS',
  } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(await walletBalance(), before);
  assert.equal((await db.query(`SELECT note FROM public.wallet_transactions WHERE reference=$1`, [ref])).rows[0].note, 'pending');
  assert.equal(rpcCalls.filter((call) => call.fn === 'credit_sms_wallet_idempotent').length, 0);
});

await verifyFix('debit/non-top-up row cannot be credited as a BUY_SMS top-up', async () => {
  const ref = 'PROBE-DEBIT-AS-TOPUP';
  await insertWalletTransaction({
    id: '66666666-0000-0000-0000-000000000011',
    reference: ref, direction: 'debit', type: 'sms_debit', amount: 75,
  });
  const before = await walletBalance();
  const result = await sendWebhook({ data: {
    reference: ref, status: 'success', amount: 75,
    currency: 'UGX', paymentType: 'BUY_SMS',
  } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(await walletBalance(), before);
  assert.equal(rpcCalls.filter((call) => call.fn === 'credit_sms_wallet_idempotent').length, 0);
});

await verifyFix('nonnumeric BUY_SMS amount is rejected without credit', async () => {
  const ref = 'PROBE-BUY-SMS-NAN';
  await insertWalletTransaction({
    id: '66666666-0000-0000-0000-000000000012',
    reference: ref, direction: 'credit', type: 'sms_topup', amount: 125,
  });
  const before = await walletBalance();
  const result = await sendWebhook({ data: {
    reference: ref, status: 'success', amount: 'not-a-number',
    currency: 'UGX', paymentType: 'BUY_SMS',
  } });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(await walletBalance(), before);
  assert.equal((await db.query(`SELECT note FROM public.wallet_transactions WHERE reference=$1`, [ref])).rows[0].note, 'pending');
});

await verifyFix('BUY_SMS without a wallet ledger row is held pending, not acknowledged as paid', async () => {
  const ref = 'PROBE-BUY-SMS-MISSING-ROW';
  const processCallsBefore = rpcCalls.filter((call) => call.fn === 'process_najiki_webhook').length;
  await insertPayment(ref, 200, 'BUY_SMS');
  const result = await sendWebhook({ data: {
    reference: ref, status: 'success', amount: 200,
    currency: 'UGX', paymentType: 'BUY_SMS',
  } });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((await db.query(
    `SELECT status::text AS status FROM kunity.payment_requests WHERE internal_reference=$1`, [ref],
  )).rows[0].status, 'pending');
  assert.equal(rpcCalls.filter((call) => call.fn === 'process_najiki_webhook').length, processCallsBefore);
});

await verifyFix('valid UGX BUY_SMS payment credits once and a replay is idempotent', async () => {
  const ref = 'PROBE-BUY-SMS-VALID';
  await insertWalletTransaction({
    id: '66666666-0000-0000-0000-000000000013',
    reference: ref, direction: 'credit', type: 'sms_topup', amount: 200,
  });
  const before = await walletBalance();
  const event = { data: {
    reference: ref, status: 'success', amount: 200,
    currency: 'UGX', paymentType: 'BUY_SMS',
  } };
  const result = await sendWebhook(event);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await walletBalance(), before + 200);
  const replay = await sendWebhook(event);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.message, 'Already processed');
  assert.equal(await walletBalance(), before + 200);
});

server.close();
await db.close();
console.log(`\nRESULT: ${passed} passed, ${failed} failed. No production systems touched.`);
process.exitCode = failed ? 1 : 0;
