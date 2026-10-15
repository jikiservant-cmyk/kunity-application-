// Pure rules for member registration and identity edits.
// Kept free of I/O so they can be tested directly (test/registration-guard-tests.mjs).
// The API route gathers the facts (DB lookups) and asks these functions what to do.

/** Fields a member may not change once their membership has left 'pending'. */
export const LOCKED_IDENTITY_FIELDS = ['national_id', 'date_of_birth', 'gender'] as const;

function normalizeField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * New registration: refuse when this person was already declined by this SACCO
 * (matched by National ID or phone), or when the National ID already belongs to
 * another member of the same SACCO. A declined person must not be able to
 * re-apply under a new email and pay the activation fee.
 */
export function registrationBlockReason(input: {
  matchesDeclinedMember: boolean;
  nationalIdTakenByOtherMember: boolean;
}): string | null {
  if (input.matchesDeclinedMember) {
    return 'Your membership application was previously declined. Please contact your SACCO.';
  }
  if (input.nationalIdTakenByOtherMember) {
    return 'This National ID is already registered with this SACCO. Please contact your SACCO.';
  }
  return null;
}

/**
 * Existing member profile update: identity fields are editable only while the
 * member is still 'pending'. Once processed, a real change is refused.
 * `incoming` holds only the keys the caller actually sent.
 */
export function identityChangeReason(input: {
  memberStatus: string | null | undefined;
  stored: Partial<Record<(typeof LOCKED_IDENTITY_FIELDS)[number], unknown>>;
  incoming: Partial<Record<(typeof LOCKED_IDENTITY_FIELDS)[number], unknown>>;
}): string | null {
  if (input.memberStatus === 'pending') return null;
  for (const field of LOCKED_IDENTITY_FIELDS) {
    if (!(field in input.incoming)) continue;
    if (normalizeField(input.incoming[field]) !== normalizeField(input.stored[field])) {
      return 'Your National ID, date of birth and gender are locked once your membership has been processed. Contact your SACCO to change them.';
    }
  }
  return null;
}
