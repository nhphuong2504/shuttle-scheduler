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
      { property: "og:title", content: "Desk Sign In | ShuttleNet Tournament Ops" },
      { property: "og:description", content: "Control desk sign in for ShuttleNet badminton tournament operations." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (mode: "in" | "up") => {
    setBusy(true);
    try {
      const fn =
        mode === "in"
          ? supabase.auth.signInWithPassword({ email, password })
          : supabase.auth.signUp({
              email,
              password,
              options: { emailRedirectTo: `${window.location.origin}/` },
            });
      const { error } = await fn;
      if (error) throw error;
      toast.success(mode === "in" ? "Signed in" : "Desk account created");
      navigate({ to: "/" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Control desk sign in" subtitle="Staff accounts can enter scores and run generation.">
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
                onKeyDown={(e) => e.key === "Enter" && run("in")}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button disabled={busy || !email || !password} onClick={() => run("in")}>
                Sign in
              </Button>
              <Button variant="outline" disabled={busy || !email || !password} onClick={() => run("up")}>
                Create desk account
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
