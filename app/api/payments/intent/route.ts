import { NextResponse } from 'next/server';
import { activationBlockReason } from '@/lib/activation-guard';
import crypto from 'crypto';
import { createServerClient } from '@supabase/ssr';
import { paymentIntentLimiter } from '@/lib/rate-limit';

// SECURITY: CORS allowlist. Never reflect an arbitrary caller-supplied Origin —
// origin reflection lets any website execute authenticated cross-origin requests.
// Only origins explicitly configured for this deployment are allowed.
const getAllowedOrigins = (): string[] => {
  const origins: string[] = [];
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      origins.push(new URL(candidate).origin);
    } catch {
      // ignore malformed env values
    }
  }
  return origins;
};

const resolveCorsOrigin = (requestOrigin: string | null): string | null => {
  if (!requestOrigin) return null;
  return getAllowedOrigins().includes(requestOrigin) ? requestOrigin : null;
};

export async function OPTIONS(req: Request) {
  const allowedOrigin = resolveCorsOrigin(req.headers.get('origin'));
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(req: Request) {
  const allowedOrigin = resolveCorsOrigin(req.headers.get('origin'));
  const corsHeaders: Record<string, string> = {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    const body = await req.json();
    const { amount, currency, phoneNumber, paymentTypeCode, memberId, organizationId } = body;

    // Check Authorization
    const authHeader = req.headers.get('authorization');
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    }

    const supabaseAdminLocal2 = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      {
        cookies: {
          getAll() { return []; },
          setAll() {},
        },
      }
    );

    const { data: { user: authUser }, error: authError } = await supabaseAdminLocal2.auth.getUser(token);
    if (authError || !authUser) {
      return NextResponse.json({ error: 'Unauthorized: Invalid or expired session token' }, { status: 401, headers: corsHeaders });
    }

    if (memberId && memberId !== authUser.id) {
      return NextResponse.json({ error: 'Forbidden: Cannot create intent for another member' }, { status: 403, headers: corsHeaders });
    }
    const finalMemberId = authUser.id; // Force memberId to be the authenticated user


    // 1. Validate inputs
    // SECURITY: amount must be a strictly positive, finite number. A truthy
    // check alone would let negative amounts through (-5 is truthy in JS).
    const numericAmount = Number(amount);
    if (!amount || !phoneNumber || !memberId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders });
    }
    if (typeof amount !== 'number' || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: 'Invalid amount: must be a positive number' }, { status: 400, headers: corsHeaders });
    }

    // Apply rate limiting per member or phone number
    try {
      await paymentIntentLimiter.check(15, `payment:${authUser.id}`);
    } catch {
      return NextResponse.json(
        { error: 'Too many payment requests. Please wait a minute before retrying.' },
        { status: 429, headers: corsHeaders }
      );
    }

    // 2. Generate a secure idempotency key
    const idempotencyKey = `najiki_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // SECURITY: Resolve the caller's organization from SERVER-AUTHORITATIVE
    // records — never trust a client-supplied organizationId for gateway tenant
    // routing. A caller must only ever create payment intents tied to an
    // organization they actually belong to.
    let resolvedOrgId: string | null = null;

    const { data: callerMember } = await supabaseAdminLocal2
      .schema('kunity')
      .from('members')
      .select('id, organization_id, status')
      .eq('id', authUser.id)
      .maybeSingle();

    if (callerMember?.organization_id) {
      resolvedOrgId = callerMember.organization_id;
    } else {
      // No member record: only allow tenant-scoped admin operations (e.g. BUY_SMS
      // topups), resolved from the authoritative admin_profiles.tenant_id.
      const isBuySms = (paymentTypeCode || '').toUpperCase() === 'BUY_SMS';
      if (isBuySms) {
        const { data: adminProfile } = await supabaseAdminLocal2
          .from('admin_profiles')
          .select('tenant_id, role')
          .eq('id', authUser.id)
          .maybeSingle();
        const isAdmin = adminProfile && ['sacco_admin', 'system_admin', 'super_admin'].includes(adminProfile.role);
        if (isAdmin && adminProfile.tenant_id) {
          resolvedOrgId = adminProfile.tenant_id;
        }
      }
    }

    if (!resolvedOrgId) {
      return NextResponse.json(
        { error: 'Forbidden: Caller is not a member of any organization' },
        { status: 403, headers: corsHeaders }
      );
    }

    // If the client supplied an organizationId, it must match the
    // server-resolved organization. Mismatch = cross-tenant probing → reject.
    if (organizationId && organizationId !== resolvedOrgId) {
      return NextResponse.json(
        { error: 'Forbidden: organizationId does not match your organization membership' },
        { status: 403, headers: corsHeaders }
      );
    }
    const finalOrganizationId = resolvedOrgId;

    // FIN-23 (source): the stored payment type is later trusted by the webhook
    // RPC's whitelist. Only the types the member app actually uses are allowed
    // for member callers; unknown types would be held for review at webhook
    // time anyway — reject them here with a clear error.
    const requestedType = (paymentTypeCode || 'account_activation').trim();
    const isMemberCaller = !!callerMember?.organization_id;
    const memberAllowedTypes = ['deposit', 'account_activation'];
    if (isMemberCaller && !memberAllowedTypes.includes(requestedType)) {
      return NextResponse.json(
        { error: `Invalid paymentTypeCode. Allowed: ${memberAllowedTypes.join(', ')}` },
        { status: 400, headers: corsHeaders }
      );
    }
    // FIN-36: an activation payment needs a savings account to post into. If
    // the member has none, the payment webhook cannot record the money and
    // rolls back, so the member would be charged and never activated. Refuse
    // up front and tell the member to open a plan first.
    if (isMemberCaller && requestedType === 'account_activation') {
      // FIN-40: declined/suspended members and members with an activation
      // payment already in progress may not start another one.
      const { data: pendingActivation } = await supabaseAdminLocal2
        .schema('kunity')
        .from('payment_requests')
        .select('created_at')
        .eq('member_id', authUser.id)
        .eq('organization_id', resolvedOrgId)
        .eq('payment_type', 'account_activation')
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const blockReason = activationBlockReason({
        memberStatus: callerMember?.status,
        pendingActivationCreatedAt: pendingActivation?.created_at ?? null,
        now: Date.now(),
      });
      if (blockReason) {
        return NextResponse.json({ error: blockReason }, { status: 409, headers: corsHeaders });
      }

      const { data: memberAccounts } = await supabaseAdminLocal2
        .schema('kunity')
        .from('accounts')
        .select('id, is_active')
        .eq('member_id', authUser.id)
        .eq('organization_id', resolvedOrgId);
      if (!memberAccounts || memberAccounts.length === 0) {
        return NextResponse.json(
          { error: 'Open a savings plan first, then purchase the activation card.' },
          { status: 400, headers: corsHeaders }
        );
      }
      // FIN-39: an already-activated member must not pay the activation fee
      // again (it would be credited to their balance a second time).
      if (memberAccounts.some((a: any) => a.is_active === true)) {
        return NextResponse.json(
          { error: 'Your account is already activated.' },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // Admin BUY_SMS topups keep their own type (credited via wallet_transactions).

    // FIN-31b: enforce the member minimums SERVER-SIDE. The member app only
    // enforces them in the browser, so a direct API call could activate an
    // account (or make a deposit) for any amount, e.g. UGX 1.
    const MEMBER_MIN_AMOUNTS: Record<string, number> = {
      account_activation: 5000,
      deposit: 2000,
    };
    if (isMemberCaller && numericAmount < (MEMBER_MIN_AMOUNTS[requestedType] ?? 0)) {
      return NextResponse.json(
        { error: `Minimum ${requestedType === 'account_activation' ? 'activation fee' : 'deposit'} is UGX ${MEMBER_MIN_AMOUNTS[requestedType].toLocaleString()}` },
        { status: 400, headers: corsHeaders }
      );
    }

    // Fetch tenant code from public.tenants
    let tenantCode = finalOrganizationId;
    {
      const { data: tenant, error } = await supabaseAdminLocal2
        .schema('public')
        .from('tenants')
        .select('code')
        .eq('id', finalOrganizationId)
        .maybeSingle();

      if (tenant && tenant.code) {
        tenantCode = tenant.code;
      } else if (error) {
        console.error("Failed to fetch tenant code:", error);
      }
    }

    const najikiUrl = process.env.NAJIKI_API_URL;
    if (!najikiUrl) {
      throw new Error("NAJIKI_API_URL is missing in environment variables");
    }

    // 3. Map Kunity's context to NaJiki's expected payload structure
    const najikiPayload = {
      applicationCode: process.env.NAJIKI_APPLICATION_CODE || 'sacco',
      tenantCode: tenantCode,
      paymentTypeCode: paymentTypeCode || 'account_activation',
      externalEntityId: finalMemberId,
      amount: numericAmount,     // Ensure strict number type
      currency: currency || 'UGX',
      phoneNumber: phoneNumber,
      reference: idempotencyKey,
      idempotencyKey: idempotencyKey,
      metadata: {
        memberId: finalMemberId,
        organizationId: finalOrganizationId,
        paymentTypeCode
      }
    };

    // Format URL correctly to avoid double slashes
    const baseUrl = najikiUrl.endsWith('/') ? najikiUrl.slice(0, -1) : najikiUrl;

    // 4. Send the request to NaJiki using the secure API key
    const response = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NAJIKI_API_KEY}` // Secure server-side authentication
      },
      body: JSON.stringify(najikiPayload)
    });

    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (e) {
      console.error('NaJiki API returned non-JSON:', responseText);
      return NextResponse.json({ error: `NaJiki gateway error (Status ${response.status}). Response: ${responseText.substring(0, 100)}` }, { status: 500, headers: corsHeaders });
    }

    if (!response.ok) {
      console.error('NaJiki API Error:', data, 'Status:', response.status);
      const errorMessage = data.error || data.message || (data && JSON.stringify(data)) || 'Failed to initialize payment';
      return NextResponse.json({ error: `NaJiki Error (${response.status}): ${errorMessage}` }, { status: response.status, headers: corsHeaders });
    }

    // Get the actual reference generated by NaJiki (or fallback to idempotencyKey)
    const najikiReference = data.reference || data.id || idempotencyKey;

    const intent = {
      id: najikiReference, // Use NaJiki reference as the ID so frontend can poll the correct endpoint
      amount: numericAmount,
      currency: currency || 'UGX',
      status: 'pending',
      providerInfo: data
    };

    // Generate a valid UUID for the payment_requests primary key id
    const dbId = crypto.randomUUID();
    const finalPaymentTypeCode = paymentTypeCode || 'account_activation';

    // Fallback to service role admin client bypass if available
    const supabaseAdminLocal3 = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      { cookies: { getAll() { return []; }, setAll() {} } }
    );

    const { error: adminInsertError } = await supabaseAdminLocal3.schema('kunity').from('payment_requests').insert({
      id: dbId,
      organization_id: finalOrganizationId,
      member_id: finalMemberId,
      amount: numericAmount,
      currency: currency || 'UGX',
      phone_number: phoneNumber,
      status: 'pending',
      direction: 'inbound',
      idempotency_key: idempotencyKey,
      internal_reference: najikiReference, // Store the NaJiki reference as the internal reference so webhook / status matches
      payment_type: finalPaymentTypeCode,
      payload: intent,
      provider: 'najiki'
    });

    if (adminInsertError) {
      console.error("Database insert error:", adminInsertError);
      throw new Error(`Database error: ${adminInsertError.message}`);
    }

    // 5. Return the payment status back to Kunity's frontend
    return NextResponse.json({ success: true, intent: intent }, { headers: corsHeaders });

  } catch (error: any) {
    console.error('Kunity Backend Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500, headers: corsHeaders });
  }
}
