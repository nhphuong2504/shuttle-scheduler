import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PublicShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { pilotSignupMetadata } from "@/lib/legal/policy";
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
        content:
          "Sign in or create an account to register for a tournament or run your own on Tournova.",
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
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);

  const signingIn = mode === "signin";

  const switchMode = (next: Mode) => {
    setMode(next);
    setProblem(null);
    setMissing({});
    setConfirmEmail(null);
    setAdultConfirmed(false);
    setEmail("");
    setPassword("");
    setShowPassword(false);
    setTermsAccepted(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const gaps: { email?: string; password?: string } = {};
    if (!email.trim()) gaps.email = "Enter your email.";
    if (!password) gaps.password = "Enter your password.";
    setMissing(gaps);
    setProblem(null);
    if (!signingIn && (!adultConfirmed || !termsAccepted)) {
      setProblem(
        "Confirm you are at least 18 and agree to the pilot terms before creating an account.",
      );
      return;
    }
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
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: pilotSignupMetadata(),
          },
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
    hasProblem ? "h-12 rounded-[10px] border-2 border-danger-foreground" : "h-12 rounded-[10px]";

  return (
    <PublicShell bare>
      <div className="mx-auto w-full max-w-[29rem] px-4 py-6 sm:py-12">
        <section
          aria-labelledby="auth-title"
          className="rounded-2xl border border-hairline bg-surface p-5 shadow-panel sm:p-8"
        >
          {confirmEmail ? (
            <div role="status" className="space-y-3">
              <h1 id="auth-title" className="font-display text-3xl font-bold">
                Check your email
              </h1>
              <p className="text-base text-muted-foreground">
                We sent a confirmation link to{" "}
                <strong className="break-words text-foreground">{confirmEmail}</strong>. Open it,
                then come back and sign in.
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
                className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1"
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
                    disabled={!interactive || busy}
                    onClick={() => switchMode(option.value)}
                    className={
                      mode === option.value
                        ? "h-11 rounded-lg border border-border-control bg-surface text-sm font-bold text-foreground"
                        : "h-11 rounded-lg text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="mb-6">
                <h1 id="auth-title" className="font-display text-3xl font-bold">
                  {signingIn ? "Sign in to Tournova" : "Create your account"}
                </h1>
                {!signingIn ? (
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Accounts are for people aged 18 or older. Players of all ages can take part
                    through an authorised adult organiser.
                  </p>
                ) : null}
                {search.redirect ? (
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {search.intent
                      ? signInIntentText(search.intent)
                      : "You'll go back to the page you were on."}
                  </p>
                ) : null}
              </div>

              <form
                onSubmit={(event) => void submit(event)}
                noValidate
                aria-busy={busy}
                className="mb-6 space-y-5"
              >
                {problem ? (
                  <div
                    role="alert"
                    className="rounded-lg border border-danger-border bg-danger-surface px-3.5 py-3 text-base"
                  >
                    <strong className="text-danger-foreground">{problem}</strong>
                  </div>
                ) : null}

                {!signingIn ? (
                  <fieldset className="space-y-3 border-b border-hairline pb-4">
                    <legend className="mb-2 text-sm font-semibold">
                      Before creating an account
                    </legend>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6">
                      <input
                        type="checkbox"
                        checked={adultConfirmed}
                        disabled={busy}
                        className="mt-1.5 size-4 shrink-0 accent-primary"
                        onChange={(event) => setAdultConfirmed(event.target.checked)}
                      />
                      <span>I am at least 18 years old.</span>
                    </label>
                    <p className="text-sm text-muted-foreground">
                      Under 18? You can still play. Ask your parent or guardian to arrange your
                      entry with the organiser. Do not create an account or enter your email here.
                    </p>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6">
                      <input
                        type="checkbox"
                        checked={termsAccepted}
                        disabled={busy}
                        className="mt-1.5 size-4 shrink-0 accent-primary"
                        onChange={(event) => setTermsAccepted(event.target.checked)}
                      />
                      <span>
                        I agree to the{" "}
                        <Link to="/terms" className="font-semibold underline underline-offset-4">
                          pilot Terms
                        </Link>
                        . I have read the{" "}
                        <Link to="/privacy" className="font-semibold underline underline-offset-4">
                          Privacy Policy
                        </Link>
                        .
                      </span>
                    </label>
                  </fieldset>
                ) : null}

                {signingIn || adultConfirmed ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="email">Email</Label>
                      <div className="relative">
                        <Input
                          id="email"
                          type="email"
                          autoComplete="email"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="name@example.com"
                          value={email}
                          disabled={busy}
                          aria-invalid={!!missing.email}
                          aria-describedby={missing.email ? "email-error" : undefined}
                          className={`${fieldClass(!!missing.email)} text-base`}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </div>
                      {missing.email ? (
                        <p
                          id="email-error"
                          className="text-sm font-semibold text-danger-foreground"
                        >
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
                          placeholder="••••••••"
                          autoComplete={signingIn ? "current-password" : "new-password"}
                          value={password}
                          disabled={busy}
                          aria-invalid={!!missing.password}
                          aria-describedby={
                            missing.password
                              ? "password-error"
                              : signingIn
                                ? undefined
                                : "password-hint"
                          }
                          className={`${fieldClass(!!missing.password)} pr-20 text-base`}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                        <button
                          type="button"
                          aria-pressed={showPassword}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          disabled={busy}
                          onClick={() => setShowPassword((value) => !value)}
                          className="absolute right-0.5 top-0.5 min-h-11 rounded-md px-3 text-sm font-semibold text-primary-ink hover:bg-muted"
                        >
                          {showPassword ? "Hide" : "Show"}
                        </button>
                      </div>
                      {missing.password ? (
                        <p
                          id="password-error"
                          className="text-sm font-semibold text-danger-foreground"
                        >
                          {missing.password}
                        </p>
                      ) : signingIn ? null : (
                        <p id="password-hint" className="text-sm text-muted-foreground">
                          Choose a password you don't use anywhere else.
                        </p>
                      )}
                    </div>
                  </>
                ) : null}

                <Button
                  type="submit"
                  disabled={!interactive || busy}
                  className="mt-2 h-12 w-full gap-2 rounded-[10px] text-base font-semibold"
                >
                  {busy ? (
                    <>
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-[18px] animate-spin motion-reduce:animate-none"
                      />
                      {signingIn ? "Signing in…" : "Creating account…"}
                    </>
                  ) : (
                    <>
                      {signingIn ? "Sign in" : "Create account"}
                      <ArrowRight aria-hidden="true" className="size-[18px]" />
                    </>
                  )}
                </Button>
              </form>

              <p className="border-t border-hairline pt-5 text-center text-sm leading-6 text-muted-foreground">
                Just want to look around?{" "}
                <Link to="/explore" className="font-semibold text-primary-ink underline">
                  Browse tournaments
                </Link>
                , no account needed.
              </p>
            </>
          )}
        </section>
        <details className="mt-4 text-sm text-muted-foreground">
          <summary className="min-h-11 cursor-pointer rounded-md py-3 text-center font-medium hover:text-foreground">
            What can I do with an account?
          </summary>
          <ul className="space-y-3 px-2 pb-3 leading-6">
            <li>
              <strong className="font-semibold text-foreground">Register for a tournament.</strong>{" "}
              Send your entry and follow the decision on your request.
            </li>
            <li>
              <strong className="font-semibold text-foreground">Run your own tournament.</strong>{" "}
              Set up events, build the schedule and add editors to help.
            </li>
            <li>
              <strong className="font-semibold text-foreground">Work a court.</strong> Start matches
              and enter scores once an organiser adds you as an editor.
            </li>
          </ul>
        </details>
      </div>
    </PublicShell>
  );
}
