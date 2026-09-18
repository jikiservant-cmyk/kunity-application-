-- supabase/migrations/09_grant_sms_tables.sql
GRANT ALL PRIVILEGES ON TABLE public.sms_configs TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_configs TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.sms_templates TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_templates TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.sms_messages TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_messages TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.sms_webhook_logs TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sms_webhook_logs TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.tenants TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenants TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.applications TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.applications TO anon, authenticated;
