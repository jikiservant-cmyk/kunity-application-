// Validation for admin-created savings and loan products.
// Pure functions: no I/O. Used by app/api/admin/products and tested in test/product-rules-tests.mjs.
// Column names match the live tables: kunity.savings_products and kunity.loan_products.

// Live check constraint on savings_products.deposit_frequency allows only 'weekly'.
export const DEPOSIT_FREQUENCIES = ['weekly'] as const;
export type DepositFrequency = (typeof DEPOSIT_FREQUENCIES)[number];

export interface ValidationOk<T> { ok: true; value: T }
export interface ValidationErr { ok: false; error: string }
export type Validation<T> = ValidationOk<T> | ValidationErr;

const fail = (error: string): ValidationErr => ({ ok: false, error });

function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 60 ? name : null;
}

function toNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input === 'string' && input.trim() !== '') {
    const n = Number(input);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function validateRate(input: unknown): Validation<number> {
  const rate = toNumber(input);
  if (rate === null || rate < 0 || rate > 100) return fail('Interest rate must be between 0 and 100 percent.');
  return { ok: true, value: Math.round(rate * 10000) / 10000 };
}

export function validateSavingsProduct(input: {
  name?: unknown;
  interestRate?: unknown;
  minBalance?: unknown;
  allowsWithdrawals?: unknown;
  depositFrequency?: unknown;
}): Validation<{
  name: string; interest_rate: number; min_balance: number;
  allows_withdrawals: boolean; deposit_frequency: DepositFrequency;
}> {
  const name = cleanName(input.name);
  if (!name) return fail('Product name must be 2 to 60 characters.');

  const rate = validateRate(input.interestRate ?? 0);
  if (!rate.ok) return rate;

  const minBalance = input.minBalance === undefined || input.minBalance === '' ? 0 : toNumber(input.minBalance);
  if (minBalance === null || minBalance < 0) return fail('Minimum balance cannot be negative.');

  const freq = String(input.depositFrequency ?? 'weekly');
  if (!(DEPOSIT_FREQUENCIES as readonly string[]).includes(freq)) {
    return fail('Deposit frequency must be weekly.');
  }

  return {
    ok: true,
    value: {
      name,
      interest_rate: rate.value,
      min_balance: round2(minBalance),
      allows_withdrawals: input.allowsWithdrawals !== false,
      deposit_frequency: freq as DepositFrequency,
    },
  };
}

/** Maximum is optional: an empty maximum means the product has no upper limit (max_principal NULL). */
export function validateLoanProduct(input: {
  name?: unknown;
  interestRate?: unknown;
  minAmount?: unknown;
  maxAmount?: unknown;
}): Validation<{ name: string; interest_rate: number; min_principal: number; max_principal: number | null }> {
  const name = cleanName(input.name);
  if (!name) return fail('Product name must be 2 to 60 characters.');

  const rate = validateRate(input.interestRate);
  if (!rate.ok) return rate;

  const minPrincipal = input.minAmount === undefined || input.minAmount === '' ? 0 : toNumber(input.minAmount);
  if (minPrincipal === null || minPrincipal < 0) return fail('Minimum loan amount cannot be negative.');

  let maxPrincipal: number | null = null;
  if (input.maxAmount !== undefined && input.maxAmount !== null && input.maxAmount !== '') {
    maxPrincipal = toNumber(input.maxAmount);
    if (maxPrincipal === null || maxPrincipal <= 0) return fail('Maximum loan amount must be greater than zero.');
    if (maxPrincipal < minPrincipal) return fail('Maximum loan amount cannot be less than the minimum.');
    maxPrincipal = round2(maxPrincipal);
  }

  return {
    ok: true,
    value: {
      name,
      interest_rate: rate.value,
      min_principal: round2(minPrincipal),
      max_principal: maxPrincipal,
    },
  };
}
