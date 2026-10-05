import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { memberTxLimiter } from '@/lib/rate-limit';
import { isSameOriginRequest, rejectCrossSiteRequest, isUuid } from '@/lib/request-guard';
import { validateAmount } from '@/lib/validators';

export async function POST(req: NextRequest) {
  try {
    // SECURITY (CSRF guard): This endpoint authenticates via session cookies,
    // which are SameSite=None (required for iframe embedding) and therefore
    // attached to cross-site requests. Combined with req.json() parsing
    // text/plain bodies, a malicious page could otherwise trigger withdrawals,
    // loan applications, or repayments on behalf of a logged-in member.
    if (!isSameOriginRequest(req)) {
      return rejectCrossSiteRequest();
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const cookieStore = cookies();
    const supabaseClient = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value; }
      }
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limit money-movement operations per member.
    try {
      await memberTxLimiter.check(10, `member:tx:${user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many transaction requests. Please wait a moment before trying again.' }, { status: 429 });
    }

    // Initialize service role client for RPCs
    const supabaseAdminLocal = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { action, amount, accountId, loanId } = body;

    if (!action || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Invalid or missing amount/action' }, { status: 400 });
    }

    // Strict server-side monetary bounds (min 100 UGX, max 100,000,000 UGX).
    const amountCheck = validateAmount(amount);
    if (!amountCheck.valid) {
      return NextResponse.json({ error: amountCheck.error }, { status: 400 });
    }

    // Fetch the member record to verify organization mapping AND account
    // standing. Only fully approved ('active') members may move money:
    // pending, rejected, and suspended members are locked out of
    // withdrawals, loan applications, and repayments.
    const { data: member, error: memberErr } = await supabaseAdminLocal
      .schema('kunity')
      .from('members')
      .select('id, organization_id, status')
      .eq('id', user.id)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
    }

    if (member.status !== 'active') {
      return NextResponse.json(
        { error: `Account is not active (status: ${member.status}). Contact your SACCO administrator.` },
        { status: 403 }
      );
    }

    // Identifier format validation before database RPC calls.
    if (accountId !== undefined && !isUuid(accountId)) {
      return NextResponse.json({ error: 'Invalid accountId' }, { status: 400 });
    }
    if (loanId !== undefined && !isUuid(loanId)) {
      return NextResponse.json({ error: 'Invalid loanId' }, { status: 400 });
    }

    let result;

    if (action === 'withdraw') {
      if (!accountId) return NextResponse.json({ error: 'Missing accountId' }, { status: 400 });

      const { data, error } = await supabaseAdminLocal.rpc(
        'member_withdraw_atomic',
        {
          p_member_id: member.id,
          p_organization_id: member.organization_id,
          p_account_id: accountId,
          p_amount: amountCheck.amount
        }
      );
      if (error) throw error;
      result = data;

    } else if (action === 'loan') {
      const { data, error } = await supabaseAdminLocal.rpc(
        'member_apply_loan',
        {
          p_member_id: member.id,
          p_organization_id: member.organization_id,
          p_amount: amountCheck.amount
        }
      );
      if (error) throw error;
      result = data;

    } else if (action === 'repay') {
      if (!accountId || !loanId) return NextResponse.json({ error: 'Missing accountId or loanId' }, { status: 400 });

      const { data, error } = await supabaseAdminLocal.rpc(
        'member_repay_loan_atomic',
        {
          p_member_id: member.id,
          p_organization_id: member.organization_id,
          p_account_id: accountId,
          p_loan_id: loanId,
          p_amount: amountCheck.amount
        }
      );
      if (error) throw error;
      result = data;

    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true, result });

  } catch (err: any) {
    console.error(`Error in /api/member/transactions:`, err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
