import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from "@supabase/ssr";
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { smsSendLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { packForPrice } from '@/lib/sms-packs';
import { normalizeNajikiBaseUrl } from '@/lib/najiki-url';

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
    const { token, intentId, momoNumber } = body;

    if (!token || !intentId) {
      return NextResponse.json({ error: 'Missing token or intentId' }, { status: 400 });
    }
    // SECURITY: intentId is interpolated into a NaJiki URL below, so it must be a plain id.
    if (typeof intentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(intentId)) {
      return NextResponse.json({ error: 'Invalid intentId' }, { status: 400 });
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

    const adminTenantId = adminAuth.tenantId;
    if (!adminTenantId) {
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
    if (request.tenant_id !== adminTenantId && !adminAuth.isGlobalAdmin) {
      return NextResponse.json({ error: 'Unauthorized: Payment request does not belong to this tenant' }, { status: 403 });
    }

    // SECURITY: only SMS top-up credit rows may be confirmed. Any other wallet row with a
    // successful gateway reference must not credit the SMS wallet.
    if (request.type !== 'sms_topup' || request.direction !== 'credit') {
      return NextResponse.json({ error: 'Not an SMS top-up payment request' }, { status: 400 });
    }

    // SECURITY: the wallet credited is the one that owns the payment, not the admin's own
    // tenant. A global admin confirming another SACCO's top-up must not credit their own wallet.
    const tenantId: string = request.tenant_id;

    if (request.note === 'success' || request.description === 'success' || request.status === 'success') {
       const { data: w } = await supabaseAdmin.schema('public').from('wallets').select('balance, sms_rate').eq('tenant_id', tenantId).single();
       return NextResponse.json({ 
         success: true, 
         message: 'Already processed',
         newBalanceUGX: w?.balance || 0,
         newBalanceCredits: Math.floor((w?.balance || 0) / (parseFloat(w?.sms_rate) || 50))
       });
    }
    if (request.note === 'failed' || request.status === 'failed') {
      return NextResponse.json(
        { success: false, status: 'failed', error: 'Payment failed. No SMS credits were added.' },
        { status: 409 }
      );
    }

    // Double check status with Najiki
    const apiUrl = normalizeNajikiBaseUrl(process.env.NAJIKI_API_URL || "https://najiki.netlify.app");
    const apiKey = process.env.NAJIKI_API_KEY || "";
    // NaJiki (GET /api/payments/[reference]) returns 404 for a tenant-scoped payment unless the
    // request names the same tenant code. Without this, every confirmation failed.
    const { data: tenantRow } = await supabaseAdmin
      .schema('public')
      .from('tenants')
      .select('code')
      .eq('id', tenantId)
      .maybeSingle();
    // Same rule as when the payment was created (admin topup route): the tenant code, else the tenant id.
    const najikiTenantCode: string = tenantRow?.code || tenantId;
    const najikiRes = await fetch(
      `${apiUrl}/api/payments/${encodeURIComponent(intentId)}?tenantCode=${encodeURIComponent(najikiTenantCode)}`,
      {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    if (!najikiRes.ok) {
      return NextResponse.json({ error: 'Failed to verify payment with NaJiki' }, { status: 400 });
    }
    const payment = await najikiRes.json();
    const gatewayStatus = String(payment?.status || '').toLowerCase();
    if (['failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected'].includes(gatewayStatus)) {
      // The authenticated NaJiki status lookup is a safe fallback when its
      // outbound failure notification has not reached Kunity yet.
      const providerAmount = Number(payment?.amount);
      const storedAmount = Number(request.amount);
      const { error: paymentStatusError } = await supabaseAdmin.schema('kunity').rpc('process_najiki_webhook', {
        p_reference: intentId,
        p_status: gatewayStatus,
        p_amount: Number.isFinite(providerAmount) ? providerAmount : storedAmount,
        p_fee: Number.isFinite(Number(payment?.fee)) ? Number(payment.fee) : 0,
        p_external_entity_id: payment?.externalEntityId || tenantId,
        p_payment_type: payment?.paymentType?.code || payment?.paymentTypeCode || 'BUY_SMS',
        p_payload: payment,
      });
      if (paymentStatusError) {
        console.error('[SMS Topup Confirm] Could not record terminal NaJiki failure:', paymentStatusError);
      }

      const { error: ledgerFailureError } = await supabaseAdmin
        .schema('public')
        .from('wallet_transactions')
        .update({ note: 'failed', status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', request.id)
        .eq('tenant_id', tenantId)
        .eq('note', 'pending');
      if (ledgerFailureError) {
        console.error('[SMS Topup Confirm] Could not mark the SMS top-up failed:', ledgerFailureError);
      }

      return NextResponse.json(
        { success: false, status: 'failed', error: 'Payment failed. No SMS credits were added.' },
        { status: 409 }
      );
    }
    if (gatewayStatus !== 'success' && gatewayStatus !== 'successful') {
      return NextResponse.json({ error: 'Payment is not yet successful' }, { status: 400 });
    }

    // The SMS wallet is denominated in the currency stored with the top-up.
    // Missing or mismatched gateway currency must not be treated as UGX.
    const expectedCurrency = typeof request.currency === 'string' && request.currency.trim()
      ? request.currency.trim().toUpperCase()
      : 'UGX';
    const gatewayCurrency = typeof payment.currency === 'string'
      ? payment.currency.trim().toUpperCase()
      : '';
    if (!gatewayCurrency || gatewayCurrency !== expectedCurrency) {
      return NextResponse.json({ error: 'Payment currency mismatch' }, { status: 400 });
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
    // Credits are derived on the server from the stored amount, never taken from the client.
    // Pack credits are the advertised count for this price; fall back to rate-derived count.
    const creditsAdded = packForPrice(addedAmount)?.credits
      ?? Math.floor(addedAmount / (parseFloat(existingWallet.sms_rate) || 50));

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

    // The dashboard confirms by polling this route. If this poll wins the race
    // against NaJiki's outbound notification, the webhook returns early on the
    // already-credited ledger row and never touches kunity.payment_requests —
    // leaving the purchase visible as "pending" in payment history even though
    // the wallet was credited. Record the terminal success here too. The wallet
    // credit is already committed, so this is best-effort and must not fail the
    // request; the SQL RPC is idempotent and ignores an absent request row.
    const { error: recordStatusError } = await supabaseAdmin.schema('kunity').rpc('process_najiki_webhook', {
      p_reference: intentId,
      p_status: 'success',
      p_amount: addedAmount,
      p_fee: Number.isFinite(Number(payment?.fee)) ? Number(payment.fee) : 0,
      p_external_entity_id: payment?.externalEntityId || tenantId,
      p_payment_type: payment?.paymentType?.code || payment?.paymentTypeCode || 'BUY_SMS',
      p_payload: payment,
    });
    if (recordStatusError) {
      console.error('[SMS Topup Confirm] Could not record SMS payment status:', recordStatusError);
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
        compiled_message: `SYSTEM CREDIT: Top-up of ${creditsAdded.toLocaleString()} SMS credits successful. New credit balance: ${Math.floor(creditResult.balance / (parseFloat(existingWallet.sms_rate) || 50))} credits.`,
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
        credits: creditsAdded,
        intentId,
        newBalanceUGX: creditResult.balance,
      },
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({
      success: true,
      addedCredits: creditsAdded,
      newBalanceCredits: Math.floor(creditResult.balance / (parseFloat(existingWallet.sms_rate) || 50)),
      newBalanceUGX: creditResult.balance
    });
  } catch (err: any) {
    console.error('Error confirming SMS topup:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
