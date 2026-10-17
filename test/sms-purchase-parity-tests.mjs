/**
 * SMS purchase parity checks — admin portal vs member portal.
 *
 * The admin SMS checkout was rebuilt to be the same purchase experience members
 * get: cream bottom sheet, phone field with icon, selectable bundle grid, dark
 * CONFIRM & PAY button, then the immersive pending → success → failed PIN
 * overlay. These checks keep the two flows from drifting apart again, and — more
 * importantly — keep the displayed bundle prices in step with the server-side
 * price list, because the API re-derives the price from the credit count.
 *
 * Run: node test/sms-purchase-parity-tests.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SMS_PACKS } from '../lib/sms-packs.ts';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const admin = read('app/admin/AdminConsole.tsx');
const member = read('app/member/page.tsx');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  ok  ${name}`);
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};

console.log('SMS purchase parity checks');

// ── 1. The admin bundles must match the server price list exactly ────────────
const bundleBlock = admin.match(/const SMS_BUNDLES = \[([\s\S]*?)\] as const;/)
  ?? admin.match(/const SMS_BUNDLES = \[([\s\S]*?)\n\];/);
check('SMS_BUNDLES is declared in the admin console', () => {
  assert.ok(bundleBlock, 'SMS_BUNDLES block not found');
});

const adminBundles = [...(bundleBlock?.[1] ?? '').matchAll(
  /credits:\s*(\d+)\s*,\s*price:\s*(\d+)/g
)].map((m) => ({ credits: Number(m[1]), price: Number(m[2]) }));

check('the admin bundles are exactly the server price list (no drift, no client-chosen price)', () => {
  assert.deepEqual(adminBundles, SMS_PACKS.map((p) => ({ credits: p.credits, price: p.price })));
});

check('bulk bundles never cost more per credit than the smaller ones', () => {
  let previous = Infinity;
  for (const b of adminBundles) {
    const perCredit = b.price / b.credits;
    assert.ok(perCredit <= previous + 1e-9, `${b.credits} credits cost more per credit than the smaller bundle`);
    previous = perCredit;
  }
});

// ── 2. The admin checkout uses the member portal's visual language ───────────
check('the admin checkout uses the member cream sheet palette', () => {
  for (const token of ["sheet:   '#F3E8D5'", "field:   '#FCFAEE'", "button:  '#2B1A11'", "accent:  '#A76C47'"]) {
    assert.ok(admin.includes(token), `missing palette token ${token}`);
  }
});

check('the admin sheet is a bottom sheet with the member 36px top radius', () => {
  assert.match(admin, /borderTopLeftRadius:\s*36/);
  assert.match(admin, /maxWidth:\s*400/);
  assert.match(admin, /alignItems:\s*'flex-end'/);
});

check('the old gradient-header checkout modal is gone', () => {
  assert.ok(!admin.includes('Mobile Money SMS Checkout'), 'old modal title still present');
  assert.ok(!admin.includes('Authorize UGX'), 'old checkout button still present');
});

check('the sheet has the member field-with-icon, bundle grid and dark confirm button', () => {
  assert.match(admin, /<Phone size=\{18\} color=\{MOMO\.muted\} \/>/);
  assert.match(admin, /gridTemplateColumns:\s*'1fr 1fr'/);
  assert.match(admin, /CONFIRM &amp; PAY/);
  assert.match(admin, /You will receive a PIN prompt on your phone\./);
});

// ── 3. Same immersive overlay journey, same copy ─────────────────────────────
check('both portals render the same pending PIN prompt copy', () => {
  for (const text of [
    'Confirm on Your Phone',
    'Payment request dispatched',
    'Waiting for SIM PIN authentication...',
    'Do not close this page while processing',
  ]) {
    assert.ok(member.includes(text), `member portal lost "${text}"`);
    assert.ok(admin.includes(text), `admin portal is missing "${text}"`);
  }
});

check('both portals render the same success and failure states', () => {
  for (const text of ['Payment Successful!', 'Top-up Not Completed', 'Try Again']) {
    assert.ok(admin.includes(text), `admin portal is missing "${text}"`);
  }
  assert.ok(member.includes('Payment Successful!'));
  assert.ok(member.includes('Transaction Failed'));
});

check('the admin overlay is driven by status, not by a toast', () => {
  assert.match(admin, /status:\s*'pending'/);
  assert.match(admin, /status:\s*'success'/);
  assert.match(admin, /status:\s*'failed'/);
  // The purchase must not close itself and rely on toasts for the outcome.
  assert.ok(
    !/setToastMessage\(\{\s*type:\s*'success',\s*text:\s*'Payment requested/.test(admin),
    'the old toast-only purchase hand-off is still present'
  );
});

check('the same pulse animation name is used by both overlays', () => {
  assert.match(admin, /@keyframes kunitySmsPulse/);
  assert.match(member, /@keyframes pulseRing/);
});

// ── 4. Money-path behaviour preserved ───────────────────────────────────────
check('the admin purchase still posts credits only (never a client-chosen price)', () => {
  const call = admin.indexOf("fetch('/api/admin/sms/topup'");
  const bodyStart = admin.indexOf('body: JSON.stringify({', call);
  const bodyEnd = admin.indexOf('})', bodyStart);
  assert.ok(call > -1 && bodyStart > -1 && bodyEnd > bodyStart, 'could not locate the top-up request body');
  const body = admin.slice(bodyStart, bodyEnd);
  assert.match(body, /credits:\s*selectedPack\.credits/);
  assert.ok(!/price:/.test(body), 'the client sent a price to the server');
});

check('the purchase validates the mobile-money number before calling the API', () => {
  assert.match(admin, /const isValidMomo = \(value: string\) =>/);
  assert.match(admin, /if \(!isValidMomo\(momoNumber\)\)/);
});

check('polling still confirms idempotently and stops on a terminal answer', () => {
  assert.match(admin, /\/api\/admin\/sms\/topup\/confirm/);
  assert.match(admin, /attempt < 40/);
  assert.match(admin, /not yet successful\|Failed to verify/);
});

check('the admin sheet closes on backdrop click and blocks closing while sending', () => {
  assert.match(admin, /const closeBuySheet = \(\) => \{\s*if \(isProcessingBuy\) return;/);
  assert.match(admin, /onClick=\{closeBuySheet\}/);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
