import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant, assertTenantMatch } from '@/lib/admin-auth';
import { loanActionLimiter } from '@/lib/rate-limit';
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
    const { loanId, status, memberId } = body;

    const authHeader = req.headers.get('authorization');
    let token = body.token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }


    if (!token || !loanId || !status) {
      return NextResponse.json({ error: 'Missing required parameters (token, loanId, status)' }, { status: 400 });
    }

    // 1. Verify Admin Authentication & Tenant
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Rate limit admin loan operations
    try {
      await loanActionLimiter.check(30, `admin:loan:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for admin loan operations' }, { status: 429 });
    }

    // 2. Fetch authoritative loan record from database
    const { data: loan, error: loanFetchErr } = await supabaseAdmin
      .schema('kunity')
      .from('loans')
      .select('id, organization_id, member_id, principal, status')
      .eq('id', loanId)
      .maybeSingle();

    if (loanFetchErr || !loan) {
      return NextResponse.json({ error: 'Loan record not found' }, { status: 404 });
    }

    // 3. Strict Tenant Isolation Assertion
    // Admin can ONLY manage loans belonging to their assigned SACCO organization
    const matchCheck = assertTenantMatch(adminAuth, loan.organization_id);
    if (!matchCheck.allowed) {
      return NextResponse.json({ error: matchCheck.error }, { status: 403 });
    }

    // Ensure memberId matches the borrower
    if (memberId && memberId !== loan.member_id) {
      return NextResponse.json({ error: 'Forbidden: memberId does not match loan borrower' }, { status: 403 });
    }

    // 4. Handle Status Transitions & Guard Against Double-Disbursement
    if (status === 'approved') {
      if (loan.status === 'approved') {
        return NextResponse.json({ error: 'Loan is already approved and disbursed' }, { status: 400 });
      }
      if (loan.status !== 'pending') {
        return NextResponse.json({ error: `Cannot approve loan currently in status: ${loan.status}` }, { status: 400 });
      }

      // CRITICAL: Always use database-authoritative loan amount, NEVER client-provided amount
      const disbursementAmount = parseFloat(loan.principal);
      if (isNaN(disbursementAmount) || disbursementAmount <= 0) {
        return NextResponse.json({ error: 'Invalid loan principal amount in database' }, { status: 400 });
      }

      
      // Atomic transition: Update loan status, wallet balance, and journal using Postgres RPC
      const { data: rpcResult, error: rpcError } = await supabaseAdmin
        .schema('kunity')
        .rpc('disburse_loan_atomic', {
          p_loan_id: loan.id,
          p_organization_id: loan.organization_id,
          p_member_id: loan.member_id,
          p_disbursement_amount: disbursementAmount
        });

      if (rpcError) {
        console.error('Failed to disburse loan via RPC:', rpcError);
        return NextResponse.json({ error: 'Failed to approve loan: ' + rpcError.message }, { status: 409 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: adminAuth.tenantId,
        action: 'approve_loan',
        entityType: 'loan',
        entityId: loan.id,
        newData: { amount: disbursementAmount, status: 'approved' }
      });

      return NextResponse.json({
        success: true,
        message: 'Loan successfully approved and funds disbursed'
      });


    } else if (status === 'rejected') {
      if (loan.status !== 'pending') {
        return NextResponse.json({ error: `Cannot reject loan in status: ${loan.status}` }, { status: 400 });
      }

      const { error: loanErr } = await supabaseAdmin
        .schema('kunity')
        .from('loans')
        .update({ 
          status: 'rejected',
          updated_at: new Date().toISOString()
        })
        .eq('id', loan.id)
        .eq('organization_id', loan.organization_id)
        .eq('status', 'pending');

      if (loanErr) {
        return NextResponse.json({ error: 'Failed to reject loan' }, { status: 500 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: adminAuth.tenantId,
        action: 'reject_loan',
        entityType: 'loan',
        entityId: loan.id,
        newData: { status: 'rejected' }
      });

      return NextResponse.json({
        success: true,
        message: 'Loan has been rejected'
      });

    } else {
      return NextResponse.json({ error: 'Unsupported loan status transition' }, { status: 400 });
    }

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('Error processing loan action on server:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
