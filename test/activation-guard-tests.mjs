/**
 * Unit tests for lib/activation-guard.ts (run on Node's TypeScript type stripping).
 * Run: node test/activation-guard-tests.mjs
 */
import assert from 'node:assert/strict';
import { activationBlockReason, ACTIVATION_IN_PROGRESS_WINDOW_MS } from '../lib/activation-guard.ts';

const now = Date.parse('2026-10-09T12:00:00Z');
const cases = [
  ['pending member, no open intent -> allowed', { memberStatus: 'pending', now }, null],
  ['active member -> allowed by this rule (account check handles it)', { memberStatus: 'active', now }, null],
  ['declined (rejected) member -> blocked', { memberStatus: 'rejected', now }, /declined/],
  ['suspended member -> blocked', { memberStatus: 'suspended', now }, /suspended/],
  ['intent created 5 min ago -> blocked', { memberStatus: 'pending', pendingActivationCreatedAt: new Date(now - 5 * 60e3).toISOString(), now }, /already in progress/],
  ['intent created 31 min ago -> allowed again', { memberStatus: 'pending', pendingActivationCreatedAt: new Date(now - 31 * 60e3).toISOString(), now }, null],
  ['unparseable timestamp -> not blocked (fails open on bad data only)', { memberStatus: 'pending', pendingActivationCreatedAt: 'garbage', now }, null],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  try {
    const got = activationBlockReason(input);
    if (expected === null) assert.equal(got, null, `expected allowed, got: ${got}`);
    else assert.match(got ?? '', expected);
    console.log(`  ✅ PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ FAIL  ${name} — ${e.message}`);
  }
}
assert.equal(ACTIVATION_IN_PROGRESS_WINDOW_MS, 30 * 60 * 1000);
console.log(`\nRESULTS: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
console.log('ALL ACTIVATION-GUARD CHECKS PASSED');
