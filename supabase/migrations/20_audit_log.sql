BEGIN;

CREATE TABLE IF NOT EXISTS kunity.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL,
    tenant_id UUID,
    action VARCHAR(255) NOT NULL,
    entity_type VARCHAR(255) NOT NULL,
    entity_id UUID,
    old_data JSONB,
    new_data JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS: Only Super Admins and System Admins can view audit logs, or Sacco Admins for their own tenant
ALTER TABLE kunity.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view audit logs"
ON kunity.audit_log FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.admin_profiles ap
        WHERE ap.id = auth.uid()
        AND (
            ap.role IN ('system_admin', 'super_admin') 
            OR (ap.role = 'sacco_admin' AND ap.tenant_id = audit_log.tenant_id)
        )
    )
);

COMMIT;
