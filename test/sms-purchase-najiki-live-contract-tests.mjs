/**
 * SMS purchase — end-to-end against the REAL NaJiki contract (29 checks).
 *
 * Runs the real /api/admin/sms/topup, /api/admin/sms/topup/confirm and
 * /api/webhooks/najiki handlers against a NaJiki simulator transcribed from
 * the jikiservant-cmyk/najiki-finance2 source — see
 * test/lib/sms-purchase-harness.mjs for the shared harness and its provenance.
 *
 * The database is a real Postgres (PGlite) with the repository's financial
 * migrations, bridged over a local Supabase REST/RPC stand-in. No production
 * credentials, provider endpoints, or real money are used.
 *
 * Run: node_modules/.bin/tsx test/sms-purchase-najiki-live-contract-tests.mjs
 */
import assert from 'node:assert/strict';
import { createHarness, IDS } from './lib/sms-purchase-harness.mjs';

const {
  db, server, ORIGIN, najiki, rpcLog,
  WEBHOOK_POST, callTopup, callConfirm, buy,
  deliverNajikiWebhook, signedHeaders, notificationPayload, najikiAddPaymentType,
  wallet, ledger, paymentRequests, resetDatabase, latestIntent, check, tally,
} = await createHarness();

const { TENANT_ID, TENANT_CODE, NAJIKI_API_KEY, NJ_TENANT_ID, PROVIDER_ID } = IDS;

console.log('\nSMS purchase vs. live NaJiki contract\n');

// ── 1. NaJiki as seeded today: BUY_SMS is not a payment type ─────────────────
console.log('NaJiki seed state (scripts/seed.ts)');
await resetDatabase();
await check('BUY_SMS is absent from the seeded sacco payment types', async () => {
  assert.deepEqual(najiki.paymentTypes.map((t) => t.code).sort(),
    ['account_activation', 'deposit', 'loan_repayment']);
});
await check('a purchase with no BUY_SMS payment type is refused, and the wallet cannot be credited', async () => {
  const response = await callTopup();
  assert.equal(response.status, 502, JSON.stringify(response.body));
  assert.match(response.body.error, /has no active credentials configured/i);
  assert.match(response.body.error, /no BUY_SMS payment type/i, 'the operator must be told what to fix');
  assert.match(response.body.error, /No money was taken/i);
  assert.equal(Number((await wallet()).balance), 0);
  const rows = await ledger();
  assert.equal(rows.length, 1, 'the pending row is written before the provider call');
  assert.equal(rows[0].note, 'pending');
  assert.equal(rows[0].status, null, 'the pending row carries note=pending; status stays NULL until terminal');
  assert.equal(rows[0].direction, 'credit');
  assert.equal(rows[0].type, 'sms_topup');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(najiki.createCalls.length, 1);
});
await check('Kunity sends the exact NaJiki create-payment contract', async () => {
  const sent = najiki.createCalls[0];
  assert.deepEqual(Object.keys(sent).sort(), [
    'amount', 'applicationCode', 'currency', 'externalEntityId', 'idempotencyKey',
    'metadata', 'paymentTypeCode', 'phoneNumber', 'tenantCode',
  ].sort());
  assert.equal(sent.applicationCode, 'sacco');
  assert.equal(sent.paymentTypeCode, 'BUY_SMS');
  assert.equal(sent.externalEntityId, TENANT_ID, 'externalEntityId must be the Kunity tenant id the webhook checks');
  assert.equal(sent.tenantCode, TENANT_CODE, 'NaJiki resolves tenants by code, not by uuid');
  assert.equal(sent.amount, 10000, 'the 200-credit pack is UGX 10,000 server-side');
  assert.equal(sent.currency, 'UGX');
  assert.equal(sent.phoneNumber, '+256772123456');
  assert.ok(sent.idempotencyKey.length >= 8);
  assert.equal(sent.metadata.paymentTypeCode, 'BUY_SMS', 'NaJiki echoes only metadata, never a top-level paymentType');
  assert.equal(sent.metadata.reference, sent.idempotencyKey);
});
await check('the NaJiki API key is presented as a Bearer token, never in the body', async () => {
  assert.equal(najiki.createAuthorizations[0], `Bearer ${NAJIKI_API_KEY}`);
  assert.equal(najiki.createCalls[0].apiKey, undefined);
});

// ── 1b. The dangerous variant: the SACCO has tenant credentials ─────────────
console.log('\nUnseeded BUY_SMS with tenant credentials configured');
najiki.tenantCredentials.set(NJ_TENANT_ID, [{ providerId: PROVIDER_ID }]);
await resetDatabase();
await check('the payment is accepted, but as a TENANT collection — not a platform fee', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const intent = await latestIntent();
  assert.equal(intent.paymentTypeId, null, 'NaJiki cannot attach a payment type it does not have');
  assert.equal(intent.isPlatformPayment, false, 'an unknown code is treated as tenant money');
  assert.equal(intent.tenantId, NJ_TENANT_ID);
});
najiki.tenantCredentials.clear();
await resetDatabase();

// ── 2. With BUY_SMS configured: the full purchase works ──────────────────────
console.log('\nBuying SMS with the payment type configured');
najikiAddPaymentType('BUY_SMS');
await resetDatabase();
await check('the top-up is accepted end-to-end and returns NaJiki\'s reference', async () => {
  const purchase = await callTopup();
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  const intent = await latestIntent();
  assert.ok(intent, 'NaJiki must have created an intent');
  assert.equal(intent.paymentTypeId, 'pt-BUY_SMS', 'the payment type must resolve, not be null');
  assert.equal(intent.isPlatformPayment, true, 'BUY_SMS must be classified as a platform fee');
  assert.equal(purchase.body.intentId, intent.reference);
});
await check('as a platform fee, no per-tenant credentials are required', async () => {
  assert.equal(najiki.tenantCredentials.size, 0);
  assert.equal((await latestIntent()).isPlatformPayment, true);
});
await check('the pending ledger row is relinked to NaJiki\'s reference and stays pending', async () => {
  const intent = await latestIntent();
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, intent.reference);
  assert.notEqual(rows[0].reference, intent.idempotencyKey);
  assert.equal(rows[0].note, 'pending');
  assert.equal(rows[0].status, null);
});
await check('the purchase is recorded in payment_requests as BUY_SMS', async () => {
  const rows = await paymentRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_type, 'BUY_SMS');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].internal_reference, (await latestIntent()).reference);
  assert.equal(rows[0].member_id, null, 'an SMS top-up is an organization purchase, not a member payment');
});

await check('all four server packs are sent at their configured price', async () => {
  for (const pack of [
    { credits: 200, price: 10000 },
    { credits: 500, price: 25000 },
    { credits: 1200, price: 50000 },
    { credits: 3000, price: 100000 },
  ]) {
    await resetDatabase();
    const response = await callTopup(buy(pack.credits));
    assert.equal(response.status, 200, `${pack.credits} credits: ${JSON.stringify(response.body)}`);
    assert.equal((await latestIntent()).amount, pack.price, `${pack.credits} credits`);
  }
});
await resetDatabase();
await callTopup();

// ── 3. The real NaJiki notification credits the SACCO SMS wallet ─────────────
console.log('\nWebhook: NaJiki success notification');
await check('a correctly signed success notification credits exactly the pack price', async () => {
  const intent = await latestIntent();
  const before = Number((await wallet()).balance);
  const result = await deliverNajikiWebhook(intent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.message, 'SMS Topup credited');
  assert.equal(Number((await wallet()).balance), before + 10000);
  const row = (await ledger())[0];
  assert.equal(row.note, 'success');
  assert.equal(row.status, 'success');
  assert.equal(result.attempts, 1, 'a successful delivery must not be retried');
  assert.equal(rpcLog.filter((c) => c.fn === 'credit_sms_wallet_idempotent').length, 1);
});
await check('the payment_requests row is moved to success by the real SQL RPC', async () => {
  const rows = await paymentRequests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success');
  assert.ok(rows[0].completed_at);
  assert.equal(rows[0].journal_entry_id, null, 'BUY_SMS never posts a SACCO journal entry');
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM kunity.journal_entries');
  assert.equal(journal.rows[0].n, 0);
});
await check('NaJiki\'s retry of the same notification cannot double-credit', async () => {
  const intent = await latestIntent();
  const before = Number((await wallet()).balance);
  const result = await deliverNajikiWebhook(intent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.message, /Already processed/i);
  assert.equal(Number((await wallet()).balance), before);
  assert.equal(rpcLog.filter((c) => c.fn === 'credit_sms_wallet_idempotent').length, 1);
});
await check('a replayed 200 is not retried by NaJiki (no 5xx)', async () => {
  assert.equal(najiki.deliveries.at(-1).attempts, 1);
});

// ── 4. Failed collection ─────────────────────────────────────────────────────
console.log('\nWebhook: NaJiki failure notification');
await resetDatabase();
await check('a failed payment marks the top-up failed and credits nothing', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const intent = await latestIntent();
  const result = await deliverNajikiWebhook(intent, 'failed');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
  const row = (await ledger())[0];
  assert.equal(row.note, 'failed');
  assert.equal(row.status, 'failed');
  assert.equal((await paymentRequests())[0].status, 'failed');
});
await check('a late success callback cannot resurrect a failed top-up', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success');
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});

// ── 5. Signature / replay protections on the live header format ──────────────
console.log('\nWebhook authentication');
await resetDatabase();
await callTopup();
await check('an unsigned notification is rejected and credits nothing', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a tampered amount invalidates the signature', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const raw = JSON.stringify(payload);
  const headers = signedHeaders(raw);
  const tampered = JSON.stringify({ ...payload, amount: 1 });
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers, body: tampered,
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a signature older than 5 minutes is rejected (replay window)', async () => {
  const intent = await latestIntent();
  const payload = notificationPayload(intent, 'success');
  const raw = JSON.stringify(payload);
  const stale = Date.now() - 6 * 60 * 1000;
  const result = await WEBHOOK_POST(new Request(`${ORIGIN}/api/webhooks/najiki`, {
    method: 'POST', headers: signedHeaders(raw, stale), body: raw,
  }));
  assert.equal(result.status, 401);
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature with a mismatched amount is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', { amount: 5000 });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature with a mismatched currency is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', { currency: 'USD' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a valid signature attributed to another tenant is refused', async () => {
  const result = await deliverNajikiWebhook(await latestIntent(), 'success', {
    externalEntityId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /tenant mismatch/i);
  assert.equal(Number((await wallet()).balance), 0);
});

// ── 6. Callback racing the create response ──────────────────────────────────
console.log('\nWebhook: callback arriving before the create response');
await resetDatabase();
najiki.mode = 'callback_before_response';
await check('the callback is credited via metadata.reference before the reference is linked', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.intent.status, 'success', 'the route must reflect the terminal callback');
  assert.equal(Number((await wallet()).balance), 10000);
  const intent = await latestIntent();
  const rows = await ledger();
  assert.equal(rows[0].reference, intent.reference);
  assert.equal(rows[0].note, 'success');
  const pr = (await paymentRequests())[0];
  assert.equal(pr.status, 'success');
  assert.equal(pr.internal_reference, intent.reference);
});

// ── 6b. The dashboard's confirm poll ─────────────────────────────────────────
console.log('\nConfirm path (dashboard polling)');
await resetDatabase();
let confirmedIntent;
await check('the confirm poll credits the wallet from NaJiki\'s status endpoint', async () => {
  const response = await callTopup();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  confirmedIntent = await latestIntent();
  confirmedIntent.status = 'success'; // mobile money completed; no webhook yet
  const confirmed = await callConfirm(confirmedIntent.reference);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.success, true);
  assert.equal(Number((await wallet()).balance), 10000);
  assert.equal((await ledger())[0].note, 'success');
});
await check('a confirm-first success is reflected in payment_requests', async () => {
  assert.equal((await paymentRequests())[0].status, 'success');
});
await check('a late webhook after a confirm credit does not double-credit', async () => {
  const result = await deliverNajikiWebhook(confirmedIntent, 'success');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(Number((await wallet()).balance), 10000);
});

// ── 7. The SQL function is the only thing that moves the balance ─────────────
console.log('\ncredit_sms_wallet_idempotent');
await resetDatabase();
await callTopup();
await check('a mismatched amount is rejected at the database level', async () => {
  const row = (await ledger())[0];
  await assert.rejects(
    db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 999]),
    /Amount does not match/,
  );
  assert.equal(Number((await wallet()).balance), 0);
});
await check('a debit row cannot be credited as a top-up', async () => {
  await db.query(`UPDATE public.wallet_transactions SET direction='debit', type='sms_debit' WHERE id=$1`, [(await ledger())[0].id]);
  const row = (await ledger())[0];
  await assert.rejects(
    db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]),
    /not a tenant-bound SMS top-up credit/,
  );
  assert.equal(Number((await wallet()).balance), 0);
});
await check('replaying the credit returns the wallet without adding the amount twice', async () => {
  await db.query(`UPDATE public.wallet_transactions SET direction='credit', type='sms_topup' WHERE id=$1`, [(await ledger())[0].id]);
  const row = (await ledger())[0];
  await db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]);
  const afterFirst = Number((await wallet()).balance);
  await db.query('SELECT * FROM public.credit_sms_wallet_idempotent($1,$2,$3)', [row.wallet_id, row.id, 10000]);
  assert.equal(Number((await wallet()).balance), afterFirst);
  assert.equal(afterFirst, 10000);
});

// ── summary ──────────────────────────────────────────────────────────────────
await new Promise((resolve) => server.close(resolve));
await db.close();
const { passed, failed } = tally;
console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
