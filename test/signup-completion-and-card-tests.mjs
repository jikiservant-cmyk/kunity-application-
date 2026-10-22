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
// survives directly beneath it. Part 3 pins the small-screen behaviour: the
// card keeps its exact dimensions while the interior is a proportional scale
// model (container-query cqw units with pinned line heights), and an exact
// numeric simulation across phone widths proves nothing can be clipped.
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
  'rotated ellipse decorations present (two, scaled with the card in cqw)',
  (member.match(/rotate\(-35deg\)/g) || []).length >= 2 &&
  /0 0 0 7cqw rgba\(255,255,255,\.018\)/.test(member) &&
  /0 0 0 13\.9cqw rgba\(255,255,255,\.015\)/.test(member)
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
  member.includes('#eb202d') && member.includes('#ff9f0a') && member.includes('-3.7cqw')
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

console.log('Card on small screens (nothing clipped, dimensions unchanged)');

check(
  'card dimensions unchanged: width cap + aspect ratio intact',
  /width: "min\(100%, 460px\)"/.test(member) && /aspectRatio: "1\.586 \/ 1"/.test(member)
);

check(
  'card is a CSS size container (containerType) — interior scales with the CARD, not the viewport',
  /containerType: "inline-size"/.test(member)
);

check(
  'padding is proportional (cqw), not fixed or viewport-clamped',
  /padding: "6\.1cqw 6\.5cqw"/.test(member)
);

check(
  'brand text, mark and label are proportional (5cqw / 6.7cqw / 2.2cqw)',
  /fontSize: "5cqw"/.test(member) && /fontSize: "6\.7cqw"/.test(member) && /fontSize: "2\.2cqw"/.test(member)
);

check(
  'chip (12.2x9.1cqw) and contactless glyph (6.7cqw) are proportional, etched lines percentage-based',
  /width: "12\.2cqw", height: "9\.1cqw"/.test(member) &&
  /left: "32%", right: "32%"/.test(member) && /top: "31%", height: "33%"/.test(member) &&
  /fontSize: "6\.7cqw", lineHeight: "8\.2cqw", transform: "rotate\(90deg\)"/.test(member)
);

check(
  'network circles proportional (9.35cqw) with proportional overlap (-3.7cqw)',
  /9\.35cqw/.test(member) && /marginLeft: "-3\.7cqw"/.test(member)
);

check(
  'EVERY text element pins lineHeight in cqw — stack height is deterministic',
  /lineHeight: "8\.2cqw"/.test(member) && /lineHeight: "6\.4cqw"/.test(member) &&
  /lineHeight: "2\.8cqw"/.test(member) && /lineHeight: "2\.5cqw"/.test(member) &&
  /lineHeight: "3\.6cqw"/.test(member) && (member.match(/lineHeight: "[\d.]+cqw"/g) || []).length >= 7
);

check(
  'long SACCO names ellipsize instead of colliding with the DEBIT CARD label',
  (member.match(/textOverflow: "ellipsis"/g) || []).length >= 2 &&
  /minWidth: 0, overflow: "hidden", textOverflow: "ellipsis"/.test(member)
);

// ---- exact layout simulation across phone widths ---------------------------
// Because every box is now a fixed cqw value (font sizes AND line heights),
// the interior stack height is deterministic — no font-metric or OS
// font-scaling guesswork. Parse the real values out of the source and prove
// the stack fits the card with slack at every width.
const num = (re, label) => {
  const m = member.match(re);
  if (!m) throw new Error('could not parse ' + label);
  return parseFloat(m[1]);
};
const padV = num(/padding: "([\d.]+)cqw [\d.]+cqw"/, 'padding');
const markLine = num(/fontSize: "6\.7cqw", lineHeight: "([\d.]+)cqw"/, 'mark line-height');
const chipTop = num(/gap: "4\.3cqw", marginTop: "([\d.]+)cqw"/, 'chip row margin');
const chipH = num(/width: "12\.2cqw", height: "([\d.]+)cqw"/, 'chip height');
const numTop = num(/marginTop: "([\d.]+)cqw", fontSize: "5cqw", lineHeight: "6\.4cqw", letterSpacing: "0\.55cqw"/, 'number margin');
const numLine = num(/fontSize: "5cqw", lineHeight: "([\d.]+)cqw", letterSpacing: "0\.55cqw"/, 'number line-height');
const bottomTop = num(/alignItems: "flex-end", marginTop: "([\d.]+)cqw"/, 'bottom row margin');
const labelLine = num(/fontSize: "1\.96cqw", lineHeight: "([\d.]+cqw)"/, 'label line-height');
const labelMB = num(/marginBottom: "([\d.]+)cqw"\s*\}\}>CARDHOLDER/, 'label margin');
const nameLine = num(/fontSize: "2\.83cqw", lineHeight: "([\d.]+)cqw", letterSpacing: "0\.4cqw"/, 'name line-height');
const sinceTop = num(/marginTop: "([\d.]+)cqw", fontSize: "2\.83cqw"/, 'since margin');
const sinceLine = num(/fontSize: "2\.83cqw", lineHeight: "([\d.]+)cqw", letterSpacing: "1px"/, 'since line-height');

// Row heights (cqw): each flex row is its tallest fixed box.
const brandRow = markLine;                                  // mark line box is tallest
const chipRow = chipTop + chipH;
const numberRow = numTop + numLine;
const bottomRow = bottomTop + labelLine + labelMB + nameLine + sinceTop + sinceLine;
const stack = brandRow + chipRow + numberRow + bottomRow;
const innerHeight = 100 / 1.586 - 2 * padV;
const slack = innerHeight - stack;

check(
  `interior stack fits the card with >=1.5cqw slack (stack ${stack.toFixed(2)}cqw of ${innerHeight.toFixed(2)}cqw available, slack ${slack.toFixed(2)}cqw)`,
  slack >= 1.5,
  `stack ${stack.toFixed(2)}cqw, available ${innerHeight.toFixed(2)}cqw`
);

let simOk = true;
const simDetail = [];
for (const w of [300, 320, 360, 375, 390, 412, 428, 460]) {
  const cardH = w / 1.586;
  const box = cardH - 2 * (padV / 100) * w;
  const content = (stack / 100) * w;
  const fits = content <= box - (1.5 / 100) * w;
  if (!fits) simOk = false;
  simDetail.push(`${w}px: content ${content.toFixed(1)}px in ${box.toFixed(1)}px box`);
}
console.log('      simulation: ' + simDetail.join(' | '));
check(
  'every row fits at real phone widths 300-460px (deterministic — line heights are pinned)',
  simOk
);

console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
if (failed) {
  console.log('SIGNUP COMPLETION + CARD: FAILURES ABOVE');
  process.exit(1);
}
console.log('SIGNUP COMPLETION + CARD: ALL CHECKS PASSED');
