/**
 * Currency validation check for the actual payment-intent route.
 * Local Auth/Supabase/NaJiki stand-ins only; no provider or production services.
 * Run: node_modules/.bin/tsx test/payment-intent-currency-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { NextRequest } from 'next/server';

const TOKEN = 'member-token';
const gatewayCalls = [];
const paymentRows = [];
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://local.test');
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const wantsObject = String(req.headers.accept || '').includes('pgrst.object');

  if (url.pathname === '/auth/v1/user') {
    return req.headers.authorization === `Bearer ${TOKEN}`
      ? json(200, { id: 'member-a', email: 'member@example.test', aud: 'authenticated' })
      : json(401, { message: 'invalid token' });
  }
  if (url.pathname === '/rest/v1/members') {
    const row = { id: 'member-a', organization_id: 'org-a', status: 'active' };
    return json(200, wantsObject ? row : [row]);
  }
  if (url.pathname === '/rest/v1/tenants') {
    const row = { code: 'sacco-a' };
    return json(200, wantsObject ? row : [row]);
  }
  if (req.method === 'POST' && url.pathname === '/api/payments') {
    gatewayCalls.push(body);
    return json(200, { reference: `NJ-INTENT-${gatewayCalls.length}`, status: 'pending' });
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/payment_requests') {
    paymentRows.push(body);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('');
    return;
  }
  return json(404, { message: `No mock for ${req.method} ${url.pathname}` });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-service-role-test';
process.env.NAJIKI_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.NAJIKI_API_KEY = 'local-najiki-key';

const { POST } = await import('../app/api/payments/intent/route.ts');
const call = async (currency) => {
  const payload = {
    amount: 2000,
    ...(currency === undefined ? {} : { currency }),
    phoneNumber: '+256772123456',
    paymentTypeCode: 'deposit',
    memberId: 'member-a',
  };
  const request = new NextRequest('http://localhost:3000/api/payments/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
};

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}: ${error.message}`);
    throw error;
  }
};

await check('foreign currency is rejected before gateway or database writes', async () => {
  const result = await call('USD');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /UGX/);
  assert.equal(gatewayCalls.length, 0);
  assert.equal(paymentRows.length, 0);
});
await check('UGX request succeeds and stores the same enforced currency', async () => {
  const result = await call('UGX');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(gatewayCalls.length, 1);
  assert.equal(gatewayCalls[0].currency, 'UGX');
  assert.equal(paymentRows.length, 1);
  assert.equal(paymentRows[0].currency, 'UGX');
});
await check('omitted currency safely defaults to UGX', async () => {
  const result = await call(undefined);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(gatewayCalls.length, 2);
  assert.equal(gatewayCalls[1].currency, 'UGX');
  assert.equal(paymentRows[1].currency, 'UGX');
});

server.close();
console.log(`\nRESULT: ${passed} passed, 0 failed`);
