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

    let tenantId = adminProfile?.tenant_id;
    if (!tenantId && user.user_metadata?.tenant_id) {
      tenantId = user.user_metadata.tenant_id;
    }

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin is not associated with any tenant' }, { status: 400 });
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

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No valid recipients with phone numbers found for the selected audience.' }, { status: 400 });
    }

    // Calculate message cost details
    const textLength = message.trim().length;
    const segments = Math.ceil(textLength / 160) || 1;
    const costPerSms = 40.00; // 40 UGX = 1 credit
    const totalCost = segments * costPerSms * recipients.length;

    // Fetch active wallet
    let wallet = null;
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('kunity')
      .from('tenant_wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet) {
      // Auto-create wallet if missing (250 credits default = 10,000 UGX)
      const { data: newWallet } = await supabaseAdmin
        .schema('kunity')
        .from('tenant_wallets')
        .insert({
          tenant_id: tenantId,
          balance: 10000.00,
          currency: 'UGX',
          is_active: true
        })
        .select('*')
        .single();
      wallet = newWallet;
    } else {
      wallet = existingWallet;
    }

    const currentBalance = parseFloat(wallet.balance);

    if (currentBalance < totalCost) {
      return NextResponse.json({
        error: `Insufficient funds in SMS wallet. This broadcast requires UGX ${totalCost.toLocaleString()} (${Math.ceil(totalCost/40)} credits) but your wallet has UGX ${currentBalance.toLocaleString()} (${Math.floor(currentBalance/40)} credits). Please top up first.`
      }, { status: 400 });
    }

    // Deduct balance and update wallet
    const newBalance = currentBalance - totalCost;
    const { error: debitErr } = await supabaseAdmin
      .schema('kunity')
      .from('tenant_wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', wallet.id);

    if (debitErr) {
      return NextResponse.json({ error: 'Failed to deduct wallet balance' }, { status: 500 });
    }

    // Log wallet transaction ledger
    const transactionRef = `tx_bcast_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await supabaseAdmin
      .schema('kunity')
      .from('wallet_transactions')
      .insert({
        wallet_id: wallet.id,
        type: 'DEBIT',
        amount: totalCost,
        running_balance: newBalance,
        description: `SMS broadcast to ${recipients.length} recipient(s) (${segments} part(s) each)`,
        reference: transactionRef
      });

    // Write to kunity.sms_logs for each recipient (Client-side ledger)
    const smsId = `bcast_${Date.now()}`;
    const logInserts = recipients.map((phone, idx) => ({
      tenant_id: tenantId, 
      recipient_phone: phone,
      message: message,
      cost: segments * costPerSms,
      status: 'sent',
      event_type: 'BROADCAST',
      provider_sms_id: `${smsId}_${idx}`
    }));

    const { error: logErr } = await supabaseAdmin
      .schema('kunity')
      .from('sms_logs')
      .insert(logInserts);

    if (logErr) {
      console.error('Error inserting broadcast logs to kunity.sms_logs:', logErr);
    }

    // Dispatch to NaJiki Gateway
    // In production, this would be a secure fetch to api.najiki.com
    const najikiUrl = process.env.NAJIKI_API_URL || `${req.nextUrl.origin}/api/messaging/send`;
    const apiKey = process.env.NAJIKI_API_KEY || 'default-sacco-api-key';
    const tenantCode = process.env.NAJIKI_TENANT_CODE || 'abc-sacco';

    const dispatchPromises = recipients.map(async (phone) => {
      try {
        await fetch(najikiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
          },
          body: JSON.stringify({
            tenantCode,
            to: phone,
            message,
            eventType: 'BROADCAST'
          })
        });
      } catch (err) {
        console.error(`Failed to dispatch SMS to NaJiki Gateway for ${phone}:`, err);
      }
    });

    // We must await the dispatch in serverless environments to ensure network requests finish
    await Promise.all(dispatchPromises);

    return NextResponse.json({
      success: true,
      recipientsCount: recipients.length,
      costCredits: Math.ceil(totalCost / 40),
      costUGX: totalCost,
      newBalanceCredits: Math.floor(newBalance / 40)
    });

  } catch (err: any) {
    console.error('Error sending SMS broadcast on server:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
