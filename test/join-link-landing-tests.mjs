// -----------------------------------------------------------------------------
// Join-link landing page wiring (/auth?sacco=<code>) — static checks.
//
// A member opening a SACCO's invite link must land DIRECTLY on the signup
// form with the SACCO's name visible from the first screen. These checks pin
// the wiring in app/auth/page.tsx:
//   1. mode is initialised from the URL (no login-card flash before a
//      post-mount effect flips it),
//   2. the "Joining <SACCO>" banner renders on every register step,
//   3. it shows a verifying state while the link resolves and hides when the
//      link is dead (the error box explains that case),
//   4. no leftover "Select Sacco" wording from the removed org-picker flow.
//
// Run: node test/join-link-landing-tests.mjs
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'app', 'auth', 'page.tsx'), 'utf8');

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

console.log('Join-link landing (app/auth/page.tsx)');

check(
  'mode is initialised from the URL — join link opens straight on signup',
  /useState<'login' \| 'register'>\(\(\)\s*=>[\s\S]{0,200}searchParams\.get\('sacco'\)/.test(page),
  'expected a useState initialiser that reads searchParams'
);

check(
  'no plain login-first default remains (would flash the login card)',
  !/useState<'login' \| 'register'>\('login'\)/.test(page)
);

check(
  'the URL still re-forces register mode on in-page navigation (effect kept)',
  /searchParams\.get\('sacco'\)[\s\S]{0,120}setMode\('register'\)/.test(page)
);

check(
  'join banner names the SACCO once the link resolves',
  /Joining \$\{orgName\}/.test(page)
);

check(
  'join banner shows a verifying state while the invite is checked',
  /Verifying your invite/.test(page)
);

check(
  'join banner is hidden when the link is dead (error box explains instead)',
  /\(joinCode \|\| !error\)/.test(page)
);

check(
  'join banner renders on every register step, not just step 1',
  /mode === 'register' && searchParams\.get\('sacco'\) && \(joinCode \|\| !error\)/.test(page)
    && !/mode === 'register' && searchParams\.get\('sacco'\) && \(joinCode \|\| !error\) && step/.test(page)
);

check(
  'step 2 is titled "Complete Your Details" — no leftover "Select Sacco"',
  /Complete Your Details/.test(page) && !/Select Sacco/.test(page)
);

check(
  'banner icon imported from lucide (Landmark)',
  /import \{[^}]*Landmark[^}]*\} from 'lucide-react'/.test(page)
);

console.log(`\nRESULTS: ${passed}/${passed + failed} passed`);
if (failed) {
  console.log('JOIN-LINK LANDING: FAILURES ABOVE');
  process.exit(1);
}
console.log('JOIN-LINK LANDING: ALL CHECKS PASSED');
