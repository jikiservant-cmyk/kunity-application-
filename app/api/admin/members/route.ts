import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant, assertTenantMatch } from '@/lib/admin-auth';
import { memberActionLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';

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

    const body = await req.json();
    const { token, memberId, action, reason, organizationId } = body;

    if (!token || !memberId || !action) {
      return NextResponse.json({ error: 'Missing required parameters (token, memberId, action)' }, { status: 400 });
    }

    // 1. Verify Admin Authentication & Tenant
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Rate limit admin actions
    try {
      await memberActionLimiter.check(30, `admin:member:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for admin member operations' }, { status: 429 });
    }

    // 2. Fetch target member
    const { data: member, error: memberErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('*')
      .eq('id', memberId)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member record not found' }, { status: 404 });
    }

    // 3. Strict Tenant Isolation Assertion
    const matchCheck = assertTenantMatch(adminAuth, member.organization_id);
    if (!matchCheck.allowed) {
      return NextResponse.json({ error: matchCheck.error }, { status: 403 });
    }

    if (organizationId && organizationId !== member.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden: organizationId does not match target member organization' },
        { status: 403 }
      );
    }

    const effectiveOrgId = member.organization_id;

    if (action === 'reject') {
      const { error: updateErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .update({ 
          status: 'rejected',
          updated_at: new Date().toISOString()
        })
        .eq('id', memberId)
        .eq('organization_id', effectiveOrgId);

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: effectiveOrgId,
        action: 'member_reject',
        entityType: 'member',
        entityId: memberId,
        oldData: { status: member.status },
        newData: { status: 'rejected', reason },
        userAgent: req.headers.get('user-agent') || undefined,
      });

      return NextResponse.json({ 
        success: true, 
        message: `Member application for ${member.first_name} was declined.` 
      });

    } else if (action === 'suspend') {
      const { error: updateErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .update({ 
          status: 'suspended',
          updated_at: new Date().toISOString()
        })
        .eq('id', memberId)
        .eq('organization_id', effectiveOrgId);

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: effectiveOrgId,
        action: 'member_suspend',
        entityType: 'member',
        entityId: memberId,
        oldData: { status: member.status },
        newData: { status: 'suspended', reason },
        userAgent: req.headers.get('user-agent') || undefined,
      });

      return NextResponse.json({ 
        success: true, 
        message: `Membership for ${member.first_name} has been suspended.` 
      });

    } else if (action === 'set_pending') {
      const { error: updateErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .update({ 
          status: 'pending',
          updated_at: new Date().toISOString()
        })
        .eq('id', memberId)
        .eq('organization_id', effectiveOrgId);

      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: effectiveOrgId,
        action: 'member_set_pending',
        entityType: 'member',
        entityId: memberId,
        oldData: { status: member.status },
        newData: { status: 'pending', reason },
        userAgent: req.headers.get('user-agent') || undefined,
      });

      return NextResponse.json({ 
        success: true, 
        message: `Member ${member.first_name} set to Pending status.` 
      });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('Error in /api/admin/members:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
