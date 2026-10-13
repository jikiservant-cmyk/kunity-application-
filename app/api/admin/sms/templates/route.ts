import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateTemplatePlaceholders, SmsEventType, SMS_EVENTS } from '../../../../../lib/sms-templates';
import { logAudit } from '../../../../../lib/audit-logger';

// SECURITY (pentest 2026-10-13, messaging): templates are only for the known event types.
const MAX_TEMPLATE_CHARS = 480;

export async function POST(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    
    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    
    // Check auth to ensure it's an admin
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Missing authorization header' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized', details: userError?.message }, { status: 401 });
    }

    // Lookup admin profile to get tenant_id safely
    const { data: adminProfile, error: profileErr } = await supabaseAdmin
      .schema('public')
      .from('admin_profiles')
      .select('tenant_id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !adminProfile || !adminProfile.tenant_id) {
      return NextResponse.json({ error: 'Admin profile or tenant ID not found' }, { status: 403 });
    }

    const role = adminProfile.role || 'member';
    const isSaccoAdmin = ['sacco_admin', 'system_admin', 'super_admin'].includes(role);
    
    if (!isSaccoAdmin) {
      return NextResponse.json({ error: 'Forbidden: Elevated administrator permissions required' }, { status: 403 });
    }

    const tenantId = adminProfile.tenant_id;

    const body = await req.json();
    const { event_type, template_text } = body;

    if (!event_type || !template_text) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (typeof event_type !== 'string' || !Object.prototype.hasOwnProperty.call(SMS_EVENTS, event_type)) {
      return NextResponse.json({ error: `Unknown event type. Allowed: ${Object.keys(SMS_EVENTS).join(', ')}` }, { status: 400 });
    }
    if (typeof template_text !== 'string') {
      return NextResponse.json({ error: 'template_text must be text' }, { status: 400 });
    }
    if (template_text.length > MAX_TEMPLATE_CHARS) {
      return NextResponse.json({ error: `Template is longer than ${MAX_TEMPLATE_CHARS} characters` }, { status: 400 });
    }

    // 1. Validate the placeholders against the schema
    const invalidPlaceholders = validateTemplatePlaceholders(event_type as SmsEventType, template_text);

    if (invalidPlaceholders.length > 0) {
      return NextResponse.json({ 
        error: `Invalid placeholders found for event ${event_type}: ${invalidPlaceholders.join(', ')}. Please use only the approved placeholders.` 
      }, { status: 400 });
    }

    // 2. Upsert the template into sms_templates table with compatibility for event_type/event_code & template_text/body
    const { data, error } = await supabaseAdmin
      .schema('public')
      .from('sms_templates')
      .upsert({
        tenant_id: tenantId,
        event_type,
        event_code: event_type,
        template_text,
        body: template_text,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id, event_type' })
      .select()
      .single();

    if (error) {
      throw error;
    }

    await logAudit(supabaseAdmin, {
      adminId: user.id,
      tenantId,
      action: 'sms_template_saved',
      entityType: 'sms_templates',
      entityId: data?.id,
      newData: { event_type, length: template_text.length },
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({ success: true, data });

  } catch (err: any) {
    console.error('Error saving SMS template:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
