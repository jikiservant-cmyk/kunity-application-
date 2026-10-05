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

    const body = await req.json();
    const { productId, productName } = body;

    if (!productId) {
      return NextResponse.json({ error: 'productId is required' }, { status: 400 });
    }

    // SECURITY: The savings product must belong to the caller's own
    // organization AND be active. Without this check a member could open an
    // account linked to another SACCO's product (cross-tenant data pollution)
    // or resurrect a deactivated product.
    const { data: product, error: productErr } = await supabaseAdminLocal
      .schema('kunity')
      .from('savings_products')
      .select('id, is_active')
      .eq('id', productId)
      .eq('organization_id', member.organization_id)
      .maybeSingle();

    if (productErr || !product) {
      return NextResponse.json(
        { error: 'Savings product not found in your organization' },
        { status: 403 }
      );
    }

    if (product.is_active === false) {
      return NextResponse.json(
        { error: 'This savings product is no longer available' },
        { status: 403 }
      );
    }

    const { data: existingMs } = await supabaseAdminLocal.schema('kunity')
      .from('member_savings')
      .select('id')
      .eq('organization_id', member.organization_id)
      .eq('member_id', member.id)
      .eq('savings_product_id', productId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();

    if (!existingMs) {
      const { data: newAccount, error: accountError } = await supabaseAdminLocal.schema('kunity').from('accounts').insert({
        organization_id: member.organization_id,
        member_id: member.id,
        name: productName || 'Savings Account',
        account_category: 'asset',
        code: `SAV-${Math.floor(100000 + Math.random() * 900000)}`,
        is_active: false,
        cached_balance: 0.00,
        currency: 'UGX',
        is_system: false
      }).select('id').single();
      
      if (accountError) throw accountError;
      
      if (newAccount) {
        const { error: msError } = await supabaseAdminLocal.schema('kunity').from('member_savings').insert({
          organization_id: member.organization_id,
          member_id: member.id,
          savings_product_id: productId,
          account_id: newAccount.id,
          status: 'frozen',
          opened_date: new Date().toISOString().split('T')[0]
        });
        if (msError) throw msError;
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(`Error in /api/member/open-account:`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
