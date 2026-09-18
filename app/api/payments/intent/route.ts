import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createServerClient } from '@supabase/ssr';
import { paymentIntentLimiter } from '@/lib/rate-limit';

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': req.headers.get('origin') || process.env.NEXT_PUBLIC_SITE_URL || 'https://demo-placeholder.supabase.co', 
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export async function POST(req: Request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_SITE_URL || 'https://demo-placeholder.supabase.co', 
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
    if (!amount || !phoneNumber || !memberId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders });
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

    // Fetch tenant code from public.tenants
    let tenantCode = organizationId || "";
    if (organizationId) {
      if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase credentials missing in environment variables");
      }
      const supabaseAdmin = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY || '',
        {
          cookies: {
            getAll() { return []; },
            setAll() {},
          },
        }
      );
      
      const { data: tenant, error } = await supabaseAdmin
        .schema('public')
        .from('tenants')
        .select('code')
        .eq('id', organizationId)
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
      amount: Number(amount),     // Ensure strict number type
      currency: currency || 'UGX',
      phoneNumber: phoneNumber,
      reference: idempotencyKey,
      idempotencyKey: idempotencyKey,
      metadata: {
        memberId: finalMemberId,
        organizationId,
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
      amount: Number(amount),
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
      organization_id: organizationId,
      member_id: finalMemberId,
      amount: Number(amount),
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
