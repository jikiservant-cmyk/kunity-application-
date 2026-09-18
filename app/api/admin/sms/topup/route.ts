import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { paymentGateway } from '@/lib/payments/gateway';
import crypto from 'crypto';
import { logAudit } from '@/lib/audit-logger';

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createServerClient(supabaseUrl, supabaseServiceKey, {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    });

    const body = await req.json();
    const { token, credits, amount, momoNumber } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    if (!credits || !amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Invalid credits or price amount' }, { status: 400 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile to get tenant_id and role
    const { data: adminProfile } = await supabaseAdmin
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    const role = adminProfile?.role || 'member';
    const isSaccoAdmin = ['sacco_admin', 'system_admin', 'super_admin'].includes(role);
    
    if (!isSaccoAdmin) {
      return NextResponse.json({ error: 'Forbidden: User is not an admin' }, { status: 403 });
    }

    const tenantId = adminProfile?.tenant_id;

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 400 });
    }

    // Retrieve tenant wallet from public.wallets (Sacco schema)
    let wallet = null;
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet && !fetchWalletErr) {
      // Auto-provision default wallet if not found
      console.log(`[SMS Topup API] Auto-provisioning default sacco wallet for organization ${tenantId}...`);
      const { data: newWallet, error: createWalletErr } = await supabaseAdmin
        .schema('public')
        .from('wallets')
        .insert({
          tenant_id: tenantId,
          balance: 0.00,
          sms_rate: 50.00
        })
        .select('*')
        .maybeSingle();

      if (createWalletErr) {
        return NextResponse.json({ error: 'Failed to find or auto-provision wallet.' }, { status: 400 });
      }
      wallet = newWallet;
    } else {
      wallet = existingWallet;
    }

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet not found for this Sacco. Please contact support.' }, { status: 400 });
    }

    // Fetch tenant code
    let tenantCode = tenantId;
    const { data: tenantData } = await supabaseAdmin.schema('public').from('tenants').select('code').eq('id', tenantId).maybeSingle();
    if (tenantData?.code) {
        tenantCode = tenantData.code;
    }

    // Create payment intent
    const intent = await paymentGateway.createPaymentIntent(amount, "UGX", {
      source: 'web_app',
      phoneNumber: momoNumber,
      organizationId: tenantId,
      tenantCode: tenantCode,
      paymentTypeCode: 'BUY_SMS',
      reference: `PAY-SMS-${Date.now()}`
    });

    // Record the payment request
    await supabaseAdmin.schema('public').from('wallet_transactions').insert({
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      tenant_id: tenantId,
      direction: 'credit',
      amount: amount,
      currency: 'UGX',
      note: 'pending',
      type: 'sms_topup',
      reference: intent.id,
      description: 'Pending SMS topup via Mobile Money'
    });

    await logAudit(supabaseAdmin, {
      adminId: user.id,
      tenantId: tenantId,
      action: 'create_sms_topup_intent',
      entityType: 'payment_intent',
      entityId: intent.id,
      newData: { amount, credits, momoNumber }
    });

    return NextResponse.json({
      success: true,
      intent
    });

  } catch (err: any) {
    console.error('Error initiating SMS wallet topup:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
