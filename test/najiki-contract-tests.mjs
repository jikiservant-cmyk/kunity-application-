/**
 * Contract checks between Kunity and NaJiki (github.com/jikiservant-cmyk/najiki-finance2).
 *
 * The signer below is a copy of NaJiki's src/lib/notification-signature.ts (buildNotificationHeaders),
 * so a request built here is exactly what NaJiki sends. The real Kunity webhook route runs against it.
 *
 * Run: node_modules/.bin/tsx test/najiki-contract-tests.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// ---- NaJiki signer (copied from najiki-finance2 src/lib/notification-signature.ts) ----
function najikiNotificationHeaders(secret, payloadString, now = Date.now()) {
  const headers = { 'Content-Type': 'application/json', 'X-Najiki-Notification': 'true' };
  if (secret) {
    const signature = createHmac('sha256', secret).update(`${now}.${payloadString}`).digest('hex');
    headers['X-Najiki-Timestamp'] = String(now);
    headers['X-Najiki-Signature'] = `t=${now},v=${signature}`;
  }
  return headers;
}

const SECRET = 'najiki-shared-secret';
process.env.NAJIKI_API_KEY = SECRET;           // NaJiki falls back to the application API key
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test';

// Stand-in for the Supabase RPC used by the payment path; only reached after the signature passes.
const rpcCalls = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  rpcCalls.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;

const { POST } = await import('../app/api/webhooks/najiki/route.ts');

const paymentBody = JSON.stringify({
  paymentIntentId: '7b1c1f4e-3a2b-4c5d-8e9f-0a1b2c3d4e5f',
  reference: 'SACCO-DEP-ABC123',
  status: 'success',
  amount: 10000,
  currency: 'UGX',
  providerPaymentId: 'LP-1',
  failureReason: null,
  externalEntityId: 'tenant-a',
  metadata: { paymentTypeCode: 'BUY_SMS', organizationId: 'tenant-a' },
});
const smsBody = JSON.stringify({
  eventType: 'SMS_DELIVERY_UPDATE', smsId: 'cm123', reference: 'SACCO-SMS-1',
  status: 'delivered', providerId: 'AT-1', recipient: '+256772123456', applicationCode: 'sacco',
});

const post = (body, headers) => POST(new NextRequest('http://localhost:3000/api/webhooks/najiki', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
}));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

console.log('Webhook signature (NaJiki format)');
{
  const res = await post(paymentBody, najikiNotificationHeaders(SECRET, paymentBody));
  assert.notEqual(res.status, 401, 'a correctly signed NaJiki notification must pass verification');
  ok('a NaJiki-signed payment notification passes verification');
}
{
  const res = await post(paymentBody, najikiNotificationHeaders('wrong-secret', paymentBody));
  assert.equal(res.status, 401);
  ok('wrong secret -> 401');
}
{
  const tampered = paymentBody.replace('"amount":10000', '"amount":99999');
  const res = await post(tampered, najikiNotificationHeaders(SECRET, paymentBody));
  assert.equal(res.status, 401);
  ok('body changed after signing -> 401');
}
{
  const old = Date.now() - 10 * 60 * 1000;
  const res = await post(paymentBody, najikiNotificationHeaders(SECRET, paymentBody, old));
  assert.equal(res.status, 401);
  ok('signature older than 5 minutes (replay) -> 401');
}
{
  const h = najikiNotificationHeaders(SECRET, paymentBody);
  delete h['X-Najiki-Timestamp'];
  const res = await post(paymentBody, h);
  assert.equal(res.status, 401);
  ok('missing timestamp header -> 401');
}
{
  // The format Kunity used before: a bare HMAC of the body, no timestamp, no t=,v= prefix.
  const bare = createHmac('sha256', SECRET).update(paymentBody).digest('hex');
  const res = await post(paymentBody, { 'X-Najiki-Signature': bare });
  assert.equal(res.status, 401);
  ok('old bare-HMAC format is no longer accepted -> 401');
}
{
  const res = await post(paymentBody, {});
  assert.equal(res.status, 401);
  ok('unsigned request -> 401');
}

console.log('SMS delivery updates on the same endpoint');
{
  const before = rpcCalls.length;
  const res = await post(smsBody, najikiNotificationHeaders(SECRET, smsBody));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).eventType, 'SMS_DELIVERY_UPDATE');
  assert.equal(rpcCalls.length, before, 'an SMS update must not touch payment processing');
  ok('signed SMS_DELIVERY_UPDATE is acknowledged (200) and never processed as a payment');
}
{
  const res = await post(smsBody, najikiNotificationHeaders('wrong', smsBody));
  assert.equal(res.status, 401);
  ok('unsigned SMS update is still rejected');
}

server.close();
console.log(`\n${passed} NaJiki contract checks passed`);
