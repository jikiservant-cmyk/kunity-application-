import { PaymentIntent, PaymentProvider } from "./types";
import { createClient } from "@supabase/supabase-js";

export class NajikiProvider implements PaymentProvider {
  name = "najiki";

  async createPaymentIntent(amount: number, currency: string, metadata?: any): Promise<PaymentIntent> {
    const apiUrl = process.env.NAJIKI_API_URL || "https://najiki.netlify.app";
    const apiKey = process.env.NAJIKI_API_KEY || "";
    const applicationCode = process.env.NAJIKI_APPLICATION_CODE || "sacco";
    
    // Check if memberId etc are passed in metadata
    const { memberId, organizationId, phoneNumber, reference, paymentTypeCode: metaPaymentTypeCode, tenantCode: metaTenantCode } = metadata || {};
    
    const paymentTypeCode = metaPaymentTypeCode || process.env.NAJIKI_PAYMENT_TYPE_CODE || "account_activation";

    // 1. Generate a secure idempotency key
    const crypto = require('crypto');
    const idempotencyKey = reference || `najiki_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 2. Map Kunity's fields to NaJiki's expected schema
    const najikiPayload = {
      applicationCode: process.env.NAJIKI_APPLICATION_CODE || 'sacco',
      ...(metaTenantCode || organizationId || process.env.NAJIKI_TENANT_CODE ? { tenantCode: metaTenantCode || organizationId || process.env.NAJIKI_TENANT_CODE } : {}),
      paymentTypeCode: paymentTypeCode,
      externalEntityId: memberId || organizationId || phoneNumber || 'UNKNOWN',
      amount: Number(amount),
      currency: currency || 'UGX',
      phoneNumber: phoneNumber,
      idempotencyKey: idempotencyKey,
      metadata: {
        memberId,
        organizationId,
        paymentTypeCode,
        ...metadata
      }
    };

    console.log(`[NaJiki] Requesting payment for ${amount} ${currency} with idempotency key ${idempotencyKey}`);
    console.log("[NaJiki API Request Payload]:", JSON.stringify({ ...najikiPayload, customerNumber: '***', customerEmail: '***' }));

    const response = await fetch(`${apiUrl}/api/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(najikiPayload)
    });

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
      console.error("[NaJiki] Payment initiation failed:", JSON.stringify(result, null, 2));
      throw new Error(result.error || result.message || "Failed to create NaJiki payment intent");
    }

    return {
      id: result.reference || result.id || idempotencyKey, // Use their reference as ID
      amount,
      currency,
      status: result.status || "pending",
      providerInfo: result
    };
  }
}
