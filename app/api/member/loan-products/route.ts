import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Lists the active loan products of the signed-in member's SACCO (read-only).
export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const cookieStore = cookies();
    const supabaseClient = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { get(name: string) { return cookieStore.get(name)?.value; } },
    });
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: member } = await admin
      .schema('kunity')
      .from('members')
      .select('organization_id')
      .eq('id', user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });

    const { data, error } = await admin
      .schema('kunity')
      .from('loan_products')
      .select('id, name, interest_rate, min_amount, max_amount')
      .eq('organization_id', member.organization_id)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) return NextResponse.json({ error: 'Could not load loan products' }, { status: 500 });

    return NextResponse.json({ success: true, loanProducts: data || [] });
  } catch (err: unknown) {
    console.error('Error in /api/member/loan-products:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
