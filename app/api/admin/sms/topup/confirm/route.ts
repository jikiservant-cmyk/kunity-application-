import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from "@supabase/ssr";
import { logAudit } from '@/lib/audit-logger';
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { topupConfirmLimiter } from '@/lib/rate-limit';
import { extractBearerToken } from '@/lib/request-guard';

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
    const { intentId, momoNumber, credits } = body;

    // SECURITY: Token comes exclusively from the Authorization header.
    const token = extractBearerToken(req);

    if (!token || !intentId) {
      return NextResponse.json({ error: 'Missing Authorization Bearer token or intentId' }, { status: 400 });
    }

    // SECURITY: Full admin verification (role + tenant binding) is mandatory
    // before any wallet crediting operation. Previously this endpoint only
    // checked that an admin_profiles row existed — without a role check —
    // allowing any authenticated user with a profile row to trigger the
    // wallet-credit flow.
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;
    const user = adminAuth.user;

    // Rate limit topup confirmations per administrator
    try {
      await topupConfirmLimiter.check(15, `admin:topup-confirm:${user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many topup confirmation attempts. Please wait a moment.' }, { status: 429 });
    }

    // Tenant binding comes from the verified admin profile (server-authoritative).
    const tenantId = adminAuth.tenantId;
    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 400 });
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
    
    // Ensure the payment request actually belongs to this tenant
    if (request.tenant_id !== tenantId) {
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
    
    // Validate amount from gateway matches what we expect
    const expectedAmount = Number(request.amount);
    if (Number(payment.amount) !== expectedAmount) {
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

    // Credit wallet atomically via idempotent RPC with row lock on wallet_transactions
    let creditResult: any = null;
    const { data: idempotentResult, error: idempotentErr } = await supabaseAdmin
      .rpc('credit_sms_wallet_idempotent', {
        p_wallet_id: existingWallet.id,
        p_transaction_id: request.id,
        p_amount: addedAmount
      });

    if (idempotentErr) {
      console.warn('Idempotent RPC failed, trying fallback:', idempotentErr.message);
      const { data: fallbackResult, error: creditErr } = await supabaseAdmin
        .rpc('credit_sms_wallet', { 
           p_wallet_id: existingWallet.id,
           p_amount: addedAmount
        })
        .single();

      if (creditErr) {
         console.error('Error crediting wallet balance:', creditErr);
         return NextResponse.json({ error: 'Failed to update wallet balance' }, { status: 500 });
      }
      creditResult = fallbackResult;

      // Update payment request status by authoritative row ID
      await supabaseAdmin
        .schema('public')
        .from('wallet_transactions')
        .update({ note: 'success', status: 'success', description: 'SMS topup successful' })
        .eq('id', request.id);
    } else {
      creditResult = Array.isArray(idempotentResult) ? idempotentResult[0] : idempotentResult;
    }

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
      adminId: user.id,
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
