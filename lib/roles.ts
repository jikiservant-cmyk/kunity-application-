/**
 * Single source of truth for role-based access control constants.
 *
 * CRITICAL SECURITY NOTE:
 * Never trust `user_metadata.role` (or any client-writable metadata) for
 * authorization decisions. user_metadata can be freely modified by any
 * authenticated user via `supabase.auth.updateUser()`. The authoritative
 * role always lives in the `public.admin_profiles` table, which is only
 * writable by the service role / database administrators.
 */

/** Roles allowed to perform elevated SACCO administrative actions. */
export const ELEVATED_ADMIN_ROLES: readonly string[] = [
  'sacco_admin',
  'system_admin',
  'super_admin',
];

/** Roles with global (cross-tenant) administrative privileges. */
export const GLOBAL_ADMIN_ROLES: readonly string[] = [
  'system_admin',
  'super_admin',
];

export function isElevatedAdminRole(role: string | null | undefined): boolean {
  return !!role && ELEVATED_ADMIN_ROLES.includes(role);
}

export function isGlobalAdminRole(role: string | null | undefined): boolean {
  return !!role && GLOBAL_ADMIN_ROLES.includes(role);
}
