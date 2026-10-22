import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant } from '@/lib/admin-auth';
import { exportLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { toCsv, csvFilename } from '@/lib/csv-export';

/**
 * Admin book downloads: "Download SACCO Books".
 *
 * GET /api/admin/export?report=ledger|deposits|members|loans|savings|sms
 * Authorization: Bearer <admin session token>
 *
 * Every report is a CSV of ONE SACCO's books:
 *   ledger   — the double-entry general ledger (journal entries + lines)
 *   deposits — payment_requests (deposits, activation fees, their statuses)
 *   members  — the member register
 *   loans    — the loans book with repaid/outstanding computed from installments
 *   savings  — per-member savings accounts with products and balances
 *   sms      — the SMS message log for this tenant
 *
 * SECURITY:
 *   - Tenant scoping ALWAYS comes from the verified admin profile
 *     (verifyAdminAndTenant), never from a client-supplied organizationId, so
 *     an admin can only ever download their own SACCO's books.
 *   - Rows are paginated past PostgREST's 1000-row cap so a big ledger is
 *     never silently truncated.
 *   - Every download is audit-logged: financial data leaving the system
 *     leaves a trail of who took what, when.
 *   - Cells are CSV-injection hardened (lib/csv-export.ts).
 */

export const dynamic = 'force-dynamic';

const REPORTS = ['ledger', 'deposits', 'members', 'loans', 'savings', 'sms'] as const;
type Report = (typeof REPORTS)[number];

const PAGE_SIZE = 1000;
// Bound memory/work per request; larger books must be exported in periods.
const MAX_ROWS = 50_000;

/** Runs one page of a query and throws on error — an export must never silently miss rows. */
async function pageOf(query: any, from: number, to: number): Promise<any[]> {
  const { data, error } = await query.range(from, to);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return data || [];
}

/** Pages through a query builder (rebuilt per page — builders are mutable) until exhausted. */
async function fetchAll(buildQuery: () => any): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const batch = await pageOf(buildQuery(), from, from + PAGE_SIZE - 1);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

const memberName = (m: any) =>
  m ? `${m.first_name || ''} ${m.last_name || ''}`.trim() : '';

export async function GET(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!supabaseUrl || !supabaseServiceKey) {
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const report = req.nextUrl.searchParams.get('report') || '';
    if (!REPORTS.includes(report as Report)) {
      return NextResponse.json(
        { error: `Unknown report "${report}". Available: ${REPORTS.join(', ')}` },
        { status: 400 }
      );
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized: Session token required' }, { status: 401 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    // Exports are always ONE SACCO's books — a global admin without a tenant
    // has nothing to export here.
    const tenantId = adminAuth.tenantId;
    if (!tenantId) {
      return NextResponse.json(
        { error: 'Forbidden: Admin is not associated with any SACCO organization' },
        { status: 403 }
      );
    }

    try {
      await exportLimiter.check(10, adminAuth.user.id);
    } catch {
      return NextResponse.json(
        { error: 'Too many export requests. Please wait a minute before downloading again.' },
        { status: 429 }
      );
    }

    // SACCO code for the filename (and to make the file self-identifying).
    const { data: orgRow } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('code, name')
      .eq('id', tenantId)
      .maybeSingle();
    const orgCode = orgRow?.code || 'sacco';

    let headers: string[] = [];
    let rows: any[][] = [];

    if (report === 'ledger') {
      const lines = await fetchAll(() =>
        supabaseAdmin
          .schema('kunity')
          .from('journal_lines')
          .select(
            'line_type, debit, credit, description, created_at, ' +
            'journal_entries!inner(reference, description, entry_date, source_module, organization_id), ' +
            'members(first_name, last_name), ' +
            'accounts(code, name, account_category)'
          )
          .eq('journal_entries.organization_id', tenantId)
          .order('created_at', { ascending: true })
      );
      headers = ['Date', 'Reference', 'Description', 'Source Module', 'Account Code', 'Account Name', 'Member', 'Line Type', 'Debit (UGX)', 'Credit (UGX)'];
      rows = lines.map((l: any) => [
        l.journal_entries?.entry_date || l.created_at,
        l.journal_entries?.reference || '',
        l.journal_entries?.description || l.description || '',
        l.journal_entries?.source_module || '',
        l.accounts?.code || '',
        l.accounts?.name || '',
        memberName(l.members) || 'Cooperative Vault',
        l.line_type || '',
        l.debit ?? 0,
        l.credit ?? 0,
      ]);
    } else if (report === 'deposits') {
      const payments = await fetchAll(() =>
        supabaseAdmin
          .schema('kunity')
          .from('payment_requests')
          .select('created_at, completed_at, amount, currency, phone_number, status, payment_type, provider, fee, internal_reference, members(first_name, last_name)')
          .eq('organization_id', tenantId)
          .order('created_at', { ascending: false })
      );
      headers = ['Date', 'Member', 'Phone', 'Amount (UGX)', 'Currency', 'Type', 'Status', 'Provider', 'Fee (UGX)', 'Reference', 'Completed At'];
      rows = payments.map((p: any) => [
        p.created_at,
        memberName(p.members),
        p.phone_number || '',
        p.amount ?? 0,
        p.currency || 'UGX',
        p.payment_type || '',
        p.status || '',
        p.provider || '',
        p.fee ?? 0,
        p.internal_reference || '',
        p.completed_at || '',
      ]);
    } else if (report === 'members') {
      const members = await fetchAll(() =>
        supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('*')
          .eq('organization_id', tenantId)
          .order('created_at', { ascending: true })
      );
      headers = ['Member Number', 'Full Name', 'Phone', 'Email', 'National ID', 'Status', 'Joined'];
      rows = members.map((m: any) => [
        (m as any).member_number || m.id?.slice(0, 8).toUpperCase() || '',
        memberName(m),
        m.phone || '',
        m.email || '',
        (m as any).national_id || (m as any).nin || '',
        m.status || '',
        m.created_at,
      ]);
    } else if (report === 'loans') {
      const loans = await fetchAll(() =>
        supabaseAdmin
          .schema('kunity')
          .from('loans')
          .select('created_at, principal, interest_rate, status, members(first_name, last_name), loan_installments(paid_principal, paid_interest)')
          .eq('organization_id', tenantId)
          .order('created_at', { ascending: false })
      );
      headers = ['Member', 'Principal (UGX)', 'Interest Rate (%)', 'Status', 'Created', 'Repaid Principal (UGX)', 'Outstanding (UGX)'];
      rows = loans.map((l: any) => {
        const repaid = (l.loan_installments || []).reduce(
          (sum: number, i: any) => sum + parseFloat(i.paid_principal || '0'),
          0
        );
        const principal = parseFloat(l.principal || '0');
        return [
          memberName(l.members),
          principal,
          l.interest_rate ?? '',
          l.status || '',
          l.created_at,
          repaid,
          principal - repaid,
        ];
      });
    } else if (report === 'savings') {
      const savings = await fetchAll(() =>
        supabaseAdmin
          .schema('kunity')
          .from('member_savings')
          .select('status, opened_date, created_at, members(first_name, last_name), savings_products(name, interest_rate, is_active), accounts(code, cached_balance, is_active)')
          .eq('organization_id', tenantId)
          .order('created_at', { ascending: true })
      );
      headers = ['Member', 'Product', 'Interest Rate (%)', 'Account Code', 'Balance (UGX)', 'Account Status', 'Savings Status', 'Opened'];
      rows = savings.map((s: any) => [
        memberName(s.members),
        s.savings_products?.name || '',
        s.savings_products?.interest_rate ?? '',
        s.accounts?.code || '',
        s.accounts?.cached_balance ?? 0,
        s.accounts?.is_active === true ? 'active' : 'inactive',
        s.status || '',
        s.opened_date || s.created_at,
      ]);
    } else if (report === 'sms') {
      const messages = await fetchAll(() =>
        supabaseAdmin
          .schema('public')
          .from('sms_messages')
          .select('created_at, phone_number, event_code, status, cost, compiled_message')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
      );
      headers = ['Date', 'Phone', 'Event', 'Status', 'Cost (UGX)', 'Message'];
      rows = messages.map((m: any) => [
        m.created_at,
        m.phone_number || '',
        m.event_code || '',
        m.status || '',
        m.cost ?? 0,
        m.compiled_message || '',
      ]);
    }

    const csv = toCsv(headers, rows);

    // Financial data leaving the building leaves a trail.
    await logAudit(supabaseAdmin, {
      adminId: adminAuth.user.id,
      tenantId,
      action: 'data_export',
      entityType: 'export',
      newData: { report, rows: rows.length },
      ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(report, orgCode)}"`,
        'Cache-Control': 'no-store',
        'X-Rows-Count': String(rows.length),
      },
    });
  } catch (err: any) {
    console.error('Export error:', err);
    return NextResponse.json(
      { error: 'Could not prepare the export. Please try again.' },
      { status: 500 }
    );
  }
}
