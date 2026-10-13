import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { smsSendLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { smsSegments } from '@/lib/sms-segments';
import { claimIdempotencyKey, isValidIdempotencyKey } from '@/lib/sms-idempotency';
import { normalizeUgandanPhone } from '@/lib/validators';

// SECURITY (pentest 2026-10-13, messaging): limits on a single broadcast.
const MAX_BROADCAST_MESSAGE_CHARS = 1000;
const MAX_EXPLICIT_RECIPIENTS = 500;

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

    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json({ error: 'Message content cannot be empty' }, { status: 400 });
    }
    if (message.length > MAX_BROADCAST_MESSAGE_CHARS) {
      return NextResponse.json({ error: `Message is longer than ${MAX_BROADCAST_MESSAGE_CHARS} characters` }, { status: 400 });
    }
    // Optional client request ID: a double-click or retry must not broadcast twice.
    const requestId = body.requestId;
    if (requestId !== undefined && requestId !== null && !isValidIdempotencyKey(requestId)) {
      return NextResponse.json({ error: 'Invalid requestId' }, { status: 400 });
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
      // SECURITY (pentest 2026-10-13): explicit lists are capped.
      if (body.recipients.length > MAX_EXPLICIT_RECIPIENTS) {
        return NextResponse.json({ error: `At most ${MAX_EXPLICIT_RECIPIENTS} recipients per broadcast` }, { status: 400 });
      }
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
        // A raw number: must belong to a member of this SACCO (checked below).
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

    // SECURITY (pentest 2026-10-13): a SACCO admin may message only that SACCO's members.
    // Before this, any number typed into a broadcast was sent, at the SACCO's expense.
    {
      const memberPhones = new Set<string>();
      const pageSize = 1000;
      for (let from = 0; ; from += pageSize) {
        const { data: page, error: pageErr } = await supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('phone')
          .eq('organization_id', tenantId)
          .range(from, from + pageSize - 1);
        if (pageErr) {
          return NextResponse.json({ error: 'Could not verify recipients. Try again.' }, { status: 500 });
        }
        for (const m of page || []) {
          const n = normalizeUgandanPhone(m.phone);
          if (n.valid) memberPhones.add(n.phone);
        }
        if (!page || page.length < pageSize) break;
      }

      const outside: string[] = [];
      recipients = recipients.filter((r) => {
        const n = normalizeUgandanPhone(r.phone);
        if (!n.valid || !memberPhones.has(n.phone)) {
          outside.push(String(r.phone));
          return false;
        }
        return true;
      });
      if (outside.length > 0) {
        return NextResponse.json({
          error: `${outside.length} number(s) are not members of this SACCO, so they were not sent. Broadcasts go to members only.`
        }, { status: 400 });
      }
    }

    // 3. Calculate message cost details
    // SECURITY (pentest 2026-10-13): real GSM-7 / UCS-2 segment count.
    const segments = smsSegments(message.trim());

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
    // Claim the request ID before anything is queued. A repeat is refused, nothing is sent.
    if (requestId) {
      const claim = await claimIdempotencyKey(supabaseAdmin, `broadcast:${tenantId}`, requestId);
      if (claim.error) {
        return NextResponse.json({ error: 'Could not record the broadcast. Try again.' }, { status: 500 });
      }
      if (!claim.claimed) {
        return NextResponse.json({ error: 'This broadcast was already sent. Nothing was sent again.' }, { status: 409 });
      }
    }

    const { inngest } = await import('@/lib/inngest/client');
    const events = recipients.map(recipient => ({
      // Inngest drops a repeated event id, so a retried queue step cannot dispatch twice.
      ...(requestId ? { id: `broadcast-${requestId}-${normalizeUgandanPhone(recipient.phone).phone}` } : {}),
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
      try {
        await inngest.send(batch);
      } catch (queueErr) {
        // Earlier batches may already be queued, so the request ID stays claimed.
        console.error('[sms-broadcast] queueing failed:', queueErr);
        return NextResponse.json({
          error: 'The broadcast could not be fully queued. Some messages may already have been sent. Check the SMS log before trying again.'
        }, { status: 502 });
      }
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
        requestId: requestId || null,
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
