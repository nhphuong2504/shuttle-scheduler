// Creates a staff login on a Supabase project, then proves the role actually resolves.
//
// WHY THIS IS NEEDED AT ALL
//
// The migrations seed `staff_roles` by email, so the authorization row for the first admin
// exists as soon as the schema is applied. What they cannot create is the identity in
// `auth.users`, because that is GoTrue's table and seeding it by hand would mean writing a
// password hash directly.
//
// There is no backfill to do, and this script deliberately does not attempt one. Email is
// the durable key:
//
//   - `on_auth_user_created_link_staff` is an AFTER INSERT trigger on `auth.users` that sets
//     `staff_roles.user_id` from a matching email, so creating the identity IS the linking
//     step - there is no second mapping to maintain.
//   - `current_staff_role()` matches on `user_id = auth.uid()` OR the JWT email, so it
//     resolves even before the trigger has run.
//
// Old UUIDs, password hashes and sessions are not carried across, and do not need to be.
//
// Usage:
//   node scripts/create-staff-login.mjs --project-ref <ref> --email <email> [--dry-run]
//                                       [--set-password | --reset-password]
//
// By default the password is generated inside this process and is never printed, so it cannot
// be recovered from this script's output. That is intentional: it leaves the account confirmed
// but unusable until a real password is set, which is the safe resting state.
//
// --set-password is the way to set a password someone actually knows. It prompts on the
// terminal with echo disabled and never transmits the value anywhere except Supabase's admin
// endpoint. Use it when recovery email is unavailable - a Supabase project rate-limits its
// mailer, and a rate-limited mailer blocks the dashboard's recovery flow entirely.
//
// WHY A PROMPT, AND NOT AN OPTION OR AN ENVIRONMENT VARIABLE
//
// Every other way of supplying a secret to a command leaks it somewhere durable:
//
//   --password <value>   lands in the shell history file (~/.zsh_history) and in `ps` output,
//                        which is world-readable on many systems.
//   PASSWORD=<value> ... lands in the environment, where child processes inherit it and
//                        `ps eww` reveals the full environment of a running process.
//   echo <value> | ...   lands in the shell history file, for the same reason as the first.
//
// A TTY prompt with echo off avoids all three. The value never reaches argv, never reaches the
// environment, and never appears in the terminal's scrollback. For that reason stdin must be a
// TTY: the script refuses a pipe rather than accept a password by a route that is routinely
// transcribed into a command.
//
// --reset-password is different and rarely what you want: it replaces the password with a new
// value generated inside the process and never printed. It exists so a verification run can
// obtain a session on an account whose password is unknown; it does not leave anyone able to
// sign in. Reach for --set-password when the goal is a usable login.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const projectRef = option("--project-ref");
const email = option("--email");
const dryRun = flag("--dry-run");
const setPassword = flag("--set-password");
const resetPassword = flag("--reset-password");

if (!projectRef || !email) {
  console.error(
    "Usage: node scripts/create-staff-login.mjs --project-ref <ref> --email <email>\n" +
      "         [--dry-run] [--set-password | --reset-password]",
  );
  process.exit(2);
}

// Both flags replace the password, by different means, so combining them has no coherent
// meaning. Refuse rather than pick one and surprise the operator.
if (setPassword && resetPassword) {
  console.error(
    "--set-password and --reset-password both replace the password, so pass only one.\n" +
      "--set-password  prompts for one you choose; the account becomes usable.\n" +
      "--reset-password generates one internally and never prints it; the account does not.",
  );
  process.exit(2);
}

function readAccessToken() {
  const fromEnv = process.env["SUPABASE_ACCESS_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(".env", "utf8");
    const match = text.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\n]+)"?\s*$/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // Fall through to the error below.
  }
  console.error("No access token. Set SUPABASE_ACCESS_TOKEN, or put it in the repository .env.");
  process.exit(2);
}

const accessToken = readAccessToken();
const apiRoot = `https://api.supabase.com/v1/projects/${projectRef}`;

/**
 * Reads a secret from the terminal with echo disabled.
 *
 * This is the only way a password enters this script, and the reason is documented at the top
 * of the file: an option would land in the shell history and in `ps`, and an environment
 * variable would land in the process environment. A TTY prompt avoids both, and the value is
 * held only in this process's memory.
 *
 * Refuses a non-TTY stdin. A pipe is how a password ends up written into a shell command, and
 * a shell command ends up in the history file - so accepting one would defeat the purpose.
 */
function promptHidden(label) {
  if (!process.stdin.isTTY) {
    console.error(
      "Refusing to read a password from a pipe or a file.\n" +
        "Passing it that way usually means writing it into the command itself, which stores it\n" +
        "in the shell history. Run this in a terminal and type the password at the prompt.",
    );
    process.exit(2);
  }

  process.stdout.write(label);

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const bytes = [];

    const settle = (fn, arg) => {
      // Restore the terminal before anything else, so a failure cannot leave the user typing
      // into a console with echo disabled.
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      fn(arg);
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) return settle(resolve, Buffer.from(bytes).toString("utf8"));
        if (byte === 0x03 || byte === 0x04) return settle(reject, new Error("aborted"));
        if (byte === 0x7f || byte === 0x08) {
          // Drop a whole character, not a byte, so backspacing a multi-byte character does not
          // leave a broken fragment behind.
          if (bytes.length > 0) {
            bytes.pop();
            while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop();
          }
          continue;
        }
        if (byte < 0x20) continue; // Ignore other control characters.
        bytes.push(byte);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Prompts twice and requires the entries to match, so a typo cannot set an unreachable password. */
async function readNewPassword() {
  const first = await promptHidden("New password: ");
  if (first.length < 8) {
    console.error("A password must be at least 8 characters. Nothing was changed.");
    process.exit(2);
  }

  // Confirmed rather than trusted. A mistyped password here would be set on the account and
  // then be unrecoverable without another admin write, which is the situation this flag exists
  // to get out of.
  const again = await promptHidden("Repeat password: ");
  if (first !== again) {
    console.error("The two entries did not match. Nothing was changed.");
    process.exit(2);
  }

  return first;
}

async function management(path, init) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      // Keep the raw body.
    }
    throw new Error(`${path} -> ${response.status} ${String(detail).trim()}`);
  }
  return text ? JSON.parse(text) : [];
}

const sql = (query) => management("/database/query", { method: "POST", body: JSON.stringify({ query }) });

const { url: projectUrl, publishable, secret } = await (async () => {
  const keys = await management("/api-keys?reveal=true");
  const publishableKey = keys.find((k) => k.type === "publishable")?.api_key;
  const secretKey = keys.find((k) => k.type === "secret")?.api_key;
  if (!publishableKey || !secretKey) throw new Error("could not resolve the project's API keys");
  return { url: `https://${projectRef}.supabase.co`, publishable: publishableKey, secret: secretKey };
})();

const normalize = (value) => value.trim().toLowerCase();

/** The staff row the migrations seed. Stated up front, because without it nothing else matters. */
const staffRows = await sql(
  `select email, role, user_id from public.staff_roles where email = '${normalize(email).replace(/'/g, "''")}'`,
);

if (staffRows.length === 0) {
  console.error(
    `No staff_roles row for ${normalize(email)} on ${projectRef}.\n` +
      "The migrations seed the first admin; if this is a different address, insert it first:\n" +
      `  INSERT INTO public.staff_roles (email, role) VALUES ('${normalize(email)}', 'admin');`,
  );
  process.exit(1);
}

const role = staffRows[0].role;
console.log(`project      ${projectRef}`);
console.log(`staff row    ${normalize(email)} -> role ${role}`);
console.log(`linked       ${staffRows[0].user_id ? "yes" : "no (the auth identity does not exist yet)"}`);

if (dryRun) {
  console.log("\nDry run: no identity created.");
  process.exit(0);
}

// GoTrue's admin endpoint. A confirmed identity, and a password this process never reveals.
const password = randomBytes(32).toString("base64url");
const createResponse = await fetch(`${projectUrl}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: normalize(email), password, email_confirm: true }),
});
const createBody = await createResponse.text();

let userId;
if (createResponse.ok) {
  userId = JSON.parse(createBody).id;
  console.log(`identity     created (${userId})`);
} else if (/already registered|already been registered|email_exists/i.test(createBody)) {
  // Idempotent: re-running is a no-op on the identity, which is what makes this safe to run
  // against production after a migration replay.
  const existing = await sql(
    `select id from auth.users where lower(email) = '${normalize(email).replace(/'/g, "''")}'`,
  );
  userId = existing[0]?.id;
  console.log(`identity     already exists (${userId})`);
} else {
  throw new Error(`creating the identity failed: ${createResponse.status} ${createBody.slice(0, 200)}`);
}

const linked = await sql(
  `select user_id from public.staff_roles where email = '${normalize(email).replace(/'/g, "''")}'`,
);
if (linked[0]?.user_id !== userId) {
  // Not fatal - `current_staff_role()` also matches the JWT email - but it means the trigger
  // did not do its job, and that is worth failing loudly on rather than discovering later.
  console.error(
    `\nstaff_roles.user_id is ${linked[0]?.user_id ?? "NULL"}, expected ${userId}.\n` +
      "The on_auth_user_created_link_staff trigger did not link the row. Check that it exists:\n" +
      "  select tgname from pg_trigger where tgrelid = 'auth.users'::regclass;",
  );
  process.exit(1);
}
console.log("linked       yes (trigger set staff_roles.user_id)");

// ---------------------------------------------------------------------------
// Verification. Everything above is setup; this is the part that can fail quietly later.
// ---------------------------------------------------------------------------

const identityIsNew = createResponse.ok;

// Verifying the role needs a real session, and a session needs a password that is known to
// this run. Use only one this run generated, or one explicitly asked for.
//
// Re-running must NOT reset the password on its own. The second run against a project finds
// the identity already present, and silently replacing its password would lock out whoever
// had set their own - a destructive side effect from a script whose stated job is to verify.
// So the reset is opt-in, and without it the run falls back to checking the same predicate
// `current_staff_role()` uses rather than skipping verification entirely.
// Replacing the password is one admin write. Both flags below differ only in where the new
// value comes from, so the endpoint and its error handling are written once.
async function replacePassword(value) {
  const response = await fetch(`${projectUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password: value }),
  });
  return { ok: response.ok, detail: (await response.text()).slice(0, 200) };
}

let sessionPassword;
// Drives the closing message. "generated" means nobody can sign in with what is on the account.
let passwordOrigin = "existing";

if (identityIsNew) {
  sessionPassword = password;
  passwordOrigin = "generated";
} else if (setPassword) {
  const typed = await readNewPassword();
  const replaced = await replacePassword(typed);
  if (!replaced.ok) {
    console.error(`setting the password failed: ${replaced.detail}`);
    process.exit(1);
  }
  console.log("password     set to the value entered at the prompt (never printed, never stored)");
  sessionPassword = typed;
  passwordOrigin = "typed";
} else if (resetPassword) {
  const replaced = await replacePassword(password);
  if (!replaced.ok) {
    console.error(`resetting the password failed: ${replaced.detail}`);
    process.exit(1);
  }
  console.log("password     replaced with a new value generated by this script");
  sessionPassword = password;
  passwordOrigin = "generated";
}

if (!sessionPassword) {
  console.log("\nverification");
  const predicate = await sql(
    `select role from public.staff_roles where user_id = '${userId}' or email = '${normalize(email).replace(/'/g, "''")}'`,
  );
  const matches = predicate[0]?.role === role;
  console.log(
    `  ${matches ? "PASS" : "FAIL"}  the predicate current_staff_role() uses resolves to ${role}`,
  );
  console.log(
    "  SKIP  end-to-end sign-in: this identity already existed, and its password is\n" +
      "        deliberately left alone so nobody is locked out. Pass --reset-password to\n" +
      "        replace it and run the full check, or sign in as this account yourself.",
  );
  if (!matches) process.exit(1);
  process.exit(0);
}

const tokenResponse = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: publishable, "Content-Type": "application/json" },
  body: JSON.stringify({ email: normalize(email), password }),
});
const tokenBody = await tokenResponse.text();
if (!tokenResponse.ok) {
  console.error(`sign-in failed, so the role cannot be verified: ${tokenBody.slice(0, 200)}`);
  process.exit(1);
}
const access = JSON.parse(tokenBody).access_token;

const rpc = async (name, body, bearer = access) => {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: publishable, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
};

let failures = 0;
const check = (label, passed, detail) => {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!passed) failures += 1;
};

console.log("\nverification");

const resolved = await rpc("current_staff_role", {});
const resolvedRole = resolved.body.replace(/"/g, "").trim();
check("current_staff_role() resolves", resolvedRole === role, `${JSON.stringify(resolved.body.trim())}`);

// An admin-only write. This is the assertion that matters: a resolved role that cannot
// actually write would look correct and be useless.
const draft = await rpc("create_tournament_draft", {
  p_payload: { name: "staff-login probe", venue_name: "staff-login probe" },
});
check("an admin-only RPC is allowed", draft.ok, draft.ok ? `created ${draft.body.trim()}` : draft.body.trim());

if (draft.ok) {
  const tournamentId = draft.body.replace(/"/g, "").trim();
  const removed = await rpc("delete_tournament_draft", { p_tournament_id: tournamentId });
  check("the probe tournament was cleaned up", removed.ok, removed.ok ? "deleted" : removed.body.trim());
}

// Contrast: an anonymous caller must be refused, so the check above is not passing for a
// reason unrelated to the role.
const anon = await rpc("create_tournament_draft", { p_payload: { name: "should not exist" } }, publishable);
check("an anonymous caller is refused", !anon.ok, `status ${anon.status}`);

// Say what actually happened to the password. The default path leaves an account nobody can
// sign into, and a closing line that did not distinguish that from a deliberate --set-password
// would be actively misleading.
const closing =
  passwordOrigin === "typed"
    ? "The password you entered is now in effect, and the checks above proved it works. It was\n" +
      "not printed, not written to disk, and not passed on the command line."
    : passwordOrigin === "generated"
      ? "The password was generated by this script and never printed, so it cannot be recovered\n" +
        "from this output. Re-run with --set-password to choose one and leave the account usable."
      : "This run did not change the password.";

console.log(
  failures === 0
    ? `\n${normalize(email)} is verified as ${role} on ${projectRef}.\n${closing}`
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
