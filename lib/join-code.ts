import { randomInt } from 'crypto';

// Per-SACCO join codes. Members register through /auth?sacco=<code>, and the
// server resolves the code to exactly one organization. Codes are case- and
// separator-insensitive when entered, and use no look-alike characters
// (0/O, 1/I/L are excluded).
// IMPORTANT: the database side uses the SAME alphabet — kunity.generate_join_code()
// (migration 38) backs the join_code column DEFAULT and a CHECK constraint keeps
// stored codes valid here. Before migration 38, codes minted from UUID hex
// contained '0'/'1' and their join links were rejected as invalid (~74% of them).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars
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

/**
 * Legacy transition only (migration 38): codes minted by migration 24's UUID-hex
 * default were replaced, but links containing them may already be in members'
 * inboxes. Such codes resolve ONLY through the closed kunity.join_code_aliases
 * mapping — this function deliberately does not widen the accepted alphabet for
 * storage or lookup of live codes. Format is exactly what migration 24 minted:
 * 10 chars of 0-9A-F. Returns null for anything else.
 */
export function legacyJoinCodeCandidate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-F]{10}$/.test(cleaned) ? cleaned : null;
}
