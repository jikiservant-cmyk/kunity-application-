/**
 * Central input validation for monetary amounts, phone numbers, and references.
 */

export interface AmountValidationResult {
  valid: boolean;
  amount: number;
  error?: string;
}

export function validateAmount(
  rawAmount: unknown,
  options: {
    min?: number;
    max?: number;
    allowDecimals?: boolean;
  } = {}
): AmountValidationResult {
  const { min = 100, max = 100_000_000, allowDecimals = true } = options;

  if (rawAmount === null || rawAmount === undefined || rawAmount === '') {
    return { valid: false, amount: 0, error: 'Amount is required' };
  }

  const num = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);

  if (!Number.isFinite(num)) {
    return { valid: false, amount: 0, error: 'Amount must be a finite number' };
  }

  if (num <= 0) {
    return { valid: false, amount: 0, error: 'Amount must be greater than zero' };
  }

  if (num < min) {
    return { valid: false, amount: num, error: `Amount must be at least ${min.toLocaleString()}` };
  }

  if (num > max) {
    return { valid: false, amount: num, error: `Amount cannot exceed ${max.toLocaleString()}` };
  }

  if (!allowDecimals && !Number.isInteger(num)) {
    return { valid: false, amount: num, error: 'Amount must be an integer' };
  }

  // Round to 2 decimal places to prevent floating point inaccuracies
  const sanitizedAmount = Math.round(num * 100) / 100;

  return { valid: true, amount: sanitizedAmount };
}

export interface PhoneValidationResult {
  valid: boolean;
  phone: string;
  error?: string;
}

export function normalizeUgandanPhone(rawPhone: unknown): PhoneValidationResult {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { valid: false, phone: '', error: 'Phone number is required' };
  }

  // Strip spaces, dashes, parentheses
  let cleaned = rawPhone.replace(/[\s\-\(\)]/g, '').trim();

  // Convert 07XXXXXXXX to +2567XXXXXXXX
  if (/^0[7][0-9]{8}$/.test(cleaned)) {
    cleaned = `+256${cleaned.slice(1)}`;
  } else if (/^256[7][0-9]{8}$/.test(cleaned)) {
    cleaned = `+${cleaned}`;
  } else if (/^\+256[7][0-9]{8}$/.test(cleaned)) {
    // Already valid E.164 Ugandan format
  } else if (/^\+[1-9]\d{8,14}$/.test(cleaned)) {
    // Valid generic international E.164
  } else {
    return {
      valid: false,
      phone: cleaned,
      error: 'Invalid phone number format. Expected Ugandan format (e.g. 07XXXXXXXX or +2567XXXXXXXX)',
    };
  }

  return { valid: true, phone: cleaned };
}
