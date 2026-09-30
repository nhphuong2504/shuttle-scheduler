// Creates a platform-role login on a Supabase project, then proves the role actually confers
// its privilege.
//
// WHY THIS IS NEEDED AT ALL
//
// The migrations seed `profiles` by email, so the authorization row for the first admin
// exists as soon as the schema is applied. What they cannot create is the identity in
// `auth.users`, because that is GoTrue's table and seeding it by hand would mean writing a
// password hash directly.
//
// There is no backfill to do, and this script deliberately does not attempt one. Email is
// the durable key:
//
//   - `on_auth_user_created_link_profile` is an AFTER INSERT trigger on `auth.users` that sets
//     `profiles.user_id` from a matching email, so creating the identity IS the linking
//     step - there is no second mapping to maintain. Its delete twin, `unlink_profile()`,
//     clears the link instead of deleting the row, which is what makes a recreate re-link.
//   - `current_system_role()` matches on `user_id = auth.uid()` OR the JWT email, so it
//     resolves even before the trigger has run.
//
// `profiles.system_role` is the platform axis only: `admin` or `user`. It is deliberately not
// per-tournament access, which is a row in `tournament_editors` or ownership of a tournament,
// and therefore not something this script can seed.
//
// Old UUIDs, password hashes and sessions are not carried across, and do not need to be.
//
// Usage:
//   node scripts/create-staff-login.mjs --project-ref <ref> --email <email> [--dry-run]
//
// The password is generated inside this process and is never printed, so it cannot be
// recovered from this script's output. That is intentional: it leaves the account confirmed
// but unusable until a real password is set, which is the safe resting state. Set one from
// the Supabase dashboard (Authentication -> Users), or with a recovery link once the site URL
// and redirect allowlist are configured.

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

if (!projectRef || !email) {
  console.error(
    "Usage: node scripts/create-staff-login.mjs --project-ref <ref> --email <email> [--dry-run]",
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

/**
 * The profiles row the migrations seed. Stated up front, because without it nothing else
 * matters: the trigger links an identity to a row, it never creates a privileged one.
 */
const profileRows = await sql(
  `select email, system_role, user_id from public.profiles where email = '${normalize(email).replace(/'/g, "''")}'`,
);

if (profileRows.length === 0) {
  console.error(
    `No profiles row for ${normalize(email)} on ${projectRef}.\n` +
      "The migrations seed the first admin; if this is a different address, insert it first:\n" +
      `  INSERT INTO public.profiles (email, system_role) VALUES ('${normalize(email)}', 'admin');`,
  );
  process.exit(1);
}

const role = profileRows[0].system_role;
console.log(`project      ${projectRef}`);
console.log(`profile      ${normalize(email)} -> system_role ${role}`);
console.log(`linked       ${profileRows[0].user_id ? "yes" : "no (the auth identity does not exist yet)"}`);

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
  `select user_id from public.profiles where email = '${normalize(email).replace(/'/g, "''")}'`,
);
if (linked[0]?.user_id !== userId) {
  // Not fatal - `current_system_role()` also matches the JWT email - but it means the trigger
  // did not do its job, and that is worth failing loudly on rather than discovering later.
  console.error(
    `\nprofiles.user_id is ${linked[0]?.user_id ?? "NULL"}, expected ${userId}.\n` +
      "The on_auth_user_created_link_profile trigger did not link the row. Check that it exists:\n" +
      "  select tgname from pg_trigger where tgrelid = 'auth.users'::regclass;",
  );
  process.exit(1);
}
console.log("linked       yes (trigger set profiles.user_id)");

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
// `current_system_role()` uses rather than skipping verification entirely.
let sessionPassword;
if (identityIsNew) {
  sessionPassword = password;
} else if (flag("--reset-password")) {
  const reset = await fetch(`${projectUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!reset.ok) {
    console.error(`resetting the password failed: ${(await reset.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log("password     replaced with a new value generated by this script");
  sessionPassword = password;
}

if (!sessionPassword) {
  console.log("\nverification");
  const predicate = await sql(
    `select system_role from public.profiles where user_id = '${userId}' or email = '${normalize(email).replace(/'/g, "''")}'`,
  );
  const matches = predicate[0]?.system_role === role;
  console.log(
    `  ${matches ? "PASS" : "FAIL"}  the predicate current_system_role() uses resolves to ${role}`,
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

const resolved = await rpc("current_system_role", {});
const resolvedRole = resolved.body.replace(/"/g, "").trim();
check(
  "current_system_role() resolves",
  resolvedRole === role,
  `${JSON.stringify(resolved.body.trim())}`,
);

// The discriminating probe, and the reason it is a separate check from the one above. A
// resolved role string that confers nothing would look correct and be useless, so this calls
// the predicate the RLS policies and the RPC guards actually branch on - and asserts it in
// both directions. A session that resolved `user` while `is_platform_admin()` answered true
// fails here rather than passing unnoticed.
const platform = await rpc("is_platform_admin", {});
const isPlatformAdmin = platform.ok && platform.body.replace(/"/g, "").trim() === "true";
check(
  `is_platform_admin() is ${role === "admin"}`,
  isPlatformAdmin === (role === "admin"),
  platform.body.trim(),
);

// Contrast: an anonymous caller has no profile at all, so the role cannot resolve for it.
// Without this the checks above could be passing for a reason unrelated to the session.
const anon = await rpc("current_system_role", {}, publishable);
check("an anonymous caller is refused", !anon.ok, `status ${anon.status}`);

console.log(
  failures === 0
    ? `\n${normalize(email)} is verified as ${role} on ${projectRef}.\n` +
        "The identity has a password generated by this script and never printed, so set a real\n" +
        "one before signing in: Supabase dashboard -> Authentication -> Users."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
