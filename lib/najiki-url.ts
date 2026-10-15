/** Normalize the configured NaJiki origin before appending API paths. */
export function normalizeNajikiBaseUrl(baseUrl: string): string {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('NAJIKI_API_URL is not configured');
  return normalized;
}
