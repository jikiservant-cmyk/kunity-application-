import { randomInt } from 'crypto';

// Per-SACCO join codes. Members register through /auth?sacco=<code>, and the
// server resolves the code to exactly one organization. Codes are case- and
// separator-insensitive when entered, and use no look-alike characters
// (0/O, 1/I/L are excluded).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** Normalise user/URL input. Returns null if it cannot be a valid code. */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Generate a new random code (used when a SACCO admin regenerates a link). */
export function generateJoinCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
