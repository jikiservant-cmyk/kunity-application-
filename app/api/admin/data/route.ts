import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { extractBearerToken } from '@/lib/request-guard';
import { adminDataLimiter } from '@/lib/rate-limit';
import { isElevatedAdminRole, isGlobalAdminRole } from '@/lib/roles';

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

    const body = await req.json().catch(() => ({}));
    const { selectedOrgId } = body;

    // SECURITY: Session token must come from the Authorization Bearer header.
    // It must NEVER be accepted from the JSON body, which risks token leakage
    // through request logging and APM traces.
    const token = extractBearerToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing Bearer token' }, { status: 401 });
    }

    // Verify token using admin client
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // Rate limit admin console requests per administrator
    try {
      await adminDataLimiter.check(60, `admin:data:${user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for admin console requests' }, { status: 429 });
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

    // SECURITY: The role is read exclusively from the server-controlled
    // admin_profiles table. user_metadata is client-writable and must never
    // be consulted for authorization.
    const role = adminProfile?.role || 'member';
    if (!isElevatedAdminRole(role)) {
      return NextResponse.json({ error: 'Forbidden: User is not an admin' }, { status: 403 });
    }
    const isGlobalAdmin = isGlobalAdminRole(role);

    // Fetch all available SACCO tenant organizations
    const { data: allOrgs } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name, code, primary_color, currency, is_active')
      .order('name', { ascending: true });

    const validOrgIds = new Set((allOrgs || []).map((o: any) => o.id));

    // Determine the logged-in user's assigned SACCO tenant organization.
    //
    // SECURITY (tenant-binding integrity):
    // Tenant resolution uses ONLY server-authoritative sources, in strict
    // priority order:
    //   1. public.admin_profiles.tenant_id  (service-role managed)
    //   2. kunity.members.organization_id    (service-role managed)
    //   3. kunity.organizations.created_by   (service-role managed)
    //
    // user_metadata (tenant_id / org_id / organization_id) is deliberately
    // NOT consulted: any authenticated user can freely overwrite their own
    // user_metadata via supabase.auth.updateUser(), so trusting it here
    // allowed a tenant admin to re-bind themselves to a foreign SACCO —
    // and the previous auto-persist wrote that forged binding back into
    // admin_profiles, poisoning every other admin endpoint.
    let orgId: string | undefined = undefined;

    // 1. Authoritative: admin_profiles.tenant_id
    if (adminProfile?.tenant_id && (validOrgIds.size === 0 || validOrgIds.has(adminProfile.tenant_id))) {
      orgId = adminProfile.tenant_id;
    }

    // 2. The admin's own member record, if one exists
    if (!orgId) {
      const { data: adminMember } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('organization_id')
        .eq('id', user.id)
        .maybeSingle();

      if (adminMember?.organization_id && (validOrgIds.size === 0 || validOrgIds.has(adminMember.organization_id))) {
        orgId = adminMember.organization_id;
      }
    }

    // 3. An organization the admin personally created (service-role managed)
    if (!orgId) {
      const { data: ownedOrg } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id')
        .eq('created_by', user.id)
        .maybeSingle();
      if (ownedOrg?.id) {
        orgId = ownedOrg.id;
      }
    }

    // Global admins may explicitly select which tenant to inspect.
    if (!orgId && isGlobalAdmin && selectedOrgId && validOrgIds.has(selectedOrgId)) {
      orgId = selectedOrgId;
    }

    // Fail closed if no authoritative tenant mapping exists.
    if (!orgId) {
      return NextResponse.json({ error: 'No organization mapped for this administrator' }, { status: 403 });
    }

    // SECURITY: Do NOT persist the resolved tenant anywhere from this read
    // endpoint. admin_profiles.tenant_id and user metadata are only ever
    // mutated through explicit, audited administrative flows.

    // 1. Fetch Organization Details from kunity.organizations & public.tenants
    const { data: kunityOrg } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('*')
      .eq('id', orgId)
      .maybeSingle();

    const { data: tenantData } = await supabaseAdmin
      .from('tenants')
      .select('name, code, application_id')
      .eq('id', orgId)
      .maybeSingle();

    const saccoName = kunityOrg?.name || tenantData?.name || 'SaccoConnect';
    const tenantCode = kunityOrg?.code || tenantData?.code || saccoName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    
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

    // 2. Fetch SMS Wallet Balance from Sacco Wallets (public.wallets)
    let walletBalance = 0;
    let smsRate = 50;
    const { data: walletData, error: walletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', orgId)
      .maybeSingle();

    if (!walletData && !walletErr) {
      const { data: newWallet } = await supabaseAdmin
        .schema('public').from('wallets')
        .insert({
          tenant_id: orgId,
          balance: 0.00,
          sms_rate: 50.00
        })
        .select('*')
        .maybeSingle();
      
      if (newWallet) {
        walletBalance = parseFloat(newWallet.balance);
        smsRate = parseFloat(newWallet.sms_rate || 50);
      }
    } else if (walletData) {
      walletBalance = parseFloat(walletData.balance);
      smsRate = parseFloat(walletData.sms_rate || 50);
    }

    // 3. Fetch SMS History Logs from DB for this tenant
    const { data: smsLogs } = await supabaseAdmin
      .schema('public')
      .from('sms_messages')
      .select('*')
      .eq('tenant_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50);

    const smsHistory = (smsLogs || []).map((log: any) => ({
      id: log.id,
      text: log.compiled_message || log.message,
      recipients: log.phone_number || log.recipient_phone,
      count: 1,
      cost: Math.ceil(parseFloat(log.cost || '50') / smsRate),
      date: log.created_at,
      status: log.status
    }));

    // 4. Fetch Members & Wallet Balances STRICTLY SCOPED to this organization
    const { data: membersData, error: membersErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('*, accounts(id, cached_balance, is_active, code, name)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (membersErr) {
      console.error('Error fetching tenant-scoped members:', membersErr);
    }

    const membersList = membersData || [];

    // Calculate tenant-scoped member statistics
    const totalMembers = membersList.length;
    const activeMembers = membersList.filter(m => m.status === 'active').length;
    const pendingMembers = membersList.filter(m => m.status === 'pending' || m.status === 'pending_approval' || !m.status).length;
    const suspendedMembers = membersList.filter(m => m.status === 'suspended').length;
    const rejectedMembers = membersList.filter(m => m.status === 'rejected').length;

    // Calculate total liquidity from members' accounts inside this tenant
    const totalLiquidity = membersList.reduce((acc: number, m: any) => 
      acc + (m.accounts ? m.accounts.reduce((sum: number, a: any) => sum + parseFloat(a.cached_balance || '0'), 0) : 0), 0
    );

    // 5. Fetch All Loans (pending, active, approved, completed, defaulted) for this tenant
    const { data: allTenantLoans } = await supabaseAdmin
      .schema('kunity')
      .from('loans')
      .select('*, members!inner(first_name, last_name, phone, organization_id)')
      .eq('members.organization_id', orgId)
      .order('created_at', { ascending: false });

    const tenantLoans = allTenantLoans || [];
    const pendingLoans = tenantLoans.filter(l => l.status === 'pending');
    const activeLoans = tenantLoans.filter(l => l.status === 'active' || l.status === 'approved' || l.status === 'disbursed');
    const completedLoans = tenantLoans.filter(l => l.status === 'completed');

    const totalLoansRequestedAmount = tenantLoans.reduce((sum, l) => sum + parseFloat(l.principal || '0'), 0);
    const totalLoansDisbursedAmount = activeLoans.concat(completedLoans).reduce((sum, l) => sum + parseFloat(l.principal || '0'), 0);
    const pendingLoansAmount = pendingLoans.reduce((sum, l) => sum + parseFloat(l.principal || '0'), 0);

    // 6. Fetch Savings Products for this tenant
    const { data: savingsProducts } = await supabaseAdmin
      .schema('kunity')
      .from('savings_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('is_active', true);

    // 7. Fetch Sacco Institutional Wallet from kunity.sacco_wallets
    let saccoWalletBalance = 0;
    const { data: kunityWalletData } = await supabaseAdmin
      .schema('kunity')
      .from('sacco_wallets')
      .select('balance')
      .eq('organization_id', orgId)
      .maybeSingle();
      
    if (kunityWalletData) {
      saccoWalletBalance = parseFloat(kunityWalletData.balance || '0');
    }

    // 8. Fetch Recent Transactions / Journal Lines for this tenant
    const { data: recentJournalLines } = await supabaseAdmin
      .schema('kunity')
      .from('journal_lines')
      .select('*, journal_entries!inner(description, organization_id), members(first_name, last_name)')
      .eq('journal_entries.organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(30);

    const transactions = (recentJournalLines || []).map((jl: any) => ({
      id: jl.id,
      description: jl.journal_entries?.description || jl.line_type || 'Transaction',
      type: jl.line_type,
      amount: parseFloat(jl.debit || jl.credit || '0'),
      memberName: jl.members ? `${jl.members.first_name} ${jl.members.last_name || ''}`.trim() : 'Cooperative Vault',
      createdAt: jl.created_at
    }));

    // Calculate total deposits and withdrawal volumes
    const totalDepositsVolume = (recentJournalLines || [])
      .filter((jl: any) => jl.line_type === 'deposit')
      .reduce((sum: number, jl: any) => sum + parseFloat(jl.credit || jl.debit || '0'), 0);

    return NextResponse.json({
      success: true,
      orgId,
      saccoName,
      tenantCode,
      apiKey,
      allOrganizations: allOrgs || [],
      currentOrganization: kunityOrg || { id: orgId, name: saccoName, code: tenantCode },
      stats: {
        totalMembers,
        activeMembers,
        pendingMembers,
        suspendedMembers,
        rejectedMembers,
        totalLiquidity,
        avgSavingsPerMember: totalMembers > 0 ? Math.round(totalLiquidity / totalMembers) : 0,
        totalLoansRequestedAmount,
        totalLoansDisbursedAmount,
        pendingLoansAmount,
        pendingLoansCount: pendingLoans.length,
        activeLoansCount: activeLoans.length,
        completedLoansCount: completedLoans.length,
        totalLoansCount: tenantLoans.length,
        saccoWalletBalance,
        totalDepositsVolume
      },
      members: membersList,
      pendingLoans,
      allLoans: tenantLoans,
      savingsProducts: savingsProducts || [],
      recentTransactions: transactions,
      smsBalance: Math.floor(walletBalance / smsRate),
      smsRate,
      smsHistory,
      adminProfile: adminProfile || { full_name: user.email?.split('@')[0] || 'Administrator', role: 'sacco_admin' }
    });

  } catch (err: any) {
    console.error('Error in /api/admin/data:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
