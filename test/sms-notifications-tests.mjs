/**
 * Regression checks for member SMS (welcome on join, receipts on payment).
 * Run: node test/sms-notifications-tests.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(read('app/api/auth/profile/route.ts'), /id: `welcome-\$\{authenticatedUserId\}`/);
});

for (const f of ['app/api/webhooks/najiki/route.ts', 'app/api/webhooks/livepay/route.ts']) {
  check(`${f}: deposit SMS has a per-payment deduplication id`, () => {
    assert.match(read(f), /id: `deposit-sms-\$\{(reference|internal_reference)\}`/);
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

console.log(`\n${passed} checks passed`);
