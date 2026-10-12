// Validation for admin-created savings and loan products.
// Pure functions: no I/O. Used by app/api/admin/products and tested in test/products-tests.mjs.

export const DEPOSIT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
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

  const freq = String(input.depositFrequency ?? 'monthly');
  if (!(DEPOSIT_FREQUENCIES as readonly string[]).includes(freq)) {
    return fail('Deposit frequency must be daily, weekly or monthly.');
  }

  return {
    ok: true,
    value: {
      name,
      interest_rate: rate.value,
      min_balance: Math.round(minBalance * 100) / 100,
      allows_withdrawals: input.allowsWithdrawals !== false,
      deposit_frequency: freq as DepositFrequency,
    },
  };
}

export function validateLoanProduct(input: {
  name?: unknown;
  interestRate?: unknown;
  minAmount?: unknown;
  maxAmount?: unknown;
}): Validation<{ name: string; interest_rate: number; min_amount: number; max_amount: number }> {
  const name = cleanName(input.name);
  if (!name) return fail('Product name must be 2 to 60 characters.');

  const rate = validateRate(input.interestRate);
  if (!rate.ok) return rate;

  const minAmount = input.minAmount === undefined || input.minAmount === '' ? 0 : toNumber(input.minAmount);
  const maxAmount = toNumber(input.maxAmount);
  if (minAmount === null || minAmount < 0) return fail('Minimum loan amount cannot be negative.');
  if (maxAmount === null || maxAmount <= 0) return fail('Maximum loan amount must be greater than zero.');
  if (maxAmount < minAmount) return fail('Maximum loan amount cannot be less than the minimum.');

  return {
    ok: true,
    value: {
      name,
      interest_rate: rate.value,
      min_amount: Math.round(minAmount * 100) / 100,
      max_amount: Math.round(maxAmount * 100) / 100,
    },
  };
}
