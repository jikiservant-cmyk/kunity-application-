import { createClient } from '@supabase/supabase-js';

async function checkTables() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !supabaseServiceKey) {
    console.log('Missing Supabase keys');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const tables = ['sms_configs', 'sms_templates', 'sms_messages', 'sms_webhook_logs', 'tenants', 'applications'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    console.log(`Table ${table}:`, error ? error.message : "Exists!");
  }
}

checkTables();
