/**
 * Contract checks between Kunity and NaJiki (github.com/jikiservant-cmyk/najiki-finance2).
 *
 * The signer below mirrors NaJiki's src/lib/notification-signature.ts (buildNotificationHeaders)
 * at provider revision 6d55d75369af05d9bd1fa529205e4d51eb213c8c. Fixtures match the current
 * notification builders in src/lib/payments.ts and src/lib/sms-queue.ts. The real Kunity route runs against them.
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

const API_KEY = 'najiki-application-api-key';
const WEBHOOK_SECRET = 'najiki-dedicated-webhook-secret';
process.env.NAJIKI_API_KEY = API_KEY;
process.env.NAJIKI_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-test';

// Stand-in for the Supabase RPC used by the payment path; only reached after the signature passes.
const rpcCalls = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  rpcCalls.push({ url: req.url, body: raw });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // A SMS debit lookup returns the linked wallet debit; everything else returns an empty object.
  if (req.url.includes('/wallet_transactions')) {
    res.end(JSON.stringify({ wallet_id: 'wallet-a', amount: 50, reference: 'debit-source-1' }));
  } else {
    res.end('{}');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;

const { POST } = await import('../app/api/webhooks/najiki/route.ts');

// Exact bare payment-notification shape produced by NaJiki's enqueueWebhookNotification.
// Notably, paymentTypeCode is echoed in metadata and the current schema has no fee field.
const paymentBody = JSON.stringify({
  paymentIntentId: '7b1c1f4e-3a2b-4c5d-8e9f-0a1b2c3d4e5f',
  reference: 'SACCO-DEP-ABC123',
  status: 'success',
  amount: 10000,
  currency: 'UGX',
  providerPaymentId: 'LP-1',
  failureReason: null,
  externalEntityId: 'member-123',
  tenantId: 'tenant-a',
  tenantCode: 'sacco-a',
  metadata: { memberId: 'member-123', organizationId: 'tenant-a', paymentTypeCode: 'deposit' },
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
  const before = rpcCalls.length;
  const res = await post(paymentBody, najikiNotificationHeaders(WEBHOOK_SECRET, paymentBody));
  assert.equal(res.status, 200, 'a correctly signed NaJiki notification must be accepted');
  const rpc = rpcCalls.slice(before).find((call) => call.url.includes('/rpc/process_najiki_webhook'));
  assert.ok(rpc, 'the provider notification must reach Kunity\'s payment RPC');
  const args = JSON.parse(rpc.body);
  assert.equal(args.p_reference, 'SACCO-DEP-ABC123');
  assert.equal(args.p_status, 'success');
  assert.equal(args.p_amount, 10000);
  assert.equal(args.p_external_entity_id, 'member-123');
  assert.equal(args.p_payment_type, 'deposit', 'Kunity must read the type from metadata.paymentTypeCode');
  assert.equal(args.p_fee, 0, 'NaJiki\'s current notification schema omits fee');
  assert.deepEqual(args.p_payload, JSON.parse(paymentBody));
  ok('the current bare NaJiki payment notification is verified and mapped into the ledger RPC');
}
{
  const res = await post(paymentBody, najikiNotificationHeaders('wrong-secret', paymentBody));
  assert.equal(res.status, 401);
  ok('wrong secret -> 401');
}
{
  // Current NaJiki setup stores a distinct webhook secret. The API key must not
  // accidentally authenticate a callback while that dedicated secret is set.
  const res = await post(paymentBody, najikiNotificationHeaders(API_KEY, paymentBody));
  assert.equal(res.status, 401);
  ok('API key is not accepted when a dedicated NaJiki webhook secret is configured -> 401');
}
{
  // Compatibility for legacy NaJiki rows that have no encrypted webhook secret.
  const saved = process.env.NAJIKI_WEBHOOK_SECRET;
  delete process.env.NAJIKI_WEBHOOK_SECRET;
  const res = await post(paymentBody, najikiNotificationHeaders(API_KEY, paymentBody));
  process.env.NAJIKI_WEBHOOK_SECRET = saved;
  assert.equal(res.status, 200);
  ok('legacy NaJiki application without a separate secret falls back to its API key');
}
{
  const tampered = paymentBody.replace('"amount":10000', '"amount":99999');
  const res = await post(tampered, najikiNotificationHeaders(WEBHOOK_SECRET, paymentBody));
  assert.equal(res.status, 401);
  ok('body changed after signing -> 401');
}
{
  const old = Date.now() - 10 * 60 * 1000;
  const res = await post(paymentBody, najikiNotificationHeaders(WEBHOOK_SECRET, paymentBody, old));
  assert.equal(res.status, 401);
  ok('signature older than 5 minutes (replay) -> 401');
}
{
  const h = najikiNotificationHeaders(WEBHOOK_SECRET, paymentBody);
  delete h['X-Najiki-Timestamp'];
  const res = await post(paymentBody, h);
  assert.equal(res.status, 401);
  ok('missing timestamp header -> 401');
}
{
  // The format Kunity used before: a bare HMAC of the body, no timestamp, no t=,v= prefix.
  const bare = createHmac('sha256', WEBHOOK_SECRET).update(paymentBody).digest('hex');
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
  const res = await post(smsBody, najikiNotificationHeaders(WEBHOOK_SECRET, smsBody));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).eventType, 'SMS_DELIVERY_UPDATE');
  assert.equal(rpcCalls.slice(before).filter((c) => !c.url.includes('wallet_transactions') && !c.url.includes('refund_sms_wallet')).length, 0, 'an SMS update must not touch payment processing');
  ok('signed SMS_DELIVERY_UPDATE is acknowledged (200) and never processed as a payment');
}
{
  const res = await post(smsBody, najikiNotificationHeaders('wrong', smsBody));
  assert.equal(res.status, 401);
  ok('unsigned SMS update is still rejected');
}
{
  const failedBody = JSON.stringify({
    eventType: 'SMS_DELIVERY_UPDATE', smsId: 'cm456', reference: 'SACCO-SMS-2',
    status: 'failed', error: 'AT rejected', recipient: '+256772123456', applicationCode: 'sacco',
  });
  const before = rpcCalls.length;
  const res = await post(failedBody, najikiNotificationHeaders(WEBHOOK_SECRET, failedBody));
  assert.equal(res.status, 200);
  const refund = rpcCalls.slice(before).find((c) => c.url.includes('/rpc/refund_sms_wallet'));
  assert.ok(refund, 'a failed SMS must call refund_sms_wallet');
  const args = JSON.parse(refund.body);
  assert.equal(args.p_reference, 'refund_najiki_cm456');
  assert.equal(args.p_amount, 50);
  assert.equal(args.p_wallet_id, 'wallet-a');
  assert.equal(args.p_debit_reference, 'debit-source-1');
  ok('failed SMS_DELIVERY_UPDATE refunds the linked debit once (idempotent reference)');
}
{
  const before = rpcCalls.length;
  const res = await post(smsBody, najikiNotificationHeaders(WEBHOOK_SECRET, smsBody));
  assert.equal(res.status, 200);
  assert.equal(rpcCalls.slice(before).filter((c) => c.url.includes('refund_sms_wallet')).length, 0);
  ok('delivered SMS_DELIVERY_UPDATE does not refund');
}

console.log('Member polling and admin confirm send the tenant code NaJiki scopes by');
{
  const { readFileSync } = await import('node:fs');
  const poll = readFileSync(new URL('../app/api/payments/[intentId]/route.ts', import.meta.url), 'utf8');
  const confirm = readFileSync(new URL('../app/api/admin/sms/topup/confirm/route.ts', import.meta.url), 'utf8');
  assert.match(poll, /tenantCode=\$\{encodeURIComponent\(tenantCode\)\}/);
  ok('member polling GET passes tenantCode (NaJiki returns 404 for a tenant-scoped intent without it)');
  assert.match(confirm, /tenantCode/);
  ok('admin confirm GET references tenantCode');
}

console.log('Payment codes match the NaJiki provider contract (src/lib/constants.ts, scripts/seed.ts)');
{
  // Snapshot from najiki-finance2 revision 6d55d75369af05d9bd1fa529205e4d51eb213c8c.
  // NaJiki resolves the type row by exact application-scoped code, then classifies platform fees by upper-case code.
  const NAJIKI_PLATFORM_FEE_TYPES = ['SMS','BUY_SMS','SMS_TOPUP','ACTIVATION','ACCOUNT_ACTIVATION','SUBSCRIPTION','MONTHLY_SUBSCRIPTION','PLATFORM_FEE'];
  // The sacco application's payment types as seeded in NaJiki.
  const NAJIKI_SACCO_SEEDED_TYPES = ['deposit', 'loan_repayment', 'account_activation'];
  // Kunity may send BUY_SMS, which is a platform code but is NOT seeded for sacco. It must be
  // created in NaJiki before top-ups are classified as platform fees (see the notes in the PR).
  const KUNITY_SENT_TYPES = ['deposit', 'account_activation', 'BUY_SMS'];

  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const sources = [...walk(new URL('../app', import.meta.url).pathname), ...walk(new URL('../lib', import.meta.url).pathname)];
  const found = new Set();
  for (const f of sources) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/paymentTypeCode:\s*'([A-Za-z_]+)'/g)) found.add(m[1]);
    for (const m of text.matchAll(/payment_type:\s*'([A-Za-z_]+)'/g)) found.add(m[1]);
  }
  for (const code of found) {
    assert.ok(KUNITY_SENT_TYPES.includes(code), `Kunity sends an unexpected payment code: ${code}`);
  }
  ok(`every payment code Kunity sends is one NaJiki knows: ${[...found].join(', ')}`);

  for (const code of ['deposit', 'loan_repayment', 'account_activation']) {
    assert.ok(NAJIKI_SACCO_SEEDED_TYPES.includes(code));
  }
  assert.equal(NAJIKI_PLATFORM_FEE_TYPES.includes('ACCOUNT_ACTIVATION'), true);
  assert.equal(NAJIKI_PLATFORM_FEE_TYPES.includes('DEPOSIT'), false);
  ok('deposit and account_activation match NaJiki seeded types; activation is a platform fee, deposit is tenant collection');
  assert.equal(NAJIKI_PLATFORM_FEE_TYPES.includes('BUY_SMS'), true);
  assert.equal(NAJIKI_SACCO_SEEDED_TYPES.includes('BUY_SMS'), false);
  ok('BUY_SMS is a platform fee code, but the current sacco seed omits its required payment-type row');
}

server.close();
console.log(`\n${passed} NaJiki contract checks passed`);
