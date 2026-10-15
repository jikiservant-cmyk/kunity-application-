// Pure rules for whether a member may START an activation payment.
// Kept free of I/O so it can be tested directly (test/activation-guard-tests.mjs).

export const ACTIVATION_IN_PROGRESS_WINDOW_MS = 30 * 60 * 1000;

export function activationBlockReason(input: {
  memberStatus?: string | null;
  pendingActivationCreatedAt?: string | null;
  now: number;
}): string | null {
  // A declined or suspended member must not be charged an activation fee that
  // can never activate them.
  if (input.memberStatus === 'rejected') {
    return 'Your membership application was declined. Please contact your SACCO.';
  }
  if (input.memberStatus === 'suspended') {
    return 'Your membership is suspended. Please contact your SACCO.';
  }
  // One activation payment at a time. Each successful payment credits the
  // member's balance, so parallel payments would be charged and credited twice.
  if (input.pendingActivationCreatedAt) {
    const created = Date.parse(input.pendingActivationCreatedAt);
    if (!Number.isNaN(created) && input.now - created < ACTIVATION_IN_PROGRESS_WINDOW_MS) {
      return 'An activation payment is already in progress. Complete it, or wait 30 minutes before trying again.';
    }
  }
  return null;
}
