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
import { existsSync, readFileSync } from 'node:fs';

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

// ── 1. No hardcoded price list: the DB rate is the only price source ─────────
check('the hardcoded SMS pack/bundle price list is gone', () => {
  assert.equal(
    existsSync(new URL('../lib/sms-packs.ts', import.meta.url)),
    false,
    'lib/sms-packs.ts still exists'
  );
  assert.ok(!admin.includes('SMS_BUNDLES'), 'the admin console still declares a bundle price list');
  assert.ok(!admin.includes('SMS_PACKS'), 'a hardcoded pack list is still declared');
});

check('the admin UI sends a credit count and shows the DB-derived price', () => {
  assert.match(admin, /normalizeSmsCredits\(Number\(buyCredits\)\)/);
  assert.match(admin, /smsPriceForCredits\(parsedBuyCredits, smsRate\)/);
  assert.match(admin, /credits:\s*parsedBuyCredits/);
  assert.match(admin, /per SMS/);
  assert.doesNotMatch(admin, /price:\s*\d{3,}/, 'a hardcoded price is still present in the UI');
});

// ── 2. The admin checkout uses the member portal's visual language ───────────
// The sheet is a literal copy of the member deposit sheet, so the design is
// asserted against the exact values in app/member/page.tsx — not approximations.
const DEPOSIT_SHEET = member.slice(
  member.indexOf("activeModal === 'deposit' || activeModal === 'withdraw'"),
  member.indexOf('</form>', member.indexOf("activeModal === 'deposit' || activeModal === 'withdraw'"))
);
const ADMIN_SHEET = admin.slice(
  admin.indexOf('SHEET: MOBILE MONEY SMS CHECKOUT'),
  admin.indexOf('</form>', admin.indexOf('SHEET: MOBILE MONEY SMS CHECKOUT'))
);
const ADMIN_DESIGN = ADMIN_SHEET;

check('the admin sheet carries the member deposit sheet colours verbatim', () => {
  for (const colour of ['#F3E8D5', '#EAE0CC', '#A76C47', '#3A271C', '#887563', '#FCFAEE', '#A5927D', '#2B1A11', '#FCFAEE']) {
    assert.ok(DEPOSIT_SHEET.includes(colour), `member sheet no longer has ${colour}`);
    assert.ok(ADMIN_SHEET.includes(colour), `admin sheet is missing ${colour}`);
  }
});

check('the admin sheet carries the member deposit sheet metrics verbatim', () => {
  for (const metric of [
    'maxWidth: 400',
    'borderTopLeftRadius: 36',
    'padding: \'36px 28px 24px\'',
    "boxShadow: '0 -10px 40px rgba(0,0,0,0.2)'",
    'height: 54',
    'height: 56',
    'borderRadius: 16',
    "letterSpacing: '0.05em'",
  ]) {
    assert.ok(DEPOSIT_SHEET.includes(metric.replace(/\\'/g, "'")), `member sheet no longer has ${metric}`);
    assert.ok(ADMIN_DESIGN.includes(metric.replace(/\\'/g, "'")), `admin sheet is missing ${metric}`);
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

check('the sheet has the member field-with-icon, a free quantity field and the dark confirm button', () => {
  assert.match(ADMIN_SHEET, /<Phone size=\{18\} color="#A5927D" \/>/);
  assert.match(ADMIN_SHEET, /type="number"/);
  assert.match(ADMIN_SHEET, /min=\{SMS_MIN_CREDITS\}/);
  assert.match(ADMIN_SHEET, /per SMS/);
  assert.match(ADMIN_SHEET, /\{isProcessingBuy \? 'PROCESSING\.\.\.' : 'CONFIRM & PAY'\} <CheckCircle2 size=\{16\} \/>/);
  assert.match(ADMIN_SHEET, /You will receive a PIN prompt on your phone\./);
  assert.match(ADMIN_SHEET, />\s*CANCEL\s*</);
});

check('the admin sheet uses the same tile, heading and info-line structure as the member sheet', () => {
  for (const shared of [
    '<CreditCard size={22} color="#A76C47" />',
    'borderTopLeftRadius: 36',
    "fontFamily: 'serif'",
    'textAlign: \'center\', fontSize: 11, color: \'#A5927D\'',
  ]) {
    const needle = shared.replace(/\\'/g, "'");
    assert.ok(DEPOSIT_SHEET.includes(needle), `member sheet no longer has ${needle}`);
    assert.ok(ADMIN_SHEET.includes(needle), `admin sheet is missing ${needle}`);
  }
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
  assert.match(body, /credits:\s*parsedBuyCredits/);
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

check('the admin sheet submits through a form and blocks closing while sending', () => {
  assert.match(ADMIN_SHEET, /<form/);
  assert.match(ADMIN_SHEET, /type="submit"/);
  assert.match(admin, /const closeBuySheet = \(\) => \{\s*if \(isProcessingBuy\) return;/);
  assert.match(ADMIN_SHEET, /onClick=\{closeBuySheet\}/);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
