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

// Verify webhook signature (Najiki should provide X-Najiki-Signature header)
function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const webhookSecret = process.env.NAJIKI_API_KEY;
  
  // Security Guard: fail closed
  if (!webhookSecret || webhookSecret === 'your-najiki-webhook-secret-here') {
    console.error('[Najiki Webhook] ERROR: NAJIKI_API_KEY not configured. Webhook rejected for security.');
    return false;
  }

  if (!signatureHeader) {
    console.error('[Najiki Webhook] Missing X-Najiki-Signature header');
    return false;
  }

  const cleanSig = signatureHeader.replace(/^sha256=/, '').trim();
  const digestHex = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const digestBase64 = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('base64');

  // Try hex matching
  try {
    const sigBuf = Buffer.from(cleanSig, 'hex');
    const digestBuf = Buffer.from(digestHex, 'hex');
    if (sigBuf.length === digestBuf.length && crypto.timingSafeEqual(sigBuf, digestBuf)) {
      return true;
    }
  } catch {}

  // Try base64 matching
  try {
    const sigBuf = Buffer.from(cleanSig, 'base64');
    const digestBuf = Buffer.from(digestBase64, 'base64');
    if (sigBuf.length === digestBuf.length && crypto.timingSafeEqual(sigBuf, digestBuf)) {
      return true;
    }
  } catch {}

  return false;
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-najiki-signature');

    // 1. Verify webhook signature FIRST!
    if (!verifyWebhookSignature(rawBody, signatureHeader)) {
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
            const typeLabel = depInfo.payment_type === 'account_activation' ? 'Account Activation Deposit' : 'Savings Deposit';
            const messageText = `Dear {{first_name}}, your {{payment_type}} of UGX {{amount}} has been received and credited to your SACCO account successfully. TxRef: {{tx_ref}}. Thank you!`;
            
            const { inngest } = await import('../../../../lib/inngest/client');
            await inngest.send({
              name: 'sms/dispatch',
              data: {
                tenantId: depInfo.organization_id,
                recipientPhone: phone,
                message: messageText,
                eventType: 'DEPOSIT_ALERT',
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
