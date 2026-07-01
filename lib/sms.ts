import { createClient } from '@supabase/supabase-js';
import { interpolateTemplate } from './sms-templates';

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
  templateData
}: {
  tenantId: string;
  recipientPhone: string;
  message?: string;
  eventType: string;
  originUrl?: string;
  templateData?: Record<string, string | number>;
}): Promise<SmsResult> {
  try {
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
      const { data: templateRecord, error: tmplErr } = await supabaseAdmin
        .schema('public')
        .from('sms_templates')
        .select('template')
        .eq('tenant_id', tenantId)
        .eq('event_type', eventType)
        .maybeSingle();
      
      if (!tmplErr && templateRecord?.template) {
        finalMessage = interpolateTemplate(templateRecord.template, templateData);
      } else if (finalMessage) {
        finalMessage = interpolateTemplate(finalMessage, templateData);
      }
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
    const costPerSms = 40.00; // 40 UGX = 1 credit
    const totalCost = segments * costPerSms;

    // 2. Fetch active wallet
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

    if (!existingWallet) {
      console.warn(`[SMS Service] Dispatch aborted. Tenant wallet not found for ${tenantId}. Wallet must be provisioned during tenant onboarding.`);
    }

    wallet = existingWallet;

    const currentBalance = wallet ? parseFloat(wallet.balance) : 0;

    // Check if wallet is active and has sufficient funds
    if (!wallet || currentBalance < totalCost) {
      const errorMsg = !wallet
        ? 'Tenant wallet not found'
        : `Insufficient funds: Required ${totalCost} UGX, balance is ${currentBalance} UGX`;

      console.warn(`[SMS Service] Dispatch aborted. ${errorMsg}`);

      // Log a failed event in the SMS logs for Sacco admins to see
      await supabaseAdmin
        .schema('public')
        .from('sms_messages')
        .insert({
          tenant_id: tenantId,
          application_id: applicationId,
          phone_number: recipientPhone,
          compiled_message: finalMessage,
          cost: 0,
          status: 'failed',
          event_code: eventType,
          provider_message_id: `failed_${Date.now()}`
        });

      return { success: false, error: errorMsg };
    }

    // 3. Atomically deduct balance using the RPC to prevent race conditions
    const { data: debitResult, error: debitErr } = await supabaseAdmin
      .schema('kunity')
      .rpc('debit_tenant_wallet', { 
        p_wallet_id: wallet.id, 
        p_amount: totalCost 
      });

    if (debitErr) {
      console.error('[SMS Service] Failed to debit wallet atomically:', debitErr);
      return { success: false, error: 'Failed to deduct wallet balance atomically' };
    } else if (debitResult && !debitResult.success) {
      return { success: false, error: debitResult.error };
    }

    const finalBalance = debitResult.new_balance;

    // 4. Wallet transaction ledger is now handled automatically by the RPC

    // 5. Write log entry in `sms_messages` table
    const providerSmsId = `sms_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const { error: logErr } = await supabaseAdmin
      .schema('public')
      .from('sms_messages')
      .insert({
        tenant_id: tenantId,
        application_id: applicationId,
        phone_number: recipientPhone,
        compiled_message: finalMessage,
        cost: totalCost,
        status: 'sent',
        event_code: eventType,
        provider_message_id: providerSmsId
      });

    if (logErr) {
      console.error('[SMS Service] Error logging SMS details:', logErr);
    }

    // 6. Dispatch to NaJiki Gateway
    const najikiUrl = process.env.NAJIKI_API_URL;
    const apiKey = process.env.NAJIKI_API_KEY;
    const tenantCode = process.env.NAJIKI_TENANT_CODE;

    if (!najikiUrl || !apiKey || !tenantCode) {
        console.error('[SMS Service] Dispatch aborted. NaJiki Gateway configuration missing.');
        return { success: false, error: 'SMS Gateway configuration missing' };
    }

    console.log(`[SMS Service] Dispatching payload to NaJiki at ${najikiUrl} for phone ${recipientPhone}`);

    try {
      const response = await fetch(najikiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({
          tenantCode,
          to: recipientPhone,
          message: finalMessage,
          eventType
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`NaJiki Gateway returned ${response.status}: ${errorText}`);
      }
      console.log(`[SMS Service] Successfully dispatched to NaJiki for ${recipientPhone}`);
    } catch (err: any) {
      console.error(`[SMS Service] NaJiki dispatch failed:`, err);
      
      // 7. Refund the wallet since dispatch failed
      let refundBalance = finalBalance + totalCost;
      const { data: creditResult, error: creditErr } = await supabaseAdmin
        .schema('kunity')
        .rpc('credit_tenant_wallet', { 
          p_wallet_id: wallet.id, 
          p_amount: totalCost 
        });

      if (creditErr) {
        console.error('[SMS Service] Failed to credit wallet atomically:', creditErr);
      } else if (creditResult && creditResult.success) {
        refundBalance = creditResult.new_balance;
      }

      // 8. Refund transaction ledger is now handled automatically by the RPC

      // 9. Update the SMS log status to failed
      await supabaseAdmin
        .schema('public')
        .from('sms_messages')
        .update({ status: 'failed' })
        .eq('provider_message_id', providerSmsId);

      return { success: false, error: `NaJiki dispatch failed and refunded. Error: ${err.message}` };
    }

    return {
      success: true,
      messageId: providerSmsId,
      costUGX: totalCost,
      newBalanceUGX: finalBalance
    };
  } catch (error: any) {
    console.error('[SMS Service] Unhandled error during SMS handling:', error);
    return { success: false, error: error?.message || 'Internal SMS service error' };
  }
}
