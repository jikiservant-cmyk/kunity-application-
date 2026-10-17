import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { paymentGateway } from '@/lib/payments/gateway';
import crypto from 'crypto';
import { logAudit } from '@/lib/audit-logger';
import { normalizeUgMomo } from '@/lib/validators';
import {
  normalizeSmsAmount,
  normalizeSmsCredits,
  parseSmsRate,
  smsAmountBounds,
  smsPriceForCredits,
  smsTopupForAmount,
  SMS_MIN_CREDITS,
  SMS_MAX_CREDITS,
} from '@/lib/sms-bundles';
import { paymentIntentLimiter } from '@/lib/rate-limit';
import { normalizeNajikiBaseUrl } from '@/lib/najiki-url';

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

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    // The admin enters the amount to spend in UGX and the server derives the SMS
    // count. `credits` is still accepted for backwards compatibility, but the two
    // spellings are mutually exclusive so a request can never mix a typed amount
    // with a credit count.
    const { token, credits, amount: amountInput, momoNumber } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    const hasCredits = credits !== undefined && credits !== null;
    const hasAmount = amountInput !== undefined && amountInput !== null;

    if (!hasCredits && !hasAmount) {
      return NextResponse.json({
        error: 'Enter the amount you want to top up, in UGX.'
      }, { status: 400 });
    }
    if (hasCredits && hasAmount) {
      return NextResponse.json({
        error: 'Send either an amount in UGX or a number of SMS, not both.'
      }, { status: 400 });
    }

    // SECURITY (pentest 2026-10-13/17): the price is never taken from the client.
    // The admin enters how much to spend; the server derives the SMS count and the
    // exact charge from the per-SMS rate stored in `public.wallets.sms_rate`.
    const creditsRequestedInput = hasCredits ? normalizeSmsCredits(credits) : null;
    if (hasCredits && creditsRequestedInput === null) {
      return NextResponse.json({
        error: `Enter a whole number of SMS between ${SMS_MIN_CREDITS.toLocaleString()} and ${SMS_MAX_CREDITS.toLocaleString()}.`
      }, { status: 400 });
    }

    const amountRequestedInput = hasAmount ? normalizeSmsAmount(amountInput) : null;
    if (hasAmount && amountRequestedInput === null) {
      return NextResponse.json({
        error: 'Enter the top-up amount as a whole number of shillings (UGX).'
      }, { status: 400 });
    }

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

    // SECURITY (pentest 2026-10-17): this is the only mobile-money entry point for
    // the admin console, and it had no throttling. A compromised admin token could
    // otherwise trigger unlimited mobile-money collections (PIN prompts on the
    // payer's phone) and fill the ledger with pending rows. Per administrator,
    // mirroring /api/payments/intent.
    try {
      await paymentIntentLimiter.check(15, `sms_topup:${user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for SMS top-ups. Please wait a minute.' }, { status: 429 });
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

    // The price comes from the database, never from the request body. A missing
    // or invalid rate fails closed: a misconfigured wallet must not sell SMS free.
    const smsRate = parseSmsRate(wallet.sms_rate);
    if (smsRate === null) {
      console.error(`[SMS Topup API] Invalid sms_rate for wallet ${wallet.id}:`, wallet.sms_rate);
      return NextResponse.json({
        error: 'SMS pricing is not configured for this SACCO. Please contact support.'
      }, { status: 503 });
    }

    let creditsRequested: number;
    let amount: number;

    if (hasAmount) {
      const quote = smsTopupForAmount(amountRequestedInput!, smsRate);
      if (quote === null) {
        const bounds = smsAmountBounds(smsRate);
        return NextResponse.json({
          error: bounds
            ? `Enter an amount between UGX ${bounds.min.toLocaleString('en-UG')} and UGX ${bounds.max.toLocaleString('en-UG')} at this SACCO's rate of UGX ${smsRate}/SMS.`
            : 'This top-up amount is outside the allowed range. Contact support if you need a larger bundle.'
        }, { status: 400 });
      }
      creditsRequested = quote.credits;
      amount = quote.amount;
    } else {
      const pricedAmount = smsPriceForCredits(creditsRequestedInput!, smsRate);
      if (pricedAmount === null) {
        return NextResponse.json({
          error: 'This top-up amount is outside the allowed range. Contact support if you need a larger bundle.'
        }, { status: 400 });
      }
      creditsRequested = creditsRequestedInput!;
      amount = pricedAmount;
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
      description: `SMS top-up: ${creditsRequested.toLocaleString()} credits at UGX ${smsRate}/SMS`
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

    // NaJiki versions before the fail-closed payment-type guard (patched in
    // najiki-finance2 branch arena/016d07ac-buy-sms-hardening) accepted BUY_SMS
    // without a registered payment type and booked the payment as a TENANT
    // collection — platform fee money settling in the SACCO's provider float
    // while everything looked healthy here. Detect that classification through
    // the status endpoint and refuse loudly. On a misclassification the wallet
    // still credits via the webhook if the payer approves the prompt, so the
    // message tells the operator NOT to retry blindly. A failed status lookup
    // must never block the purchase — the payment exists at NaJiki.
    if (callbackState === 'pending') {
      try {
        const apiUrl = normalizeNajikiBaseUrl(process.env.NAJIKI_API_URL || 'https://najiki.netlify.app');
        const classificationRes = await fetch(
          `${apiUrl}/api/payments/${encodeURIComponent(najikiRef)}?tenantCode=${encodeURIComponent(tenantCode)}`,
          { headers: { Authorization: `Bearer ${process.env.NAJIKI_API_KEY || ''}` } },
        );
        if (classificationRes.ok) {
          const classification = await classificationRes.json();
          if ('paymentType' in classification && classification.paymentType?.code !== 'BUY_SMS') {
            const explanation =
              'NaJiki accepted the payment but did not register it as an SMS platform fee ' +
              '(no BUY_SMS payment type exists for the application) — it was requested as a ' +
              'TENANT collection instead. If your phone confirmed the debit, the SMS credits ' +
              'will still arrive automatically; register BUY_SMS in NaJiki Setup before retrying.';
            console.error(`[SMS Topup API] ${explanation}`, { najikiRef });
            return NextResponse.json(
              { error: `Mobile money request was not accepted as an SMS purchase: ${explanation}` },
              { status: 502 },
            );
          }
        }
      } catch (classificationErr) {
        console.warn('[SMS Topup API] Could not verify NaJiki payment classification:', classificationErr);
      }
    }

    await logAudit(supabaseAdmin, {
      adminId: user.id,
      tenantId: tenantId,
      action: 'create_sms_topup_intent',
      entityType: 'payment_intent',
      entityId: najikiRef,
      newData: { amount, credits: creditsRequested, smsRate, momoNumber: momo, enteredAmount: hasAmount ? amountRequestedInput : null }
    });

    const responseIntent = callbackState === 'pending' ? intent : { ...intent, status: callbackState };

    return NextResponse.json({
      success: true,
      intent: responseIntent,
      intentId: najikiRef,
      // The UI renders the amount the server actually charged, not its own estimate.
      credits: creditsRequested,
      amount,
      smsRate
    });

  } catch (err: any) {
    console.error('Error initiating SMS wallet topup:', err);
    // SECURITY: never reflect internal error text (SQL details, file paths) to the client.
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
