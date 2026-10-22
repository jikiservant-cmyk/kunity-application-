// Claims an idempotency key before an SMS request is processed. Returns true only for the
// first request that claims the key. The database primary key makes the claim atomic.
export async function claimIdempotencyKey(
  supabaseAdmin: { schema: (s: string) => any; from: (t: string) => any },
  scope: string,
  key: string
): Promise<{ claimed: boolean; error?: string }> {
  const { error } = await supabaseAdmin
    .schema('public')
    .from('sms_idempotency_keys')
    .insert({ scope, idem_key: key });
  if (!error) return { claimed: true };
  // 23505 = unique_violation: the key was already claimed by an earlier request.
  if ((error as { code?: string }).code === '23505') return { claimed: false };
  return { claimed: false, error: error.message };
}

// Releases a claim when the work it guarded produced no side effects (e.g. a
// broadcast where not a single message was dispatched), so an honest retry is
// not locked out by the earlier claim. Only call it when NOTHING happened.
export async function releaseIdempotencyKey(
  supabaseAdmin: { schema: (s: string) => any; from: (t: string) => any },
  scope: string,
  key: string
): Promise<void> {
  await supabaseAdmin
    .schema('public')
    .from('sms_idempotency_keys')
    .delete()
    .eq('scope', scope)
    .eq('idem_key', key);
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}
