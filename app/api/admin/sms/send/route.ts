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
    const { token, recipientType, message } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    if (!message || !message.trim()) {
      return NextResponse.json({ error: 'Message content cannot be empty' }, { status: 400 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile to get organization_id
    const { data: adminProfile, error: profileErr } = await supabaseAdmin
      .from('admin_profiles')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();

    const tenantId = adminProfile?.tenant_id;

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin profile is not associated with any tenant' }, { status: 400 });
    }

    // Resolve list of recipient phone numbers
    let recipients: string[] = [];

    if (recipientType === 'all') {
      // Get all members of the organization
      const { data: members, error: mErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('phone')
        .eq('organization_id', tenantId);
      
      if (!mErr && members) {
        recipients = members.map(m => m.phone).filter(Boolean);
      }
    } else if (recipientType === 'loans') {
      // Get members with pending loans
      const { data: pendingLoans, error: lErr } = await supabaseAdmin
        .schema('kunity')
        .from('loans')
        .select('members!inner(phone)')
        .eq('status', 'pending')
        .eq('members.organization_id', tenantId);
      
      if (!lErr && pendingLoans) {
        recipients = pendingLoans.map((l: any) => l.members?.phone).filter(Boolean);
      }
    } else {
      // It's a specific member ID
      const { data: member, error: mErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('phone')
        .eq('id', recipientType)
        .maybeSingle();
      
      if (!mErr && member && member.phone) {
        recipients = [member.phone];
      }
    }

    // De-duplicate phone numbers and filter out empty ones
    recipients = [...new Set(recipients.filter(Boolean))];

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No valid recipients with phone numbers found for the selected audience.' }, { status: 400 });
    }

    // Calculate message cost details
    const textLength = message.trim().length;
    let segments = 1;
    if (textLength > 160) {
      segments = Math.ceil(textLength / 153);
    }
    const costPerSms = 40.00; // 40 UGX = 1 credit
    const totalCost = segments * costPerSms * recipients.length;

    // Fetch active wallet
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      return NextResponse.json({
        error: `Wallet not found for this tenant. Please provision a wallet first.`
      }, { status: 400 });
    }
    
    const wallet = existingWallet;

    const currentBalance = parseFloat(wallet.balance);

    if (currentBalance < totalCost) {
      return NextResponse.json({
        error: `Insufficient funds in SMS wallet. This broadcast requires UGX ${totalCost.toLocaleString()} (${Math.ceil(totalCost/40)} credits) but your wallet has UGX ${currentBalance.toLocaleString()} (${Math.floor(currentBalance/40)} credits). Please top up first.`
      }, { status: 400 });
    }

    // Queue SMS dispatches via Inngest
    // Instead of deducting up-front, the Inngest jobs will handle individual deductions and logging safely.
    const { inngest } = await import('../../../../../lib/inngest/client');
    const events = recipients.map(phone => ({
      name: 'sms/dispatch' as const,
      data: {
        tenantId,
        recipientPhone: phone,
        message,
        eventType: 'BROADCAST',
        originUrl: req.nextUrl.origin
      }
    }));

    // Send in batches of 100 to avoid request size limits if many recipients
    for (let i = 0; i < events.length; i += 100) {
      const batch = events.slice(i, i + 100);
      await inngest.send(batch);
    }

    // Since we're offloading to Inngest, the new balance won't be immediately visible in this response.
    // We return the expected cost and the fact that it's queued.
    return NextResponse.json({
      success: true,
      recipientsCount: recipients.length,
      costCredits: Math.ceil(totalCost / 40),
      costUGX: totalCost,
      newBalanceCredits: Math.floor(currentBalance / 40) // This is current balance before background drain
    });

  } catch (err: any) {
    console.error('Error sending SMS broadcast on server:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
