import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { memberAccountLimiter } from '@/lib/rate-limit';
import { isSameOriginRequest, rejectCrossSiteRequest, isUuid } from '@/lib/request-guard';

export async function POST(req: NextRequest) {
  try {
    // SECURITY (CSRF guard): cookie-authenticated, state-changing endpoint.
    if (!isSameOriginRequest(req)) {
      return rejectCrossSiteRequest();
    }

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

    // Rate limit savings-account opening per member.
    try {
      await memberAccountLimiter.check(20, `member:open-account:${user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many account requests. Please wait a moment before trying again.' }, { status: 429 });
    }

    const supabaseAdminLocal = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: member, error: memberErr } = await supabaseAdminLocal
      .schema('kunity')
      .from('members')
      .select('id, organization_id, status')
      .eq('id', user.id)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
    }

    // Rejected or suspended members may not open savings accounts.
    if (member.status === 'rejected' || member.status === 'suspended') {
      return NextResponse.json(
        { error: `Account is ${member.status}. Contact your SACCO administrator.` },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { productId, productName } = body;

    if (!productId) {
      return NextResponse.json({ error: 'productId is required' }, { status: 400 });
    }

    if (!isUuid(productId)) {
      return NextResponse.json({ error: 'Invalid productId format' }, { status: 400 });
    }

    // SECURITY (cross-tenant guard): The savings product must exist AND
    // belong to the caller's own SACCO organization. Without this check a
    // member could attach a savings account to a product of a different
    // tenant, polluting foreign-tenant data.
    const { data: product } = await supabaseAdminLocal
      .schema('kunity')
      .from('savings_products')
      .select('id, organization_id, is_active')
      .eq('id', productId)
      .maybeSingle();

    if (!product || product.organization_id !== member.organization_id) {
      return NextResponse.json({ error: 'Savings product not found in your cooperative' }, { status: 404 });
    }

    if (product.is_active === false) {
      return NextResponse.json({ error: 'This savings product is not currently available' }, { status: 403 });
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
