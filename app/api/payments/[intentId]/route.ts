import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from '@supabase/ssr';

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

    const supabaseAdmin = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
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
      .select('member_id')
      .eq('internal_reference', intentId)
      .maybeSingle();

    if (!requestRecord || requestRecord.member_id !== authUser.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
    return NextResponse.json(data);
  } catch (err: any) {
    console.error("Error fetching payment status:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
