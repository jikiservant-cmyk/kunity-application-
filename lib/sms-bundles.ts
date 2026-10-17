// SMS top-up pricing.
//
// There is no hardcoded pack/price list anywhere. A SACCO buys any whole number
// of SMS, and the price is derived from the per-SMS rate stored in the database
// for that SACCO (`public.wallets.sms_rate`). The client sends only the credit
// count — never a price — so a caller can never buy credits at a price they chose.
//
// Price and credit maths live here so the API routes, the tests, and the admin UI
// all use exactly the same rules.

/** Smallest useful top-up. Keeps a purchase above mobile-money fee noise. */
export const SMS_MIN_CREDITS = 10;

/** Upper bound per purchase (at UGX 50/SMS this is UGX 5,000,000). */
export const SMS_MAX_CREDITS = 100_000;

/** Sanity ceiling on how much a single top-up may charge. */
export const SMS_MAX_CHARGE_UGX = 10_000_000;

/** A per-SMS rate this high is almost certainly a configuration error. */
export const SMS_MAX_RATE_UGX = 10_000;

/**
 * Parse the DB-stored per-SMS rate. PostgREST returns `numeric` columns as
 * strings, so accept both. Anything missing, non-finite, zero or negative is
 * rejected: a bad rate must fail the purchase, never make SMS free.
 */
export function parseSmsRate(value: unknown): number | null {
  const rate = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN);
  if (!Number.isFinite(rate) || rate <= 0 || rate > SMS_MAX_RATE_UGX) return null;
  return rate;
}

/**
 * Validate a requested quantity of SMS. Whole numbers only, so a caller cannot
 * buy a fraction of a credit or slip a numeric string through.
 */
export function normalizeSmsCredits(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) return null;
  if (input < SMS_MIN_CREDITS || input > SMS_MAX_CREDITS) return null;
  return input;
}

/** Total charge for a credit count at the SACCO's DB rate, in whole UGX. */
export function smsPriceForCredits(credits: unknown, ratePerSms: unknown): number | null {
  const count = normalizeSmsCredits(credits);
  const rate = parseSmsRate(ratePerSms);
  if (count === null || rate === null) return null;

  const price = Math.round(count * rate);
  if (!Number.isFinite(price) || price <= 0 || price > SMS_MAX_CHARGE_UGX) return null;
  return price;
}

/** Credits delivered by a paid amount at the SACCO's DB rate. */
export function smsCreditsForAmount(amount: unknown, ratePerSms: unknown): number | null {
  const paid = typeof amount === 'number'
    ? amount
    : (typeof amount === 'string' && amount.trim() !== '' ? Number(amount.trim()) : NaN);
  const rate = parseSmsRate(ratePerSms);
  if (!Number.isFinite(paid) || paid <= 0 || rate === null) return null;

  const credits = Math.round(paid / rate);
  return Number.isFinite(credits) && credits > 0 ? credits : null;
}
