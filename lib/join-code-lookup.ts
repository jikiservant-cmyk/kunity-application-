import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeJoinCode, legacyJoinCodeCandidate } from './join-code';

// Single lookup path for join links. BOTH /api/organizations/resolve and
// /api/auth/profile must resolve codes through here — the dead-link bug of
// 2026-10-21 happened because the DB generator and the app validator each had
// their own idea of what a code looks like, with no shared lookup between them.
//
// Order of resolution:
//   1. Strict alphabet code (normalizeJoinCode) -> kunity.organizations.join_code.
//      This is the only format new codes may have (CHECK-enforced since 38).
//   2. Legacy hex code (legacyJoinCodeCandidate) -> kunity.join_code_aliases.
//      Closed-set transition mapping so links shared before migration 38 keep
//      working WITHOUT loosening the alphabet: a look-alike variant of a legacy
//      code is not in the alias table and resolves to nothing.

export type JoinCodeOrg = { id: string; name: string | null; is_active: boolean | null };

export type JoinCodeResolution =
  | { status: 'invalid' } // fails both accepted formats
  | { status: 'not_found' } // well-formed but no SACCO holds it
  | { status: 'found'; org: JoinCodeOrg }
  | { status: 'error'; message: string }; // database failure

export async function resolveJoinCodeToOrg(
  supabaseAdmin: SupabaseClient,
  rawCode: unknown
): Promise<JoinCodeResolution> {
  const code = normalizeJoinCode(rawCode);
  const legacy = code ? null : legacyJoinCodeCandidate(rawCode);
  if (!code && !legacy) return { status: 'invalid' };

  try {
    if (code) {
      const { data: org, error } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .select('id, name, is_active')
        .eq('join_code', code)
        .maybeSingle();
      if (error) return { status: 'error', message: error.message };
      return org ? { status: 'found', org } : { status: 'not_found' };
    }

    const { data: alias, error: aliasErr } = await supabaseAdmin
      .schema('kunity')
      .from('join_code_aliases')
      .select('organization_id')
      .eq('legacy_code', legacy)
      .maybeSingle();
    if (aliasErr) return { status: 'error', message: aliasErr.message };
    if (!alias) return { status: 'not_found' };

    const { data: org, error } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name, is_active')
      .eq('id', alias.organization_id)
      .maybeSingle();
    if (error) return { status: 'error', message: error.message };
    return org ? { status: 'found', org } : { status: 'not_found' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'lookup failed' };
  }
}
