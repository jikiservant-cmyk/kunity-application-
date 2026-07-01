import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { validateTemplatePlaceholders, SmsEventType } from '../../../../../lib/sms-templates';

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
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr || !adminProfile || !adminProfile.tenant_id) {
      return NextResponse.json({ error: 'Admin profile or tenant ID not found' }, { status: 403 });
    }

    const tenantId = adminProfile.tenant_id;

    const body = await req.json();
    const { event_type, template_text } = body;

    if (!event_type || !template_text) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Validate the placeholders against the schema
    const invalidPlaceholders = validateTemplatePlaceholders(event_type as SmsEventType, template_text);

    if (invalidPlaceholders.length > 0) {
      return NextResponse.json({ 
        error: `Invalid placeholders found for event ${event_type}: ${invalidPlaceholders.join(', ')}. Please use only the approved placeholders.` 
      }, { status: 400 });
    }

    // 2. Upsert the template into sms_templates table
    const { data, error } = await supabaseAdmin
      .schema('kunity')
      .from('sms_templates')
      .upsert({
        tenant_id: tenantId,
        event_type,
        template_text,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id, event_type' })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, data });

  } catch (err: any) {
    console.error('Error saving SMS template:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
