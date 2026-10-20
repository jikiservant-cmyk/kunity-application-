/**
 * Is NaJiki actually serving its API right now?
 *
 * A configured `NAJIKI_API_URL` proves nothing — that is how production spent a
 * day failing every deposit. Two incidents shaped this module:
 *
 *   1. the origin pointed at a deployment whose `/api/payments` answered with a
 *      Next.js HTML page, and
 *   2. the provider's own rate limiter answered JSON `503 Service temporarily
 *      unavailable` when its Redis was not configured.
 *
 * Neither is something a member can act on. So before a money path calls NaJiki
 * we spend one cheap request on `/api/health`, cache the answer, and refuse with
 * a clear message when the provider is not usable. The member finds out in about
 * a second instead of after entering a PIN.
 *
 * Compatibility: a deployment that does not expose `/api/health` (404/405) is
 * treated as "cannot determine" and allowed through — the create call is the
 * real test. Only a definite failure blocks.
 */

import { najikiHostLabel, resolveNajikiBaseUrl } from './najiki-url';

export type NajikiAvailability =
  | { ok: true; host: string; version: string | null; cached: boolean }
  | { ok: false; host: string; reason: string; cached: boolean };

/** Long enough to keep the cost negligible, short enough to notice a recovery. */
const OK_TTL_MS = 30_000;
/** Failures are re-checked quickly so a fixed provider is picked up at once. */
const FAILED_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_500;

type CacheEntry = { at: number; result: NajikiAvailability };
const cache = new Map<string, CacheEntry>();

/** Test hook: forget every cached verdict. */
export function resetNajikiAvailabilityCache(): void {
  cache.clear();
}

function parseHealthBody(text: string): { isJson: boolean; version: string | null } {
  try {
    const parsed = JSON.parse(text);
    return {
      isJson: true,
      version: typeof parsed?.version === 'string' ? parsed.version : null,
    };
  } catch {
    return { isJson: false, version: null };
  }
}

/**
 * Probe the configured NaJiki origin.
 *
 * `force` bypasses the cache (used by the health endpoint and by tests).
 */
export async function checkNajikiAvailability(
  options: { force?: boolean; fetcher?: typeof fetch } = {},
): Promise<NajikiAvailability> {
  let baseUrl: string;
  try {
    baseUrl = resolveNajikiBaseUrl();
  } catch (error: any) {
    // Misconfiguration is a definite failure, but it is not this module's job to
    // throw: the caller decides whether that is a 503 or a boot error.
    return {
      ok: false,
      host: 'unconfigured',
      reason: error?.message || 'NAJIKI_API_URL is not configured',
      cached: false,
    };
  }

  const host = najikiHostLabel(baseUrl);
  const now = Date.now();
  if (!options.force) {
    const hit = cache.get(baseUrl);
    if (hit && now - hit.at < (hit.result.ok ? OK_TTL_MS : FAILED_TTL_MS)) {
      return { ...hit.result, cached: true };
    }
  }

  const record = (result: NajikiAvailability): NajikiAvailability => {
    cache.set(baseUrl, { at: Date.now(), result });
    return result;
  };

  let response: Response;
  try {
    const doFetch = options.fetcher ?? fetch;
    response = await doFetch(`${baseUrl}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error: any) {
    const reason = error?.name === 'TimeoutError'
      ? `did not answer within ${PROBE_TIMEOUT_MS} ms`
      : (error?.message || 'is unreachable');
    console.error(`[najiki-health] ${host} ${reason}`);
    return record({ ok: false, host, reason, cached: false });
  }

  const text = await response.text().catch(() => '');
  const { isJson, version } = parseHealthBody(text);

  // No health route: an older build, or a host that only serves the payment API.
  // We cannot judge from here, so let the create call decide.
  if (response.status === 404 || response.status === 405) {
    return record({ ok: true, host, version: null, cached: false });
  }

  if (!isJson) {
    const looksLikeHtml = /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text);
    const reason = looksLikeHtml
      ? 'answered with an HTML page instead of the NaJiki API'
      : 'answered with a non-JSON body instead of the NaJiki API';
    console.error(`[najiki-health] ${host} ${reason} (HTTP ${response.status})`);
    return record({ ok: false, host, reason, cached: false });
  }

  if (!response.ok) {
    const reason = `reported itself unhealthy (HTTP ${response.status})`;
    console.error(`[najiki-health] ${host} ${reason}: ${text.slice(0, 200)}`);
    return record({ ok: false, host, reason, cached: false });
  }

  return record({ ok: true, host, version, cached: false });
}

/**
 * Member-facing explanation for an unavailable provider.
 *
 * Deliberately free of hostnames, status codes and provider internals: the
 * member needs to know that nothing was charged and what to do next.
 */
export function providerUnavailableMessage(availability?: NajikiAvailability): string {
  const hostnote = availability && !availability.ok ? availability.reason : '';
  if (/HTML page|non-JSON/i.test(hostnote)) {
    return 'Payments are temporarily unavailable while our provider is being updated. ' +
      'No money has been taken from your phone. Please try again in a few minutes.';
  }
  return 'The payment provider is temporarily unavailable, so no money was taken. ' +
    'Please try again in a few minutes.';
}
