/**
 * End-to-end check of the admin SMS purchase flow (topup -> NaJiki -> confirm -> credit).
 *
 * The real POST handlers in app/api/admin/sms/topup/route.ts and .../topup/confirm/route.ts run
 * against a local stand-in for Supabase REST/RPC and the NaJiki gateway. The stand-in keeps the
 * wallet_transactions ledger in memory, so every write order and every credit is observable.
 *
 * Run: node_modules/.bin/tsx test/sms-topup-e2e-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';

const TENANT = 'tenant-a';
const WALLET_ID = 'wallet-a';
const ADMIN_TOKEN = 'admin-token';
const NAJIKI_REF = 'NJ-TOPUP-1';

const state = {
  balance: 0,
  ledger: [],            // wallet_transactions rows
  najikiCalls: [],       // POST /api/payments bodies
  najikiCreateMode: 'ok',// ok | error | pending_later
  najikiStatus: 'pending',// status returned by GET /api/payments/:ref
  najikiAmount: 10000,
  ledgerInsertFail: false,
  events: [],            // ordered log: 'ledger_insert' | 'najiki_create' | 'ledger_link'
  creditCalls: 0,
};

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://x');
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const wantsObject = String(req.headers.accept || '').includes('pgrst.object');
  const filters = [...url.searchParams.entries()]
    .filter(([k]) => !['select', 'order', 'limit', 'offset'].includes(k))
    .map(([k, v]) => [k, v.replace(/^eq\./, '')]);
  const matches = (row) => filters.every(([k, v]) => String(row[k]) === v);

  // NaJiki gateway
  if (req.method === 'POST' && url.pathname === '/api/payments') {
    state.events.push('najiki_create');
    state.najikiCalls.push(body);
    if (state.najikiCreateMode === 'error') return json(502, { error: 'NaJiki is down' });
    return json(200, { reference: NAJIKI_REF, status: 'pending' });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
    return json(200, { reference: decodeURIComponent(url.pathname.split('/').pop()), status: state.najikiStatus, amount: state.najikiAmount });
  }

  // Supabase Auth
  if (url.pathname === '/auth/v1/user') {
    return req.headers.authorization === `Bearer ${ADMIN_TOKEN}`
      ? json(200, { id: 'admin-a', email: 'admin@a.test', aud: 'authenticated' })
      : json(401, { message: 'bad token' });
  }

  const table = url.pathname.replace('/rest/v1/', '');
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.replace('/rest/v1/rpc/', '');
    if (fn === 'credit_sms_wallet_idempotent') {
      state.creditCalls++;
      const row = state.ledger.find(r => r.id === body.p_transaction_id);
      if (!row) return json(400, { message: 'tx not found' });
      if (row.note !== 'success') {
        row.note = 'success'; row.status = 'success';
        state.balance += Number(body.p_amount);
      }
      return json(200, [{ id: WALLET_ID, tenant_id: TENANT, balance: state.balance, sms_rate: 50 }]);
    }
    return json(404, { message: 'unknown rpc ' + fn });
  }

  if (table === 'admin_profiles') {
    const row = { id: 'admin-a', role: 'sacco_admin', tenant_id: TENANT };
    return json(200, wantsObject ? row : [row]);
  }
  if (table === 'tenants') {
    const row = { code: 'sacco-a', application_id: 'app-1' };
    return json(200, wantsObject ? row : [row]);
  }
  if (table === 'wallets') {
    const row = { id: WALLET_ID, tenant_id: TENANT, balance: state.balance, sms_rate: 50 };
    return json(200, wantsObject ? row : [row]);
  }
  if (table === 'wallet_transactions') {
    if (req.method === 'POST') {
      state.events.push('ledger_insert');
      if (state.ledgerInsertFail) return json(400, { code: '42703', message: 'simulated insert failure' });
      state.ledger.push({ ...body });
      return json(201, {});
    }
    if (req.method === 'PATCH') {
      state.events.push('ledger_link');
      const matched = state.ledger.filter(matches);
      matched.forEach(r => Object.assign(r, body));
      return json(200, matched);
    }
    if (req.method === 'GET') {
      const rows = state.ledger.filter(matches);
      const row = rows[0] || null;
      return json(200, wantsObject ? row : (row ? [row] : []));
    }
  }
  if (table === 'audit_logs' || table === 'audit_log' || table === 'sms_messages') {
    return json(201, {});
  }
  return json(404, { message: `stand-in has no handler for ${req.method} ${table}` });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.NEXT_PUBLIC_SUPABASE_URL = base;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test';
process.env.NAJIKI_API_URL = base;
process.env.NAJIKI_API_KEY = 'najiki-key';
process.env.NAJIKI_APPLICATION_CODE = 'sacco';

const { POST: topup } = await import('../app/api/admin/sms/topup/route.ts');
const { POST: confirm } = await import('../app/api/admin/sms/topup/confirm/route.ts');

const call = async (handler, payload) => {
  const req = new NextRequest('http://localhost:3000/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const res = await handler(req);
  return { status: res.status, body: await res.json() };
};
const reset = () => {
  state.balance = 0; state.ledger = []; state.najikiCalls = []; state.events = [];
  state.najikiCreateMode = 'ok'; state.najikiStatus = 'pending'; state.ledgerInsertFail = false; state.creditCalls = 0;
};

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const buy = { token: ADMIN_TOKEN, credits: 200, momoNumber: '0772123456', organizationId: TENANT };

console.log('Purchase: request payment');
{
  reset();
  const r = await call(topup, buy);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.intentId, NAJIKI_REF);
  ok('returns NaJiki\'s reference as intentId for the confirm step');
  assert.deepEqual(state.events, ['ledger_insert', 'najiki_create', 'ledger_link'],
    'the pending ledger row is written before NaJiki is called, then linked');
  ok('ledger row is written BEFORE the NaJiki call (no payment without a record)');
  const call0 = state.najikiCalls[0];
  assert.equal(call0.paymentTypeCode, 'BUY_SMS');
  assert.equal(call0.amount, 10000, 'price comes from the server pack, not the client');
  assert.equal(call0.phoneNumber, '+256772123456');
  assert.match(call0.idempotencyKey, /^PAY-SMS-/);
  ok('NaJiki receives BUY_SMS, the server price, the normalised momo and a local idempotency key');
  assert.equal(state.ledger[0].reference, NAJIKI_REF);
  assert.equal(state.ledger[0].note, 'pending');
  ok('ledger row now carries NaJiki\'s reference, so the webhook and confirm can find it');
}
{
  reset();
  state.ledgerInsertFail = true;
  const r = await call(topup, buy);
  assert.equal(r.status, 500);
  assert.equal(state.najikiCalls.length, 0, 'NaJiki must not be called when the ledger write fails');
  ok('ledger write fails -> no payment is requested (fail closed)');
}
{
  reset();
  state.najikiCreateMode = 'error';
  const r = await call(topup, buy);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /NaJiki is down/);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0].note, 'pending');
  assert.equal(state.balance, 0);
  ok('NaJiki refuses -> admin sees the reason; pending row credits nothing');
}
{
  reset();
  const r = await call(topup, { ...buy, credits: 999 });
  assert.equal(r.status, 400);
  assert.equal(state.najikiCalls.length, 0);
  ok('an unknown credit pack is refused before anything is written');
}

console.log('Purchase: confirm and credit');
{
  reset();
  await call(topup, buy);
  const before = await call(confirm, { token: ADMIN_TOKEN, intentId: NAJIKI_REF });
  assert.equal(before.status, 400);
  assert.match(before.body.error, /not yet successful/);
  assert.equal(state.balance, 0);
  ok('while NaJiki says pending (PIN not entered yet): nothing is credited, UI keeps waiting');

  state.najikiStatus = 'success';
  const paid = await call(confirm, { token: ADMIN_TOKEN, intentId: NAJIKI_REF });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.addedCredits, 200);
  assert.equal(state.balance, 10000);
  assert.equal(state.creditCalls, 1);
  ok('once NaJiki reports success: 200 credits added, wallet credited once');

  const again = await call(confirm, { token: ADMIN_TOKEN, intentId: NAJIKI_REF });
  assert.equal(again.status, 200);
  assert.equal(again.body.message, 'Already processed');
  assert.equal(state.balance, 10000, 'a repeat confirm must not credit again');
  ok('repeat confirm (polling, double click) returns "Already processed" and credits nothing');
}
{
  reset();
  await call(topup, buy);
  state.najikiStatus = 'success';
  state.najikiAmount = 9000; // NaJiki charged a different amount
  const r = await call(confirm, { token: ADMIN_TOKEN, intentId: NAJIKI_REF });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /amount mismatch/);
  assert.equal(state.balance, 0);
  ok('amount mismatch with NaJiki -> nothing credited');
}

server.close();
console.log(`\n${passed} SMS purchase checks passed`);
