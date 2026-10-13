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

    // 2. Resolve recipients. Member audiences are read from the database here, with paging,
    //    so every member's number is included (PostgREST returns at most 1000 rows per query).
    //    The browser never supplies the member list for these audiences.
    const pageAll = async (fetchPage: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>) => {
      const rows: any[] = [];
      const pageSize = 1000;
      const maxPages = 500; // 500,000 rows: a safety stop, far above any SACCO
      for (let page = 0; page < maxPages; page++) {
        const from = page * pageSize;
        const { data, error } = await fetchPage(from, from + pageSize - 1);
        if (error) return { rows: [] as any[], error };
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
      }
      return { rows, error: null as any };
    };

    type RawRecipient = { phone: unknown; firstName?: string; lastName?: string };
    let rawRecipients: RawRecipient[] = [];
    let fromDatabase = false;
    let explicitList = false;

    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      // Explicit numbers typed by the admin: capped, and every number must be valid.
      if (body.recipients.length > MAX_EXPLICIT_RECIPIENTS) {
        return NextResponse.json({ error: `At most ${MAX_EXPLICIT_RECIPIENTS} recipients per broadcast` }, { status: 400 });
      }
      explicitList = true;
      rawRecipients = body.recipients.map((phone: any) => ({
        phone: typeof phone === 'string' ? phone : phone?.phone,
        firstName: 'Member'
      }));
    } else if (recipientType === 'all') {
      const { rows, error } = await pageAll((from, to) =>
        supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('id, phone, first_name, last_name')
          .eq('organization_id', tenantId)
          .order('id')
          .range(from, to)
      );
      if (error) {
        return NextResponse.json({ error: 'Could not load the member list. Try again.' }, { status: 500 });
      }
      fromDatabase = true;
      rawRecipients = rows.map(m => ({ phone: m.phone, firstName: m.first_name, lastName: m.last_name }));
    } else if (recipientType === 'loans') {
      const { rows, error } = await pageAll((from, to) =>
        supabaseAdmin
          .schema('kunity')
          .from('loans')
          .select('id, organization_id, members!inner(phone, first_name, last_name, organization_id)')
          .eq('status', 'pending')
          .eq('organization_id', tenantId)
          .order('id')
          .range(from, to)
      );
      if (error) {
        return NextResponse.json({ error: 'Could not load borrowers. Try again.' }, { status: 500 });
      }
      fromDatabase = true;
      rawRecipients = rows
        .filter((l: any) => l.members?.organization_id === tenantId)
        .map((l: any) => ({ phone: l.members.phone, firstName: l.members.first_name, lastName: l.members.last_name }));
    } else if (recipientType) {
      if (recipientType.startsWith('07') || recipientType.startsWith('+256')) {
        // A raw number: must belong to a member of this SACCO (checked below).
        rawRecipients = [{ phone: recipientType, firstName: 'Member' }];
      } else {
        // A member ID: looked up strictly within the admin's tenant.
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
        rawRecipients = member.phone
          ? [{ phone: member.phone, firstName: member.first_name, lastName: member.last_name }]
          : [];
      }
    }

    // Normalise every number to one format (E.164) and remove duplicates on that value, so the
    // same person listed as 0772… and +256772… receives one SMS.
    const invalidEntries: string[] = [];
    const byPhone = new Map<string, { phone: string; firstName?: string; lastName?: string }>();
    for (const r of rawRecipients) {
      if (r.phone === undefined || r.phone === null || r.phone === '') continue;
      const n = normalizeUgandanPhone(r.phone);
      if (!n.valid) {
        invalidEntries.push(String(r.phone));
        continue;
      }
      if (!byPhone.has(n.phone)) {
        byPhone.set(n.phone, { phone: n.phone, firstName: r.firstName, lastName: r.lastName });
      }
    }

    // Explicit lists must be fully valid. Member records with bad numbers are skipped and counted.
    if (explicitList && invalidEntries.length > 0) {
      return NextResponse.json({
        error: `These numbers are not valid Ugandan mobile numbers: ${invalidEntries.slice(0, 10).join(', ')}${invalidEntries.length > 10 ? ' …' : ''}`
      }, { status: 400 });
    }
    const skippedInvalid = fromDatabase ? invalidEntries.length : 0;

    let recipients = Array.from(byPhone.values());

    if (recipients.length === 0) {
      return NextResponse.json({
        error: 'No valid recipients with phone numbers found for the selected audience.'
      }, { status: 400 });
    }

    // SECURITY (pentest 2026-10-13): a SACCO admin may message only that SACCO's members.
    // Member audiences are members by construction, so only typed numbers are checked here.
    if (!fromDatabase) {
      const memberPhones = new Set<string>();
      const { rows: memberRows, error: memberErr } = await pageAll((from, to) =>
        supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('id, phone')
          .eq('organization_id', tenantId)
          .order('id')
          .range(from, to)
      );
      if (memberErr) {
        return NextResponse.json({ error: 'Could not verify recipients. Try again.' }, { status: 500 });
      }
      for (const m of memberRows) {
        const n = normalizeUgandanPhone(m.phone);
        if (n.valid) memberPhones.add(n.phone);
      }

      const outside = recipients.filter(r => !memberPhones.has(r.phone));
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
      skippedInvalid,
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
