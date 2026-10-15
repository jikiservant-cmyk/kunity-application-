import crypto from 'crypto';
import { hashApiKey } from '@/lib/api-keys';
import { smsSegments } from '@/lib/sms-segments';
import { claimIdempotencyKey, isValidIdempotencyKey } from '@/lib/sms-idempotency';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { messagingLimiter } from '@/lib/rate-limit';

// API-key SMS gateway. Sends through NaJiki (POST /api/messaging/send); NaJiki owns the
// Africa's Talking dispatch and the sms_messages log.

const MAX_RECIPIENTS = 100;
const MAX_MESSAGE_CHARS = 1000;
const SENDER_ID_PATTERN = /^[A-Za-z0-9]{3,11}$/;
const E164_PATTERN = /^\+\d{9,15}$/;
const EVENT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;




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

    // 1. Identity & Tenant Resolution
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json({ error: 'Unauthorized: Missing or invalid Authorization Bearer token' }, { status: 401 });
    }
    const apiKey = authHeader.split(' ')[1];

    // Retrieve application mapping based on API Key
    const { data: app, error: appErr } = await supabaseAdmin
      .from('applications')
      .select('id, name')
      // SECURITY (pentest 2026-10-13): keys are stored as SHA-256 digests only.
      .eq('api_key_hash', hashApiKey(apiKey))
      .maybeSingle();

    if (appErr || !app) {
      return NextResponse.json({ error: 'Unauthorized: Invalid API Key' }, { status: 401 });
    }

    // Rate limit per application
    try {
      await messagingLimiter.check(60, `msg:app:${app.id}`);
    } catch {
      return NextResponse.json({ error: 'Rate limit exceeded for SMS messaging gateway' }, { status: 429 });
    }

    // Parse Request Payload
    const body = await req.json();
    const { to, message, tenantCode, eventCode, eventType, from } = body;
    const finalEventCode = eventCode || eventType;

    // SECURITY (pentest 2026-10-13, messaging): optional request key. A retry with the same key
    // is refused instead of being sent and billed again.
    const idempotencyKeyHeader = req.headers.get('idempotency-key');
    if (idempotencyKeyHeader !== null && !isValidIdempotencyKey(idempotencyKeyHeader)) {
      return NextResponse.json({ error: 'Bad Request: Idempotency-Key must be 8-100 characters of A-Z, a-z, 0-9, _ or -' }, { status: 400 });
    }

    if (finalEventCode !== undefined && finalEventCode !== null
      && (typeof finalEventCode !== 'string' || !EVENT_CODE_PATTERN.test(finalEventCode))) {
      return NextResponse.json({ error: 'Bad Request: "eventCode" must be 1-50 letters, digits, _ or -' }, { status: 400 });
    }

    if (!to || !message) {
      return NextResponse.json({ error: 'Bad Request: "to" and "message" are required' }, { status: 400 });
    }

    // SECURITY: validate the payload shape before any billing or provider call.
    if (typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Bad Request: "message" must be a non-empty string' }, { status: 400 });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json({ error: `Bad Request: "message" exceeds ${MAX_MESSAGE_CHARS} characters` }, { status: 400 });
    }
    if (from !== undefined && from !== null && (typeof from !== 'string' || !SENDER_ID_PATTERN.test(from))) {
      return NextResponse.json({ error: 'Bad Request: "from" must be 3-11 alphanumeric characters' }, { status: 400 });
    }

    // FIN-37: tenantCode is REQUIRED. Without it the message had no tenant to
    // bill, so any application key could send SMS at the platform's expense.
    if (!tenantCode || typeof tenantCode !== 'string') {
      return NextResponse.json({ error: 'Bad Request: "tenantCode" is required' }, { status: 400 });
    }

    const { data: t, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('id, name, is_active')
      .eq('code', tenantCode)
      .eq('application_id', app.id)
      .maybeSingle();

    if (tenantErr || !t) {
      return NextResponse.json({ error: 'Not Found: Invalid tenantCode for this application' }, { status: 404 });
    }
    if (!t.is_active) {
      return NextResponse.json({ error: 'Forbidden: Tenant is not active' }, { status: 403 });
    }
    const tenant = t;

    // 2. Format & Sanitize Phone Numbers
    const numbers = Array.isArray(to) ? to : [to];
    if (numbers.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: `Bad Request: at most ${MAX_RECIPIENTS} recipients per request` }, { status: 400 });
    }
    const normalizedNumbers = numbers.map((n: string) => {
      let clean = String(n).replace(/[^\d+]/g, '');
      // If starts with 07 or 03 (Uganda standard local), replace with +256
      if (clean.startsWith('0') && clean.length === 10) {
        clean = '+256' + clean.slice(1);
      } else if (!clean.startsWith('+') && clean.length >= 9) {
        clean = '+' + clean;
      } else if (/^(256|254|255)\d+$/.test(clean)) {
        clean = '+' + clean;
      }
      return clean;
    });

    if (normalizedNumbers.length === 0) {
      return NextResponse.json({ error: 'No valid phone numbers provided' }, { status: 400 });
    }
    // SECURITY: reject malformed numbers up front so the tenant is never billed for them.
    if (!normalizedNumbers.every((n: string) => E164_PATTERN.test(n))) {
      return NextResponse.json({ error: 'Bad Request: one or more phone numbers are invalid' }, { status: 400 });
    }

    // 3. SMS dispatch goes through NaJiki, the only SMS path (see lib/sms.ts).
    //    NaJiki queues each message and answers 202 with its smsId. A later delivery failure
    //    arrives as an SMS_DELIVERY_UPDATE webhook, which refunds that recipient's charge.
    const najikiUrl = process.env.NAJIKI_API_URL;
    const najikiKey = process.env.NAJIKI_API_KEY;
    const najikiAppCode = process.env.NAJIKI_APPLICATION_CODE || 'sacco';
    if (!najikiUrl || !najikiKey) {
      console.error('[messaging] NaJiki is not configured (NAJIKI_API_URL / NAJIKI_API_KEY). Request rejected (fail-closed).');
      return NextResponse.json({ error: 'SMS service unavailable: NaJiki gateway is not configured on server' }, { status: 503 });
    }
    const najikiBase = najikiUrl.replace(/\/+$/, '');

    // FIN-37: bill the tenant's SMS wallet BEFORE dispatch (same rate rules as lib/sms.ts).
    // SECURITY (pentest 2026-10-13): count real segments (GSM-7 or UCS-2), not a fixed 160.
    const segments = smsSegments(message.trim());
    const { data: wallet } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('id, balance, sms_rate')
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (!wallet) {
      return NextResponse.json({ error: 'SMS wallet not found for this tenant' }, { status: 402 });
    }
    const parsedRate = parseFloat(String(wallet.sms_rate ?? ''));
    const costPerSms = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 50.0;
    const perSmsCost = segments * costPerSms;
    const totalCost = perSmsCost * normalizedNumbers.length;
    if (parseFloat(String(wallet.balance)) < totalCost) {
      return NextResponse.json({ error: 'Insufficient SMS wallet balance' }, { status: 402 });
    }

    // Claim the request key before anything is billed or sent.
    const idemScope = `api:${app.id}`;
    if (idempotencyKeyHeader !== null) {
      const claim = await claimIdempotencyKey(supabaseAdmin, idemScope, idempotencyKeyHeader);
      if (claim.error) {
        return NextResponse.json({ error: 'Could not record the request. Try again.' }, { status: 500 });
      }
      if (!claim.claimed) {
        return NextResponse.json({ error: 'Duplicate request: this Idempotency-Key was already used. Nothing was sent.' }, { status: 409 });
      }
    }

    const releaseClaim = async () => {
      if (idempotencyKeyHeader === null) return;
      await supabaseAdmin.schema('public').from('sms_idempotency_keys')
        .delete().eq('scope', idemScope).eq('idem_key', idempotencyKeyHeader);
    };

    // One debit and one NaJiki request per recipient, so a later failure refunds exactly one share.
    const requestId = crypto.randomUUID();
    type Outcome = { number: string; status: 'queued' | 'rejected' | 'unconfirmed' | 'not_sent'; smsId?: string; reference?: string; deduplicated?: boolean; error?: string };
    const outcomes: Outcome[] = [];

    for (let i = 0; i < normalizedNumbers.length; i++) {
      const number = normalizedNumbers[i];
      const debitKey = `api_${requestId}_${i}`;

      const { error: debitErr } = await supabaseAdmin.rpc('debit_sms_wallet', {
        p_wallet_id: wallet.id,
        p_amount: perSmsCost,
        p_idempotency_key: debitKey,
        p_tenant_id: tenant.id,
        p_description: `API SMS dispatch to ${number}`,
      });
      if (debitErr) {
        // Nothing is charged or sent for this recipient or any after it.
        console.error('[messaging] wallet debit failed:', debitErr);
        for (let j = i; j < normalizedNumbers.length; j++) {
          outcomes.push({ number: normalizedNumbers[j], status: 'not_sent', error: 'Insufficient SMS wallet balance' });
        }
        break;
      }

      // Stable per-recipient key: a retry of the same request maps to the same NaJiki message.
      const najikiIdem = idempotencyKeyHeader !== null ? `${idempotencyKeyHeader}-${i}` : `api-${debitKey}`;
      let resp: Response | null = null;
      try {
        resp = await fetch(`${najikiBase}/api/messaging/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${najikiKey}`,
            'Idempotency-Key': najikiIdem,
          },
          body: JSON.stringify({
            applicationCode: najikiAppCode,
            to: number,
            message,
            idempotencyKey: najikiIdem,
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        resp = null;
      }

      if (resp && resp.ok) {
        const data: any = await resp.json().catch(() => ({}));
        const smsId = data?.smsId ? String(data.smsId) : undefined;
        if (smsId) {
          // Record NaJiki's id on this debit, so a later SMS_DELIVERY_UPDATE 'failed' can find it.
          const { error: linkErr } = await supabaseAdmin
            .schema('public')
            .from('wallet_transactions')
            .update({ description: `najiki_sms:${smsId}` })
            .eq('reference', debitKey)
            .eq('direction', 'debit');
          if (linkErr) console.error('[messaging] could not link SMS to its debit, failure refunds need manual review:', linkErr, { smsId, debitKey });
        }
        outcomes.push({ number, status: 'queued', smsId, reference: data?.reference, deduplicated: !!data?.deduplicated });
      } else if (resp && resp.status >= 400 && resp.status < 500) {
        // NaJiki refused this message outright, so it was never sent. Refund this recipient.
        const { error: refundErr } = await supabaseAdmin.rpc('refund_sms_wallet', {
          p_wallet_id: wallet.id,
          p_amount: perSmsCost,
          p_reference: `refund_${debitKey}`,
        });
        if (refundErr) console.error('[messaging] refund failed, needs manual review:', refundErr);
        outcomes.push({ number, status: 'rejected', error: `NaJiki rejected the message (HTTP ${resp.status})` });
      } else {
        // 5xx or no response: NaJiki may already have queued it. Keep the charge (no refund, so
        // nothing can be sent twice for free) and report it as unconfirmed.
        console.error('[messaging] NaJiki did not confirm the message:', resp?.status ?? 'network error');
        outcomes.push({ number, status: 'unconfirmed', error: 'NaJiki did not confirm. Not refunded; check before resending.' });
      }
    }

    const queued = outcomes.filter((o) => o.status === 'queued').length;
    // Nothing was queued and nothing is pending, so nothing was sent or kept. Free the key so the
    // client can retry the same request.
    if (queued === 0 && !outcomes.some((o) => o.status === 'unconfirmed')) {
      await releaseClaim();
    }
    const httpStatus = queued > 0 || outcomes.some((o) => o.status === 'unconfirmed') ? 202 : 422;

    return NextResponse.json({
      success: queued > 0,
      queued,
      rejected: outcomes.filter((o) => o.status === 'rejected').length,
      unconfirmed: outcomes.filter((o) => o.status === 'unconfirmed').length,
      notSent: outcomes.filter((o) => o.status === 'not_sent').length,
      responses: outcomes,
    }, { status: httpStatus });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('Critical exception in SMS API Gateway:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
