// -----------------------------------------------------------------------------
// Signup completion + virtual account card — static wiring checks.
//
// Part 1 (app/auth/page.tsx): "Finish Setup" must complete the registration
// and hand the member to the LOGIN screen (signed out, success banner), never
// re-run signup ("User already registered"). Includes the email-confirmation
// branch (sign-up without a session) and the friendly already-registered path.
//
// Part 2 (app/member/page.tsx): the virtual account card follows the reference
// debit-card design — dark gradient, chip, contactless, member number, the
// SACCO's name as the brand, the member's name as cardholder — while the
// wallet balance (with its show/hide toggle and the savings/loan figures)
// survives directly beneath it.
//
// Run: node test/signup-completion-and-card-tests.mjs
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const auth = readFileSync(join(ROOT, 'app', 'auth', 'page.tsx'), 'utf8');
const member = readFileSync(join(ROOT, 'app', 'member', 'page.tsx'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('Signup completion (app/auth/page.tsx)');

check(
  'after successful setup the session is signed out before redirecting',
  /await supabase\.auth\.signOut\(\)/.test(auth)
);

check(
  'registration redirects to the login screen (?registered=1), not the dashboard',
  /router\.push\('\/auth\?registered=1'\)/.test(auth)
);

check(
  'the register branch no longer auto-pushes /member directly (login branch keeps its role-based push)',
  !/setTimeout\(\(\) => \{\s*router\.push\('\/member'\);/.test(auth)
);

check(
  'login screen shows a success banner for ?registered=1',
  /registered'\) === '1'/.test(auth) && /Account created!/.test(auth)
);

check(
  '"User already registered" becomes a friendly nudge to sign in (mode flips to login)',
  /already registered|already exists/i.test(auth) &&
  /An account with this email already exists/.test(auth)
);

check(
  'sign-up without a session (email confirmation on) explains the next step instead of a 401',
  /Check your email to confirm/.test(auth)
);

console.log('Virtual account card (app/member/page.tsx)');

check(
  'card uses the reference debit-card aspect ratio 1.586 / 1',
  /aspectRatio:\s*"1\.586 \/ 1"/.test(member)
);

check(
  'card background is the exact reference gradient',
  /linear-gradient\(135deg, #252a30, #11151a 65%, #20252b\)/.test(member)
);

check(
  'rotated ellipse decorations present (two, with the reference shadows)',
  (member.match(/rotate\(-35deg\)/g) || []).length >= 2 &&
  /0 0 0 32px rgba\(255,255,255,\.018\)/.test(member)
);

check(
  'SACCO name is the card brand (fallback Kunity), first letter as the brand mark',
  /member\?\.organization\?\.name \|\| 'Kunity'/.test(member) &&
  /saccoName\[0\] \|\| 'K'/.test(member)
);

check(
  'card type label reads DEBIT CARD',
  /DEBIT CARD/.test(member)
);

check(
  'gold chip with the reference gradient and etched lines',
  /linear-gradient\(135deg, #ffe9a1, #d7ae48\)/.test(member) &&
  member.includes('9e803c')
);

check(
  'contactless indicator is the rotated ))) glyph',
  /rotate\(90deg\)/.test(member) && member.includes(')))')
);

check(
  'card number shows the member number as **** **** XXXX XXXX',
  /\*\*\*\* \*\*\*\* \$\{memberNumberRaw\.slice\(0, 4\)\}/.test(member) &&
  /member\?\.member_number \|\| member\?\.id/.test(member)
);

check(
  'cardholder is the member name, uppercased, with the CARDHOLDER label',
  /CARDHOLDER/.test(member) && /memberObj\.name\.toUpperCase\(\)/.test(member)
);

check(
  'expiry slot shows MEMBER SINCE derived from created_at',
  /MEMBER SINCE/.test(member) && /created_at/.test(member)
);

check(
  'illustrative network circles: red #eb202d + orange #ff9f0a overlapping',
  member.includes('#eb202d') && member.includes('#ff9f0a') && member.includes('marginLeft: -17')
);

check(
  'wallet balance + show/hide toggle survive beneath the card',
  /Wallet Balance/.test(member) && /setShowBal\(!showBal\)/.test(member)
);

check(
  'Main Savings / Active Loan figures survive beneath the card',
  /Main Savings/.test(member) && /Active Loan/.test(member)
);

check(
  'old "Premium Balance Card" is gone (no old gradient, no Premium label)',
  !/Premium Balance Card/.test(member) &&
  !/cRich\} 45%, \$\{T\.cMid\} 100%/.test(member) &&
  !/>Premium</.test(member)
);

check(
  'old Chip() helper removed (new card has its own chip)',
  !/function Chip\(\)/.test(member)
);

console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
if (failed) {
  console.log('SIGNUP COMPLETION + CARD: FAILURES ABOVE');
  process.exit(1);
}
console.log('SIGNUP COMPLETION + CARD: ALL CHECKS PASSED');
