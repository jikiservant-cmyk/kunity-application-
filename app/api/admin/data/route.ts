import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { apiLimiter } from '@/lib/rate-limit';

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
    const { token, selectedOrgId } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }

    // 1. Cryptographically verify the session token AND the admin role.
    // verifyAdminAndTenant reads the caller's role strictly from the
    // server-side public.admin_profiles table.
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Rate limit admin console data requests per administrator
    try {
      await apiLimiter.check(60, `admin:data:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many requests. Please slow down.' }, { status: 429 });
    }

    // 2. SECURITY: Resolve the administrator's tenant from SERVER-AUTHORITATIVE
    // sources only. user_metadata is client-writable (any authenticated user can
    // call supabase.auth.updateUser) and must NEVER be trusted for tenant binding.
    // Resolution order:
    //   a) Global admins (super_admin/system_admin) may explicitly scope to any
    //      active organization via selectedOrgId.
    //   b) The caller's authoritative public.admin_profiles.tenant_id.
    //   c) First-time onboarding fallback (only when tenant_id is NULL): the
    //      caller's own kunity.members row, or an organization they created.
    let orgId: string | undefined = undefined;

    if (adminAuth.isGlobalAdmin && selectedOrgId) {
      const { data: targetOrg, error: targetOrgErr } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id, is_active')
        .eq('id', selectedOrgId)
        .maybeSingle();

      if (targetOrgErr || !targetOrg) {
        return NextResponse.json({ error: 'Target organization not found' }, { status: 404 });
      }
      if (targetOrg.is_active === false) {
        return NextResponse.json({ error: 'Target organization is inactive' }, { status: 403 });
      }
      orgId = selectedOrgId;
    }

    if (!orgId && adminAuth.tenantId) {
      orgId = adminAuth.tenantId;
    }

    // Onboarding fallback: only fill a missing tenant binding, and only from
    // server-side records (never from client-writable auth metadata).
    if (!orgId) {
      // a) An organization this administrator founded/created. This is a
      //    SERVER-ASSIGNED signal (org creation is restricted to platform
      //    operators), so it takes priority over self-service records.
      const { data: ownedOrg } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id')
        .eq('created_by', adminAuth.user.id)
        .maybeSingle();
      if (ownedOrg?.id) {
        orgId = ownedOrg.id;
      }

      // b) The caller's own APPROVED member record. Self-service signup lets a
      //    user register into any active SACCO, so a pending/rejected member
      //    row must never be trusted to bind an administrator's tenant — only
      //    a membership the target organization actually approved counts.
      if (!orgId) {
        const { data: adminMember } = await supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('organization_id, status')
          .eq('id', adminAuth.user.id)
          .maybeSingle();

        if (adminMember?.organization_id && adminMember.status === 'active') {
          orgId = adminMember.organization_id;
        }
      }

      // Persist the resolved tenant binding ONLY if it was previously unset.
      // Never overwrite an existing binding from this route.
      if (orgId) {
        await supabaseAdmin
          .from('admin_profiles')
          .update({ tenant_id: orgId })
          .eq('id', adminAuth.user.id)
          .is('tenant_id', null);
      }
    }

    // Tenant admins may not probe foreign organizations via selectedOrgId.
    if (!adminAuth.isGlobalAdmin && selectedOrgId && selectedOrgId !== orgId) {
      return NextResponse.json(
        { error: 'Forbidden: Cross-tenant organization access is prohibited' },
        { status: 403 }
      );
    }

    // Fail closed if no tenant could be resolved from authoritative sources.
    if (!orgId) {
      return NextResponse.json({ error: 'No organization mapped for this administrator' }, { status: 403 });
    }

    // Fetch admin profile (full row) for the response payload
    const { data: adminProfile } = await supabaseAdmin
      .from('admin_profiles')
      .select('*')
      .eq('id', adminAuth.user.id)
      .maybeSingle();

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

    let membersList = membersData || [];

    // 4b. Activation-fee evidence for pending applicants. The admin approval
    // queue needs to show WHO HAS PAID before letting them in, so attach each
    // pending member's newest successful account_activation payment
    // (amount, when, provider reference) — no new tables required.
    const pendingMemberIds = membersList
      .filter((m: any) => m.status === 'pending' || m.status === 'pending_approval' || !m.status)
      .map((m: any) => m.id);

    if (pendingMemberIds.length > 0) {
      const { data: activationPayments } = await supabaseAdmin
        .schema('kunity')
        .from('payment_requests')
        .select('member_id, amount, internal_reference, provider, created_at')
        .in('member_id', pendingMemberIds)
        .eq('status', 'success')
        .or('payment_type.eq.account_activation,internal_reference.like.PAY-ACT-%')
        .order('created_at', { ascending: false });

      const latestByMember = new Map<string, any>();
      for (const p of activationPayments || []) {
        if (!latestByMember.has(p.member_id)) {
          latestByMember.set(p.member_id, {
            amount: parseFloat(p.amount || '0'),
            paid_at: p.created_at,
            reference: p.internal_reference || null,
            provider: p.provider || null,
          });
        }
      }

      membersList = membersList.map((m: any) => ({
        ...m,
        activation_payment: latestByMember.get(m.id) || null,
      }));
    }

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

    // SECURITY: The full organization directory is only exposed to global
    // administrators (super_admin/system_admin). Tenant admins are locked to
    // their own organization and must not be able to enumerate other SACCOs.
    let allOrgs: any[] = [];
    if (adminAuth.isGlobalAdmin) {
      const { data: allOrgsData } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id, name, code, primary_color, currency, is_active')
        .order('name', { ascending: true });
      allOrgs = allOrgsData || [];
    }

    return NextResponse.json({
      success: true,
      orgId,
      saccoName,
      tenantCode,
      apiKey,
      allOrganizations: allOrgs,
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
      adminProfile: adminProfile || { full_name: adminAuth.user.email?.split('@')[0] || 'Administrator', role: 'sacco_admin' }
    });

  } catch (err: any) {
    console.error('Error in /api/admin/data:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
