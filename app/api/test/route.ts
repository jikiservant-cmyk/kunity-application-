import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function GET() {
  const supabaseAdmin = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    }
  );

  const { data, error } = await supabaseAdmin.from('tenants').select('*');
  
  // Also try to query information_schema if possible? Supabase usually restricts it.
  
  return NextResponse.json({ tenants: data, error: error?.message });
}
