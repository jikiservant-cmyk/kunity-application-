/**
 * Unit tests for lib/registration-guard.ts (Node TypeScript type stripping).
 * Run: node test/registration-guard-tests.mjs
 */
import assert from 'node:assert/strict';
import { registrationBlockReason, identityChangeReason } from '../lib/registration-guard.ts';

const reg = [
  ['new applicant, no match -> allowed', { matchesDeclinedMember: false, nationalIdTakenByOtherMember: false }, null],
  ['previously declined by this SACCO -> blocked', { matchesDeclinedMember: true, nationalIdTakenByOtherMember: false }, /previously declined/],
  ['National ID held by another member -> blocked', { matchesDeclinedMember: false, nationalIdTakenByOtherMember: true }, /National ID is already registered/],
];

const idChange = [
  ['pending member changes National ID -> allowed', { memberStatus: 'pending', stored: { national_id: 'CM1' }, incoming: { national_id: 'CM2' } }, null],
  ['active member changes National ID -> blocked', { memberStatus: 'active', stored: { national_id: 'CM1' }, incoming: { national_id: 'CM2' } }, /locked/],
  ['active member resubmits same National ID -> allowed', { memberStatus: 'active', stored: { national_id: 'CM1' }, incoming: { national_id: ' CM1 ' } }, null],
  ['active member, field not sent -> allowed', { memberStatus: 'active', stored: { national_id: 'CM1', gender: 'M' }, incoming: { date_of_birth: undefined } }, null],
  ['suspended member changes gender -> blocked', { memberStatus: 'suspended', stored: { gender: 'M' }, incoming: { gender: 'F' } }, /locked/],
  ['rejected member changes date of birth -> blocked', { memberStatus: 'rejected', stored: { date_of_birth: '1990-01-01' }, incoming: { date_of_birth: '1991-01-01' } }, /locked/],
  ['stored empty, incoming blank -> allowed', { memberStatus: 'active', stored: { national_id: null }, incoming: { national_id: '' } }, null],
];

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✅ PASS  ${name}`); }
  catch (e) { failed++; console.log(`  ❌ FAIL  ${name}\n      ${e.message}`); }
};

for (const [name, input, expected] of reg) {
  run(name, () => {
    const got = registrationBlockReason(input);
    if (expected === null) assert.equal(got, null, `expected allowed, got: ${got}`);
    else assert.match(got ?? '', expected);
  });
}
for (const [name, input, expected] of idChange) {
  run(name, () => {
    const got = identityChangeReason(input);
    if (expected === null) assert.equal(got, null, `expected allowed, got: ${got}`);
    else assert.match(got ?? '', expected);
  });
}

console.log(`\nRESULTS: ${reg.length + idChange.length - failed}/${reg.length + idChange.length} passed`);
process.exit(failed ? 1 : 0);
