import crypto from 'crypto';
import { hashApiKey } from '@/lib/api-keys';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { messagingLimiter } from '@/lib/rate-limit';

// If running in edge or node without africastalking, we use fetch to their REST API.
// Africastalking API: https://api.africastalking.com/version1/messaging

const MAX_RECIPIENTS = 100;
const MAX_MESSAGE_CHARS = 1000;
const SENDER_ID_PATTERN = /^[A-Za-z0-9]{3,11}$/;
const E164_PATTERN = /^\+\d{9,15}$/;

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Identity & Tenant Resolution
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json({ error: 'Unauthorized: Missing or invalid Authorization Bearer token' }, { status: 401 });
    }
    const apiKey = authHeader.split(' ')[1];

    // Retrieve application mapping based on API Key
    const { data: app, error: appErr } = await supabaseAdmin
      .from('applications')
      .select('id, name')
      // SECURITY (pentest 2026-10-13): keys are stored as SHA-256 digests only.
      .eq('api_key_hash', hashApiKey(apiKey))
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({ error: 'Unauthorized: Invalid API Key' }, { status: 401 });
    }

    // Rate limit per application
    try {
      await messagingLimiter.check(60, `msg:app:${app.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for SMS messaging gateway' }, { status: 429 });
    }

    // Parse Request Payload
    const body = await req.json();
    const { to, message, tenantCode, eventCode, eventType, from } = body;
    const finalEventCode = eventCode || eventType;

    if (!to || !message) {
      return NextResponse.json({ error: 'Bad Request: "to" and "message" are required' }, { status: 400 });
    }

    // SECURITY: validate the payload shape before any billing or provider call.
    if (typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Bad Request: "message" must be a non-empty string' }, { status: 400 });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json({ error: `Bad Request: "message" exceeds ${MAX_MESSAGE_CHARS} characters` }, { status: 400 });
    }
    if (from !== undefined && from !== null && (typeof from !== 'string' || !SENDER_ID_PATTERN.test(from))) {
      return NextResponse.json({ error: 'Bad Request: "from" must be 3-11 alphanumeric characters' }, { status: 400 });
    }

    // FIN-37: tenantCode is REQUIRED. Without it the message had no tenant to
    // bill, so any application key could send SMS at the platform's expense.
    if (!tenantCode) {
      return NextResponse.json({ error: 'Bad Request: "tenantCode" is required' }, { status: 400 });
    }

    const { data: t, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('id, name, is_active')
      .eq('code', tenantCode)
      .eq('application_id', app.id)
      .maybeSingle();

    if (tenantErr || !t) {
      return NextResponse.json({ error: 'Not Found: Invalid tenantCode for this application' }, { status: 404 });
    }
    if (!t.is_active) {
      return NextResponse.json({ error: 'Forbidden: Tenant is not active' }, { status: 403 });
    }
    const tenant = t;

    // 2. Format & Sanitize Phone Numbers
    const numbers = Array.isArray(to) ? to : [to];
    if (numbers.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: `Bad Request: at most ${MAX_RECIPIENTS} recipients per request` }, { status: 400 });
    }
    const normalizedNumbers = numbers.map((n: string) => {
      let clean = String(n).replace(/[^\d+]/g, '');
      // If starts with 07 or 03 (Uganda standard local), replace with +256
      if (clean.startsWith('0') && clean.length === 10) {
        clean = '+256' + clean.slice(1);
      } else if (!clean.startsWith('+') && clean.length >= 9) {
        clean = '+' + clean;
      } else if (/^(256|254|255)\d+$/.test(clean)) {
        clean = '+' + clean;
      }
      return clean;
    });

    if (normalizedNumbers.length === 0) {
      return NextResponse.json({ error: 'No valid phone numbers provided' }, { status: 400 });
    }
    // SECURITY: reject malformed numbers up front so the tenant is never billed for them.
    if (!normalizedNumbers.every((n: string) => E164_PATTERN.test(n))) {
      return NextResponse.json({ error: 'Bad Request: one or more phone numbers are invalid' }, { status: 400 });
    }

    // 3. SMS Gateway Dispatch (Africa's Talking) - FAIL CLOSED
    const atApiKey = process.env.AFRICASTALKING_API_KEY;
    const atUsername = process.env.AFRICASTALKING_USERNAME || 'sandbox';

    if (!atApiKey || atApiKey.trim() === '' || atApiKey === 'YOUR_AFRICASTALKING_API_KEY') {
      console.error('[NaJiki Gateway] ERROR: AFRICASTALKING_API_KEY is not configured. Request rejected (fail-closed).');
      return NextResponse.json({
        error: 'SMS service unavailable: Gateway credentials (AFRICASTALKING_API_KEY) are not configured on server',
        provider: 'africastalking'
      }, { status: 503 });
    }

    // FIN-37: bill the tenant's SMS wallet BEFORE dispatch (same rate rules as
    // lib/sms.ts). One idempotent debit covers the whole batch.
    const segments = message.trim().length > 160 ? Math.ceil(message.trim().length / 153) : 1;
    const { data: wallet } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('id, balance, sms_rate')
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (!wallet) {
      return NextResponse.json({ error: 'SMS wallet not found for this tenant' }, { status: 402 });
    }
    const parsedRate = parseFloat(String(wallet.sms_rate ?? ''));
    const costPerSms = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 50.0;
    const totalCost = segments * costPerSms * normalizedNumbers.length;
    if (parseFloat(String(wallet.balance)) < totalCost) {
      return NextResponse.json({ error: 'Insufficient SMS wallet balance' }, { status: 402 });
    }

    const debitKey = `api_${crypto.randomUUID()}`;
    const { error: debitErr } = await supabaseAdmin.rpc('debit_sms_wallet', {
      p_wallet_id: wallet.id,
      p_amount: totalCost,
      p_idempotency_key: debitKey,
      p_tenant_id: tenant.id,
      p_description: `API SMS dispatch (${normalizedNumbers.length} recipient(s))`
    });
    if (debitErr) {
      console.error('[messaging] wallet debit failed:', debitErr);
      return NextResponse.json({ error: 'Insufficient SMS wallet balance' }, { status: 402 });
    }

    // Refund helper: used only when the provider definitively rejects the batch.
    const refundBatch = async () => {
      const { error: refundErr } = await supabaseAdmin.rpc('refund_sms_wallet', {
        p_wallet_id: wallet.id,
        p_amount: totalCost,
        p_reference: `refund_${debitKey}`
      });
      if (refundErr) console.error('[messaging] refund failed, needs manual review:', refundErr);
    };

    // Real Africastalking dispatch
    const url = atUsername === 'sandbox' 
      ? 'https://api.sandbox.africastalking.com/version1/messaging' 
      : 'https://api.africastalking.com/version1/messaging';

    const formParams = new URLSearchParams();
    formParams.append('username', atUsername);
    formParams.append('to', normalizedNumbers.join(','));
    formParams.append('message', message);
    if (from) {
      formParams.append('from', from);
    }

    const atResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': atApiKey
      },
      body: formParams.toString()
    });

    if (!atResponse.ok) {
      await refundBatch();
      const errText = await atResponse.text();
      console.error('[NaJiki Gateway] AfricasTalking HTTP error:', atResponse.status, errText);
      return NextResponse.json({
        error: `SMS gateway dispatch failed with status ${atResponse.status}`,
        details: errText
      }, { status: 502 });
    }

    const atResult = await atResponse.json();
    
    // 4. Tracking, Cost Auditing, and Logging - Only log verified provider responses
    const responses = atResult?.SMSMessageData?.Recipients || [];
    
    if (responses.length === 0) {
      await refundBatch();
      const providerMsg = atResult?.SMSMessageData?.Message || 'No recipients processed by SMS provider';
      console.error('[NaJiki Gateway] AfricasTalking returned no recipients:', providerMsg);
      return NextResponse.json({
        error: `SMS provider error: ${providerMsg}`,
        details: atResult
      }, { status: 502 });
    }

    for (const recipient of responses) {
      let cost = 0;
      // AfricasTalking returns cost like 'UGX 40.00' or 'KES 1.00'
      if (recipient.cost) {
        const parts = recipient.cost.split(' ');
        if (parts.length === 2) {
          cost = parseFloat(parts[1]);
        }
      }
      
      await supabaseAdmin
        .from('sms_messages')
        .insert({
          tenant_id: tenant?.id || null,
          application_id: app.id,
          phone_number: recipient.number,
          compiled_message: message,
          cost: cost,
          status: recipient.status,
          provider_message_id: recipient.messageId,
          event_code: finalEventCode || null
        });
    }

    return NextResponse.json({
      success: true,
      responses: responses
    }, { status: 201 });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('Critical exception in SMS API Gateway:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
