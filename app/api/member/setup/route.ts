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

    // 1. Ensure a default savings product exists
    let { data: productsData } = await supabaseAdminLocal.schema('kunity').from('savings_products').select('*').eq('organization_id', member.organization_id);
    let productId = null;
    
    if (!productsData || productsData.length === 0) {
      const { data: newProduct } = await supabaseAdminLocal.schema('kunity').from('savings_products').insert({
        organization_id: member.organization_id,
        name: 'Standard Savings',
        interest_rate: 5.0,
        min_balance: 0,
        allows_withdrawals: true,
        deposit_frequency: 'monthly'
      }).select('id').single();
      if (newProduct) productId = newProduct.id;
    } else {
      productId = productsData[0].id;
    }

    // 2. Ensure an active account exists
    let { data: activeAccounts } = await supabaseAdminLocal.schema('kunity').from('accounts').select('*').eq('member_id', member.id).eq('is_active', true);
    
    if (!activeAccounts || activeAccounts.length === 0) {
      const { data: newAccount } = await supabaseAdminLocal.schema('kunity').from('accounts').insert({
        organization_id: member.organization_id,
        member_id: member.id,
        code: `ACC-${Math.floor(1000 + Math.random() * 9000)}`,
        name: 'Main Wallet',
        is_active: true,
        account_category: 'liability',
        cached_balance: 0
      }).select('*').single();
      
      if (newAccount && productId) {
        await supabaseAdminLocal.schema('kunity').from('member_savings').insert({
          organization_id: member.organization_id,
          member_id: member.id,
          product_id: productId,
          account_id: newAccount.id,
          status: 'active'
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(`Error in /api/member/setup:`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
