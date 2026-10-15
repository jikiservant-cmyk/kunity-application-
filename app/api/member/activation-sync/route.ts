import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// FIN-34: server-side reconciliation of activation. The browser used to flip
// member_savings / accounts to active itself, but the lockdown revokes client
// UPDATE on those tables, so that write silently failed. This route does the
// same thing with the service role, and ONLY when the payment webhook has
// already recorded a successful activation payment for this member.
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server configuration missing' }, { status: 500 });
    }

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: member } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('id, organization_id')
      .eq('id', user.id)
      .maybeSingle();
    if (!member) {
      return NextResponse.json({ error: 'Member profile not found' }, { status: 403 });
    }

    // Only a webhook-recorded successful activation payment can activate.
    const { data: paid } = await supabaseAdmin
      .schema('kunity')
      .from('payment_requests')
      .select('id')
      .eq('member_id', member.id)
      .eq('organization_id', member.organization_id)
      .eq('status', 'success')
      .or('payment_type.eq.account_activation,internal_reference.like.PAY-ACT-%')
      .limit(1)
      .maybeSingle();

    if (!paid) {
      return NextResponse.json({ success: true, activated: false });
    }

    const { error: msErr } = await supabaseAdmin
      .schema('kunity')
      .from('member_savings')
      .update({ status: 'active' })
      .eq('member_id', member.id)
      .eq('organization_id', member.organization_id)
      .is('deleted_at', null);

    const { error: accErr } = await supabaseAdmin
      .schema('kunity')
      .from('accounts')
      .update({ is_active: true })
      .eq('member_id', member.id)
      .eq('organization_id', member.organization_id);

    if (msErr || accErr) {
      console.error('[activation-sync] update failed:', msErr || accErr);
      return NextResponse.json({ error: 'Could not sync activation. Please try again.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, activated: true });
  } catch (err: any) {
    console.error('Error in /api/member/activation-sync:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
