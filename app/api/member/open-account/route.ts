import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// FIN-33: the single supported way for a member to open a savings plan.
// Accounts are created INACTIVE and FROZEN here (service role). They only
// become usable when the activation payment is recorded by the payment
// webhook. The browser must not insert into kunity.accounts / member_savings
// directly: the lockdown migrations revoke client INSERT on those tables, so
// that path fails with "permission denied" and the member can never activate.
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: member, error: memberErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('id, organization_id, status')
      .eq('id', user.id)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { productId, productName } = body as { productId?: string; productName?: string };

    if (!productId || typeof productId !== 'string') {
      return NextResponse.json({ error: 'productId is required' }, { status: 400 });
    }

    // The savings product must belong to the caller's own organization and be active.
    const { data: product, error: productErr } = await supabaseAdmin
      .schema('kunity')
      .from('savings_products')
      .select('id, name, is_active')
      .eq('id', productId)
      .eq('organization_id', member.organization_id)
      .maybeSingle();

    if (productErr || !product) {
      return NextResponse.json({ error: 'Savings product not found in your organization' }, { status: 403 });
    }

    if (product.is_active === false) {
      return NextResponse.json({ error: 'This savings product is no longer available' }, { status: 403 });
    }

    // Idempotent: one account per product per member.
    const { data: existingMs } = await supabaseAdmin
      .schema('kunity')
      .from('member_savings')
      .select('id, account_id')
      .eq('organization_id', member.organization_id)
      .eq('member_id', member.id)
      .eq('savings_product_id', productId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();

    if (existingMs) {
      return NextResponse.json({ success: true, alreadyOpen: true, accountId: existingMs.account_id });
    }

    const { data: newAccount, error: accountError } = await supabaseAdmin
      .schema('kunity')
      .from('accounts')
      .insert({
        organization_id: member.organization_id,
        member_id: member.id,
        name: productName || product.name || 'Savings Account',
        account_category: 'asset',
        code: `SAV-${Math.floor(100000 + Math.random() * 900000)}`,
        is_active: false,
        cached_balance: 0.0,
        currency: 'UGX',
        is_system: false,
      })
      .select('id')
      .single();

    if (accountError || !newAccount) {
      console.error('[open-account] account insert failed:', accountError);
      return NextResponse.json({ error: 'Could not open account. Please try again.' }, { status: 500 });
    }

    const { error: msError } = await supabaseAdmin
      .schema('kunity')
      .from('member_savings')
      .insert({
        organization_id: member.organization_id,
        member_id: member.id,
        savings_product_id: productId,
        account_id: newAccount.id,
        status: 'frozen',
        opened_date: new Date().toISOString().split('T')[0],
      });

    if (msError) {
      console.error('[open-account] member_savings insert failed:', msError);
      // roll back the orphan account so a retry starts clean
      await supabaseAdmin.schema('kunity').from('accounts').delete().eq('id', newAccount.id);
      return NextResponse.json({ error: 'Could not open account. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, alreadyOpen: false, accountId: newAccount.id });
  } catch (err: any) {
    console.error('Error in /api/member/open-account:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
