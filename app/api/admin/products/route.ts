import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyAdminAndTenant, assertTenantMatch } from '@/lib/admin-auth';
import { apiLimiter } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit-logger';
import { validateSavingsProduct, validateLoanProduct } from '@/lib/product-rules';

// SACCO admins list, create and activate/deactivate their own SACCO's savings and
// loan products. Every query is scoped to the admin's tenant; the client never
// chooses another SACCO (global admins may name one, as on the join-code route).
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
    const { token, organizationId, action } = body as {
      token?: string; organizationId?: string; action?: string;
    };
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const authResult = await verifyAdminAndTenant(supabaseAdmin, token);
    if (authResult.error || !authResult.auth) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const adminAuth = authResult.auth;

    try {
      await apiLimiter.check(60, `admin:products:${adminAuth.user.id}`);
    } catch {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 });
    }

    const targetOrgId = adminAuth.isGlobalAdmin ? (organizationId || adminAuth.tenantId) : adminAuth.tenantId;
    if (!targetOrgId) return NextResponse.json({ error: 'Organization is required' }, { status: 400 });
    const tenantCheck = assertTenantMatch(adminAuth, targetOrgId);
    if (!tenantCheck.allowed) return NextResponse.json({ error: tenantCheck.error }, { status: 403 });

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const ua = req.headers.get('user-agent') || undefined;

    if (action === 'list') {
      const [savings, loans] = await Promise.all([
        supabaseAdmin.schema('kunity').from('savings_products')
          .select('id, name, interest_rate, min_balance, allows_withdrawals, deposit_frequency, is_active, created_at')
          .eq('organization_id', targetOrgId).order('created_at', { ascending: true }),
        supabaseAdmin.schema('kunity').from('loan_products')
          .select('id, name, interest_rate, min_amount, max_amount, is_active, created_at')
          .eq('organization_id', targetOrgId).order('created_at', { ascending: true }),
      ]);
      if (savings.error || loans.error) {
        console.error('[admin/products] list failed:', savings.error || loans.error);
        return NextResponse.json({ error: 'Could not load products' }, { status: 500 });
      }
      return NextResponse.json({ success: true, savingsProducts: savings.data || [], loanProducts: loans.data || [] });
    }

    if (action === 'create_savings') {
      const v = validateSavingsProduct(body);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      const { data, error } = await supabaseAdmin.schema('kunity').from('savings_products')
        .insert({ ...v.value, organization_id: targetOrgId, is_active: true })
        .select('id, name, interest_rate, min_balance, allows_withdrawals, deposit_frequency, is_active')
        .single();
      if (error || !data) {
        console.error('[admin/products] create savings failed:', error);
        return NextResponse.json({ error: 'Could not create the savings product' }, { status: 500 });
      }
      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id, tenantId: targetOrgId, action: 'savings_product_created',
        entityType: 'savings_product', entityId: data.id, oldData: null, newData: v.value,
        ipAddress: ip, userAgent: ua,
      });
      return NextResponse.json({ success: true, product: data });
    }

    if (action === 'create_loan') {
      const v = validateLoanProduct(body);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      const { data, error } = await supabaseAdmin.schema('kunity').from('loan_products')
        .insert({ ...v.value, organization_id: targetOrgId, is_active: true })
        .select('id, name, interest_rate, min_amount, max_amount, is_active')
        .single();
      if (error || !data) {
        console.error('[admin/products] create loan failed:', error);
        return NextResponse.json({ error: 'Could not create the loan product' }, { status: 500 });
      }
      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id, tenantId: targetOrgId, action: 'loan_product_created',
        entityType: 'loan_product', entityId: data.id, oldData: null, newData: v.value,
        ipAddress: ip, userAgent: ua,
      });
      return NextResponse.json({ success: true, product: data });
    }

    if (action === 'set_active') {
      const { productType, productId, isActive } = body as { productType?: string; productId?: string; isActive?: unknown };
      if (productType !== 'savings' && productType !== 'loan') {
        return NextResponse.json({ error: 'Invalid productType' }, { status: 400 });
      }
      if (typeof productId !== 'string' || !/^[0-9a-f-]{36}$/i.test(productId)) {
        return NextResponse.json({ error: 'Invalid productId' }, { status: 400 });
      }
      if (typeof isActive !== 'boolean') return NextResponse.json({ error: 'isActive must be true or false' }, { status: 400 });

      const table = productType === 'savings' ? 'savings_products' : 'loan_products';
      const { data, error } = await supabaseAdmin.schema('kunity').from(table)
        .update({ is_active: isActive })
        .eq('id', productId)
        .eq('organization_id', targetOrgId)
        .select('id, is_active')
        .maybeSingle();
      if (error) return NextResponse.json({ error: 'Could not update the product' }, { status: 500 });
      if (!data) return NextResponse.json({ error: 'Product not found in your SACCO' }, { status: 404 });

      await logAudit(supabaseAdmin, {
        adminId: adminAuth.user.id, tenantId: targetOrgId,
        action: isActive ? `${productType}_product_activated` : `${productType}_product_deactivated`,
        entityType: `${productType}_product`, entityId: productId,
        oldData: { is_active: !isActive }, newData: { is_active: isActive },
        ipAddress: ip, userAgent: ua,
      });
      return NextResponse.json({ success: true, product: data });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: unknown) {
    console.error('Error in /api/admin/products:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
