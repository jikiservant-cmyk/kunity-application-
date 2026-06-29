import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

    // 1. Verify API Key from headers
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Unauthorized: Missing x-api-key header' }, { status: 401 });
    }

    // Retrieve application mapping based on API Key
    const { data: app, error: appErr } = await supabaseAdmin
      .from('applications')
      .select('id, name')
      .eq('api_key', apiKey)
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({ error: 'Unauthorized: Invalid x-api-key' }, { status: 401 });
    }

    // 2. Parse Request Payload
    const body = await req.json();
    const { to, message, eventType, tenantCode, metadata } = body;

    if (!to || !message || !tenantCode) {
      return NextResponse.json({ error: 'Bad Request: recipient "to", "message", and "tenantCode" are required' }, { status: 400 });
    }

    // Retrieve tenant mapping based on tenantCode
    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('id, name, is_active')
      .eq('code', tenantCode)
      .eq('application_id', app.id)
      .maybeSingle();

    if (tenantErr || !tenant) {
      return NextResponse.json({ error: 'Not Found: Invalid tenantCode for this application' }, { status: 404 });
    }

    if (!tenant.is_active) {
      return NextResponse.json({ error: 'Forbidden: Tenant is deactivated' }, { status: 403 });
    }

    // 3. Calculate expected SMS Cost (UGX) for gateway logging
    // 1 segment is 160 characters.
    const messageLength = message.trim().length;
    const segments = Math.ceil(messageLength / 160) || 1;
    const costPerSegment = 40.00;
    const totalCost = segments * costPerSegment;

    // 4. Log the SMS send event to public.sms_messages (Audit Log)
    const providerSmsId = `at_sms_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const { error: smsLogErr } = await supabaseAdmin
      .from('sms_messages')
      .insert({
        tenant_id: tenant.id,
        application_id: app.id,
        phone_number: to,
        compiled_message: message,
        cost: totalCost,
        status: 'sent',
        provider_message_id: providerSmsId,
        event_code: eventType
      });

    if (smsLogErr) {
      console.error('[NaJiki Gateway] Error inserting sms log:', smsLogErr);
      // We can choose to fail or continue since it's just an audit log, but typically fail
      return NextResponse.json({ error: 'Failed to log message in gateway' }, { status: 500 });
    }

    // 5. Here NaJiki would call Africa's Talking or Twilio via their SDK
    // For this implementation, we simulate a successful dispatch.
    console.log(`[NaJiki Gateway] Message dispatched to ${to} for tenant ${tenantCode}`);

    // 6. Return success response to KUnity
    return NextResponse.json({
      success: true,
      messageId: providerSmsId,
      recipient: to,
      segments,
      costUGX: totalCost
    }, { status: 201 });

  } catch (err: any) {
    console.error('Critical exception in SMS API Gateway:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
