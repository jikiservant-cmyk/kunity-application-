import { NextRequest, NextResponse } from 'next/server';

// Kunity uses NaJiki only (see lib/payments/gateway.ts). LivePay is not a supported
// provider, so this endpoint accepts no events: it never credits money, never activates
// a member and never sends SMS. Returning 410 tells any caller to stop sending.
export async function POST(_req: NextRequest) {
  console.warn('[LivePay Webhook] Received a LivePay event, but LivePay is disabled. Rejected.');
  return NextResponse.json(
    { error: 'LivePay is not an active payment provider. Use NaJiki.' },
    { status: 410 }
  );
}

export async function GET() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
