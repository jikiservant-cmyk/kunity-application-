import { PaymentIntent, PaymentProvider } from "./types";

export class NajikiProvider implements PaymentProvider {
  name = "najiki";

  async createPaymentIntent(amount: number, currency: string, metadata?: any): Promise<PaymentIntent> {
    const applicationCode = process.env.NAJIKI_APPLICATION_CODE || "sacco";
    
    // Check if memberId etc are passed in metadata
    const { memberId, organizationId, phoneNumber, reference, paymentTypeCode: metaPaymentTypeCode } = metadata || {};
    
    const paymentTypeCode = metaPaymentTypeCode || process.env.NAJIKI_PAYMENT_TYPE_CODE || "deposit";

    // We need an idempotencyKey
    const idempotencyKey = reference || `naj-${Date.now()}`;

    // Tenant code must match what NaJiki expects, not just the local organizationId.
    const tenantCode = process.env.NAJIKI_TENANT_CODE || "abc-sacco";

    const payload = {
      applicationCode,
      tenantCode,
      paymentTypeCode,
      externalEntityId: memberId || "unknown",
      amount,
      phoneNumber,
      idempotencyKey,
      metadata: {
        currency,
        ...metadata
      }
    };

    console.log(`[NaJiki] Requesting payment for ${amount} ${currency}`);

    const response = await fetch("https://najiki.netlify.app/api/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    // Handle potential non-JSON responses from Netlify (like 502, 404, etc.)
    const contentType = response.headers.get("content-type");
    let result;
    if (contentType && contentType.includes("application/json")) {
      result = await response.json();
    } else {
      const text = await response.text();
      console.error(`[NaJiki] Non-JSON response received: ${response.status} ${text.substring(0, 100)}`);
      throw new Error(`NaJiki API returned ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(result.error || result.message || "Failed to create NaJiki payment intent");
    }

    return {
      id: result.reference || idempotencyKey, // Use their reference as ID
      amount,
      currency,
      status: result.status || "pending",
      providerInfo: result
    };
  }
}
