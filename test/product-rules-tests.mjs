/**
 * Unit tests for lib/product-rules.ts (Node TypeScript type stripping).
 * Run: node test/product-rules-tests.mjs
 */
import assert from 'node:assert/strict';
import { validateSavingsProduct, validateLoanProduct } from '../lib/product-rules.ts';

const cases = [
  ['savings: valid product', () => validateSavingsProduct({ name: '  Child  Savings ', interestRate: '6.5', minBalance: 0, allowsWithdrawals: false, depositFrequency: 'weekly' }),
    (r) => r.ok && r.value.name === 'Child Savings' && r.value.interest_rate === 6.5 && r.value.allows_withdrawals === false && r.value.deposit_frequency === 'weekly'],
  ['savings: name too short', () => validateSavingsProduct({ name: 'A', interestRate: 5, depositFrequency: 'monthly' }), (r) => !r.ok && /name/.test(r.error)],
  ['savings: rate above 100', () => validateSavingsProduct({ name: 'Plan', interestRate: 150, depositFrequency: 'monthly' }), (r) => !r.ok && /Interest rate/.test(r.error)],
  ['savings: negative rate', () => validateSavingsProduct({ name: 'Plan', interestRate: -1, depositFrequency: 'monthly' }), (r) => !r.ok],
  ['savings: non-numeric rate', () => validateSavingsProduct({ name: 'Plan', interestRate: 'abc', depositFrequency: 'monthly' }), (r) => !r.ok],
  ['savings: unknown frequency', () => validateSavingsProduct({ name: 'Plan', interestRate: 5, depositFrequency: 'yearly' }), (r) => !r.ok && /frequency/.test(r.error)],
  ['savings: withdrawals default allowed', () => validateSavingsProduct({ name: 'Plan', interestRate: 5, depositFrequency: 'monthly' }), (r) => r.ok && r.value.allows_withdrawals === true],
  ['savings: negative minimum balance', () => validateSavingsProduct({ name: 'Plan', interestRate: 5, minBalance: -10, depositFrequency: 'monthly' }), (r) => !r.ok],
  ['loan: valid product', () => validateLoanProduct({ name: 'Development Loan', interestRate: 12, minAmount: 100000, maxAmount: '2000000' }),
    (r) => r.ok && r.value.max_amount === 2000000 && r.value.min_amount === 100000],
  ['loan: max below min', () => validateLoanProduct({ name: 'Bad', interestRate: 5, minAmount: 500, maxAmount: 100 }), (r) => !r.ok && /cannot be less/.test(r.error)],
  ['loan: zero maximum', () => validateLoanProduct({ name: 'Bad', interestRate: 5, maxAmount: 0 }), (r) => !r.ok],
  ['loan: missing maximum', () => validateLoanProduct({ name: 'Bad', interestRate: 5 }), (r) => !r.ok],
  ['loan: name with only spaces', () => validateLoanProduct({ name: '   ', interestRate: 5, maxAmount: 1000 }), (r) => !r.ok],
  ['loan: name not a string', () => validateLoanProduct({ name: 12, interestRate: 5, maxAmount: 1000 }), (r) => !r.ok],
];

let failed = 0;
for (const [name, make, check] of cases) {
  try {
    const r = make();
    assert.ok(check(r), JSON.stringify(r));
    console.log(`  ✅ PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\nRESULTS: ${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
