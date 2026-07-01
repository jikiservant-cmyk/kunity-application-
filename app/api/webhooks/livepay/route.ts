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

// Verify LivePay webhook signature
function verifyLivePaySignature(rawBody: string, signatureHeader: string | null): boolean {
  const webhookSecret = process.env.LIVEPAY_SECRET_KEY;
  
  // If no secret configured, skip verification (dev mode only)
  if (!webhookSecret || webhookSecret === 'YOUR_LIVEPAY_SECRET_KEY') {
    console.warn('[LivePay Webhook] WARNING: Webhook secret not configured - skipping signature verification!');
    return true;
  }

  if (!signatureHeader) {
    console.error('[LivePay Webhook] Missing X-LivePay-Signature header');
    return false;
  }

  // LivePay likely uses HMAC-SHA256. Adjust if they use a different algorithm.
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = hmac.update(rawBody).digest('hex');
  
  // Compare computed signature with received signature
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
    const signatureHeader = req.headers.get('x-livepay-signature');

    // 1. Verify webhook signature FIRST!
    if (!verifyLivePaySignature(rawBody, signatureHeader)) {
      console.error('[LivePay Webhook] Invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      console.error('[LivePay Webhook] Invalid JSON payload');
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // LivePay usually sends reference, status, etc. in the webhook payload.
    const { internal_reference, status, amount, fee, currency, phone_number, provider } = body;

    if (!internal_reference) {
      console.error('[LivePay Webhook] Missing internal_reference');
      return NextResponse.json({ error: 'Missing internal_reference' }, { status: 400 });
    }

    console.log(`[LivePay Webhook] Processing payment: reference=${internal_reference}, status=${status}, amount=${amount}`);

    const supabaseAdmin = getSupabaseAdmin();
    
    // 2. Call our ATOMIC PostgreSQL function to process everything in one transaction
    const { data: result, error: rpcError } = await supabaseAdmin.schema('kunity').rpc('process_livepay_webhook', {
      p_internal_reference: internal_reference,
      p_status: status,
      p_amount: amount,
      p_fee: fee,
      p_currency: currency,
      p_payload: body
    });

    if (rpcError) {
      console.error('[LivePay Webhook] RPC Error:', rpcError);
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    console.log('[LivePay Webhook] Success:', result);

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
          console.error('[LivePay Webhook] Error retrieving payment request and member details for SMS:', depErr);
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
                  tx_ref: internal_reference,
                  payment_type: typeLabel
                }
              }
            });
            console.log(`[SMS Webhook] Deposit SMS alert successfully queued in Inngest for ${phone} (TxRef: ${internal_reference})`);
          } else {
            console.warn(`[LivePay Webhook] No phone number recorded for member ${depInfo.member_id}. Skipping SMS.`);
          }
        }
      } catch (smsErr) {
        console.error('⚠️ Failed to dispatch automatic deposit SMS alert:', smsErr);
      }
    }

    // Returns a 200 OK so LivePay knows we received it
    return NextResponse.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[LivePay Webhook] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
