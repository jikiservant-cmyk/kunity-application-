import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { token, credits, amount, momoNumber } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    if (!credits || !amount) {
      return NextResponse.json({ error: 'Credits and price amount are required' }, { status: 400 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile to get organization_id
    const { data: adminProfile, error: profileErr } = await supabaseAdmin
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    let tenantId = adminProfile?.tenant_id;
    if (!tenantId && user.user_metadata?.tenant_id) {
      tenantId = user.user_metadata.tenant_id;
    }

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 400 });
    }

    // Retrieve tenant wallet
    const { data: existingWallet } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      return NextResponse.json({ error: 'Wallet not found for this tenant. Please provision a wallet first.' }, { status: 400 });
    }

    const wallet = existingWallet;

    const currentBalance = parseFloat(wallet.balance);
    const addedAmount = parseFloat(amount);
    const newBalance = currentBalance + addedAmount;

    // Update wallet balance in database using RPC
    const { data: creditResult, error: creditErr } = await supabaseAdmin
      .schema('kunity')
      .rpc('credit_tenant_wallet', { 
        p_wallet_id: wallet.id, 
        p_amount: addedAmount 
      });

    if (creditErr) {
      console.error('Error crediting wallet balance:', creditErr);
      return NextResponse.json({ error: 'Failed to update wallet balance' }, { status: 500 });
    } else if (creditResult && !creditResult.success) {
      return NextResponse.json({ error: creditResult.error }, { status: 500 });
    }

    // Record credit transaction in wallet transactions ledger is handled by the RPC.
    
    // Log high-level activity log inside kunity.sms_logs as administrative notification
    const providerSmsId = `tx_topup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await supabaseAdmin
      .schema('kunity')
      .from('sms_logs')
      .insert({
        tenant_id: tenantId,
        recipient_phone: momoNumber || 'SYSTEM',
        message: `SYSTEM CREDIT: Top-up of ${credits.toLocaleString()} SMS credits successful. New credit balance: ${Math.floor(newBalance / 40)} credits.`,
        cost: -addedAmount, // Positive cost for debits, negative cost for credits in logs if needed, or 0.00
        status: 'delivered',
        event_type: 'DEPOSIT_ALERT',
        provider_sms_id: providerSmsId
      });

    return NextResponse.json({
      success: true,
      addedCredits: credits,
      newBalanceCredits: Math.floor(newBalance / 40),
      newBalanceUGX: newBalance
    });

  } catch (err: any) {
    console.error('Error topping up SMS wallet on server:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
