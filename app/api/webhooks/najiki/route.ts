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

// Verify a NaJiki notification. Matches NaJiki's signer (src/lib/notification-signature.ts):
//   X-Najiki-Timestamp: <unix ms>
//   X-Najiki-Signature: t=<unix ms>,v=<hex HMAC-SHA256 of "<t>.<raw body>">
// The secret is the application's webhook secret. NaJiki falls back to the application API key
// when no separate webhook secret is set, so NAJIKI_WEBHOOK_SECRET defaults to NAJIKI_API_KEY.
// The timestamp is inside the signed string and must be within 5 minutes, so a captured body
// cannot be replayed later.
const NAJIKI_MAX_SKEW_MS = 5 * 60 * 1000;

function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null
): boolean {
  const secret = process.env.NAJIKI_WEBHOOK_SECRET || process.env.NAJIKI_API_KEY;

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
    if (body?.eventType === 'SMS_DELIVERY_UPDATE') {
      console.log(`[Najiki Webhook] SMS delivery update ${body.reference ?? body.smsId}: ${body.status}`);
      return NextResponse.json({ received: true, eventType: 'SMS_DELIVERY_UPDATE' });
    }

    // NaJiki webhook payload
    const payloadData = body.data || body;
    const { 
      reference, 
      status, 
      amount, 
      externalEntityId, 
      paymentType, 
      metadata,
      fee = 0 // Default to 0 if fee not provided
    } = payloadData;

    const finalPaymentType = paymentType || payloadData.paymentTypeCode || metadata?.paymentTypeCode;

    if (!reference && !externalEntityId) {
      console.error('[Najiki Webhook] Missing reference or externalEntityId');
      return NextResponse.json({ error: 'Missing reference or externalEntityId' }, { status: 400 });
    }

    console.log(`[Najiki Webhook] Processing payment: reference=${reference}, status=${status}, amount=${amount}, fee=${fee}`);

    const supabaseAdmin = getSupabaseAdmin();

    if (finalPaymentType === 'BUY_SMS' && (status === 'success' || status === 'successful')) {
      console.log(`[Najiki Webhook] Handling SMS Topup manually for reference=${reference}`);
      
      
      // Fix: prevent filter injection by checking id and reference in two separate parameterized queries
      let request = null;
      // Try by UUID id if reference looks like a UUID
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(reference)) {
        const { data } = await supabaseAdmin
          .schema('public')
          .from('wallet_transactions')
          .select('*')
          .eq('id', reference)
          .maybeSingle();
        request = data;
      }
      if (!request) {
        const { data } = await supabaseAdmin
          .schema('public')
          .from('wallet_transactions')
          .select('*')
          .eq('reference', reference)
          .maybeSingle();
        request = data;
      }


      if (request && request.note !== 'success' && request.status !== 'success') {
        // Cross-check incoming amount with stored transaction amount
        if (Math.abs(Number(amount) - Number(request.amount)) > 0.01) {
          console.error(`[Najiki Webhook] Amount mismatch: incoming ${amount} != stored ${request.amount}`);
          return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
        }

        const { error: creditErr } = await supabaseAdmin
          .rpc('credit_sms_wallet_idempotent', {
              p_wallet_id: request.wallet_id,
              p_transaction_id: request.id,
              p_amount: Number(request.amount)
          });

        if (!creditErr) {
          console.log(`[Najiki Webhook] Successfully credited SMS wallet for reference=${reference}`);
          return NextResponse.json({ success: true, message: 'SMS Topup credited' });
        } else {
           console.error('[Najiki Webhook] Error crediting wallet balance:', creditErr);
           return NextResponse.json({ error: 'Failed to credit wallet' }, { status: 500 });
        }
      } else if (request && (request.note === 'success' || request.status === 'success')) {
        console.log(`[Najiki Webhook] SMS Topup already processed for reference=${reference}`);
        return NextResponse.json({ success: true, message: 'Already processed' });
      }
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

    // FIN-38: the ledger REJECTED this event (amount/currency mismatch, unknown
    // reference, held payment type). Do not acknowledge with 200: the gateway
    // would stop retrying and nothing would alert anyone. A non-2xx keeps the
    // event in the gateway's retry/alert queue until ops resolve it.
    if (result && result.success === false) {
      console.error('[Najiki Webhook] Rejected by ledger:', result);
      return NextResponse.json({ error: result.error || 'Rejected', data: result }, { status: 409 });
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
            
            const { inngest } = await import('../../../../lib/inngest/client');
            await inngest.send({
              // Replays of the same NaJiki event must not send a second SMS.
              id: `deposit-sms-${reference}`,
              name: 'sms/dispatch',
              data: {
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
                }
              }
            });
            console.log(`[SMS Webhook] Deposit SMS alert successfully queued in Inngest for ${phone} (TxRef: ${reference})`);
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
