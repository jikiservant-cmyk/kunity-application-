import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant, assertTenantMatch } from '@/lib/admin-auth';
import { apiLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { generateApiKey, hashApiKey } from '@/lib/api-keys';

// SACCO admins rotate their SACCO application's SMS gateway API key.
// The new key is returned ONCE in this response. Only its SHA-256 digest is stored,
// so the previous key stops working immediately.
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

    const body = await req.json().catch(() => ({}));
    const { token, organizationId } = body as { token?: string; organizationId?: string };
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    try {
      await apiLimiter.check(10, `admin:api-key:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 });
    }

    const targetTenantId = adminAuth.isGlobalAdmin ? (organizationId || adminAuth.tenantId) : adminAuth.tenantId;
    if (!targetTenantId) {
      return NextResponse.json({ error: 'Organization is required' }, { status: 400 });
    }
    const tenantCheck = assertTenantMatch(adminAuth, targetTenantId);
    if (!tenantCheck.allowed) {
      return NextResponse.json({ error: tenantCheck.error }, { status: 403 });
    }

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('id, application_id')
      .eq('id', targetTenantId)
      .maybeSingle();
    if (!tenant?.application_id) {
      return NextResponse.json({ error: 'No application is linked to this SACCO' }, { status: 404 });
    }

    const newKey = generateApiKey();
    const { error: updErr } = await supabaseAdmin
      .from('applications')
      .update({ api_key_hash: hashApiKey(newKey), api_key: null })
      .eq('id', tenant.application_id);
    if (updErr) {
      console.error('[api-key] rotate failed:', updErr);
      return NextResponse.json({ error: 'Could not rotate the API key' }, { status: 500 });
    }

    await logAudit(supabaseAdmin, {
      adminId: adminAuth.user.id,
      tenantId: targetTenantId,
      action: 'api_key_rotate',
      entityType: 'applications',
      entityId: tenant.application_id,
      newData: { rotated: true },
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({ success: true, apiKey: newKey });
  } catch (err: any) {
    console.error('Error rotating API key:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
