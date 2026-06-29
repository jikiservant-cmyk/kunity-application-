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

    const body = await req.json();
    const { token, loanId, status, memberId, amount, organizationId } = body;

    if (!token || !loanId || !status) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile to verify rights
    const { data: adminProfile } = await supabaseAdmin
      .from('admin_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (!adminProfile || adminProfile.role !== 'sacco_admin') {
      return NextResponse.json({ error: 'Forbidden: Admin authorization required' }, { status: 403 });
    }

    // Perform Loan Status Update
    const { error: loanErr } = await supabaseAdmin
      .schema('kunity')
      .from('loans')
      .update({ status })
      .eq('id', loanId);

    if (loanErr) {
      return NextResponse.json({ error: 'Failed to update loan status' }, { status: 500 });
    }

    // If approved, disburse funds and record journal transactions
    if (status === 'approved') {
      // Find the member's wallet account
      const { data: account, error: accErr } = await supabaseAdmin
        .schema('kunity')
        .from('accounts')
        .select('id, cached_balance')
        .eq('member_id', memberId)
        .maybeSingle();

      if (accErr || !account) {
        return NextResponse.json({ error: 'Member wallet account not found' }, { status: 404 });
      }

      // Calculate and update the new balance
      const newBalance = parseFloat(account.cached_balance || '0') + parseFloat(amount);
      const { error: walletErr } = await supabaseAdmin
        .schema('kunity')
        .from('accounts')
        .update({ cached_balance: newBalance })
        .eq('id', account.id);

      if (walletErr) {
        return NextResponse.json({ error: 'Failed to credit member wallet balance' }, { status: 500 });
      }

      // Write Journal Entry
      const { data: entry, error: entryErr } = await supabaseAdmin
        .schema('kunity')
        .from('journal_entries')
        .insert({
          organization_id: organizationId,
          description: `Loan Disbursement (Loan UUID: ${loanId.substring(0, 8)})`
        })
        .select('id')
        .maybeSingle();

      if (entryErr) {
        console.error('Error creating journal entry on server:', entryErr);
      }

      // Write Journal Line
      if (entry) {
        const { error: lineErr } = await supabaseAdmin
          .schema('kunity')
          .from('journal_lines')
          .insert({
            journal_entry_id: entry.id,
            account_id: account.id,
            member_id: memberId,
            line_type: 'loan_disbursement',
            debit: parseFloat(amount)
          });

        if (lineErr) {
          console.error('Error creating journal line on server:', lineErr);
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Loan successfully ${status}`
    });

  } catch (err: any) {
    console.error('Error processing loan action on server:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
