import { NextRequest, NextResponse } from "next/server";
import { paymentGateway } from "../../../../lib/payments/gateway";
import { apiLimiter } from "../../../../lib/rate-limit";
import { createServerClient } from "@supabase/ssr";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") ?? "127.0.0.1";
    await apiLimiter.check(10, ip);

    const body = await req.json();
    const { amount, currency = "UGX", memberId, organizationId, phoneNumber, paymentTypeCode } = body;

    if (!amount || amount <= 0 || !memberId || !organizationId || !phoneNumber) {
      return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
    }

    const finalPaymentTypeCode = paymentTypeCode || 'account_activation';
    const intent = await paymentGateway.createPaymentIntent(amount, currency, {
      source: 'web_app',
      phoneNumber,
      memberId,
      organizationId,
      paymentTypeCode: finalPaymentTypeCode,
      reference: finalPaymentTypeCode === 'account_activation' ? `PAY-ACT-${Date.now()}` : `PAY-${Date.now()}`
    });

    // Make an admin auth client to bypass RLS to insert quickly
    const supabaseAdmin = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return [];
          },
          setAll() {},
        },
      }
    );

    await supabaseAdmin.schema('kunity').from('payment_requests').insert({
      organization_id: organizationId,
      member_id: memberId,
      transaction_reference: intent.id,
      amount: amount,
      status: 'pending',
      direction: 'inbound',
      idempotency_key: intent.id,
      payment_type: finalPaymentTypeCode,
      payload: intent
    });

    return NextResponse.json({ success: true, intent });
  } catch (error: any) {
    console.error("Payment intent error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to process payment request" },
      { status: 500 }
    );
  }
}
