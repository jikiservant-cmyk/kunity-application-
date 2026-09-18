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

let clientInstance: any = null;

function getClient() {
  if (clientInstance) return clientInstance;

  // Self-heal bloated/duplicate cookies to prevent "400 Bad Request"
  if (typeof window !== 'undefined') {
    try {
      const cookies = document.cookie.split(';');
      const counts: Record<string, number> = {};
      cookies.forEach(c => {
        const name = c.trim().split('=')[0].trim();
        if (name.startsWith('sb-')) {
          counts[name] = (counts[name] || 0) + 1;
        }
      });
      Object.keys(counts).forEach(name => {
        if (counts[name] > 1) {
          // Expire them across common cookie scopes
          document.cookie = `${name}=; path=/; max-age=0; SameSite=None; Secure`;
          document.cookie = `${name}=; path=/; max-age=0; SameSite=None; Secure; Partitioned`;
          document.cookie = `${name}=; path=/; max-age=0;`;
        }
      });
    } catch (e) {
      console.warn("Cookie self-healing error:", e);
    }
  }

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
        secure: !isLocalhost
      },
      db: {
        schema: 'kunity'
      }
    }
  );

  if (typeof window !== 'undefined' && !isLocalhost) {
    clientInstance.auth.onAuthStateChange((event: string, session: any) => {
      try {
        const cookies = document.cookie.split(';');
        if (!(window as any).__partitionedCookies) {
          (window as any).__partitionedCookies = {};
        }
        cookies.forEach(cookie => {
          const trimmed = cookie.trim();
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex !== -1) {
            const name = trimmed.substring(0, eqIndex).trim();
            const value = trimmed.substring(eqIndex + 1).trim();
            if (name.startsWith('sb-') && value) {
              if ((window as any).__partitionedCookies[name] !== value) {
                document.cookie = `${name}=${value}; path=/; max-age=31536000; SameSite=None; Secure; Partitioned`;
                (window as any).__partitionedCookies[name] = value;
              }
            }
          }
        });
      } catch (err) {
        console.error("Error setting partitioned cookies:", err);
      }
    });
  }

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
