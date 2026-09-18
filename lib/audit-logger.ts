import { SupabaseClient } from '@supabase/supabase-js';

export async function logAudit(
  supabaseAdmin: SupabaseClient,
  params: {
    adminId: string;
    tenantId: string | null;
    action: string;
    entityType: string;
    entityId?: string;
    oldData?: any;
    newData?: any;
    ipAddress?: string;
    userAgent?: string;
  }
) {
  try {
    const { error } = await supabaseAdmin.schema('kunity').from('audit_log').insert({
      admin_id: params.adminId,
      tenant_id: params.tenantId,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      old_data: params.oldData || null,
      new_data: params.newData || null,
      ip_address: params.ipAddress || null,
      user_agent: params.userAgent || null,
    });
    
    if (error) {
      console.error('Failed to write audit log:', error);
    }
  } catch (err) {
    console.error('Error in logAudit:', err);
  }
}
