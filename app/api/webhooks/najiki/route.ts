import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Initialize a Supabase client with the service role key to bypass RLS for webhook posting.
function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321', // Dummy fallback for build phase
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'
  );
}

// Verify a NaJiki notification. Matches NaJiki's signer
// (najiki-finance2/src/lib/notification-signature.ts):
//   X-Najiki-Timestamp: <unix ms>
//   X-Najiki-Signature: t=<unix ms>,v=<hex HMAC-SHA256 of "<t>.<raw body>">
// Current NaJiki setup/seed creates a dedicated application webhook secret, so
// production must set NAJIKI_WEBHOOK_SECRET to that exact one-time value. The
// API-key fallback is retained only for legacy NaJiki application rows that do
// not have webhookSecretEncrypted configured.
// The timestamp is inside the signed string and must be within 5 minutes, so a captured body
// cannot be replayed later.
const NAJIKI_MAX_SKEW_MS = 5 * 60 * 1000;
let warnedAboutLegacySecretFallback = false;

function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null
): boolean {
  const dedicatedSecret = process.env.NAJIKI_WEBHOOK_SECRET?.trim();
  const secret = dedicatedSecret || process.env.NAJIKI_API_KEY?.trim();

  if (!dedicatedSecret && process.env.NODE_ENV === 'production' && !warnedAboutLegacySecretFallback) {
    warnedAboutLegacySecretFallback = true;
    console.error(
      '[Najiki Webhook] NAJIKI_WEBHOOK_SECRET is not configured. The API-key fallback only works ' +
      'for legacy NaJiki application rows without a dedicated webhook secret.'
    );
  }

  // Security Guard: fail closed
  if (!secret || secret === 'your-najiki-webhook-secret-here') {
    console.error('[Najiki Webhook] ERROR: NaJiki webhook secret not configured. Webhook rejected for security.');
    return false;
  }
  if (!signatureHeader || !timestampHeader) {
    console.error('[Najiki Webhook] Missing X-Najiki-Signature or X-Najiki-Timestamp header');
    return false;
  }

  const match = /^t=(\d+),v=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const signedAt = Number(match[1]);
  if (!Number.isFinite(signedAt) || String(signedAt) !== timestampHeader.trim()) return false;
  if (Math.abs(Date.now() - signedAt) > NAJIKI_MAX_SKEW_MS) {
    console.error('[Najiki Webhook] Stale or future timestamp rejected');
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(`${signedAt}.${rawBody}`).digest('hex');
  const received = Buffer.from(match[2].toLowerCase(), 'hex');
  const want = Buffer.from(expected, 'hex');
  return received.length === want.length && crypto.timingSafeEqual(received, want);
}

// Refund the wallet debit that paid for a NaJiki SMS that failed to deliver. Idempotent: the refund
// reference is derived from smsId, and refund_sms_wallet never refunds the same reference twice.
async function refundFailedSms(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  smsId: string
): Promise<'refunded' | 'not_found' | 'error'> {
  const { data: debit, error } = await supabaseAdmin
    .schema('public')
    .from('wallet_transactions')
    .select('wallet_id, amount, reference')
    .eq('description', `najiki_sms:${smsId}`)
    .eq('direction', 'debit')
    .maybeSingle();
  if (error) {
    console.error('[Najiki Webhook] Could not look up SMS debit:', error);
    return 'error';
  }
  if (!debit) return 'not_found';

  const { error: refundErr } = await supabaseAdmin.rpc('refund_sms_wallet', {
    p_wallet_id: debit.wallet_id,
    p_amount: Number(debit.amount),
    p_reference: `refund_najiki_${smsId}`,
    p_debit_reference: debit.reference,
  });
  if (refundErr) {
    console.error('[Najiki Webhook] Refund RPC failed:', refundErr);
    return 'error';
  }
  console.log(`[Najiki Webhook] Refunded failed SMS smsId=${smsId}`);
  return 'refunded';
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-najiki-signature');
    const timestampHeader = req.headers.get('x-najiki-timestamp');

    // 1. Verify webhook signature FIRST!
    if (!verifyWebhookSignature(rawBody, signatureHeader, timestampHeader)) {
      console.error('[Najiki Webhook] Invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error('[Najiki Webhook] Invalid JSON payload');
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // SMS delivery updates share this endpoint (NaJiki sends them to the same webhook path).
    // They are not payments: acknowledge them so NaJiki does not treat the call as failed.
    // A 'failed' update means NaJiki could not deliver the message, so the sender's wallet is refunded.
    // The debit was linked to NaJiki's smsId when the message was queued (lib/sms.ts, messaging gateway).
    if (body?.eventType === 'SMS_DELIVERY_UPDATE') {
      const smsId = body.smsId ? String(body.smsId) : '';
      console.log(`[Najiki Webhook] SMS delivery update ${body.reference ?? smsId}: ${body.status}`);
      if (body.status === 'failed' && smsId) {
        const outcome = await refundFailedSms(getSupabaseAdmin(), smsId);
        if (outcome === 'error') {
          // NaJiki does not retry delivery updates, so this must be visible in logs for manual refund.
          console.error(`[Najiki Webhook] REFUND FAILED for smsId=${smsId}; needs manual review`);
          return NextResponse.json({ error: 'Refund failed' }, { status: 500 });
        }
        if (outcome === 'not_found') {
          console.warn(`[Najiki Webhook] No wallet debit linked to smsId=${smsId}; nothing to refund`);
        }
      }
      return NextResponse.json({ received: true, eventType: 'SMS_DELIVERY_UPDATE' });
    }

    // NaJiki webhook payload
    const payloadData = body.data || body;
    const {
      reference,
      amount,
      externalEntityId,
      paymentType,
      metadata,
      fee = 0 // Default to 0 if fee not provided
    } = payloadData;

    // SECURITY (pentest 2026-10-17): normalize status casing before every
    // comparison. An unrecognized status used to fall through the SMS branch to
    // the generic payment RPC, which ACKed it with 200 ("intermediate status
    // recorded") while never crediting the wallet — silent money loss if a
    // provider ever changes casing ("SUCCESS" vs "success").
    const status = String(payloadData.status || '').trim().toLowerCase();

    const finalPaymentType = paymentType || payloadData.paymentTypeCode || metadata?.paymentTypeCode;
    const isSuccessfulPaymentStatus = status === 'success' || status === 'successful';
    const isFailedPaymentStatus = ['failed', 'failure', 'cancelled', 'canceled', 'expired', 'rejected'].includes(status);

    if (!reference && !externalEntityId) {
      console.error('[Najiki Webhook] Missing reference or externalEntityId');
      return NextResponse.json({ error: 'Missing reference or externalEntityId' }, { status: 400 });
    }

    console.log(`[Najiki Webhook] Processing payment: reference=${reference}, status=${status}, amount=${amount}, fee=${fee}`);

    const supabaseAdmin = getSupabaseAdmin();

    if (finalPaymentType === 'BUY_SMS' && (isSuccessfulPaymentStatus || isFailedPaymentStatus)) {
      const terminalLedgerStatus = isSuccessfulPaymentStatus ? 'success' : 'failed';
      console.log(`[Najiki Webhook] Handling SMS Topup ${terminalLedgerStatus} for reference=${reference}`);
      if (!reference) {
        return NextResponse.json({ error: 'Missing SMS top-up reference' }, { status: 400 });
      }

      // Resolve the ledger transaction by exact, parameterized id/reference lookup.
      // During a very fast callback, the NaJiki reference may arrive before the
      // create-payment response has linked our pre-written row. NaJiki echoes
      // metadata.reference, which is the local idempotency reference we wrote first.
      const lookupReferences = [...new Set([
        typeof reference === 'string' ? reference.trim() : '',
        typeof metadata?.reference === 'string' ? metadata.reference.trim() : '',
      ].filter(Boolean))];
      let request = null;
      let lookupError = null;
      for (const lookupReference of lookupReferences) {
        if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(lookupReference)) {
          const { data, error } = await supabaseAdmin
            .schema('public')
            .from('wallet_transactions')
            .select('*')
            .eq('id', lookupReference)
            .maybeSingle();
          request = data;
          lookupError = error;
        }
        if (!request && !lookupError) {
          const { data, error } = await supabaseAdmin
            .schema('public')
            .from('wallet_transactions')
            .select('*')
            .eq('reference', lookupReference)
            .maybeSingle();
          request = data;
          lookupError = error;
        }
        if (request || lookupError) break;
      }
      if (lookupError) {
        console.error('[Najiki Webhook] SMS top-up lookup failed:', lookupError);
        return NextResponse.json({ error: 'Could not verify SMS top-up' }, { status: 500 });
      }
      if (!request) {
        // NaJiki treats most 4xx responses as permanent. 503 is deliberate:
        // this can be the create-response/link race, so ask it to retry rather
        // than permanently dropping a paid top-up.
        return NextResponse.json({ error: 'SMS top-up transaction not found yet' }, { status: 503 });
      }
      if (request.type !== 'sms_topup' || request.direction !== 'credit') {
        return NextResponse.json({ error: 'Transaction is not a pending SMS top-up' }, { status: 409 });
      }
      if (!request.tenant_id || String(request.tenant_id) !== String(externalEntityId || '')) {
        console.error(`[Najiki Webhook] SMS top-up tenant mismatch for reference=${reference}`);
        return NextResponse.json({ error: 'SMS top-up tenant mismatch' }, { status: 409 });
      }

      const incomingAmount = Number(amount);
      const storedAmount = Number(request.amount);
      if (!Number.isFinite(incomingAmount) || incomingAmount <= 0
          || !Number.isFinite(storedAmount) || storedAmount <= 0
          || Math.abs(incomingAmount - storedAmount) > 0.01) {
        console.error(`[Najiki Webhook] Invalid or mismatched SMS top-up amount: incoming ${amount} != stored ${request.amount}`);
        return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
      }

      const incomingCurrency = typeof payloadData.currency === 'string'
        ? payloadData.currency.trim().toUpperCase()
        : '';
      const storedCurrency = typeof request.currency === 'string' && request.currency.trim()
        ? request.currency.trim().toUpperCase()
        : 'UGX';
      if (!incomingCurrency || incomingCurrency !== storedCurrency) {
        console.error(`[Najiki Webhook] Invalid or mismatched SMS top-up currency: incoming ${incomingCurrency || '(missing)'} != stored ${storedCurrency}`);
        return NextResponse.json({ error: 'Currency mismatch' }, { status: 409 });
      }

      const alreadyCredited = request.note === 'success' || request.status === 'success';
      const alreadyFailed = request.note === 'failed' || request.status === 'failed';
      const ledgerIsPending = (!request.note || request.note === 'pending')
        && (!request.status || request.status === 'pending');
      if (isSuccessfulPaymentStatus && alreadyFailed) {
        return NextResponse.json({ error: 'SMS top-up was already marked failed' }, { status: 409 });
      }
      if (isFailedPaymentStatus && alreadyCredited) {
        return NextResponse.json({ error: 'SMS top-up was already credited' }, { status: 409 });
      }
      if (!alreadyCredited && !alreadyFailed && !ledgerIsPending) {
        return NextResponse.json({ error: 'SMS top-up transaction is not pending' }, { status: 409 });
      }

      // Keep Kunity's payment_requests record in sync with terminal provider
      // callbacks. The SQL payment RPC records BUY_SMS status without posting a
      // SACCO journal; only its success path below credits the separate SMS wallet.
      const { data: paymentResult, error: paymentRpcError } = await supabaseAdmin
        .schema('kunity')
        .rpc('process_najiki_webhook', {
          p_reference: reference,
          p_status: status,
          p_amount: incomingAmount,
          p_fee: fee,
          p_external_entity_id: externalEntityId,
          p_payment_type: finalPaymentType,
          p_payload: body,
        });
      if (paymentRpcError) {
        console.error('[Najiki Webhook] Could not record SMS payment status:', paymentRpcError);
        return NextResponse.json({ error: 'Could not record SMS payment status' }, { status: 500 });
      }
      if (paymentResult?.success === false && paymentResult.error !== 'Unknown payment reference') {
        console.error('[Najiki Webhook] SMS payment rejected by payment ledger:', paymentResult);
        return NextResponse.json({ error: paymentResult.error || 'SMS payment rejected' }, { status: 409 });
      }
      if (paymentResult?.error === 'Unknown payment reference') {
        // The wallet top-up row is the authoritative credit record. The companion
        // payment_requests row is best-effort and is written after the provider
        // returns its reference, so it can legitimately be absent during a race.
        console.warn(`[Najiki Webhook] No payment_requests row yet for SMS reference=${reference}; wallet ledger remains authoritative`);
      }
      const paymentRequestStatus = String(paymentResult?.status || '').toLowerCase();
      if (isSuccessfulPaymentStatus && paymentRequestStatus === 'failed') {
        return NextResponse.json({ error: 'SMS payment was already marked failed' }, { status: 409 });
      }
      if (isFailedPaymentStatus && paymentRequestStatus === 'success') {
        return NextResponse.json({ error: 'SMS payment was already marked successful' }, { status: 409 });
      }

      if (isFailedPaymentStatus) {
        if (alreadyFailed) {
          console.log(`[Najiki Webhook] SMS Topup failure already recorded for reference=${reference}`);
          return NextResponse.json({ success: true, message: 'Already processed' });
        }

        // Record the provider's terminal failure without changing the wallet balance.
        // Match the values we read so a concurrent success callback/credit cannot
        // be overwritten by this failure.
        let failedUpdate = supabaseAdmin
          .schema('public')
          .from('wallet_transactions')
          .update({ note: 'failed', status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', request.id);
        failedUpdate = request.note == null
          ? failedUpdate.is('note', null)
          : failedUpdate.eq('note', request.note);
        failedUpdate = request.status == null
          ? failedUpdate.is('status', null)
          : failedUpdate.eq('status', request.status);

        const { data: failedRow, error: failedUpdateError } = await failedUpdate
          .select('id')
          .maybeSingle();
        if (failedUpdateError) {
          console.error('[Najiki Webhook] Could not mark SMS top-up failed:', failedUpdateError);
          return NextResponse.json({ error: 'Could not record SMS top-up failure' }, { status: 500 });
        }
        if (!failedRow) {
          const { data: latestRow, error: latestReadError } = await supabaseAdmin
            .schema('public')
            .from('wallet_transactions')
            .select('note, status')
            .eq('id', request.id)
            .maybeSingle();
          if (latestReadError) {
            console.error('[Najiki Webhook] Could not verify SMS top-up failure state:', latestReadError);
            return NextResponse.json({ error: 'Could not verify SMS top-up failure state' }, { status: 500 });
          }
          if (latestRow?.note === 'success' || latestRow?.status === 'success') {
            return NextResponse.json({ error: 'SMS top-up was already credited' }, { status: 409 });
          }
          if (latestRow?.note !== 'failed' && latestRow?.status !== 'failed') {
            return NextResponse.json({ error: 'Could not record SMS top-up failure' }, { status: 500 });
          }
        }

        console.log(`[Najiki Webhook] SMS Topup marked failed for reference=${reference}`);
        return NextResponse.json({ success: true, message: 'SMS top-up marked failed' });
      }

      if (alreadyCredited) {
        console.log(`[Najiki Webhook] SMS Topup already processed for reference=${reference}`);
        return NextResponse.json({ success: true, message: 'Already processed' });
      }

      const { error: creditErr } = await supabaseAdmin.rpc('credit_sms_wallet_idempotent', {
        p_wallet_id: request.wallet_id,
        p_transaction_id: request.id,
        p_amount: storedAmount,
      });

      if (creditErr) {
        console.error('[Najiki Webhook] Error crediting wallet balance:', creditErr);
        return NextResponse.json({ error: 'Failed to credit wallet' }, { status: 500 });
      }
      console.log(`[Najiki Webhook] Successfully credited SMS wallet for reference=${reference}`);
      return NextResponse.json({ success: true, message: 'SMS Topup credited' });
    }

    
    // 2. Call our ATOMIC PostgreSQL function to process everything in one transaction
    const { data: result, error: rpcError } = await supabaseAdmin.schema('kunity').rpc('process_najiki_webhook', {
      p_reference: reference,
      p_status: status,
      p_amount: amount,
      p_fee: fee,
      p_external_entity_id: externalEntityId,
      p_payment_type: finalPaymentType,
      p_payload: body
    });

    if (rpcError) {
      console.error('[Najiki Webhook] RPC Error:', rpcError);
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    console.log('[Najiki Webhook] Success:', result);

    // Current NaJiki treats 4xx responses (except 408/429) as permanent and
    // will not retry them. A missing reference can be a create-response race,
    // so return a retryable 503 for that case. Signed amount/currency/type
    // mismatches are permanent business rejections and remain 409.
    if (result && result.success === false) {
      console.error('[Najiki Webhook] Rejected by ledger:', result);
      const statusCode = result.error === 'Unknown payment reference' ? 503 : 409;
      return NextResponse.json({ error: result.error || 'Rejected', data: result }, { status: statusCode });
    }

    // 3. If newly processed successful deposit, send an automated SMS notification
    if (result && result.message === 'Success recorded. Journal entries created.') {
      try {
        // Fetch details of the deposit and the member to dispatch SMS
        const { data: depInfo, error: depErr } = await supabaseAdmin
          .schema('kunity')
          .from('payment_requests')
          .select(`
            amount,
            payment_type,
            internal_reference,
            organization_id,
            member_id,
            members (
              first_name,
              phone
            )
          `)
          .eq('id', result.payment_request_id)
          .maybeSingle();

        if (depErr) {
          console.error('[Najiki Webhook] Error retrieving payment request and member details for SMS:', depErr);
        }

        if (depInfo && depInfo.members) {
          const memberInfo = depInfo.members as any;
          const phone = memberInfo.phone;
          const firstName = memberInfo.first_name || 'Member';
          const rawAmount = parseFloat(depInfo.amount);
          const formattedAmount = rawAmount.toLocaleString();
          
          if (phone) {
            // SAME RULE AS THE LEDGER RPC: activation is recognised as income (membership fee),
            // not credited to a savings account, so it gets a receipt, not a deposit alert.
            const isActivation = depInfo.payment_type === 'account_activation'
              || String(depInfo.internal_reference || '').startsWith('PAY-ACT-');
            const typeLabel = isActivation ? 'Account Activation Deposit' : 'Savings Deposit';
            const messageText = isActivation
              ? `Dear {{first_name}}, we have received your membership activation fee of UGX {{amount}}. TxRef: {{tx_ref}}. Thank you!`
              : `Dear {{first_name}}, your {{payment_type}} of UGX {{amount}} has been received and credited to your SACCO account successfully. TxRef: {{tx_ref}}. Thank you!`;
            
            const { sendSms } = await import('../../../../lib/sms');
            const sms = await sendSms({
              // Replays of the same NaJiki event must not send a second SMS:
              // the key deduplicates both the wallet debit and the gateway dispatch.
              tenantId: depInfo.organization_id,
              recipientPhone: phone,
              message: messageText,
              eventType: isActivation ? 'ACTIVATION_RECEIPT' : 'DEPOSIT_ALERT',
              originUrl: req.url,
              templateData: {
                first_name: firstName,
                amount: formattedAmount,
                tx_ref: reference,
                payment_type: typeLabel
              },
              idempotencyKey: `deposit-sms-${reference}`
            });
            if (sms.success) {
              console.log(`[SMS Webhook] Deposit SMS alert dispatched to NaJiki for ${phone} (TxRef: ${reference})`);
            } else {
              console.warn(`[SMS Webhook] Deposit SMS alert failed for ${phone} (TxRef: ${reference}): ${sms.error}`);
            }
          } else {
            console.warn(`[Najiki Webhook] No phone number recorded for member ${depInfo.member_id}. Skipping SMS.`);
          }
        }
      } catch (smsErr) {
        console.error('⚠️ Failed to dispatch automatic deposit SMS alert:', smsErr);
      }
    }

    // Returns a 200 OK so NaJiki knows we received it
    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[Najiki Webhook] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
