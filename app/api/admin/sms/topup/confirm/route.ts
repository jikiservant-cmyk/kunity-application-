import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from "@supabase/ssr";
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { smsSendLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    const supabaseAdmin = createServerClient(supabaseUrl, supabaseServiceKey, {
      cookies: {
        getAll() { return []; },
        setAll() {},
      },
    });

    const body = await req.json();
    const { token, intentId, momoNumber, credits } = body;

    if (!token || !intentId) {
      return NextResponse.json({ error: 'Missing token or intentId' }, { status: 400 });
    }

    // 1. Verify caller is a genuine administrator (token + role from admin_profiles)
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Rate limit topup confirmation attempts per administrator
    try {
      await smsSendLimiter.check(20, `admin:topup:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for topup confirmation' }, { status: 429 });
    }

    const tenantId = adminAuth.tenantId;
    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 403 });
    }

    // Safe parameter lookup avoiding string interpolation in .or()
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId);

    let request: any = null;
    if (isUUID) {
      const { data: byId } = await supabaseAdmin
        .schema('public')
        .from('wallet_transactions')
        .select('*')
        .eq('id', intentId)
        .maybeSingle();
      request = byId;
    }

    if (!request) {
      const { data: byRef } = await supabaseAdmin
        .schema('public')
        .from('wallet_transactions')
        .select('*')
        .eq('reference', intentId)
        .maybeSingle();
      request = byRef;
    }

    if (!request) {
      return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
    }
    
    // Ensure the payment request actually belongs to this admin's tenant.
    // Global admins (super_admin/system_admin) may confirm for any tenant.
    if (request.tenant_id !== tenantId && !adminAuth.isGlobalAdmin) {
      return NextResponse.json({ error: 'Unauthorized: Payment request does not belong to this tenant' }, { status: 403 });
    }

    if (request.note === 'success' || request.description === 'success' || request.status === 'success') {
       const { data: w } = await supabaseAdmin.schema('public').from('wallets').select('balance, sms_rate').eq('tenant_id', tenantId).single();
       return NextResponse.json({ 
         success: true, 
         message: 'Already processed',
         newBalanceUGX: w?.balance || 0,
         newBalanceCredits: Math.floor((w?.balance || 0) / (parseFloat(w?.sms_rate) || 50))
       });
    }

    // Double check status with Najiki
    const apiUrl = process.env.NAJIKI_API_URL || "https://najiki.netlify.app";
    const apiKey = process.env.NAJIKI_API_KEY || "";
    const najikiRes = await fetch(`${apiUrl}/api/payments/${intentId}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    if (!najikiRes.ok) {
      return NextResponse.json({ error: 'Failed to verify payment with NaJiki' }, { status: 400 });
    }
    const payment = await najikiRes.json();
    if (payment.status !== 'success' && payment.status !== 'successful') {
      return NextResponse.json({ error: 'Payment is not yet successful' }, { status: 400 });
    }
    
    // Validate amount from gateway matches what we expect.
    // FIN-12: compare with a small tolerance — strict !== breaks when the
    // gateway returns the amount as a string or with different precision.
    // FIN-25: Number.isFinite guard — if the gateway returns a missing/garbage
    // amount, Number(...) is NaN and `NaN > 0.01` is false, which used to
    // silently PASS this check.
    const expectedAmount = Number(request.amount);
    const gatewayAmount = Number(payment.amount);
    if (!Number.isFinite(expectedAmount) ||
        !Number.isFinite(gatewayAmount) ||
        Math.abs(gatewayAmount - expectedAmount) > 0.01) {
      return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 400 });
    }

    // Retrieve Sacco wallet from public.wallets
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      return NextResponse.json({ error: 'Wallet not found' }, { status: 400 });
    }

    const addedAmount = expectedAmount;

    // Credit wallet atomically via idempotent RPC with row lock on wallet_transactions.
    // SECURITY: There is deliberately NO fallback to the non-idempotent
    // credit_sms_wallet RPC — a fallback would allow double-crediting the wallet
    // when the idempotent RPC fails transiently and the request is retried.
    // If the idempotent RPC fails we fail closed and surface the error instead.
    const { data: idempotentResult, error: idempotentErr } = await supabaseAdmin
      .rpc('credit_sms_wallet_idempotent', {
        p_wallet_id: existingWallet.id,
        p_transaction_id: request.id,
        p_amount: addedAmount
      });

    if (idempotentErr) {
      console.error('Error crediting wallet balance (idempotent RPC, failing closed):', idempotentErr);
      return NextResponse.json({ error: 'Failed to update wallet balance' }, { status: 500 });
    }

    let creditResult: any = Array.isArray(idempotentResult) ? idempotentResult[0] : idempotentResult;

    if (!creditResult) {
      const { data: refreshedWallet } = await supabaseAdmin
        .schema('public')
        .from('wallets')
        .select('*')
        .eq('id', existingWallet.id)
        .single();
      creditResult = refreshedWallet || existingWallet;
    }

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
        compiled_message: `SYSTEM CREDIT: Top-up of ${credits.toLocaleString()} SMS credits successful. New credit balance: ${Math.floor(creditResult.balance / (parseFloat(existingWallet.sms_rate) || 50))} credits.`,
        cost: addedAmount,
        transaction_type: 'credit',
        status: 'delivered',
        event_code: 'DEPOSIT_ALERT',
        provider_message_id: providerSmsId
      });

    await logAudit(supabaseAdmin, {
      adminId: adminAuth.user.id,
      tenantId,
      action: 'sms_topup_confirm',
      entityType: 'wallets',
      entityId: existingWallet.id,
      newData: {
        amount: addedAmount,
        credits,
        intentId,
        newBalanceUGX: creditResult.balance,
      },
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({
      success: true,
      addedCredits: credits,
      newBalanceCredits: Math.floor(creditResult.balance / (parseFloat(existingWallet.sms_rate) || 50)),
      newBalanceUGX: creditResult.balance
    });
  } catch (err: any) {
    console.error('Error confirming SMS topup:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
