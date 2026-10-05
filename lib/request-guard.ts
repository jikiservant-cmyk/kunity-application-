import { NextRequest } from 'next/server';

/**
 * Request-level security guards for API routes.
 *
 * Why this exists:
 * Session cookies are configured with `SameSite=None` (required because the
 * app is embedded in cross-site iframes). SameSite=None cookies are attached
 * to ANY cross-site request, which re-opens CSRF exposure. Additionally,
 * `req.json()` happily parses a body sent with `Content-Type: text/plain`,
 * so an attacker page can fire `fetch(..., { mode: 'no-cors',
 * credentials: 'include' })` POSTs that bypass CORS preflight entirely.
 *
 * For cookie-authenticated, state-changing endpoints we therefore enforce
 * an explicit same-origin check on every request.
 */

/**
 * Returns a list of hosts that are considered first-party for this deployment.
 */
function allowedHosts(req: NextRequest): string[] {
  const hosts = new Set<string>();
  const host = req.headers.get('host');
  if (host) hosts.add(host.toLowerCase());
  for (const envName of ['NEXT_PUBLIC_SITE_URL', 'APP_URL'] as const) {
    const raw = process.env[envName];
    if (raw) {
      try {
        hosts.add(new URL(raw).host.toLowerCase());
      } catch {
        /* ignore malformed env values */
      }
    }
  }
  return Array.from(hosts);
}

/**
 * CSRF / cross-site request guard for cookie-authenticated state-changing
 * endpoints (POST/PUT/PATCH/DELETE).
 *
 * A request is considered first-party when EITHER:
 *  - The `Origin` header host matches the request host / configured site URL, OR
 *  - The `Sec-Fetch-Site` header (modern browsers) is `same-origin`.
 *
 * Requests with no Origin AND no Sec-Fetch-Site header are rejected
 * (fail-closed): browsers always attach Origin to cross-site and same-origin
 * POST fetches, so a missing header indicates a non-browser or tampered
 * client, which has no business calling cookie-authenticated endpoints.
 */
export function isSameOriginRequest(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  const origin = req.headers.get('origin');

  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      return allowedHosts(req).includes(originHost);
    } catch {
      return false;
    }
  }

  if (site) {
    return site === 'same-origin' || site === 'same-origin' + '' || site === 'none';
  }

  // No Origin and no Sec-Fetch-Site: fail closed for state-changing requests.
  return false;
}

/** Convenience wrapper returning a 403 response for cross-site requests. */
export function rejectCrossSiteRequest(): Response {
  return new Response(
    JSON.stringify({ error: 'Forbidden: Cross-site requests are not allowed for this endpoint.' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Extracts a Bearer token strictly from the `Authorization` header.
 *
 * SECURITY NOTE: Session tokens must NEVER be accepted from JSON request
 * bodies — body contents are routinely captured in request logs, APM traces
 * and proxy logs, which would leak live Supabase access tokens.
 */
export function extractBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Basic UUID format validation to keep PostgREST filters safe and typed. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
