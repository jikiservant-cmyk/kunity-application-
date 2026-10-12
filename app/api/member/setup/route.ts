import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const cookieStore = cookies();
    const supabaseClient = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value; }
      }
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdminLocal = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: member, error: memberErr } = await supabaseAdminLocal
      .schema('kunity')
      .from('members')
      .select('id, organization_id')
      .eq('id', user.id)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
    }

    // 1. Savings products are created by the SACCO admin (Settings > Products).
    //    This route no longer creates a default product, so a member can never
    //    set the SACCO's savings terms. If the SACCO has no product yet, no
    //    account is opened here and the member is told to wait for the admin.
    let { data: productsData } = await supabaseAdminLocal.schema('kunity').from('savings_products').select('id, is_active').eq('organization_id', member.organization_id);
    const activeProduct = (productsData || []).find((p: any) => p.is_active !== false);
    const productId: string | null = activeProduct ? activeProduct.id : null;

    // 2. Ensure the member has a savings account. FIN-31: the account is
    //    created INACTIVE and FROZEN, exactly like /api/member/open-account.
    //    It only becomes usable when the activation payment is recorded by the
    //    payment webhook. (Previously this created an is_active=true account
    //    for ANY caller, letting members skip the activation fee and receive
    //    loan proceeds into an account that was never paid for.)
    const { data: anyAccount } = await supabaseAdminLocal
      .schema('kunity')
      .from('accounts')
      .select('id')
      .eq('member_id', member.id)
      .limit(1)
      .maybeSingle();

    if (!anyAccount && productId) {
      const { data: newAccount, error: accountError } = await supabaseAdminLocal
        .schema('kunity')
        .from('accounts')
        .insert({
          organization_id: member.organization_id,
          member_id: member.id,
          code: `ACC-${Math.floor(1000 + Math.random() * 9000)}`,
          name: 'Main Wallet',
          is_active: false,
          account_category: 'liability',
          cached_balance: 0,
          currency: 'UGX',
          is_system: false
        })
        .select('id')
        .single();

      if (accountError) throw accountError;

      const { error: msError } = await supabaseAdminLocal
        .schema('kunity')
        .from('member_savings')
        .insert({
          organization_id: member.organization_id,
          member_id: member.id,
          savings_product_id: productId,
          account_id: newAccount.id,
          status: 'frozen',
          opened_date: new Date().toISOString().split('T')[0]
        });
      if (msError) throw msError;
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(`Error in /api/member/setup:`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
