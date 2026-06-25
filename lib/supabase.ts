import { createBrowserClient } from '@supabase/ssr';

const getEnv = (key: string) => {
  if (typeof window !== 'undefined' && (window as any).ENV) {
    return (window as any).ENV[key];
  }
  return process.env[key] || process.env[key.replace('NEXT_PUBLIC_', '')];
};

const supabaseUrl = getEnv('NEXT_PUBLIC_SUPABASE_URL') || 'https://demo-placeholder.supabase.co';
const supabaseAnonKey = getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY') || 'placeholder-key';

export const supabase = createBrowserClient(
  supabaseUrl,
  supabaseAnonKey,
  {
    db: {
      schema: 'kunity'
    },
    cookieOptions: {
      sameSite: 'none',
      secure: true
    }
  }
);
