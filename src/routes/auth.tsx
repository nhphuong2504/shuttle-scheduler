import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Desk Sign In | ShuttleNet Tournament Ops" },
      { name: "description", content: "Control desk sign in for ShuttleNet badminton tournament operations." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Signed in");
      navigate({ to: "/" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const claimInvite = async () => {
    setBusy(true);
    try {
      const { data: invited, error: inviteError } = await supabase.rpc("is_invited_email", { value: email });
      if (inviteError) throw inviteError;
      if (!invited) throw new Error("This email has not been invited. Ask an administrator.");
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) throw error;
      toast.success("Staff account created. Sign in if email confirmation is disabled.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Control desk sign in" subtitle="Only invited staff accounts can operate the tournament.">
      <div className="max-w-md">
        <Panel title="Sign in">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void signIn()}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button disabled={busy || !email || !password} onClick={() => void signIn()}>
                Sign in
              </Button>
              <Button variant="outline" disabled={busy || !email || !password} onClick={() => void claimInvite()}>
                Claim invite
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
