import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize a Supabase client with the service role key to bypass RLS for webhook posting.
function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321', // Dummy fallback for build phase
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'
  );
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    let body;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // LivePay usually sends reference, status, etc. in the webhook payload.
    // Example: { internal_reference: "uuid", status: "success", amount: 50000, fee: 500, currency: "UGX", ... }
    const { internal_reference, status, amount, fee, currency, phone_number, provider } = body;

    if (!internal_reference) {
      return NextResponse.json({ error: 'Missing internal_reference' }, { status: 400 });
    }

    // (Optional) Implement webhook signature validation here.
    // e.g. using crypto to verify headers['x-livepay-signature'] against LIVEPAY_SECRET_KEY

    const isSuccess = status === 'success' || status === 'successful';
    const supabaseAdmin = getSupabaseAdmin();
    
    // Update payment request
    const { data: paymentData, error: paymentError } = await supabaseAdmin.schema('kuntiy')
      .from('payment_requests')
      .update({ status: isSuccess ? 'success' : 'failed' })
      .eq('transaction_reference', internal_reference)
      .select('member_id, organization_id');

    if (paymentError) {
      console.error('Error processing livepay webhook:', paymentError);
      return NextResponse.json({ error: paymentError.message }, { status: 500 });
    }

    // If payment is successful, activate the user's accounts
    if (isSuccess && paymentData && paymentData.length > 0) {
      const { member_id, organization_id } = paymentData[0];

      // First activate the member_savings record
      await supabaseAdmin.schema('kuntiy')
        .from('member_savings')
        .update({ status: 'active' })
        .eq('member_id', member_id)
        .eq('organization_id', organization_id);

      // Then activate the corresponding accounts
      await supabaseAdmin.schema('kuntiy')
        .from('accounts')
        .update({ is_active: true })
        .eq('member_id', member_id)
        .eq('organization_id', organization_id);
    }

    // Returns a 200 OK so LivePay knows we received it
    return NextResponse.json({ success: true, data: paymentData });
  } catch (error: any) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
