import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { PublicShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Desk Sign In | Tournova Tournament Ops" },
      { name: "description", content: "Control desk sign in for Tournova badminton tournament operations." },
    ],
  }),
  component: AuthPage,
});

/**
 * Sign in, or create an account.
 *
 * Sign-up is open, and that is deliberate rather than incidental. There used to be an
 * invite list: `is_invited_email` was checked before an account could be created, and a
 * non-invited address was refused. That list was the whole of the old authorization
 * model - it decided who existed, and then a staff role decided what they could do. The
 * new model decides what someone may do per tournament instead, so an account on its own
 * grants nothing: signing up lets you create and own your own tournament, and it does not
 * let you touch anybody else's until its owner adds you as an editor.
 *
 * The database enforces that, which is why the page no longer asks. Removing the invite
 * check here is not a relaxation of the rule; the rule moved, and a client-side copy of it
 * would only be a second place for it to be wrong.
 */
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

  const signUp = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) throw error;
      // With confirmation on there is no session yet, so "you are in" would be a lie.
      // The message says which of the two things happened rather than assuming.
      if (data.session) {
        toast.success("Account created. You can create a tournament now.");
        navigate({ to: "/setup" });
      } else {
        toast.success("Account created. Check your email to confirm it, then sign in.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell
      title="Control desk sign in"
      subtitle="Sign in, or create an account to run your own tournament."
    >
      <div className="max-w-md">
        <Panel title="Sign in or create an account">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
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
            {/*
              Two verbs on one form, not a tab switch. The fields are identical, so a
              tab would only hide one of them; the buttons say which is which. "Sign in"
              stays first because that is the common case at a desk.
            */}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button disabled={busy || !email || !password} onClick={() => void signIn()}>
                Sign in
              </Button>
              <Button
                variant="outline"
                disabled={busy || !email || !password}
                onClick={() => void signUp()}
              >
                Create account
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone can create an account and run their own tournament. Editing somebody
              else's needs its owner to add you from the Access page.
            </p>
          </div>
        </Panel>
      </div>
    </PublicShell>
  );
}
