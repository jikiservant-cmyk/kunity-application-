import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant, assertTenantMatch } from '@/lib/admin-auth';
import { apiLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { generateJoinCode, normalizeJoinCode } from '@/lib/join-code';

// SACCO admins read / regenerate their own SACCO's member join code.
// action: 'get' (default) | 'regenerate'. Regenerating invalidates the old link
// immediately; members already registered are not affected.
export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const { token, organizationId, action = 'get' } = body as {
      token?: string; organizationId?: string; action?: 'get' | 'regenerate';
    };

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (action !== 'get' && action !== 'regenerate') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    try {
      await apiLimiter.check(30, `admin:join-code:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 });
    }

    // Global admins may name an organization; SACCO admins are always their own.
    const targetOrgId = adminAuth.isGlobalAdmin ? (organizationId || adminAuth.tenantId) : adminAuth.tenantId;
    if (!targetOrgId) {
      return NextResponse.json({ error: 'Organization is required' }, { status: 400 });
    }

    const tenantCheck = assertTenantMatch(adminAuth, targetOrgId);
    if (!tenantCheck.allowed) {
      return NextResponse.json({ error: tenantCheck.error }, { status: 403 });
    }

    const { data: org, error: orgErr } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name, join_code')
      .eq('id', targetOrgId)
      .maybeSingle();

    if (orgErr || !org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }

    // Self-heal: codes minted by migration 24's SQL default came from UUID hex
    // and can contain '0'/'1', which the join-link alphabet excludes — those
    // links never worked. Migration 38 backfills them, but rows created outside
    // migrations (or before it ran) are healed here on read so the admin is
    // always shown a working link.
    const storedCode = typeof org.join_code === 'string' ? org.join_code : '';
    const autoHeal = action === 'get' && !normalizeJoinCode(storedCode);

    if (action === 'regenerate' || autoHeal) {
      if (autoHeal && storedCode) {
        // Preserve any link already shared under this legacy code via the
        // closed alias mapping (tolerates the table not existing pre-migration).
        const { error: aliasErr } = await supabaseAdmin
          .schema('kunity')
          .from('join_code_aliases')
          .upsert({ legacy_code: storedCode, organization_id: org.id }, { onConflict: 'legacy_code', ignoreDuplicates: true });
        if (aliasErr) {
          console.warn('[join-code] could not preserve legacy alias (table missing or conflict):', aliasErr.message);
        }
      } else {
        // Admin-initiated rotation: the UI promises older links stop working
        // immediately, so drop every legacy alias for this SACCO as well.
        const { error: clearErr } = await supabaseAdmin
          .schema('kunity')
          .from('join_code_aliases')
          .delete()
          .eq('organization_id', org.id);
        if (clearErr) {
          console.warn('[join-code] could not clear legacy aliases (table missing?):', clearErr.message);
        }
      }

      // Retry on the (very unlikely) unique-index collision.
      let newCode: string | null = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < 5 && !newCode; attempt++) {
        const candidate = generateJoinCode();
        const { error: updErr } = await supabaseAdmin
          .schema('kunity')
          .from('organizations')
          .update({ join_code: candidate })
          .eq('id', org.id);
        if (!updErr) newCode = candidate;
        else lastErr = updErr;
      }
      if (!newCode) {
        console.error('[join-code] regenerate failed:', lastErr);
        return NextResponse.json({ error: 'Could not create a new join code. Please try again.' }, { status: 500 });
      }

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id,
        tenantId: org.id,
        action: 'join_code_regenerated',
        entityType: 'organization',
        entityId: org.id,
        oldData: {
          join_code_last4: (org.join_code || '').slice(-4),
          reason: autoHeal ? 'auto_heal_non_conforming_code' : 'admin_regenerate',
        },
        newData: { join_code_last4: newCode.slice(-4) },
        ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
        userAgent: req.headers.get('user-agent') || undefined,
      });

      return NextResponse.json({ success: true, joinCode: newCode, organizationName: org.name });
    }

    return NextResponse.json({ success: true, joinCode: org.join_code, organizationName: org.name });
  } catch (err: any) {
    console.error('Error in /api/admin/join-code:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
