import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ intentId: string }> }
) {
  try {
    const { intentId } = await params;

    const authHeader = req.headers.get('authorization');
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { createServerClient } = require('@supabase/ssr');
    const supabaseAdmin = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      { cookies: { getAll() { return []; }, setAll() {} } }
    );

    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // IDOR Check: Ensure the intent exists in our DB and belongs to the caller
    const { data: requestRecord } = await supabaseAdmin
      .schema('kunity')
      .from('payment_requests')
      .select('member_id, status')
      .eq('internal_reference', intentId)
      .maybeSingle();

    if (!requestRecord || requestRecord.member_id !== authUser.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // FIN-35: our ledger is the source of truth for "paid". The gateway can
    // report success before the webhook has credited the member and activated
    // the account, so the app must not show "activated" from the gateway alone.
    // Only report success once the database says so; while the gateway says
    // success but our webhook hasn't landed yet, report 'processing'.
    const dbStatus = String(requestRecord.status || '').toLowerCase();
    if (dbStatus === 'success' || dbStatus === 'successful') {
      return NextResponse.json({ status: 'success', source: 'ledger' });
    }
    if (dbStatus === 'failed') {
      return NextResponse.json({ status: 'failed', source: 'ledger' });
    }

    const apiUrl = process.env.NAJIKI_API_URL || "https://najiki.netlify.app";
    const apiKey = process.env.NAJIKI_API_KEY || "";
    const response = await fetch(`${apiUrl}/api/payments/${intentId}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch payment status: ${response.statusText}` },
        { status: response.status }
      );
    }
    const data = await response.json();
    const gatewayStatus = String(data?.status || '').toLowerCase();
    if (gatewayStatus === 'success' || gatewayStatus === 'successful') {
      return NextResponse.json({ ...data, status: 'processing', source: 'gateway' });
    }
    return NextResponse.json(data);
  } catch (err: any) {
    console.error("Error fetching payment status:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
