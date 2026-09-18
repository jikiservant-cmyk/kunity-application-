import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { messagingLimiter } from '@/lib/rate-limit';

// If running in edge or node without africastalking, we use fetch to their REST API.
// Africastalking API: https://api.africastalking.com/version1/messaging

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
      .eq('api_key', apiKey)
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

    let tenant = null;
    if (tenantCode) {
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
      tenant = t;
    }

    // 2. Format & Sanitize Phone Numbers
    const numbers = Array.isArray(to) ? to : [to];
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
