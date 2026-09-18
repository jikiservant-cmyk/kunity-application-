import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

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
    console.error(`Error in /api/member/transactions:`, err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
