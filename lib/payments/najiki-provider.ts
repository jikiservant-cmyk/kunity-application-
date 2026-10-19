import { PaymentIntent, PaymentProvider } from "./types";
import { najikiHostLabel, resolveNajikiBaseUrl } from "../najiki-url";

export class NajikiProvider implements PaymentProvider {
  name = "najiki";

  async createPaymentIntent(amount: number, currency: string, metadata?: any): Promise<PaymentIntent> {
    // No fallback origin: guessing where the provider lives is how real payments
    // reached a stale deployment and every top-up failed with an HTML 500.
    const apiUrl = resolveNajikiBaseUrl();
    const host = najikiHostLabel(apiUrl);
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

    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(najikiPayload),
        // Without a timeout a slow NaJiki call would hang the admin request.
        signal: AbortSignal.timeout(20000),
      });
    } catch (error: any) {
      // Timeout, DNS failure, TLS failure or a closed port. Say where we tried
      // to go: an operator can fix a wrong NAJIKI_API_URL in seconds, but not
      // from "fetch failed".
      const reason = error?.name === 'TimeoutError' ? 'timed out after 20s' : (error?.message || 'network error');
      console.error(`[NaJiki] Could not reach ${host}: ${reason}`);
      throw new Error(
        `NaJiki could not be reached at ${host} (${reason}). ` +
        'Check that NAJIKI_API_URL points at the live NaJiki deployment.'
      );
    }

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const bodyText = await response.text();

    // A non-JSON answer is never a valid payment API response. In practice it is
    // a framework error page (Next.js `<!DOCTYPE html>`) or a login redirect,
    // which means the configured origin is broken, stale or not NaJiki at all.
    // Report THAT instead of leaking the HTML to the caller.
    if (!isJson) {
      const looksLikeHtml = /^\s*<!doctype html/i.test(bodyText) || /^\s*<html/i.test(bodyText);
      console.error(
        `[NaJiki] Non-JSON response from ${host}: HTTP ${response.status} ` +
        `(${looksLikeHtml ? 'HTML page' : contentType || 'unknown content type'}) ` +
        `${bodyText.slice(0, 200)}`
      );
      throw new Error(
        `NaJiki returned ${looksLikeHtml ? 'an HTML page' : 'a non-JSON response'} (HTTP ${response.status}) ` +
        `from ${host} instead of a payment API response. That deployment is broken or stale — ` +
        'check that NAJIKI_API_URL points at the live NaJiki API.'
      );
    }

    let result: any;
    try {
      result = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      console.error(`[NaJiki] Unparseable JSON from ${host}: ${bodyText.slice(0, 200)}`);
      throw new Error(`NaJiki returned an unreadable response (HTTP ${response.status}) from ${host}.`);
    }

    if (!response.ok) {
      console.error("[NaJiki] Payment initiation failed:", JSON.stringify(result, null, 2));
      throw new Error(result.error || result.message || `NaJiki rejected the payment request (HTTP ${response.status})`);
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
