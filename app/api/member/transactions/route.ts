import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { memberActionLimiter } from '@/lib/rate-limit';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  try {
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

    // Initialize service role client for RPCs
    const supabaseAdminLocal = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { action, amount, accountId, loanId } = body;

    if (!action || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Invalid or missing amount/action' }, { status: 400 });
    }

    // FIN-10: rate limit member money-movement operations (brute-force guard)
    try {
      await memberActionLimiter.check(30, `member:tx:${user.id}`);
    } catch {
      return NextResponse.json(
        { error: 'Too many transaction requests. Please wait a moment before trying again.' },
        { status: 429 }
      );
    }

    // Validate identifiers before hitting the database
    if ((action === 'withdraw' || action === 'repay') && (!accountId || !UUID_RE.test(String(accountId)))) {
      return NextResponse.json({ error: 'Invalid accountId' }, { status: 400 });
    }
    if (action === 'repay' && (!loanId || !UUID_RE.test(String(loanId)))) {
      return NextResponse.json({ error: 'Invalid loanId' }, { status: 400 });
    }

    // Fetch the member record to verify organization mapping
    const { data: member, error: memberErr } = await supabaseAdminLocal
      .schema('kunity')
      .from('members')
      .select('id, organization_id')
      .eq('id', user.id)
      .maybeSingle();

    if (memberErr || !member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
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
          p_amount: amount
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
          p_amount: amount
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
          p_amount: amount
        }
      );
      if (error) throw error;
      result = data;

    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true, result });

  } catch (err: any) {
    // FIN-27: business-rule rejections from the RPCs (RAISE EXCEPTION) are
    // client errors — return them as 400 with the message, not a 500 that
    // leaks internals and confuses the member app. Anything else is a genuine
    // server error: log it and return a generic message.
    const msg = String(err?.message || '');
    const businessRule = [
      'must be greater than zero',
      'not found',
      'is not active',
      'not in a repayable state',
      'Insufficient funds',
      'exceeds remaining',
      'already approved',
      'Cannot approve',
      'Disbursement amount mismatch',
    ].some((pat) => msg.includes(pat));

    if (businessRule) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    console.error(`Error in /api/member/transactions:`, err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
