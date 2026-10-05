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
     * - api/auth/profile (profile setup route — verifies its own Bearer token)
     * - api/webhooks (HMAC-signed payment webhooks)
     * - api/internal (internal endpoints)
     * - api/organizations (public registration dropdown — no session)
     * - api/inngest (Inngest Cloud endpoint — SDK-verified signatures, no session)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/auth/profile|api/webhooks|api/internal|api/organizations|api/inngest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
