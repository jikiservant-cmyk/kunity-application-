import { createBrowserClient } from '@supabase/ssr';

const getEnvUrl = () => {
  if (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_URL) {
    return (window as any).ENV.NEXT_PUBLIC_SUPABASE_URL;
  }
  return process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://demo-placeholder.supabase.co';
};

const getEnvAnonKey = () => {
  if (typeof window !== 'undefined' && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return (window as any).ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';
};

// Cookies live for 30 days so a login survives browser restarts and PWA
// relaunches — the member stays signed in until they tap logout.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

let clientInstance: any = null;

function getClient() {
  if (clientInstance) return clientInstance;

  const supabaseUrl = getEnvUrl();
  const supabaseAnonKey = getEnvAnonKey();

  // Detect if we are in localhost or HTTP to avoid cookie rejection
  const isLocalhost = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  clientInstance = createBrowserClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookieOptions: {
        sameSite: isLocalhost ? 'lax' : 'none',
        secure: !isLocalhost,
        maxAge: SESSION_COOKIE_MAX_AGE,
      },
      db: {
        schema: 'kunity'
      }
    }
  );

  // SESSION PERSISTENCE (2026-10-22): this client used to (a) re-save every
  // sb-* cookie as a SECOND copy with Partitioned + a 1-year expiry on every
  // auth change, and (b) "self-heal" by deleting every duplicate copy on
  // load — including the live session cookie. The two writer/eraser hacks
  // fought each other, left same-named cookies with drifting values, and the
  // middleware then read a stale copy, concluded the refresh token was
  // already used, and wiped the login on every hard refresh. Both blocks are
  // removed: @supabase/ssr is the single writer of session cookies, with the
  // SAME attributes the middleware uses (see lib/supabase-middleware.ts).
  // Do not re-add manual DOM cookie handling for sb-* cookies here.

  return clientInstance;
}

export const supabase = new Proxy({} as any, {
  get(target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop);
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  },
  set(target, prop, value, receiver) {
    const client = getClient();
    return Reflect.set(client, prop, value);
  }
});
