import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase-middleware";

// Next.js 16: the "middleware" file convention is renamed to "proxy" (same behaviour).
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - api/auth/profile (profile setup route)
     * - api/webhooks (webhook routes)
     * - api/internal (internal webhook endpoints like payment-completed)
     * - api/messaging (SMS gateway: authenticated by its own API key, not by session
     *   cookies. Without this exclusion cookieless integrator calls were redirected to /auth.)
     * - api/organizations (public signup dropdown: id + name of ACTIVE orgs only.
     *   Must stay reachable pre-login — the middleware redirects cookieless
     *   requests to /auth, which would break the signup SACCO selector.)
     * - api/health (deployment/configuration probe: must answer without a session
     *   and without spending a Supabase getUser() round trip on every uptime check)
     * - api/inngest (Inngest serve endpoint: the platform calls GET/POST/PUT without
     *   session cookies to sync and run background jobs. Behind this proxy every
     *   call was redirected to /auth, so SMS broadcasts and alerts were queued but
     *   never executed. The handler verifies INNGEST_SIGNING_KEY itself.)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/auth/profile|api/webhooks|api/internal|api/organizations|api/health|api/inngest|api/messaging|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
