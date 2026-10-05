import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { smsSendLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';

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
    const { token, recipientType, message, organizationId } = body;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Missing session token' }, { status: 401 });
    }

    if (!message || !message.trim()) {
      return NextResponse.json({ error: 'Message content cannot be empty' }, { status: 400 });
    }

    // 1. Verify Admin Authentication & Tenant Scope
    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Determine target tenant ID
    let tenantId = adminAuth.tenantId;
    if (adminAuth.isGlobalAdmin && organizationId) {
      // Validate that organizationId exists and is active
      const { data: orgRecord } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id, is_active')
        .eq('id', organizationId)
        .maybeSingle();

      if (!orgRecord || orgRecord.is_active === false) {
        return NextResponse.json({ error: 'Target organization does not exist or is inactive' }, { status: 400 });
      }
      tenantId = organizationId;
    }

    if (!tenantId) {
      return NextResponse.json({ error: 'Unauthorized: Admin profile is not associated with any SACCO tenant' }, { status: 400 });
    }

    // Rate limit SMS broadcast requests per admin
    try {
      await smsSendLimiter.check(20, `admin:sms:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for SMS broadcasts' }, { status: 429 });
    }

    // 2. Resolve list of recipient phone numbers with STRICT tenant isolation
    let recipients: { phone: string, firstName?: string, lastName?: string }[] = [];
    
    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      recipients = body.recipients.map((phone: string) => ({
        phone: typeof phone === 'string' ? phone : (phone as any).phone,
        firstName: 'Member'
      }));
    } else if (recipientType === 'all') {
      // Get all members strictly belonging to this SACCO organization
      const { data: members, error: mErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('phone, first_name, last_name')
        .eq('organization_id', tenantId);
      
      if (!mErr && members) {
        recipients = members.filter(m => m.phone).map(m => ({ phone: m.phone, firstName: m.first_name, lastName: m.last_name }));
      }
    } else if (recipientType === 'loans') {
      // Get members with pending loans strictly in this SACCO organization
      const { data: pendingLoans, error: lErr } = await supabaseAdmin
        .schema('kunity')
        .from('loans')
        .select('organization_id, members!inner(phone, first_name, last_name, organization_id)')
        .eq('status', 'pending')
        .eq('organization_id', tenantId);
      
      if (!lErr && pendingLoans) {
        recipients = pendingLoans
          .filter((l: any) => l.members?.phone && l.members?.organization_id === tenantId)
          .map((l: any) => ({ phone: l.members.phone, firstName: l.members.first_name, lastName: l.members.last_name }));
      }
    } else if (recipientType) {
      // It's a specific member ID or raw phone number
      if (recipientType.startsWith('07') || recipientType.startsWith('+256')) {
        recipients = [{ phone: recipientType, firstName: 'Member' }];
      } else {
        // Look up member strictly within admin's tenant
        const { data: member, error: mErr } = await supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('phone, first_name, last_name, organization_id')
          .eq('id', recipientType)
          .eq('organization_id', tenantId)
          .maybeSingle();
        
        if (mErr || !member) {
          return NextResponse.json(
            { error: 'Forbidden: Target member not found or belongs to another SACCO tenant' },
            { status: 404 }
          );
        }

        if (member.phone) {
          recipients = [{ phone: member.phone, firstName: member.first_name, lastName: member.last_name }];
        }
      }
    }

    // De-duplicate by phone
    const seen = new Set();
    recipients = recipients.filter(r => {
      if (!r.phone) return false;
      if (seen.has(r.phone)) return false;
      seen.add(r.phone);
      return true;
    });

    if (recipients.length === 0) {
      return NextResponse.json({ error: 'No valid recipients with phone numbers found for the selected audience.' }, { status: 400 });
    }

    // 3. Calculate message cost details
    const textLength = message.trim().length;
    let segments = 1;
    if (textLength > 160) {
      segments = Math.ceil(textLength / 153);
    }

    // 4. Fetch active wallet from public.wallets strictly scoped to tenant
    let wallet = null;
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!existingWallet && !fetchWalletErr) {
      const { data: newWallet, error: createWalletErr } = await supabaseAdmin
        .schema('public')
        .from('wallets')
        .insert({
          tenant_id: tenantId,
          balance: 0.00,
          sms_rate: 50.00
        })
        .select('*')
        .maybeSingle();

      if (createWalletErr) {
        // FIN-29: a concurrent request may have provisioned the wallet first
        // (unique tenant) — re-fetch instead of failing the broadcast.
        const { data: refetched } = await supabaseAdmin
          .schema('public')
          .from('wallets')
          .select('*')
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (!refetched) {
          return NextResponse.json({ error: 'Failed to auto-provision SACCO SMS wallet.' }, { status: 400 });
        }
        wallet = refetched;
      } else {
        wallet = newWallet;
      }
    } else {
      wallet = existingWallet;
    }

    if (!wallet) {
      return NextResponse.json({
        error: 'Wallet not found for this SACCO. Please contact support to provision a wallet.'
      }, { status: 400 });
    }

    // FIN-28: sanitize the SMS rate — a stored 0/negative/non-finite rate must
    // never make broadcasts free (or the cost math NaN).
    const parsedRate = parseFloat(String(wallet.sms_rate ?? ''));
    const costPerSms = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 50.00;

    const totalCost = segments * costPerSms * recipients.length;
    const currentBalance = parseFloat(wallet.balance);

    if (currentBalance < totalCost) {
      return NextResponse.json({
        error: `Insufficient funds in SMS wallet. This broadcast requires UGX ${totalCost.toLocaleString()} (${Math.ceil(totalCost/costPerSms)} credits) but your wallet has UGX ${currentBalance.toLocaleString()} (${Math.floor(currentBalance/costPerSms)} credits). Please top up first.`
      }, { status: 400 });
    }

    // 5. Queue SMS dispatches via Inngest
    const { inngest } = await import('@/lib/inngest/client');
    const events = recipients.map(recipient => ({
      name: 'sms/dispatch' as const,
      data: {
        tenantId,
        recipientPhone: recipient.phone,
        templateData: { first_name: recipient.firstName || '', last_name: recipient.lastName || '' },
        message,
        eventType: 'BROADCAST',
        originUrl: req.nextUrl.origin
      }
    }));

    for (let i = 0; i < events.length; i += 100) {
      const batch = events.slice(i, i + 100);
      await inngest.send(batch);
    }

    await logAudit(supabaseAdmin, {
      adminId: adminAuth.user.id,
      tenantId,
      action: 'sms_broadcast',
      entityType: 'sms_messages',
      newData: {
        recipientsCount: recipients.length,
        recipientType,
        totalCost,
      },
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return NextResponse.json({
      success: true,
      recipientsCount: recipients.length,
      costCredits: Math.ceil(totalCost / costPerSms),
      costUGX: totalCost,
      newBalanceCredits: Math.floor(currentBalance / costPerSms)
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('Error sending SMS broadcast on server:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
