import { NextResponse } from 'next/server';
import { checkNajikiAvailability } from '@/lib/najiki-health';

/**
 * Deployment health / configuration probe.
 *
 * Purpose: answer "is this environment actually wired up?" in one request, on
 * launch day and from an uptime monitor afterwards.
 *
 * Why it exists: every Supabase client in this app falls back to
 * `https://demo-placeholder.supabase.co` / `placeholder-key` when the public env
 * vars are missing, and the webhook route falls back to a dummy key. Without a
 * probe like this, a half-configured production deployment boots normally, looks
 * healthy, and only fails at the point of use (usually as an unexplained login
 * error) — the worst possible failure mode on go-live day.
 *
 * Safety: returns PRESENCE BOOLEANS ONLY. No secret value, prefix, length or hash
 * is ever included. The Supabase probe is a single shallow GET to the auth health
 * endpoint with a short timeout.
 *
 * Status code: 200 when healthy, 503 when degraded, so an uptime monitor can
 * alert on it directly.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PLACEHOLDER_URL = 'https://demo-placeholder.supabase.co';
const PLACEHOLDER_KEYS = new Set(['placeholder-key', 'dummy-key', 'your-supabase-anon-key-here']);
const PROBE_TIMEOUT_MS = 4000;

function env(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Redact anything that could be a credential: report presence, never content. */
function isReal(value: string | null, placeholders: Set<string> = PLACEHOLDER_KEYS): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (placeholders.has(lowered)) return false;
  // Values left as the documented .env.example stubs must not count as configured.
  if (/^your[-_]/i.test(value) || /^my[-_]/i.test(value) || /here$/.test(lowered)) return false;
  if (/^nk_?\.{2,}$/.test(lowered) || /^njk_whsec_\.{2,}$/.test(lowered)) return false;
  return true;
}

async function probeSupabase(url: string, anonKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/health`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Any HTTP answer means the project is reachable; 401/403 means bad credentials.
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/**
 * Ask NaJiki whether it is actually serving its API.
 *
 * Presence of `NAJIKI_API_URL` is not health: the variable has been set to a
 * deployment whose `/api/payments` answered with an HTML error page, so every
 * deposit failed while this probe happily reported the env var as present. The
 * shared availability check owns that logic — one implementation, used by the
 * money paths and by this endpoint.
 */
async function probeNajiki(url: string): Promise<{ reachable: boolean; version: string | null; reason?: string }> {
  const availability = await checkNajikiAvailability({ force: true });
  if (availability.ok) {
    return { reachable: true, version: availability.version };
  }
  // `url` is passed for the log line only; the checker already logged the detail.
  console.error(`[health] NaJiki is not usable at ${url}: ${availability.reason}`);
  return { reachable: false, version: null, reason: availability.reason };
}

export async function GET() {
  const supabaseUrl = env('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL');
  const supabaseAnonKey = env('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const najikiApiUrl = env('NAJIKI_API_URL');
  const najikiApiKey = env('NAJIKI_API_KEY');
  const najikiWebhookSecret = env('NAJIKI_WEBHOOK_SECRET');
  const appUrl = env('APP_URL', 'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_URL');
  const upstashUrl = env('UPSTASH_REDIS_REST_URL');
  const upstashToken = env('UPSTASH_REDIS_REST_TOKEN');

  const urlConfigured = isReal(supabaseUrl, new Set()) && supabaseUrl !== PLACEHOLDER_URL;
  const anonConfigured = isReal(supabaseAnonKey);
  const serviceRoleConfigured = isReal(serviceRoleKey);
  const usesPlaceholder = supabaseUrl === PLACEHOLDER_URL || !supabaseUrl;

  const warnings: string[] = [];
  if (!urlConfigured) {
    warnings.push(
      usesPlaceholder
        ? 'NEXT_PUBLIC_SUPABASE_URL is not set — clients are pointed at the demo placeholder and nothing will work.'
        : 'NEXT_PUBLIC_SUPABASE_URL does not look like a real Supabase project URL.'
    );
  }
  if (!anonConfigured) warnings.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is missing — sign-in cannot work.');
  if (!serviceRoleConfigured) {
    warnings.push(
      'SUPABASE_SERVICE_ROLE_KEY is missing — admin routes, webhooks and the middleware role lookup will fail.'
    );
  }
  if (!najikiApiUrl) warnings.push('NAJIKI_API_URL is missing — payments and SMS cannot be initiated.');
  if (!najikiApiKey) warnings.push('NAJIKI_API_KEY is missing — NaJiki rejects all API calls.');
  if (!najikiWebhookSecret) {
    warnings.push(
      'NAJIKI_WEBHOOK_SECRET is missing — signed payment notifications will be rejected (fails closed).'
    );
  } else if (najikiApiKey && najikiWebhookSecret === najikiApiKey) {
    warnings.push(
      'NAJIKI_WEBHOOK_SECRET equals NAJIKI_API_KEY — the legacy fallback is in use. Set the dedicated webhook secret from NaJiki.'
    );
  } else if (/^nk_/.test(najikiWebhookSecret) && !/^njk_whsec_/.test(najikiWebhookSecret)) {
    warnings.push('NAJIKI_WEBHOOK_SECRET looks like an API key rather than a dedicated webhook secret.');
  }
  if (!appUrl) {
    warnings.push('APP_URL is not set — the payment-intent CORS allowlist may reject your real origin.');
  }

  const rateLimitBackend = upstashUrl && upstashToken ? 'upstash' : 'memory';
  const rateLimitFailClosed = process.env.ENFORCE_REDIS_RATELIMIT === 'true';
  if (rateLimitBackend === 'memory') {
    warnings.push(
      'Upstash is not configured — rate limiting is per-instance in-memory and does not hold across replicas.'
    );
  }
  if (!rateLimitFailClosed) {
    warnings.push('ENFORCE_REDIS_RATELIMIT is not "true" — rate limiting will not fail closed under load.');
  }
  if (process.env.PAYMENT_PROVIDER_TYPE && process.env.PAYMENT_PROVIDER_TYPE !== 'najiki') {
    warnings.push('PAYMENT_PROVIDER_TYPE is not "najiki" — Kunity routes payments through NaJiki only.');
  }

  const supabaseReachable = urlConfigured && anonConfigured
    ? await probeSupabase(supabaseUrl as string, supabaseAnonKey as string)
    : null;
  if (supabaseReachable === false) {
    warnings.push('The configured Supabase project did not answer the auth health probe.');
  }

  // A configured URL is not a working provider. Probe it, and say plainly when
  // the origin we are pointed at is not serving the NaJiki API.
  const najikiProbe = najikiApiUrl ? await probeNajiki(najikiApiUrl) : null;
  if (najikiProbe && !najikiProbe.reachable) {
    warnings.push(
      'NaJiki is not usable at the configured NAJIKI_API_URL — payments will fail. ' +
      'Point it at the origin of the running NaJiki deployment, with no trailing slash and no /api suffix.'
    );
  }

  const criticalOk = urlConfigured && anonConfigured && serviceRoleConfigured && supabaseReachable !== false;
  const healthy = criticalOk
    && najikiApiUrl !== null
    && najikiApiKey !== null
    && najikiWebhookSecret !== null
    && najikiProbe !== null
    && najikiProbe.reachable;

  const body = {
    status: healthy ? 'ok' : criticalOk ? 'degraded' : 'not_ready',
    deployment: process.env.NODE_ENV === 'production' ? 'production' : process.env.NODE_ENV,
    checkedAt: new Date().toISOString(),
    checks: {
      supabaseUrl: urlConfigured,
      supabaseAnonKey: anonConfigured,
      supabaseServiceRoleKey: serviceRoleConfigured,
      supabaseReachable,
      najikiApiUrl: Boolean(najikiApiUrl),
      najikiReachable: najikiProbe ? najikiProbe.reachable : null,
      najikiVersion: najikiProbe?.version ?? null,
      najikiApiKey: Boolean(najikiApiKey),
      najikiWebhookSecret: Boolean(najikiWebhookSecret),
      najikiApplicationCode: env('NAJIKI_APPLICATION_CODE') ?? null,
      appUrl: Boolean(appUrl),
      rateLimitBackend,
      rateLimitFailClosed,
    },
    warnings,
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
