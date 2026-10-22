/**
 * Regression checks for member SMS (welcome on join, receipts on payment).
 * Run: node test/sms-notifications-tests.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { LOW_SMS_BALANCE_CREDITS } from '../lib/sms-alerts.ts';
import { validateTemplatePlaceholders, SMS_EVENTS } from '../lib/sms-templates.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok - ${name}`); };

console.log('member SMS regression checks');

check('welcome SMS is sent only by the request that created the member row', () => {
  const s = read('app/api/auth/profile/route.ts');
  assert.match(s, /const createdHere = !insertErr;/);
  assert.match(s, /if \(phone && createdHere\) \{/);
});

check('welcome SMS carries a deduplication id', () => {
  assert.match(read('app/api/auth/profile/route.ts'), /idempotencyKey: `welcome-\$\{authenticatedUserId\}`/);
});

for (const f of ['app/api/webhooks/najiki/route.ts']) {
  check(`${f}: deposit SMS has a per-payment deduplication id`, () => {
    assert.match(read(f), /idempotencyKey: `deposit-sms-\$\{(reference|internal_reference)\}`/);
  });
  check(`${f}: activation payments get a receipt, not a "credited" deposit alert`, () => {
    const s = read(f);
    assert.match(s, /const isActivation = depInfo\.payment_type === 'account_activation'/);
    assert.match(s, /PAY-ACT-/);
    assert.match(s, /membership activation fee of UGX/);
    assert.match(s, /eventType: isActivation \? 'ACTIVATION_RECEIPT' : 'DEPOSIT_ALERT'/);
  });
}

check('ACTIVATION_RECEIPT is a known event with its own placeholders', () => {
  assert.ok(SMS_EVENTS.ACTIVATION_RECEIPT);
  const ok = 'Dear {{first_name}}, fee of UGX {{amount}}. TxRef: {{tx_ref}}.';
  assert.deepEqual(validateTemplatePlaceholders('ACTIVATION_RECEIPT', ok), []);
  assert.deepEqual(validateTemplatePlaceholders('ACTIVATION_RECEIPT', '{{payment_type}}'), ['{{payment_type}}']);
});

check('failed-send ledger rows store the normalised phone, not the raw input', () => {
  const s = read('lib/sms.ts');
  assert.doesNotMatch(s, /phone_number: recipientPhone,/);
  assert.match(s, /phone_number: cleanPhone,/);
});

check('welcome SMS no longer claims "pending verification"', () => {
  const s = read('app/api/auth/profile/route.ts');
  assert.doesNotMatch(s, /pending verification/);
  assert.match(s, /membership application has been received/);
});

check('successful SMS sends are logged in sms_messages with status sent', () => {
  const s = read('lib/sms.ts');
  assert.match(s, /status: 'sent'/);
  assert.match(s, /Sent-message log insert failed/);
});

check('LivePay webhook is disabled (410) and its provider file is removed', () => {
  const s = read('app/api/webhooks/livepay/route.ts');
  assert.match(s, /status: 410/);
  assert.doesNotMatch(s, /inngest|sms\/dispatch|process_livepay/);
  assert.equal(existsSync(new URL('../lib/payments/live-pay-provider.ts', import.meta.url)), false);
});

check('admin dashboard reports low SMS balance and shows a warning', () => {
  assert.match(read('app/api/admin/data/route.ts'), /smsLowBalance: walletBalance < smsRate \* LOW_SMS_BALANCE_CREDITS/);
  assert.equal(LOW_SMS_BALANCE_CREDITS, 50);
  // The console reads the flag from the API and forwards it to the overview panel,
  // which renders the announced (role="alert") low-balance notice.
  assert.match(read('app/admin/AdminConsole.tsx'), /setSmsLowBalance\(!!data\.smsLowBalance\)/);
  assert.match(read('app/admin/AdminConsole.tsx'), /smsLowBalance=\{smsLowBalance\}/);
  const overview = read('app/admin/AdminOverview.tsx');
  assert.match(overview, /smsLowBalance &&/);
  assert.match(overview, /role="alert"[\s\S]{0,200}(SMS|sms)[\s\S]{0,80}(running low|balance)/);
});

console.log(`\n${passed} checks passed`);
