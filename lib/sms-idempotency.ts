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

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}
