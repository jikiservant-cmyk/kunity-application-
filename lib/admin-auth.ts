import { SupabaseClient } from '@supabase/supabase-js';

export interface AdminAuthResult {
  user: {
    id: string;
    email?: string;
  };
  adminProfile: {
    id: string;
    role: string;
    tenant_id: string | null;
  };
  tenantId: string | null;
  isGlobalAdmin: boolean;
}

export async function verifyAdminAndTenant(
  supabaseAdmin: SupabaseClient,
  token: string
): Promise<{ auth?: AdminAuthResult; error?: string; status: number }> {
  if (!token) {
    return { error: 'Unauthorized: Session token is required', status: 401 };
  }

  // 1. Cryptographically verify the session token with Supabase Auth
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return { error: 'Unauthorized: Invalid or expired session token', status: 401 };
  }

  // 2. Fetch the caller's admin profile
  const { data: adminProfile, error: profileError } = await supabaseAdmin
    .from('admin_profiles')
    .select('id, role, tenant_id')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError || !adminProfile) {
    return { error: 'Forbidden: Admin profile not found for caller', status: 403 };
  }

  const allowedRoles = ['sacco_admin', 'super_admin', 'system_admin'];
  if (!allowedRoles.includes(adminProfile.role)) {
    return { error: 'Forbidden: Elevated administrator permissions required', status: 403 };
  }

  const isGlobalAdmin = ['super_admin', 'system_admin'].includes(adminProfile.role);

  return {
    auth: {
      user: {
        id: user.id,
        email: user.email,
      },
      adminProfile: {
        id: adminProfile.id,
        role: adminProfile.role,
        tenant_id: adminProfile.tenant_id,
      },
      tenantId: adminProfile.tenant_id,
      isGlobalAdmin,
    },
    status: 200,
  };
}

export function assertTenantMatch(
  auth: AdminAuthResult,
  targetTenantId: string | null | undefined
): { allowed: boolean; error?: string } {
  if (auth.isGlobalAdmin) {
    return { allowed: true };
  }

  if (!auth.tenantId) {
    return {
      allowed: false,
      error: 'Forbidden: Admin is not associated with any SACCO organization',
    };
  }

  if (!targetTenantId || auth.tenantId !== targetTenantId) {
    return {
      allowed: false,
      error: 'Forbidden: Access denied to foreign SACCO tenant. Cross-tenant modification is prohibited.',
    };
  }

  return { allowed: true };
}
