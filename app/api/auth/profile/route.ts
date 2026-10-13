import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { profileUpdateLimiter, registrationLimiter } from '@/lib/rate-limit';
import { registrationBlockReason, identityChangeReason } from '@/lib/registration-guard';
import { normalizeJoinCode } from '@/lib/join-code';

export async function POST(req: NextRequest) {
  try {
    // 1. Database Configuration
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return NextResponse.json({ error: 'Server database configuration missing' }, { status: 500 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();

    // 2. Authentication & Session Verification
    // Resolve session token from Authorization Bearer header or request body
    const authHeader = req.headers.get('authorization');
    let token = '';
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.substring(7).trim();
    }
    if (!token && body.token) {
      token = String(body.token).trim();
    }

    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized: Valid session authentication token is required' },
        { status: 401 }
      );
    }

    // Cryptographically verify the session token with Supabase Auth
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authUser) {
      return NextResponse.json(
        { error: 'Unauthorized: Invalid or expired session token' },
        { status: 401 }
      );
    }

    // Rate limit profile setup / update requests per authenticated user
    try {
      await profileUpdateLimiter.check(20, `auth:profile:${authUser.id}`);
    } catch {
      return NextResponse.json(
        { error: 'Too many profile update requests. Please wait a moment before trying again.' },
        { status: 429 }
      );
    }

    const { 
      userId, 
      fullName, 
      orgId: requestedOrgId,
      joinCode,
      email, 
      phone,
      gender,
      dateOfBirth,
      nationalId,
      address,
      nextOfKinName,
      nextOfKinPhone
    } = body;

    // 3. Caller Identity Verification
    // CRITICAL: Bind operation strictly to the verified caller's authenticated user ID
    const authenticatedUserId = authUser.id;
    if (userId && userId !== authenticatedUserId) {
      return NextResponse.json(
        { error: 'Forbidden: Caller identity does not match requested user ID. Account tampering is prohibited.' },
        { status: 403 }
      );
    }

    // 4. Tenant Verification (join-link based)
    // The SACCO is taken ONLY from the join code. Clients can't pick a SACCO by
    // ID, so every member joins the SACCO whose link they were given.
    const normalizedCode = normalizeJoinCode(joinCode);
    if (!normalizedCode) {
      return NextResponse.json({ error: 'A valid SACCO join link is required to register.' }, { status: 400 });
    }

    const { data: targetOrg, error: orgErr } = await supabaseAdmin
      .schema('kunity')
      .from('organizations')
      .select('id, name, is_active')
      .eq('join_code', normalizedCode)
      .maybeSingle();

    if (orgErr || !targetOrg) {
      return NextResponse.json({ error: 'Invalid join link: SACCO not found' }, { status: 404 });
    }

    if (!targetOrg.is_active) {
      return NextResponse.json({ error: 'Forbidden: Selected SACCO organization is inactive' }, { status: 403 });
    }

    const orgId: string = targetOrg.id;

    // Any orgId sent by the client must agree with the join code.
    if (requestedOrgId && requestedOrgId !== orgId) {
      return NextResponse.json(
        { error: 'Forbidden: Organization does not match the join link' },
        { status: 403 }
      );
    }

    // If signup metadata specified a tenant_id, ensure orgId matches
    const metadataTenantId = authUser.user_metadata?.tenant_id;
    if (metadataTenantId && metadataTenantId !== orgId) {
      return NextResponse.json(
        { error: 'Forbidden: Specified organization does not match user registration tenant' },
        { status: 403 }
      );
    }

    // 5. Existing Member Check & Cross-Tenant Tampering Guard
    const { data: existingMember, error: fetchMemberErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .select('id, organization_id, status, phone, first_name, last_name, national_id, date_of_birth, gender')
      .eq('id', authenticatedUserId)
      .maybeSingle();

    if (fetchMemberErr) {
      console.error('Failed to query existing member status:', fetchMemberErr);
      return NextResponse.json({ error: 'Database error verifying member record' }, { status: 500 });
    }

    const cleanFullName = (fullName || authUser.user_metadata?.full_name || '').trim();
    const firstName = cleanFullName.split(' ')[0] || cleanFullName || 'Member';
    const lastName = cleanFullName.split(' ').slice(1).join(' ') || '';
    const memberEmail = email || authUser.email || null;

    if (existingMember) {
      // CRITICAL: An existing member cannot change or tamper with their assigned organization_id.
      // Their account is strictly bound to their verified SACCO tenant.
      if (existingMember.organization_id !== orgId) {
        return NextResponse.json(
          { error: 'Forbidden: Member already belongs to another SACCO organization. Cross-tenant migration is prohibited.' },
          { status: 403 }
        );
      }

      // Identity fields are locked once the membership has been processed.
      const identityBlock = identityChangeReason({
        memberStatus: existingMember.status,
        stored: {
          national_id: existingMember.national_id,
          date_of_birth: existingMember.date_of_birth,
          gender: existingMember.gender,
        },
        incoming: {
          ...(nationalId !== undefined ? { national_id: nationalId } : {}),
          ...(dateOfBirth !== undefined ? { date_of_birth: dateOfBirth } : {}),
          ...(gender !== undefined ? { gender } : {}),
        },
      });
      if (identityBlock) {
        return NextResponse.json({ error: identityBlock }, { status: 403 });
      }

      // A changed National ID must not belong to another member of this SACCO.
      if (nationalId && String(nationalId).trim() !== String(existingMember.national_id ?? '').trim()) {
        const { data: nidTaken } = await supabaseAdmin
          .schema('kunity')
          .from('members')
          .select('id')
          .eq('organization_id', orgId)
          .eq('national_id', String(nationalId).trim())
          .neq('id', authenticatedUserId)
          .limit(1)
          .maybeSingle();
        if (nidTaken) {
          return NextResponse.json({ error: 'This National ID is already registered with this SACCO. Please contact your SACCO.' }, { status: 409 });
        }
      }

      // Safe update: Only mutate allowable profile fields, never overwrite status or tenant
      const updatePayload: Record<string, any> = {
        first_name: firstName,
        last_name: lastName,
        email: memberEmail,
        updated_at: new Date().toISOString()
      };

      if (phone !== undefined) updatePayload.phone = phone;
      if (gender !== undefined) updatePayload.gender = gender;
      if (dateOfBirth !== undefined) updatePayload.date_of_birth = dateOfBirth;
      if (nationalId !== undefined) updatePayload.national_id = nationalId;
      if (address !== undefined) updatePayload.address = address;
      if (nextOfKinName !== undefined) updatePayload.next_of_kin_name = nextOfKinName;
      if (nextOfKinPhone !== undefined) updatePayload.next_of_kin_phone = nextOfKinPhone;

      const { error: updateErr } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .update(updatePayload)
        .eq('id', authenticatedUserId)
        .eq('organization_id', existingMember.organization_id);

      if (updateErr) {
        console.error('Failed to update member profile:', updateErr);
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }

      return NextResponse.json({ success: true, message: 'Member profile updated successfully' });
    }

    // 6. New Member Registration
    // Rate-limit new profiles per client network: one person can otherwise mint
    // unlimited accounts (and welcome SMS) by signing up again.
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    try {
      await registrationLimiter.check(5, `register:${clientIp}`);
    } catch (rlErr: unknown) {
      return NextResponse.json({ error: (rlErr as Error).message }, { status: 429 });
    }

    // A person already declined by THIS SACCO may not re-register under a new
    // email (matched by National ID or phone); a National ID already held by
    // another member of this SACCO is refused.
    // Two plain equality lookups (no string-built filter from user input).
    let matchesDeclinedMember = false;
    const declinedChecks: Array<[string, string]> = [];
    if (nationalId) declinedChecks.push(['national_id', String(nationalId).trim()]);
    if (phone) declinedChecks.push(['phone', String(phone).trim()]);
    for (const [column, value] of declinedChecks) {
      const { data: declined } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('id')
        .eq('organization_id', orgId)
        .eq('status', 'rejected')
        .eq(column, value)
        .limit(1)
        .maybeSingle();
      if (declined) matchesDeclinedMember = true;
    }
    let nationalIdTakenByOtherMember = false;
    if (nationalId) {
      const { data: nidTaken } = await supabaseAdmin
        .schema('kunity')
        .from('members')
        .select('id')
        .eq('organization_id', orgId)
        .eq('national_id', String(nationalId).trim())
        .limit(1)
        .maybeSingle();
      nationalIdTakenByOtherMember = !!nidTaken;
    }
    const registrationBlock = registrationBlockReason({ matchesDeclinedMember, nationalIdTakenByOtherMember });
    if (registrationBlock) {
      return NextResponse.json({ error: registrationBlock }, { status: 403 });
    }

    // Strictly create the member under authenticatedUserId and verified orgId
    const newMemberData = {
      id: authenticatedUserId,
      organization_id: orgId,
      profile_id: authenticatedUserId,
      member_number: authenticatedUserId.slice(0, 8).toUpperCase(),
      first_name: firstName,
      last_name: lastName,
      email: memberEmail,
      phone: phone || null,
      gender: gender || null,
      date_of_birth: dateOfBirth || null,
      national_id: nationalId || null,
      address: address || null,
      next_of_kin_name: nextOfKinName || null,
      next_of_kin_phone: nextOfKinPhone || null,
      status: 'pending', // Starts in pending status for SACCO admin verification
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error: insertErr } = await supabaseAdmin
      .schema('kunity')
      .from('members')
      .insert(newMemberData);
    // SMS SAFETY: only the request that created the row sends the welcome SMS. A racing
    // request that hits the duplicate-key branch below must not send a second one.
    const createdHere = !insertErr;

    if (insertErr) {
      // If a database trigger inserted a minimal row concurrently during auth signup:
      if (insertErr.code === '23505') {
        const { error: retryUpdateErr } = await supabaseAdmin
          .schema('kunity')
          .from('members')
          .update({
            first_name: firstName,
            last_name: lastName,
            email: memberEmail,
            phone: phone || null,
            gender: gender || null,
            date_of_birth: dateOfBirth || null,
            national_id: nationalId || null,
            address: address || null,
            next_of_kin_name: nextOfKinName || null,
            next_of_kin_phone: nextOfKinPhone || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', authenticatedUserId)
          .eq('organization_id', orgId);

        if (retryUpdateErr) {
          return NextResponse.json({ error: retryUpdateErr.message }, { status: 500 });
        }
      } else {
        console.error('Failed to register member profile:', insertErr);
        return NextResponse.json({ error: insertErr.message }, { status: 500 });
      }
    }

    // 7. Queue Member Welcome SMS Notification
    if (phone && createdHere) {
      const shortId = authenticatedUserId.slice(0, 8).toUpperCase();
      const saccoName = targetOrg.name || 'our SACCO';
      const welcomeMsg = `Hello ${firstName}, welcome to ${saccoName}! Your membership application has been received. Your Member ID is: ${shortId}. Keep this ID for your records.`;
      try {
        const { inngest } = await import('@/lib/inngest/client');
        await inngest.send({
          // Deduplicates the welcome SMS per member for the event retention window.
          id: `welcome-${authenticatedUserId}`,
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
              sacco_name: saccoName
            }
          }
        });
      } catch (smsErr) {
        console.warn('Could not queue member welcome SMS notification:', smsErr);
      }
    }

    return NextResponse.json({ success: true, message: 'Member profile registered successfully' });

  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as any).message)
        : 'Internal server error';

    console.error('API Route Exception in /api/auth/profile:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
