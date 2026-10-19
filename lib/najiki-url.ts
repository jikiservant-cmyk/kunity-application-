/**
 * Where Kunity talks to NaJiki.
 *
 * There is deliberately NO built-in default origin. This module used to fall
 * back to a hardcoded host, which meant a deployment that forgot
 * `NAJIKI_API_URL` silently sent real payment requests to whatever happened to
 * be running at that address. On 2026-10-19 that fallback pointed at a stale
 * deployment: `/api/payments` answered `500` with a Next.js HTML error page,
 * so every deposit failed with "NaJiki gateway error ... <!DOCTYPE html>".
 * A money path that guesses where the provider lives is worse than one that
 * refuses to start, so a missing origin is now a hard configuration error.
 *
 * The live NaJiki API is `https://najiki.vercel.app`. The older
 * `najiki.netlify.app` deployment is stale and must not be used.
 */

/** The origin operators should configure. Documentation only — never a fallback. */
export const NAJIKI_EXAMPLE_ORIGIN = 'https://najiki.vercel.app';

export class NajikiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NajikiConfigError';
  }
}

/**
 * Normalize a configured NaJiki origin before appending API paths.
 *
 * Trims whitespace, drops trailing slashes, and rejects anything that is not an
 * absolute http(s) URL — a typo such as `najiki.vercel.app` (no scheme) would
 * otherwise be handed to `fetch` and fail with an opaque "Failed to parse URL".
 */
export function normalizeNajikiBaseUrl(baseUrl: string): string {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) {
    throw new NajikiConfigError(
      `NAJIKI_API_URL is not configured. Set it to the live NaJiki origin (for example ${NAJIKI_EXAMPLE_ORIGIN}), without a trailing /api.`,
    );
  }

  const normalized = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new NajikiConfigError(
      `NAJIKI_API_URL is not a valid absolute URL ("${normalized}"). Expected something like ${NAJIKI_EXAMPLE_ORIGIN}.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NajikiConfigError(
      `NAJIKI_API_URL must use http or https ("${normalized}" does not).`,
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
      'NAJIKI_API_URL is not set, so payments and SMS cannot be addressed to NaJiki. ' +
        `Set it to the live NaJiki origin (for example ${NAJIKI_EXAMPLE_ORIGIN}), without a trailing /api.`,
    );
  }

  const normalized = normalizeNajikiBaseUrl(raw);
  if (/\/api$/i.test(normalized)) {
    throw new NajikiConfigError(
      `NAJIKI_API_URL must be the NaJiki origin without the /api suffix (got "${normalized}"). ` +
        'Kunity appends /api/payments itself.',
    );
  }
  // Not fatal — if that deployment is ever revived it should work — but loud,
  // because this exact origin answered the API with an HTML page and made every
  // production deposit fail on 2026-10-19.
  if (najikiHostLabel(normalized) === 'najiki.netlify.app') {
    console.warn(
      `[najiki] NAJIKI_API_URL points at ${normalized}, which is a stale deployment. ` +
      `The live NaJiki API is ${NAJIKI_EXAMPLE_ORIGIN}.`,
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
