import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { StaffRoleName } from "@/lib/tournament/data";

export function useSession() {
  const [session, setSession] = useState<{ userEmail: string | null; userId: string | null } | null>(null);
  const [role, setRole] = useState<StaffRoleName | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      const next = data.session
        ? { userEmail: data.session.user.email ?? null, userId: data.session.user.id }
        : null;
      setSession(next);
      if (next) {
        const { data: roleName } = await supabase.rpc("current_staff_role");
        if (active) setRole((roleName as StaffRoleName | null) ?? null);
      } else {
        setRole(null);
      }
      setReady(true);
    };
    void load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      void load();
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const can = (...needed: StaffRoleName[]) => !!role && needed.includes(role);

  return {
    session,
    ready,
    signedIn: !!session,
    role,
    isAdmin: role === "admin",
    canRegister: can("admin", "registrar"),
    canScore: can("admin", "scorer"),
    canSchedule: can("admin", "scheduler"),
    canGenerate: can("admin", "registrar"),
  };
}
