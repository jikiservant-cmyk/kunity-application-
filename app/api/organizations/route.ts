import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseKey) {
      console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in organizations API');
      return NextResponse.json({ error: 'Database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    console.log('🔄 Fetching organizations from kunity.organizations...');
    let { data: orgs, error: fetchError } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name');

    if (fetchError) {
      console.error('❌ Error fetching organizations from DB:', fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    
    if (!orgs) {
      orgs = [];
    }


    console.log(`✅ Successfully loaded ${orgs?.length || 0} organizations`);
    return NextResponse.json({ organizations: orgs });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : 'Internal server error';
    console.error('❌ GET /api/organizations error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
