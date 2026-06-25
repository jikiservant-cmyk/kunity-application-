import { PaymentProvider, PaymentIntent } from "./types";

export class LivePayProvider implements PaymentProvider {
  name = "livepay";
  
  async createPaymentIntent(amount: number, currency: string, metadata?: any): Promise<PaymentIntent> {
    const apiKey = process.env.LIVEPAY_API_KEY;
    const accountNumber = process.env.LIVEPAY_ACCOUNT_NUMBER;

    if (!apiKey || !accountNumber) {
      throw new Error("LivePay credentials (LIVEPAY_API_KEY, LIVEPAY_ACCOUNT_NUMBER) are missing.");
    }

    // A unique reference string for the money request (no spaces, max 30 chars limit)
    const reference = metadata?.reference || `REF${Date.now()}`;
    const description = metadata?.description || "Payment Request";
    const phoneNumber = metadata?.phoneNumber;

    if (!phoneNumber) {
      throw new Error("Phone number is required for LivePay transactions.");
    }

    const payload: any = {
      accountNumber,
      phoneNumber,
      amount,
      currency,
      reference,
      description
    };

    // Note: LivePay docs specify network conditionally required for non-UGX
    if (currency !== "UGX" && metadata?.network) {
      payload.network = metadata.network;
    }

    console.log(`[LivePay] Requesting collect-money for ${amount} ${currency}`);

    const response = await fetch("https://livepay.me/api/collect-money", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || result.message || "Failed to create LivePay payment intent");
    }

    return {
      id: result.internal_reference || result.reference || reference,
      amount,
      currency,
      status: "pending", // Collection is pending until confirmed by webhook/status check
      providerInfo: { result, originalReference: reference }
    };
  }

  async confirmPayment(intentId: string): Promise<PaymentIntent> {
    // In a real implementation this might hit a "check-transaction-status" endpoint
    // Docs link: https://docs.livepay.me/transaction-status
    console.log(`[LivePay] Confirming payment with ID ${intentId}`);
    return {
      id: intentId,
      amount: 0,
      currency: "UGX",
      status: "completed",
    };
  }
}

