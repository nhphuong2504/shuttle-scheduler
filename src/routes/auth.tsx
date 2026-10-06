import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PublicShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  localRedirect,
  normalizeSignInIntent,
  signedInDestination,
  signInIntentText,
  type SignInSearch,
} from "@/lib/routing/redirect";

export const Route = createFileRoute("/auth")({
  /**
   * The return address, narrowed to a local path or dropped.
   *
   * `validateSearch` is the one place the parameter is read, so an address that arrived
   * from anywhere - a link in a chat, a hand-edited URL - is reduced to a path in this app
   * or to nothing before any component sees it. `localRedirect` carries the rules and the
   * argument for each one; nothing here decides on its own.
   *
   * A rejected value is dropped from the search rather than kept and ignored, so the URL a
   * person copies on is one this page can read.
   *
   * The intent is narrowed to its own vocabulary and, like the address, dropped when it
   * does not survive. It is also read *only* beside a return address, which is the same
   * pairing `signInSearch` writes: what the page says for an intent is where the caller is
   * going, so with nowhere to go there is nothing to say. Reading it as a free-standing
   * parameter would let a hand-edited link put a promise on this page that the sign-in
   * cannot keep.
   */
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const redirect = localRedirect(search["redirect"]);
    if (!redirect) return {};
    const intent = normalizeSignInIntent(search["intent"]);
    return intent ? { redirect, intent } : { redirect };
  },
  head: () => ({
    meta: [
      { title: "Sign in | Tournova Tournament Ops" },
      {
        name: "description",
        content: "Sign in or create an account to register for a tournament or run your own on Tournova.",
      },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup";

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
 *
 * ## One card, two tabs
 *
 * The fields are identical, so the two doors share one form and a tab says which verb it
 * performs. Problems are shown in the page, above the form, rather than in a toast that
 * disappears before it is read, and the submit button stays enabled: an empty field is
 * answered with a sentence beside it, not with a greyed-out button.
 */
function AuthPage() {
  const navigate = useNavigate();
  /**
   * Where a successful sign-in or sign-up goes.
   *
   * The route's search has already been validated, so this is either a path in this app or
   * Home. Both doors use it: an account created from a "sign in to register" link should
   * land on the tournament that asked for it, exactly as a sign-in does.
   */
  const search = Route.useSearch();
  const destination = signedInDestination(search);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ email?: string; password?: string }>({});
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  const signingIn = mode === "signin";

  const switchMode = (next: Mode) => {
    setMode(next);
    setProblem(null);
    setMissing({});
    setConfirmEmail(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const gaps: { email?: string; password?: string } = {};
    if (!email.trim()) gaps.email = "Enter your email.";
    if (!password) gaps.password = "Enter your password.";
    setMissing(gaps);
    setProblem(null);
    if (gaps.email || gaps.password) return;

    setBusy(true);
    try {
      if (signingIn) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Signed in");
        void navigate({ to: destination });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        // With confirmation on there is no session yet, so "you are in" would be a lie.
        // The page says which of the two things happened rather than assuming.
        if (data.session) {
          toast.success("Account created. You can create a tournament now.");
          void navigate({ to: destination });
        } else {
          setConfirmEmail(email);
        }
      }
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : signingIn
            ? "Sign in failed. Try again."
            : "Could not create the account. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const fieldClass = (hasProblem: boolean) =>
    hasProblem ? "h-12 border-2 border-danger-foreground text-base" : "h-12 text-base";

  return (
    <PublicShell
      title={signingIn ? "Sign in to Tournova" : "Create your account"}
      subtitle={
        signingIn
          ? "An account lets you register for a tournament, or run your own. Watching a tournament never needs one."
          : "It takes an email and a password. Then you can register for a tournament or start your own."
      }
    >
      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-10">
        <aside className="flex flex-col justify-between gap-8 rounded-2xl border border-hairline bg-muted/50 p-6 sm:p-8">
          <div className="space-y-6">
            {search.redirect ? (
              <p className="inline-flex rounded-full bg-info-surface px-3.5 py-1.5 text-sm font-semibold text-info-foreground">
                {search.intent ? signInIntentText(search.intent) : "You'll go back to the page you were on."}
              </p>
            ) : null}
            <h2 className="font-display text-2xl font-bold">What an account is for</h2>
            <ol className="space-y-5 text-lg">
              {[
                ["Register", "for a tournament and see your request's status."],
                ["Run your own", "tournament and add editors to help."],
                ["Work a court", "when an organiser adds you as an editor."],
              ].map(([lead, rest], index) => (
                <li key={lead} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-info-surface font-score text-sm font-bold text-info-foreground"
                  >
                    {index + 1}
                  </span>
                  <span>
                    <strong>{lead}</strong> {rest}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <p className="border-t border-hairline pt-5 text-base text-muted-foreground">
            Anyone can create an account. Helping run somebody else's tournament needs its owner to
            add you.
          </p>
        </aside>

        <section
          aria-label={signingIn ? "Sign in" : "Create account"}
          className="rounded-2xl border border-hairline bg-surface p-6 shadow-panel sm:p-8"
        >
          {confirmEmail ? (
            <div role="status" className="space-y-3">
              <h2 className="font-display text-2xl font-bold">Check your email</h2>
              <p className="text-base text-muted-foreground">
                We sent a confirmation link to{" "}
                <strong className="text-foreground">{confirmEmail}</strong>. Open it, then come
                back and sign in.
              </p>
              <Button className="h-12 w-full text-base" onClick={() => switchMode("signin")}>
                Go to sign in
              </Button>
            </div>
          ) : (
            <>
              <div
                role="group"
                aria-label="Sign in or create an account"
                className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
              >
                {(
                  [
                    { value: "signin", label: "Sign in" },
                    { value: "signup", label: "Create account" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={mode === option.value}
                    onClick={() => switchMode(option.value)}
                    className={
                      mode === option.value
                        ? "min-h-11 rounded-lg bg-surface text-base font-bold text-foreground ring-1 ring-border-selected"
                        : "min-h-11 rounded-lg text-base font-semibold text-muted-foreground transition-colors hover:text-foreground"
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
  
              <form onSubmit={(event) => void submit(event)} noValidate className="mt-6 space-y-4">
                {problem ? (
                  <div
                    role="alert"
                    className="rounded-lg border border-danger-border bg-danger-surface px-3.5 py-3 text-base"
                  >
                    <strong className="text-danger-foreground">{problem}</strong>
                  </div>
                ) : null}
  
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    value={email}
                    disabled={busy}
                    aria-invalid={!!missing.email}
                    aria-describedby={missing.email ? "email-error" : undefined}
                    className={fieldClass(!!missing.email)}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  {missing.email ? (
                    <p id="email-error" className="text-sm font-semibold text-danger-foreground">
                      {missing.email}
                    </p>
                  ) : null}
                </div>
  
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={signingIn ? "current-password" : "new-password"}
                      value={password}
                      disabled={busy}
                      aria-invalid={!!missing.password}
                      aria-describedby={
                        missing.password ? "password-error" : signingIn ? undefined : "password-hint"
                      }
                      className={`${fieldClass(!!missing.password)} pr-20`}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((value) => !value)}
                      className="absolute right-1 top-1 min-h-10 rounded-md px-3 text-sm font-semibold text-primary-ink hover:bg-muted"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                  {missing.password ? (
                    <p id="password-error" className="text-sm font-semibold text-danger-foreground">
                      {missing.password}
                    </p>
                  ) : signingIn ? null : (
                    <p id="password-hint" className="text-sm text-muted-foreground">
                      Choose a password you don't use anywhere else.
                    </p>
                  )}
                </div>
  
                <Button type="submit" disabled={busy} className="h-12 w-full text-base font-semibold">
                  {busy
                    ? signingIn
                      ? "Signing in…"
                      : "Creating account…"
                    : signingIn
                      ? "Sign in"
                      : "Create account"}
                </Button>
              </form>
  
              <p className="mt-6 border-t border-hairline pt-5 text-sm text-muted-foreground">
                Just want to look around?{" "}
                <Link to="/explore" className="font-semibold text-primary-ink underline">
                  Browse tournaments
                </Link>
                , no account needed.
              </p>
            </>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
