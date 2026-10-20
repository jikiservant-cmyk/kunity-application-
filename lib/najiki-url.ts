/**
 * Where Kunity talks to NaJiki.
 *
 * The origin comes from the environment, always. There is deliberately no
 * built-in default host in this module: a deployment that forgot
 * `NAJIKI_API_URL` used to fall back to a hardcoded address, which meant real
 * payment requests were sent to whatever happened to be running there. The
 * NaJiki deployment moves between hosts (Netlify today, Vercel previously), so
 * a compiled-in address is wrong the moment the provider moves.
 *
 * A missing or malformed origin is therefore a hard configuration error: the
 * request fails before any money path is touched, with a message that says what
 * to set.
 */

export class NajikiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NajikiConfigError';
  }
}

const CONFIG_HINT =
  'Set NAJIKI_API_URL to the origin of your live NaJiki deployment (for example https://najiki.example.com), ' +
  'with no trailing slash and no /api suffix — Kunity appends /api/payments itself.';

/**
 * Normalize a configured NaJiki origin before appending API paths.
 *
 * Trims whitespace, drops trailing slashes, and rejects anything that is not an
 * absolute http(s) URL — a typo such as `najiki.example.com` (no scheme) would
 * otherwise be handed to `fetch` and fail with an opaque "Failed to parse URL".
 */
export function normalizeNajikiBaseUrl(baseUrl: string): string {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) {
    throw new NajikiConfigError(`NAJIKI_API_URL is not configured. ${CONFIG_HINT}`);
  }

  const normalized = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new NajikiConfigError(
      `NAJIKI_API_URL is not a valid absolute URL ("${normalized}"). ${CONFIG_HINT}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NajikiConfigError(
      `NAJIKI_API_URL must use http or https ("${normalized}" does not). ${CONFIG_HINT}`,
    );
  }
  return normalized;
}

/**
 * Resolve the NaJiki origin from the environment.
 *
 * Throws {@link NajikiConfigError} with an actionable message when the variable
 * is missing, malformed, or includes the `/api` prefix (Kunity appends its own
 * path, so `https://host/api` would call `/api/api/payments`).
 *
 * Callers on a money path should let this propagate: a request that cannot be
 * addressed to the real provider must fail before any ledger row is written.
 */
export function resolveNajikiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.NAJIKI_API_URL ?? '').trim();
  if (!raw) {
    throw new NajikiConfigError(
      `NAJIKI_API_URL is not set, so payments and SMS cannot be addressed to NaJiki. ${CONFIG_HINT}`,
    );
  }

  const normalized = normalizeNajikiBaseUrl(raw);
  if (/\/api$/i.test(normalized)) {
    throw new NajikiConfigError(
      `NAJIKI_API_URL must be the NaJiki origin without the /api suffix (got "${normalized}"). ${CONFIG_HINT}`,
    );
  }
  return normalized;
}

/** Hostname for logs and error messages; never includes credentials or query strings. */
export function najikiHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'the configured NaJiki origin';
  }
}
