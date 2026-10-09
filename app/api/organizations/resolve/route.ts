import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { apiLimiter } from '@/lib/rate-limit';
import { normalizeJoinCode } from '@/lib/join-code';

// Public: turns a SACCO join code into that SACCO's id + name so the sign-up
// page can lock the selection. Replaces the old public list of all SACCOs.
// Returns ONLY id and name, and only for active SACCOs.
export async function GET(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    try {
      await apiLimiter.check(30, `org-resolve:${ip}`);
    } catch {
      return NextResponse.json({ error: 'Too many attempts. Please wait a moment.' }, { status: 429 });
    }

    const code = normalizeJoinCode(req.nextUrl.searchParams.get('code'));
    if (!code) {
      return NextResponse.json({ error: 'This join link is not valid.' }, { status: 400 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: org, error } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name, is_active')
      .eq('join_code', code)
      .maybeSingle();

    if (error) {
      console.error('[organizations/resolve] lookup failed:', error);
      return NextResponse.json({ error: 'Could not check this link. Please try again.' }, { status: 500 });
    }
    if (!org || !org.is_active) {
      return NextResponse.json({ error: 'This join link is invalid or no longer active. Ask your SACCO for a new link.' }, { status: 404 });
    }

    return NextResponse.json({ organization: { id: org.id, name: org.name } });
  } catch (err: unknown) {
    console.error('GET /api/organizations/resolve error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
