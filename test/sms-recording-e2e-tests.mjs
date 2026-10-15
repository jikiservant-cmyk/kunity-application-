/**
 * End-to-end check of lib/sms.ts sendSms(): every dispatch outcome must leave a row in
 * public.sms_messages. A local stand-in serves the Supabase REST/RPC endpoints and the
 * NaJiki gateway, so the real sendSms code runs and every write it makes is captured.
 *
 * Run: node_modules/.bin/tsx test/sms-recording-e2e-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';

const state = {
  balance: 5000,
  najikiMode: 'ok',      // ok | client_error | server_error
  inserts: [],           // sms_messages rows written
  debits: [],            // debit_sms_wallet calls
  refunds: [],           // refund_sms_wallet calls
  najikiRequests: [],    // what NaJiki received
};

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://x');
  const wantsObject = String(req.headers.accept || '').includes('pgrst.object');
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  // NaJiki gateway
  if (req.method === 'POST' && url.pathname === '/api/messaging/send') {
    assert.equal(req.headers.authorization, 'Bearer najiki-key');
    state.najikiRequests.push({ headers: req.headers, body });
    if (state.najikiMode === 'client_error') return json(400, { error: 'bad number' });
    if (state.najikiMode === 'server_error') return json(502, { error: 'gateway down' });
    if (state.najikiMode === 'ok_no_id') return json(200, { success: true });
    return json(200, { success: true, messageId: 'NJ-TEST-1' });
  }

  // Supabase REST
  if (url.pathname === '/rest/v1/tenants') {
    const sel = url.searchParams.get('select');
    if (sel === 'application_id') return json(200, wantsObject ? { application_id: 'app-1' } : [{ application_id: 'app-1' }]);
    if (sel === 'code') return json(200, wantsObject ? { code: 'sacco-a' } : [{ code: 'sacco-a' }]);
    if (sel === 'id,application_id') return json(200, [{ id: 't-1' }]);
  }
  if (req.method === 'GET' && url.pathname === '/rest/v1/wallets') {
    const row = { id: 'wallet-1', tenant_id: 't-1', balance: state.balance, sms_rate: 50 };
    return json(200, wantsObject ? row : [row]);
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/debit_sms_wallet') {
    state.debits.push(body);
    state.balance -= body.p_amount;
    return json(200, { balance: state.balance });
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/refund_sms_wallet') {
    state.refunds.push(body);
    state.balance += body.p_amount;
    return json(200, { balance: state.balance });
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/sms_messages') {
    state.inserts.push(body);
    return json(201, {});
  }
  return json(404, { error: `unexpected ${req.method} ${url.pathname}` });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
process.env.NEXT_PUBLIC_SUPABASE_URL = base;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test';
process.env.NAJIKI_API_URL = base;
process.env.NAJIKI_API_KEY = 'najiki-key';

const { sendSms } = await import('../lib/sms.ts');

const send = (message = 'Hello test') => sendSms({
  tenantId: 't-1',
  recipientPhone: '0772123456',
  message,
  eventType: 'WELCOME',
});
const last = () => state.inserts[state.inserts.length - 1];

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

console.log('sms recording end-to-end checks');

await check('successful send: debit, dispatch, and a "sent" row with the provider id', async () => {
  state.inserts = []; state.debits = []; state.balance = 5000; state.najikiMode = 'ok';
  const r = await send();
  assert.equal(r.success, true, r.error);
  assert.equal(state.debits.length, 1);
  assert.equal(state.debits[0].p_amount, 50);
  assert.equal(state.inserts.length, 1, 'exactly one row recorded');
  const row = last();
  assert.equal(row.tenant_id, 't-1');
  assert.equal(row.application_id, 'app-1');
  assert.equal(row.phone_number, '+256772123456');
  assert.equal(row.compiled_message, 'Hello test');
  assert.equal(row.cost, 50);
  assert.equal(row.status, 'sent');
  assert.equal(row.event_code, 'WELCOME');
  assert.equal(row.transaction_type, 'debit');
  assert.equal(row.provider_message_id, 'NJ-TEST-1');
});

await check('successful send without a provider id still records a unique "sent" row', async () => {
  state.inserts = []; state.balance = 5000;
  state.najikiMode = 'ok_no_id';
  const r = await send();
  state.najikiMode = 'ok';
  assert.equal(r.success, true, r.error);
  assert.equal(last().status, 'sent');
  assert.match(last().provider_message_id, /^sent_[0-9a-f-]{36}$/);
});

await check('NaJiki 4xx: debit refunded and a "failed_refunded" row recorded', async () => {
  state.inserts = []; state.debits = []; state.refunds = []; state.balance = 5000; state.najikiMode = 'client_error';
  const r = await send();
  assert.equal(r.success, false);
  assert.equal(state.refunds.length, 1);
  assert.match(state.refunds[0].p_debit_reference, /^debit_[0-9a-f-]{36}$/);
  assert.equal(state.balance, 5000, 'balance restored');
  assert.equal(last().status, 'failed_refunded');
  assert.equal(last().phone_number, '+256772123456');
});

await check('NaJiki 5xx: no refund (provider may still deliver), "failed_no_refund" row recorded', async () => {
  state.inserts = []; state.refunds = []; state.balance = 5000; state.najikiMode = 'server_error';
  const r = await send();
  assert.equal(r.success, false);
  assert.equal(state.refunds.length, 0);
  assert.equal(last().status, 'failed_no_refund');
});

await check('empty wallet: nothing is dispatched and a "failed" row is recorded', async () => {
  state.inserts = []; state.debits = []; state.balance = 0; state.najikiMode = 'ok';
  const r = await send();
  assert.equal(r.success, false);
  assert.match(r.error, /Insufficient funds/);
  assert.equal(state.debits.length, 0);
  assert.equal(last().status, 'failed');
});

await check('NaJiki contract: idempotency key in header and body, no sender override', async () => {
  state.najikiRequests = []; state.balance = 5000; state.najikiMode = 'ok';
  const r = await sendSms({
    tenantId: 't-1', recipientPhone: '0772123456', message: 'Contract check',
    eventType: 'WELCOME', idempotencyKey: 'welcome-contract-key-1',
  });
  assert.equal(r.success, true, r.error);
  const req = state.najikiRequests.at(-1);
  assert.equal(req.headers['idempotency-key'], 'welcome-contract-key-1');
  assert.equal(req.body.idempotencyKey, 'welcome-contract-key-1');
  assert.equal('from' in req.body, false, 'sender must not be overridden with the application code');
  assert.equal(req.body.to, '+256772123456');
});

server.close();
console.log(`\n${passed} checks passed`);
