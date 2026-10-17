import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { paymentGateway } from '@/lib/payments/gateway';
import crypto from 'crypto';
import { logAudit } from '@/lib/audit-logger';
import { packForCredits, normalizeUgMomo } from '@/lib/sms-packs';

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
    const { token, credits, momoNumber } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    // SECURITY (pentest 2026-10-13): the price is never taken from the client.
    // The client picks a pack by its credit count; the server sets the price.
    const pack = packForCredits(credits);
    if (!pack) {
      return NextResponse.json({ error: 'Invalid credit pack' }, { status: 400 });
    }
    const amount = pack.price;

    const momo = normalizeUgMomo(momoNumber);
    if (!momo) {
      return NextResponse.json({ error: 'Invalid mobile money number' }, { status: 400 });
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
        // FIN-29: a concurrent request may have provisioned the wallet first
        // (unique tenant) — re-fetch instead of failing the topup.
        const { data: refetched } = await supabaseAdmin
          .schema('public')
          .from('wallets')
          .select('*')
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (!refetched) {
          return NextResponse.json({ error: 'Failed to find or auto-provision wallet.' }, { status: 400 });
        }
        wallet = refetched;
      } else {
        wallet = newWallet;
      }
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

    // SMS WALLET FIX (2026-10-13): write the pending ledger row BEFORE asking NaJiki for a
    // payment. Before, the row was written after the call and its insert result was ignored.
    // If that insert failed, the admin could pay NaJiki with nothing to credit later.
    const localRef = `PAY-SMS-${crypto.randomUUID()}`;
    const { error: pendingErr } = await supabaseAdmin.schema('public').from('wallet_transactions').insert({
      id: crypto.randomUUID(),
      wallet_id: wallet.id,
      tenant_id: tenantId,
      direction: 'credit',
      amount: amount,
      currency: 'UGX',
      note: 'pending',
      type: 'sms_topup',
      reference: localRef,
      description: 'Pending SMS topup via Mobile Money'
    });
    if (pendingErr) {
      console.error('[SMS Topup API] Could not record pending topup, no payment requested:', pendingErr);
      return NextResponse.json({ error: 'Could not start the top-up. No payment was requested. Try again.' }, { status: 500 });
    }

    // Create payment intent with NaJiki (the only provider). The local reference is sent as the
    // idempotency key, so a retried request cannot create a second payment.
    let intent;
    try {
      intent = await paymentGateway.createPaymentIntent(amount, "UGX", {
        source: 'web_app',
        phoneNumber: momo,
        organizationId: tenantId,
        tenantCode: tenantCode,
        paymentTypeCode: 'BUY_SMS',
        reference: localRef
      });
    } catch (gatewayErr: any) {
      // The pending row stays. If NaJiki did take a payment, its webhook or the confirm route
      // still credits it. A pending row with no NaJiki payment credits nothing.
      console.error('[SMS Topup API] NaJiki payment request failed:', gatewayErr?.message);
      const gatewayMessage = gatewayErr?.message || 'NaJiki unavailable';
      // BUY_SMS is a platform fee in NaJiki's PLATFORM_FEE_TYPES, so it is exempt
      // from the per-tenant credential rule. Seeing that rule fire for this
      // route means NaJiki has no BUY_SMS payment type row for the application:
      // the code resolved to null and the purchase was treated as tenant money.
      // Say so, otherwise the operator goes hunting for SACCO credentials that
      // are not the problem. Intent creation failed, so nothing was collected.
      const missingPlatformPaymentType =
        /no active credentials configured/i.test(gatewayMessage)
        && /requires per-tenant credentials/i.test(gatewayMessage);
      const error = missingPlatformPaymentType
        ? `${gatewayMessage} — NaJiki has no BUY_SMS payment type for this application, so the purchase was treated as a tenant collection. Add BUY_SMS in NaJiki Setup. No money was taken.`
        : gatewayMessage;
      return NextResponse.json({ error: `Mobile money request failed: ${error}` }, { status: 502 });
    }

    // Link the ledger row to NaJiki's reference: the webhook and the confirm route look the top-up
    // up by that reference. If this link fails, the payment cannot be credited automatically.
    const najikiRef = String(intent.id);
    const { error: linkErr } = await supabaseAdmin
      .schema('public')
      .from('wallet_transactions')
      .update({ reference: najikiRef })
      .eq('reference', localRef)
      .eq('tenant_id', tenantId);
    if (linkErr) {
      console.error('[SMS Topup API] Could not link top-up to NaJiki reference:', linkErr, { localRef, najikiRef });
      return NextResponse.json({
        error: `Payment was requested but could not be linked to your account. Contact support with reference ${najikiRef}.`
      }, { status: 500 });
    }

    // Record the NaJiki payment in payment_requests, the same way /api/payments/intent does, so the
    // top-up is visible with the other payments. A fast provider callback can arrive before this
    // POST receives NaJiki's response; the webhook can already have marked the pre-written wallet
    // row successful or failed via metadata.reference. Reflect that terminal state instead of
    // inserting a stale pending payment request. The wallet credit itself never depends on this row.
    const { data: linkedTopup, error: linkedTopupReadError } = await supabaseAdmin
      .schema('public')
      .from('wallet_transactions')
      .select('note, status')
      .eq('reference', najikiRef)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (linkedTopupReadError) {
      console.error('[SMS Topup API] Could not read linked top-up status:', linkedTopupReadError, { najikiRef });
    }
    const callbackState = linkedTopup?.note === 'success' || linkedTopup?.status === 'success'
      ? 'success'
      : linkedTopup?.note === 'failed' || linkedTopup?.status === 'failed'
        ? 'failed'
        : 'pending';

    // The ledger RPC records BUY_SMS without posting journal entries.
    // Failure to write this reporting row remains non-fatal to wallet credit.
    const { error: prErr } = await supabaseAdmin.schema('kunity').from('payment_requests').insert({
      id: crypto.randomUUID(),
      organization_id: tenantId,
      member_id: null,
      amount: amount,
      currency: 'UGX',
      phone_number: momo,
      status: callbackState,
      ...(callbackState !== 'pending' ? { completed_at: new Date().toISOString() } : {}),
      direction: 'inbound',
      idempotency_key: localRef,
      internal_reference: najikiRef,
      payment_type: 'BUY_SMS',
      payload: intent,
      provider: 'najiki',
    });
    if (prErr) {
      console.error('[SMS Topup API] payment_requests row not written (top-up continues, credit unaffected):', prErr, { najikiRef });
    }

    await logAudit(supabaseAdmin, {
      adminId: user.id,
      tenantId: tenantId,
      action: 'create_sms_topup_intent',
      entityType: 'payment_intent',
      entityId: najikiRef,
      newData: { amount, credits: pack.credits, momoNumber: momo }
    });

    const responseIntent = callbackState === 'pending' ? intent : { ...intent, status: callbackState };

    return NextResponse.json({
      success: true,
      intent: responseIntent,
      intentId: najikiRef
    });

  } catch (err: any) {
    console.error('Error initiating SMS wallet topup:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
