import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: Request) {
  try {
    // Initialize a supabase client with the service role key to bypass RLS
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    console.log('📥 Profile setup request:', body);
    const { 
      userId, 
      fullName, 
      orgId, 
      email, 
      phone,
      gender,
      dateOfBirth,
      nationalId,
      address,
      nextOfKinName,
      nextOfKinPhone
    } = body;

    if (!userId || !orgId) {
      return NextResponse.json({ error: 'Missing userId or orgId' }, { status: 400 });
    }

    // Check if the member already exists in members table to avoid duplicate welcome messages if they edit profile
    const { data: existingMember } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    const isNewRegistration = !existingMember;

    // The database triggers automatically handle creating the row in public.admin_profiles from metadata,
    // which then triggers creation of the kunity.members row.
    // Here we write all the other collected sign-up information directly into kunity.members.
    console.log('🔄 Upserting member details in kunity.members...');
    const memberData = {
      id: userId,
      organization_id: orgId,
      profile_id: userId,
      member_number: userId,
      first_name: fullName.split(' ')[0] || fullName,
      last_name: fullName.split(' ').slice(1).join(' ') || '',
      email,
      phone,
      gender: gender || null,
      date_of_birth: dateOfBirth || null,
      national_id: nationalId || null,
      address: address || null,
      next_of_kin_name: nextOfKinName || null,
      next_of_kin_phone: nextOfKinPhone || null,
    };

    const { data: member, error: memberError } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .upsert(memberData, { onConflict: 'id' })
      .select('id')
      .single();

    if (memberError) {
      console.error('❌ Member error:', memberError);
      return NextResponse.json({ error: memberError.message }, { status: 500 });
    }
    console.log('✅ Member upserted successfully:', member);

    // If this is a brand new Sacco member registration, automatically dispatch a welcome message
    if (isNewRegistration && phone) {
      const firstName = fullName.split(' ')[0] || 'Member';
      const shortId = userId.slice(0, 8).toUpperCase();
      const welcomeMsg = `Hello ${firstName}, welcome to our SACCO! Your membership has been successfully activated. Your Member ID is: ${shortId}. Thank you for joining!`;
      try {
        const { inngest } = await import('../../../../lib/inngest/client');
        await inngest.send({
          name: 'sms/dispatch',
          data: {
            tenantId: orgId,
            recipientPhone: phone,
            message: welcomeMsg,
            eventType: 'WELCOME',
            originUrl: req.url,
            templateData: {
              first_name: firstName,
              member_id: shortId,
              sacco_name: 'our SACCO'
            }
          }
        });
        console.log(`[SMS welcome] Welcome SMS queued in Inngest successfully for ${phone}`);
      } catch (smsErr) {
        console.error('⚠️ Failed to send automatic welcome SMS:', smsErr);
      }
    }

    return NextResponse.json({ success: true });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('❌ API Route Exception:', JSON.stringify(err, null, 2));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
