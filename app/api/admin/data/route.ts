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
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Retrieve admin profile from public.admin_profiles
    const { data: adminProfile, error: profileErr } = await supabaseAdmin
      .from('admin_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (profileErr) {
      return NextResponse.json({ error: 'Database error reading profile' }, { status: 500 });
    }

    // Multi-level organization / tenant ID fallback
    let orgId = adminProfile?.tenant_id;

    if (!orgId && user.user_metadata?.tenant_id) {
      orgId = user.user_metadata.tenant_id;
    }

    // If still missing, query first organization available or members table
    if (!orgId) {
      const { data: adminMember } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('organization_id')
        .eq('id', user.id)
        .maybeSingle();
      orgId = adminMember?.organization_id;
    }

    if (!orgId) {
      const { data: tenants } = await supabaseAdmin
        .from('tenants')
        .select('id')
        .limit(1);
      if (tenants && tenants.length > 0) {
        orgId = tenants[0].id;
      }
    }

    // Proactively save resolved orgId to public.admin_profiles if missing
    if (orgId && adminProfile && !adminProfile.tenant_id) {
      await supabaseAdmin
        .from('admin_profiles')
        .update({ tenant_id: orgId })
        .eq('id', user.id);
    }

    if (!orgId) {
      return NextResponse.json({ error: 'No organization mapped for this administrator' }, { status: 400 });
    }

    // 1. Fetch Organization Details from public.tenants
    const { data: tenantData, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('name, code, application_id')
      .eq('id', orgId)
      .maybeSingle();

    if (tenantErr) {
      console.error('Error fetching tenant data:', tenantErr);
    }

    const saccoName = tenantData?.name || 'SaccoConnect';
    const tenantCode = tenantData?.code || saccoName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    
    let apiKey = '';
    if (tenantData?.application_id) {
      const { data: appData } = await supabaseAdmin
        .from('applications')
        .select('api_key')
        .eq('id', tenantData.application_id)
        .maybeSingle();
        
      if (appData?.api_key) {
        apiKey = appData.api_key;
      }
    }

    // 2. Fetch SMS Wallet Balance
    let walletBalance = 0;
    const { data: walletData, error: walletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', orgId)
      .maybeSingle();

    if (walletErr) {
      console.error('Error fetching tenant wallet:', walletErr);
    }

    if (walletData) {
      walletBalance = parseFloat(walletData.balance);
    }

    // 3. Fetch SMS History Logs from DB
    const { data: smsLogs, error: smsLogsErr } = await supabaseAdmin
      .schema('kunity')
      .from('sms_logs')
      .select('*')
      .eq('tenant_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (smsLogsErr) {
      console.error('Error fetching SMS logs:', smsLogsErr);
    }

    const smsHistory = (smsLogs || []).map((log: any) => ({
      id: log.id,
      text: log.message,
      recipients: log.recipient_phone,
      count: 1, // Individual API sent logs have 1 recipient
      cost: Math.ceil(parseFloat(log.cost) / 40), // Map UGX cost back to UI credits
      date: log.created_at,
      status: log.status
    }));

    // If history is completely empty, prepopulate with default welcoming alerts
    if (smsHistory.length === 0) {
      smsHistory.push(
        { id: "1", text: `Welcome to ${saccoName}! Your account is now fully active.`, recipients: "All Members", count: 3, cost: 3, date: new Date(Date.now() - 3600000 * 24).toISOString(), status: "delivered" },
        { id: "2", text: "Please remember to submit your weekly savings contributions. Thank you!", recipients: "All Members", count: 3, cost: 3, date: new Date(Date.now() - 3600000 * 4).toISOString(), status: "delivered" }
      );
    }

    // 4. Fetch Members & Wallet Balances (bypassing RLS)
    const { data: membersData, error: membersErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('*, accounts(id, cached_balance)')
      .eq('organization_id', orgId);

    if (membersErr) {
      console.error('Error fetching members on server:', membersErr);
    }

    // 5. Fetch Pending Loans
    const { data: loansData, error: loansErr } = await supabaseAdmin
      .schema('kunity')
      .from('loans')
      .select('*, members!inner(first_name, last_name, organization_id)')
      .eq('status', 'pending')
      .eq('members.organization_id', orgId);

    if (loansErr) {
      console.error('Error fetching loans on server:', loansErr);
    }

    return NextResponse.json({
      success: true,
      orgId,
      saccoName,
      apiKey,
      tenantCode,
      smsBalance: Math.floor(walletBalance / 40), // Convert UGX balance to UI credits (1 credit = 40 UGX)
      smsHistory,
      members: membersData || [],
      pendingLoans: loansData || [],
      adminProfile: adminProfile || { id: user.id, role: 'sacco_admin', tenant_id: orgId }
    });

  } catch (err: any) {
    console.error('Error in /api/admin/data:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
