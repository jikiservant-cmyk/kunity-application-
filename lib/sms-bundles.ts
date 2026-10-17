// SMS top-up pricing.
//
// There is no hardcoded pack/price list anywhere. The SACCO admin enters the
// amount they want to spend in UGX, and the number of SMS is derived from the
// per-SMS rate stored in the database (`public.wallets.sms_rate`). The client
// sends only the amount — never a price or a credit count — so a caller can
// never buy credits at a price they chose.
//
// Amounts that are not an exact multiple of the rate are floored to whole SMS
// and charged at `credits x rate`, so a purchase can never cost more than the
// admin typed. The API still accepts a credit count for backwards compatibility
// (the tests and scripts use it); both spellings end at the same server-priced
// (credits, charge) pair.
//
// Pricing maths lives here so the API routes, the tests, and the admin UI all
// use exactly the same rules.

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

/**
 * Validate an amount entered by the admin: whole shillings, positive, and no
 * larger than the sanity ceiling on a single charge. Strings are rejected on
 * purpose — the browser must send a number, not a numeric string.
 */
export function normalizeSmsAmount(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) return null;
  if (input <= 0 || input > SMS_MAX_CHARGE_UGX) return null;
  return input;
}

/**
 * The amount range a SACCO can top up at its DB rate: enough for the minimum
 * number of SMS up to either the maximum credit count or the charge ceiling.
 */
export function smsAmountBounds(ratePerSms: unknown): { min: number; max: number } | null {
  const rate = parseSmsRate(ratePerSms);
  if (rate === null) return null;

  const min = Math.ceil(SMS_MIN_CREDITS * rate);
  const max = Math.min(Math.floor(SMS_MAX_CREDITS * rate), SMS_MAX_CHARGE_UGX);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null;
  return { min, max };
}

/**
 * Turn an amount in UGX into the actual purchase at the SACCO's DB rate.
 *
 * Credits are floored so the SACCO never hands out more SMS than were paid for,
 * and the charge is `credits x rate` so the payer is never charged more than the
 * amount they typed (an amount that is not a multiple of the rate leaves a
 * remainder below one SMS, which is simply not charged).
 */
export function smsTopupForAmount(
  amount: unknown,
  ratePerSms: unknown,
): { credits: number; amount: number } | null {
  const paid = normalizeSmsAmount(amount);
  const rate = parseSmsRate(ratePerSms);
  const bounds = smsAmountBounds(ratePerSms);
  if (paid === null || rate === null || bounds === null) return null;
  if (paid < bounds.min || paid > bounds.max) return null;

  // +1e-9 absorbs binary floating point noise (e.g. 50_000 / 0.1) without
  // ever promoting a genuine fraction of an SMS to a whole one.
  const credits = Math.floor(paid / rate + 1e-9);
  if (credits < SMS_MIN_CREDITS || credits > SMS_MAX_CREDITS) return null;

  const charge = Math.round(credits * rate);
  if (!Number.isFinite(charge) || charge <= 0 || charge > SMS_MAX_CHARGE_UGX) return null;
  return { credits, amount: charge };
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
