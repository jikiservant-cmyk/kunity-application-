'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Loader2 } from 'lucide-react';

export default function LandingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        // Fetch role to redirect to correct dashboard
        const { data: profile } = await supabase
          .schema('public')
          .from('admin_profiles')
          .select('role')
          .eq('id', session.user.id)
          .maybeSingle();
          
        const role = profile?.role || 'member';
        const isAdmin = ['sacco_admin', 'super_admin', 'system_admin', 'admin'].includes(role);
        if (isAdmin) {
          router.replace('/admin');
        } else {
          router.replace('/member');
        }
      } else {
        router.replace('/auth');
      }
    };

    checkSession();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FEF6EE]">
      <Loader2 className="w-8 h-8 animate-spin text-[#F97316]" />
    </div>
  );
}
