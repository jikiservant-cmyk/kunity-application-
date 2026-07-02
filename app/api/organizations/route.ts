import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in organizations API');
      return NextResponse.json({ error: 'Database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
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

    if (!orgs || orgs.length === 0) {
      console.log('🆕 No organizations found in DB - creating default cooperative...');
      const { data: newOrg, error: createError } = await supabaseAdmin
        .schema('kunity')
        .from('organizations')
        .insert({
          name: 'Default Sacco',
          code: 'DEF',
          email: 'hello@def.com',
        })
        .select('id, name')
        .single();

      if (createError) {
        console.error('❌ Error creating default organization:', createError);
        return NextResponse.json({ error: createError.message }, { status: 500 });
      }

      if (newOrg) {
        orgs = [newOrg];
      }
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
