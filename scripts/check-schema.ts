import { createClient } from '@supabase/supabase-js';

async function checkSchema() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  
  // Try to insert a dummy record and look at the error, or query information_schema
  const { data, error } = await supabase.rpc('execute_sql', { sql_query: "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sms_messages';" });
  
  if (error) {
    console.log("Error calling rpc:", error.message);
    
    // Alternative: direct SQL if we don't have rpc
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/sms_messages?limit=1`, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`
      }
    });
    const json = await res.json();
    console.log("Data from sms_messages:", json);
  } else {
    console.log("Columns:", data);
  }
}

checkSchema();
