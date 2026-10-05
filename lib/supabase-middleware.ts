import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isElevatedAdminRole } from "@/lib/roles";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const isLocalhost = request.nextUrl.hostname === 'localhost' || request.nextUrl.hostname === '127.0.0.1';

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://demo-placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder-key',
    {
      cookieOptions: {
        sameSite: isLocalhost ? 'lax' : 'none',
        secure: !isLocalhost
      },
      cookies: {
        getAll() {
          const allCookies = request.cookies.getAll();
          const uniqueMap = new Map();
          allCookies.forEach(cookie => {
            uniqueMap.set(cookie.name, cookie);
          });
          return Array.from(uniqueMap.values());
        },
        setAll(cookiesToSet) {
          const uniqueMap = new Map();
          cookiesToSet.forEach(cookie => {
            uniqueMap.set(cookie.name, cookie);
          });
          const uniqueCookies = Array.from(uniqueMap.values()) as typeof cookiesToSet;

          uniqueCookies.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          uniqueCookies.forEach(({ name, value, options }) => {
            const cookieOpts: any = { 
              ...options, 
              sameSite: isLocalhost ? 'lax' : 'none', 
              secure: !isLocalhost 
            };
            if (!isLocalhost) {
              cookieOpts.partitioned = true;
            }
            supabaseResponse.cookies.set(name, value, cookieOpts);
          });
        },
      },
    }
  );

  // refreshing the auth token
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  // SECURITY (API integrity): API endpoints must never receive an HTML login
  // redirect. Anonymous or expired-session API calls get a proper 401 JSON,
  // and requests that carry an Authorization header are passed through so the
  // route can authenticate the Bearer session / gateway API key itself.
  // (Note: supabase-js reports a missing session as status 400, which
  // previously triggered the login-page redirect even for public API routes.)
  const isApiRequest = request.nextUrl.pathname.startsWith('/api/');
  const hasAuthorizationHeader = !!request.headers.get('authorization');

  if (authError) {
    if (!authError.message?.includes('Auth session missing!')) {
      console.warn("[Middleware] Auth token check warning:", authError.message);
    }

    const sessionInvalid =
      authError.message?.includes('Refresh Token') ||
      authError.status === 400 ||
      authError.status === 401;

    if (sessionInvalid) {
      if (isApiRequest) {
        if (!hasAuthorizationHeader) {
          const unauthorized = NextResponse.json(
            { error: 'Unauthorized: Session missing, expired, or invalid' },
            { status: 401 }
          );
          request.cookies.getAll().forEach(cookie => {
            if (cookie.name.startsWith('sb-')) {
              const cookieOpts: any = {
                path: '/',
                maxAge: 0,
                sameSite: isLocalhost ? 'lax' : 'none',
                secure: !isLocalhost
              };
              if (!isLocalhost) {
                cookieOpts.partitioned = true;
              }
              unauthorized.cookies.set(cookie.name, '', cookieOpts);
            }
          });
          return unauthorized;
        }
        // Authorization header present: the route performs its own
        // cryptographic authentication. Fall through without redirecting.
      } else if (!request.nextUrl.pathname.startsWith('/auth')) {
        const url = request.nextUrl.clone();
        url.pathname = '/auth';
        const redirectResponse = NextResponse.redirect(url);
        request.cookies.getAll().forEach(cookie => {
          if (cookie.name.startsWith('sb-')) {
            const cookieOpts: any = {
              path: '/',
              maxAge: 0,
              sameSite: isLocalhost ? 'lax' : 'none',
              secure: !isLocalhost
            };
            if (!isLocalhost) {
              cookieOpts.partitioned = true;
            }
            redirectResponse.cookies.set(cookie.name, '', cookieOpts);
          }
        });
        return redirectResponse;
      }
    }
  }

  // Route protection logic
  const isAuthPage = request.nextUrl.pathname.startsWith('/auth');
  const isAdminPage = request.nextUrl.pathname.startsWith('/admin');
  const isMemberPage = request.nextUrl.pathname.startsWith('/member');

  // If there's no user, redirect to login for protected routes
  if (!user && (isAdminPage || isMemberPage)) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth';
    return NextResponse.redirect(url);
  }

  // If user exists, fetch their authoritative role strictly from public.admin_profiles table
  if (user) {
    let role: string | null = null;
    
    // Authoritative check: Query database using service role key, never trust client-writable user_metadata
    try {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;

      if (serviceKey && supabaseUrl) {
        const adminSupabase = createServerClient(
          supabaseUrl,
          serviceKey,
          {
            cookies: {
              getAll() {
                return [];
              },
              setAll() {
                // Do nothing
              }
            }
          }
        );
        const { data: profile } = await adminSupabase
          .schema('public')
          .from('admin_profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle();
        role = profile?.role || null;
      }
    } catch (e) {
      console.warn("[Middleware] Could not fetch authoritative role:", e);
    }
    
    role = role || 'member';
    const isSaccoAdmin = isElevatedAdminRole(role);
    const isMember = !isSaccoAdmin;

    if (isAuthPage) {
      // Don't let logged-in users see the auth page
      const url = request.nextUrl.clone();
      if (isSaccoAdmin) {
        url.pathname = '/admin';
      } else {
        url.pathname = '/member';
      }
      return NextResponse.redirect(url);
    }

    if (isAdminPage || isMemberPage) {
      // Protect /admin routes, must be strictly admin
      if (isAdminPage && !isSaccoAdmin) {
        const url = request.nextUrl.clone();
        url.pathname = isMember ? '/member' : '/auth';
        return NextResponse.redirect(url);
      }

      // Protect /member routes, must be strictly member
      if (isMemberPage && isSaccoAdmin && !isMember) {
        const url = request.nextUrl.clone();
        url.pathname = '/admin';
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
