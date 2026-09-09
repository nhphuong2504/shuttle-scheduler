import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

export function useSession() {
  const [session, setSession] = useState<{ userEmail: string | null } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ? { userEmail: data.session.user.email ?? null } : null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ? { userEmail: s.user.email ?? null } : null);
      setReady(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, ready, signedIn: !!session };
}
