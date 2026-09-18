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

    if (action === 'approve') {
      // 1. Update member status to 'active' scoped to member's organization
      const { error: updateErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .update({ 
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('id', memberId)
        .eq('organization_id', effectiveOrgId);

      if (updateErr) {
        return NextResponse.json({ error: 'Failed to approve member in database: ' + updateErr.message }, { status: 500 });
      }

      // 2. Ensure member has an active wallet account in kunity.accounts
      const { data: existingAccounts } = await supabaseAdmin
        .schema('kunity')
        .from('accounts')
        .select('*')
        .eq('member_id', memberId)
        .eq('organization_id', effectiveOrgId);

      if (!existingAccounts || existingAccounts.length === 0) {
        const accCode = `WAL-${Math.floor(1000 + Math.random() * 9000)}`;
        await supabaseAdmin
          .schema('kunity')
          .from('accounts')
          .insert({
            organization_id: effectiveOrgId,
            member_id: memberId,
            name: `${member.first_name || 'Member'} Primary Wallet`,
            code: accCode,
            account_category: 'asset',
            currency: 'UGX',
            cached_balance: 0,
            is_active: true,
            is_system: false
          });
      } else {
        // Activate existing accounts
        await supabaseAdmin
          .schema('kunity')
          .from('accounts')
          .update({ is_active: true })
          .eq('member_id', memberId)
          .eq('organization_id', effectiveOrgId);
      }

      // 3. Queue approval confirmation SMS
      if (member.phone) {
        try {
          const { inngest } = await import('@/lib/inngest/client');
          const firstName = member.first_name || 'Member';
          const approvalMsg = `Hello ${firstName}, congratulations! Your SACCO membership has been approved and activated. You can now log in, deposit, and access cooperative credit.`;
          await inngest.send({
            name: 'sms/dispatch',
            data: {
              tenantId: effectiveOrgId,
              recipientPhone: member.phone,
              message: approvalMsg,
              eventType: 'APPROVAL',
              originUrl: req.url,
              templateData: {
                first_name: firstName,
                member_id: member.id.substring(0, 8).toUpperCase()
              }
            }
          });
        } catch (smsErr) {
          console.warn('Could not queue member approval SMS notification:', smsErr);
        }
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: effectiveOrgId,
        action: 'member_approve',
        entityType: 'member',
        entityId: memberId,
        oldData: { status: member.status },
        newData: { status: 'active' },
        userAgent: req.headers.get('user-agent') || undefined,
      });

      return NextResponse.json({ 
        success: true, 
        message: `${member.first_name} has been approved and their account is now active!` 
      });

    } else if (action === 'reject') {
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
