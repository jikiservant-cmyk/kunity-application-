import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { paymentGateway } from '@/lib/payments/gateway';

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

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

    if (!credits || !amount) {
      return NextResponse.json({ error: 'Credits and price amount are required' }, { status: 400 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile to get organization_id
    const { data: adminProfile } = await supabaseAdmin
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    const tenantId = adminProfile?.tenant_id;

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 400 });
    }

    // Retrieve tenant wallet just to make sure they have one
    const { data: existingWallet } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      return NextResponse.json({ error: 'Wallet not found for this tenant. Please provision a wallet first.' }, { status: 400 });
    }

    // Create payment intent
    const intent = await paymentGateway.createPaymentIntent(amount, "UGX", {
      source: 'web_app',
      phoneNumber: momoNumber,
      organizationId: tenantId,
      paymentTypeCode: 'sms_topup',
      reference: `PAY-SMS-${Date.now()}`
    });

    // Record the payment request
    await supabaseAdmin.schema('kunity').from('payment_requests').insert({
      id: intent.id,
      organization_id: tenantId,
      transaction_reference: intent.id,
      amount: amount,
      status: 'pending',
      direction: 'inbound',
      idempotency_key: intent.id,
      payment_type: 'sms_topup',
      payload: intent
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
