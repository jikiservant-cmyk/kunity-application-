import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { interpolateTemplate } from './sms-templates';
import { normalizeUgandanPhone } from './validators';

export interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
  costUGX?: number;
  newBalanceUGX?: number;
}

/**
 * Shared utility to dispatch SMS messages with Sacco wallet checks and ledgers.
 * Guaranteed to execute and be awaited synchronously for serverless safety.
 */
export async function sendSms({
  tenantId,
  recipientPhone,
  message,
  eventType,
  originUrl,
  templateData,
  idempotencyKey
}: {
  tenantId: string;
  recipientPhone: string;
  message?: string;
  eventType: string;
  originUrl?: string;
  templateData?: Record<string, string | number>;
  idempotencyKey?: string;
}): Promise<SmsResult> {
  try {
    // 0. Normalize and validate recipient phone number centrally
    const phoneResult = normalizeUgandanPhone(recipientPhone);
    if (!phoneResult.valid) {
      return { success: false, error: phoneResult.error || 'Invalid recipient phone number' };
    }
    const cleanPhone = phoneResult.phone;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[SMS Service] Configuration error: Missing URL or service role key.');
      return { success: false, error: 'Server database configuration missing' };
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let applicationId = null;
    try {
      const { data: tenantData } = await supabaseAdmin
        .schema('public')
        .from('tenants')
        .select('application_id')
        .eq('id', tenantId)
        .maybeSingle();
      if (tenantData) {
        applicationId = tenantData.application_id;
      }
    } catch (e) {
      console.error('[SMS Service] Error fetching application_id for tenant:', e);
    }

    // Resolve custom template if available
    let finalMessage = message || '';

    if (eventType && templateData) {
      // SECURITY: never interpolate raw values into PostgREST .or() filters —
      // strip anything that could alter the filter expression.
      const safeEventType = String(eventType).replace(/[^A-Za-z0-9_-]/g, '');
      if (safeEventType) {
        const { data: templateRecord, error: tmplErr } = await supabaseAdmin
          .schema('public')
          .from('sms_templates')
          .select('*')
          .eq('tenant_id', tenantId)
          .or(`event_code.eq.${safeEventType},event_type.eq.${safeEventType}`)
          .maybeSingle();

        const templateBody = templateRecord?.template_text || templateRecord?.body;
        if (!tmplErr && templateBody) {
          finalMessage = interpolateTemplate(templateBody, templateData);
        } else if (finalMessage) {
          finalMessage = interpolateTemplate(finalMessage, templateData);
        }
      }
    } else if (templateData && finalMessage) {
      finalMessage = interpolateTemplate(finalMessage, templateData);
    }

    if (!finalMessage.trim()) {
      return { success: false, error: 'No message content provided or resolved from template.' };
    }

    // 1. Calculate message cost details
    const textLength = finalMessage.trim().length;
    let segments = 1;
    if (textLength > 160) {
      segments = Math.ceil(textLength / 153);
    }
    const defaultCostPerSms = 50.00;

    // 2. Fetch active wallet from public.wallets (Sacco schema)
    let wallet = null;
    const { data: existingWallet, error: fetchWalletErr } = await supabaseAdmin
      .schema('public')
      .from('wallets')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (fetchWalletErr) {
      console.error('[SMS Service] Error fetching tenant wallet:', fetchWalletErr);
    }

    if (!existingWallet && !fetchWalletErr) {
      console.log(`[SMS Service] Auto-provisioning default sacco wallet for organization ${tenantId}...`);
      const { data: newWallet, error: createWalletErr } = await supabaseAdmin
        .schema('public')
        .from('wallets')
        .insert({
          tenant_id: tenantId,
          balance: 0.00,
          sms_rate: 50.00
        })
        .select('*')
        .maybeSingle();

      if (createWalletErr) {
        console.error('[SMS Service] Error provisioning default wallet:', createWalletErr);
      } else {
        wallet = newWallet;
      }
    } else {
      wallet = existingWallet;
    }

    let totalCost = segments * (wallet?.sms_rate ? parseFloat(wallet.sms_rate) : defaultCostPerSms);
    const currentBalance = wallet ? parseFloat(wallet.balance) : 0;
    const finalBalance = currentBalance - totalCost;

    // Check if wallet is active and has sufficient funds
    if (!wallet || currentBalance < totalCost) {
      const errorMsg = !wallet
        ? 'Tenant wallet not found'
        : `Insufficient funds: Required ${totalCost} UGX, balance is ${currentBalance} UGX`;

      console.warn(`[SMS Service] Dispatch aborted. ${errorMsg}`);

      // Log a failed event in the SMS logs for Sacco admins if possible
      const { error: logFailedErr } = await supabaseAdmin
        .schema('public')
        .from('sms_messages')
        .insert({
          tenant_id: tenantId,
          application_id: applicationId,
          phone_number: cleanPhone,
          compiled_message: finalMessage,
          cost: 0,
          transaction_type: 'debit',
          status: 'failed',
          event_code: eventType,
          provider_message_id: `failed_${Date.now()}`
        });

      if (logFailedErr) {
        console.warn(`[SMS Service] Optional failed log insertion skipped: ${logFailedErr.message}`);
      }

      return { success: false, error: errorMsg };
    }

    // 3. Deduct balance directly from public.wallets with deterministic idempotency key
    const resolvedIdempotencyKey = idempotencyKey 
      ? `debit_${idempotencyKey}` 
      : `debit_${crypto.createHash('sha256').update(`${tenantId}:${cleanPhone}:${eventType}:${finalMessage}`).digest('hex').substring(0, 32)}`;

    const { data: debitResult, error: debitErr } = await supabaseAdmin
      .rpc('debit_sms_wallet', {
          p_wallet_id: wallet.id,
          p_amount: totalCost,
          p_idempotency_key: resolvedIdempotencyKey,
          p_tenant_id: tenantId,
          p_description: `SMS dispatch for event ${eventType || 'BROADCAST'}`
      })
      .single();

    if (debitErr) {
      console.error('[SMS Service] Failed to debit wallet:', debitErr);
      return { success: false, error: 'Failed to deduct wallet balance' };
    }

    // 4. Wallet transaction ledger is handled above

    // 5. Logging to sms_messages is now handled by the NaJiki Gateway Aggregator

    // 6. Dispatch to NaJiki Gateway
    const najikiUrl = process.env.NAJIKI_API_URL;
    const apiKey = process.env.NAJIKI_API_KEY;
    const applicationCode = process.env.NAJIKI_APPLICATION_CODE || 'sacco';
    
    let tenantCode = process.env.NAJIKI_TENANT_CODE;
    try {
      const { data: tenantData } = await supabaseAdmin.schema('public').from('tenants').select('code').eq('id', tenantId).maybeSingle();
      if (tenantData && tenantData.code) {
        tenantCode = tenantData.code;
      }
    } catch (e) {
      console.error('[SMS Service] Failed to fetch tenant code:', e);
    }


    if (!najikiUrl || !apiKey || !tenantCode) {
        console.error('[SMS Service] Dispatch aborted. NaJiki Gateway configuration missing.');
        return { success: false, error: 'SMS Gateway configuration missing' };
    }

    const maskedPhone = `${cleanPhone.slice(0, 4)}***${cleanPhone.slice(-2)}`;
    console.log(`[SMS Service] Dispatching payload to NaJiki at ${najikiUrl}/api/messaging/send for phone ${maskedPhone}`);

    try {
      const response = await fetch(`${najikiUrl}/api/messaging/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          applicationCode,
          tenantCode,
          firstName: templateData?.firstName || templateData?.first_name,
          lastName: templateData?.lastName || templateData?.last_name,
          to: cleanPhone,
          message: finalMessage,
          eventType,
          from: applicationCode
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP_${response.status}: ${errorText}`);
      }
      console.log(`[SMS Service] Successfully dispatched to NaJiki for ${recipientPhone}`);
    } catch (err: any) {
      console.error(`[SMS Service] NaJiki dispatch failed:`, err);
      
      const isHttpError = err.message.startsWith('HTTP_');
      const isClientError = isHttpError && err.message.match(/HTTP_4\d\d/);
      
      // 7. Refund the wallet ONLY if it's a known HTTP error (e.g. 400 Bad Request)
      // Do NOT refund on network timeouts or 5xx, as the message might still be processing.
      if (isClientError) {
        // FIN-06 FIX: the previous refund called `credit_sms_wallet` with a
        // `p_idempotency_key` parameter that function does not accept — the RPC
        // lookup always failed, so failed SMS were debited but NEVER refunded.
        // Use the dedicated idempotent refund RPC instead.
        const refundReference = idempotencyKey
          ? `refund_${idempotencyKey}`
          : `refund_${crypto.createHash('sha256').update(`${tenantId}:${cleanPhone}:${eventType}:${finalMessage}`).digest('hex').substring(0, 32)}`;

        const { data: refundResult, error: refundErr } = await supabaseAdmin
          .rpc('refund_sms_wallet', {
            p_wallet_id: wallet.id,
            p_amount: totalCost,
            p_reference: refundReference
          })
          .single();

        let refundBalance: number | undefined;
        if (refundErr) {
          console.error('[SMS Service] Failed to refund wallet after failed dispatch:', refundErr);
        } else if (refundResult) {
          const b = parseFloat(String((refundResult as { balance?: number | string }).balance ?? ''));
          if (Number.isFinite(b)) refundBalance = b;
        }
        refundBalance = refundBalance !== undefined ? refundBalance : finalBalance + totalCost;

        // 8. Update the SMS log status to failed
        await supabaseAdmin
          .schema('public')
          .from('sms_messages')
          .insert({
            tenant_id: tenantId,
            application_id: applicationId,
            phone_number: recipientPhone,
            compiled_message: finalMessage,
            cost: totalCost,
            transaction_type: 'debit',
            status: 'failed_refunded',
            event_code: eventType,
            provider_message_id: `failed_${Date.now()}`
          });

        return { success: false, error: `NaJiki dispatch failed (client error) and refunded. Error: ${err.message}` };
      }

      // 8. For network timeouts or 5xx, mark as 'unknown' or 'failed' but DO NOT refund to prevent abuse.
      await supabaseAdmin
        .schema('public')
        .from('sms_messages')
        .insert({
          tenant_id: tenantId,
          application_id: applicationId,
          phone_number: recipientPhone,
          compiled_message: finalMessage,
          cost: totalCost,
          transaction_type: 'debit',
          status: 'failed_no_refund',
          event_code: eventType,
          provider_message_id: `failed_${Date.now()}`
        });

      return { success: false, error: `NaJiki dispatch failed (network/server error). NO refund issued. Error: ${err.message}` };
    }

    return {
      success: true,
      messageId: `sent_via_najiki_${Date.now()}`,
      costUGX: totalCost,
      newBalanceUGX: finalBalance
    };
  } catch (error: any) {
    console.error('[SMS Service] Unhandled error during SMS handling:', error);
    return { success: false, error: error?.message || 'Internal SMS service error' };
  }
}
