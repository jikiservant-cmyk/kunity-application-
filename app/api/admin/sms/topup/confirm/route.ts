import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from "@supabase/ssr";

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    const supabaseAdmin = createServerClient(supabaseUrl, supabaseServiceKey, {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    });

    const body = await req.json();
    const { token, intentId, momoNumber, credits, amount } = body;

    if (!token || !intentId) {
      return NextResponse.json({ error: 'Missing token or intentId' }, { status: 400 });
    }

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    const { data: adminProfile } = await supabaseAdmin
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    const tenantId = adminProfile?.tenant_id;
    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 400 });
    }

    // Double check status with Najiki
    const najikiRes = await fetch(`https://najiki.netlify.app/api/payments/${intentId}`);
    if (!najikiRes.ok) {
      return NextResponse.json({ error: 'Failed to verify payment with NaJiki' }, { status: 400 });
    }
    const payment = await najikiRes.json();
    if (payment.status !== 'success' && payment.status !== 'successful') {
      return NextResponse.json({ error: 'Payment is not yet successful' }, { status: 400 });
    }

    // Check payment_request
    const { data: request } = await supabaseAdmin
      .schema('kunity')
      .from('payment_requests')
      .select('*')
      .eq('id', intentId)
      .maybeSingle();

    if (!request) {
      return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
    }

    if (request.status === 'success') {
       return NextResponse.json({ success: true, message: 'Already processed' });
    }

    // Retrieve tenant wallet
    const { data: existingWallet } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 400 });
    }

    // Credit wallet using RPC
    const addedAmount = parseFloat(amount);
    const { data: creditResult, error: creditErr } = await supabaseAdmin
      .schema('kunity')
      .rpc('credit_tenant_wallet', { 
        p_wallet_id: existingWallet.id, 
        p_amount: addedAmount 
      });

    if (creditErr) {
       console.error('Error crediting wallet balance:', creditErr);
       return NextResponse.json({ error: 'Failed to update wallet balance' }, { status: 500 });
    }

    // Update payment request status
    await supabaseAdmin
      .schema('kunity')
      .from('payment_requests')
      .update({ status: 'success', completed_at: new Date().toISOString() })
      .eq('id', intentId);

    let applicationId = null;
    try {
      const { data: tenantData } = await supabaseAdmin
        .schema('public')
        .from('tenants')
        .select('application_id')
        .eq('id', tenantId)
        .maybeSingle();
      if (tenantData) {
        applicationId = tenantData.application_id;
      }
    } catch (e) {
      console.error('Error fetching tenant application_id for topup log:', e);
    }

    const providerSmsId = `tx_topup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await supabaseAdmin
      .schema('public')
      .from('sms_messages')
      .insert({
        tenant_id: tenantId,
        application_id: applicationId,
        phone_number: momoNumber || 'SYSTEM',
        compiled_message: `SYSTEM CREDIT: Top-up of ${credits.toLocaleString()} SMS credits successful. New credit balance: ${Math.floor(creditResult.new_balance / 40)} credits.`,
        cost: -addedAmount,
        status: 'delivered',
        event_code: 'DEPOSIT_ALERT',
        provider_message_id: providerSmsId
      });

    return NextResponse.json({
      success: true,
      addedCredits: credits,
      newBalanceCredits: Math.floor(creditResult.new_balance / 40),
      newBalanceUGX: creditResult.new_balance
    });
  } catch (err: any) {
    console.error('Error confirming SMS topup:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
