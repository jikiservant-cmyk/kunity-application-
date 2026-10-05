import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase-middleware";

export async function middleware(request: NextRequest) {
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
     * - api/organizations (public signup dropdown: id + name of ACTIVE orgs only.
     *   Must stay reachable pre-login — the middleware redirects cookieless
     *   requests to /auth, which would break the signup SACCO selector.)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/auth/profile|api/webhooks|api/internal|api/organizations|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
