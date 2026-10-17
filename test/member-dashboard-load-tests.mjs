/**
 * Regression checks for the member dashboard load path.
 *
 * Bug (2026-10-17): `loading` started as `true`, but the member page never
 * called `fetchData()` on mount. The admin console had its mount effect; the
 * member page did not, so members sat on the orange spinner forever while
 * admins saw a fully loaded dashboard. `fetchData` also had no error handling,
 * so any rejected query left the spinner up just as permanently.
 *
 * Run: node test/member-dashboard-load-tests.mjs
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const member = read('app/member/page.tsx');
const admin = read('app/admin/AdminConsole.tsx');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok - ${name}`); };

console.log('Member dashboard load checks');

check('the member dashboard triggers a load on mount', () => {
  assert.match(
    member,
    /useEffect\(\(\) => \{\s*void fetchData\(\);[\s\S]*?\}, \[\]\);/,
    'no mount effect calls fetchData — loading can never become false'
  );
});

check('the admin console still loads on mount (the working reference path)', () => {
  assert.match(admin, /useEffect\(\(\) => \{\s*fetchAdminData\(\);/);
});

check('the member load always clears the spinner (try/catch/finally)', () => {
  const start = member.indexOf('const fetchData = async () => {');
  const end = member.indexOf('const handleOpenAccount');
  assert.ok(start > -1 && end > start, 'could not locate fetchData');
  const wrapper = member.slice(start, end);
  assert.match(wrapper, /try \{/);
  assert.match(wrapper, /catch \(error\)/);
  assert.match(wrapper, /finally \{\s*setLoading\(false\);\s*\}/);
});

check('the member load is bounded so a hung query cannot spin forever', () => {
  assert.match(member, /withTimeout\(loadDashboard\(\), 30_000, /);
});

check('a missing member profile shows an actionable error, not a blank dashboard', () => {
  assert.match(member, /memberError\.code === 'PGRST116'/);
  assert.match(member, /setLoadError\('Your member profile was not found for this SACCO/);
});

check('the error screen explains the failure and offers a retry', () => {
  assert.match(member, /Dashboard could not load/);
  assert.match(member, /setLoading\(true\); void fetchData\(\)/);
  assert.match(member, /Try again/);
});

console.log(`\n${passed} member dashboard load checks passed`);
