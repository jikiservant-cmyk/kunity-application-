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

// Verify webhook signature ( Najiki should provide X-Najiki-Signature header )
function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const webhookSecret = process.env.NAJIKI_WEBHOOK_SECRET;
  
  // If no secret configured, skip verification (dev mode only)
  if (!webhookSecret || webhookSecret === 'your-najiki-webhook-secret-here') {
    console.warn('[Najiki Webhook] WARNING: Webhook secret not configured - skipping signature verification!');
    return true;
  }

  if (!signatureHeader) {
    console.error('[Najiki Webhook] Missing X-Najiki-Signature header');
    return false;
  }

  // Najiki likely uses HMAC-SHA256. Adjust if they use a different algorithm.
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(rawBody).digest('hex');
  
  // Compare computed signature with received signature
  // Use timingSafeEqual to prevent timing attacks
  const signatureBuffer = Buffer.from(signatureHeader, 'hex');
  const digestBuffer = Buffer.from(digest, 'hex');
  
  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
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
