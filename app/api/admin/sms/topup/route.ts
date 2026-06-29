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
    let wallet = null;
    const { data: existingWallet } = await supabaseAdmin
      .schema('kunity')
      .from('tenant_wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      // Auto-create wallet if missing
      const { data: newWallet } = await supabaseAdmin
        .schema('kunity')
        .from('tenant_wallets')
        .insert({
          tenant_id: tenantId,
          balance: 0.00,
          currency: 'UGX',
          is_active: true
        })
        .select('*')
        .single();
      wallet = newWallet;
    } else {
      wallet = existingWallet;
    }

    const currentBalance = parseFloat(wallet.balance);
    const addedAmount = parseFloat(amount);
    const newBalance = currentBalance + addedAmount;

    // Update wallet balance in database
    const { error: creditErr } = await supabaseAdmin
      .schema('kunity')
      .from('tenant_wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', wallet.id);

    if (creditErr) {
      console.error('Error crediting wallet balance:', creditErr);
      return NextResponse.json({ error: 'Failed to update wallet balance' }, { status: 500 });
    }

    // Record credit transaction in wallet transactions ledger
    const transactionRef = `tx_topup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const { error: txErr } = await supabaseAdmin
      .schema('kunity')
      .from('wallet_transactions')
      .insert({
        wallet_id: wallet.id,
        type: 'CREDIT',
        amount: addedAmount,
        running_balance: newBalance,
        description: `SMS bundle top-up of ${credits.toLocaleString()} credits via Mobile Money (${momoNumber || 'system'})`,
        reference: transactionRef
      });

    if (txErr) {
      console.error('Error logging top-up transaction ledger:', txErr);
    }

    // Log high-level activity log inside kunity.sms_logs as administrative notification
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
        provider_sms_id: transactionRef
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
