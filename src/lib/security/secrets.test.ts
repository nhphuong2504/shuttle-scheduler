import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The secrets guard.
 *
 * ## What it protects, and why a test rather than a review
 *
 * This project holds exactly one dangerous credential: the Supabase **service-role key**.
 * It bypasses Row Level Security completely - it is not a user with more permissions, it
 * is the database - so a leak is not a bug, it is the whole dataset. Two ways to leak it
 * are one keystroke away and neither is visible in review:
 *
 *   1. Giving it a `VITE_` prefix, or reading it in a client module. Vite inlines every
 *      `VITE_*` value into the browser bundle, so the key would be served to every visitor
 *      and readable with View Source.
 *   2. Committing it. `.env` is git-ignored, but that only helps until someone copies the
 *      value into a fixture, a workflow file or a test.
 *
 * The posture is currently clean, which is exactly when it is worth pinning: the guard
 * costs nothing while it passes, and its only job is to make the moment it stops passing
 * loud. A future agent adding an integration lane is the realistic failure mode, and this
 * fails their build rather than their review.
 *
 * ## Scope: it detects values, not names
 *
 * Mentioning `SUPABASE_SERVICE_ROLE_KEY` is fine and this file itself does it - the server
 * client reads it, the operator scripts read it, and `.env.example` documents it. What
 * must never appear is a *value*. So the checks look for key-shaped strings and for
 * decoded JWTs, never for an identifier.
 */

const ROOT = join(__dirname, "../../..");
const SELF = join(__dirname, "secrets.test.ts");

/** Files a scan of the working tree should skip entirely. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".output",
  ".tanstack",
  ".nitro",
  ".wrangler",
  ".benchmark",
  "test-results",
  "playwright-report",
  ".vinxi",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Text extensions worth scanning; binary files would only produce noise. */
const TEXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".sql",
  ".css",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
  ".example",
  "",
]);

function textFiles(dir: string): string[] {
  return walk(dir).filter((file) => TEXT.has(extname(file)) && file !== SELF);
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Key-shaped strings, matched so that *mentioning* a prefix is not a hit.
 *
 * `sb_secret_` on its own appears legitimately in `src/integrations/supabase/client.ts`,
 * which compares against that prefix to decide whether a key is opaque or a JWT. Requiring
 * 20 further characters distinguishes the prefix from a key every time.
 */
const KEY_SHAPED: { name: string; pattern: RegExp }[] = [
  { name: "a secret API key", pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: "a JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
];

/** Decodes every JWT payload it can find in a file. */
function jwtPayloads(text: string): string[] {
  const payloads: string[] = [];
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/g)) {
    const segment = match[0].split(".")[1];
    if (!segment) continue;
    try {
      payloads.push(Buffer.from(segment, "base64url").toString("utf8"));
    } catch {
      // Not a decodable payload, so not a token we can reason about.
    }
  }
  return payloads;
}

const tracked = (): string[] => {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    // No git available (a tarball checkout, say). The tracked-files checks then cannot
    // run, but the working-tree checks below still do.
    return [];
  }
};

describe("the service-role key is never exposed", () => {
  it("is not given a VITE_ prefix anywhere, which would inline it into the bundle", () => {
    const offenders: string[] = [];
    for (const file of [...textFiles(join(ROOT, "src")), ...textFiles(ROOT)]) {
      for (const match of read(file).matchAll(/VITE_[A-Za-z0-9_]*(SERVICE_ROLE|SECRET)[A-Za-z0-9_]*/g)) {
        offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect([...new Set(offenders)].sort(), "a VITE_-prefixed service key is client-visible").toEqual(
      [],
    );
  });

  it("does not appear as a key-shaped value in src/", () => {
    const offenders: string[] = [];
    for (const file of textFiles(join(ROOT, "src"))) {
      const text = read(file);
      for (const { name, pattern } of KEY_SHAPED) {
        const match = text.match(pattern);
        if (match) offenders.push(`${relative(ROOT, file)} contains ${name}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("does not appear in any tracked file", () => {
    const offenders: string[] = [];
    for (const path of tracked()) {
      const file = join(ROOT, path);
      if (file === SELF || !existsSync(file)) continue;
      const text = read(file);

      for (const { name, pattern } of KEY_SHAPED) {
        // A JWT is only conclusive once decoded; a bare `eyJ.eyJ` pair in prose is not.
        if (name === "a JWT") continue;
        if (pattern.test(text)) offenders.push(`${path} contains ${name}`);
      }

      for (const payload of jwtPayloads(text)) {
        if (/"role"\s*:\s*"service_role"/.test(payload)) {
          offenders.push(`${path} contains a service-role JWT`);
        }
      }

      // An actual assignment, not the commented placeholder `.env.example` documents.
      if (/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+/m.test(text)) {
        offenders.push(`${path} assigns SUPABASE_SERVICE_ROLE_KEY`);
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      "a credential is committed; rotate it and remove it from history",
    ).toEqual([]);
  });

  it("is absent from the local .env, which is the only place it may ever live", () => {
    const envPath = join(ROOT, ".env");
    if (!existsSync(envPath)) return; // A fresh checkout, or CI, which must have none.
    const env = read(envPath);
    expect(
      /^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+/m.test(env),
      "The service-role key is present locally. Never add it to a VITE_ variable, and " +
        "never copy it anywhere tracked.",
    ).toBe(false);
  });

  it("keeps recorded auth sessions untracked and ignored", () => {
    expect(
      tracked().some((path) => path.startsWith("e2e/.auth/")),
      "a recorded auth session is committed; remove it and rotate the token",
    ).toBe(false);

    const ignore = read(join(ROOT, ".gitignore"));
    expect(
      ignore.includes("e2e/.auth/"),
      ".gitignore no longer excludes e2e/.auth/, so a recorded session could be committed",
    ).toBe(true);
  });
});
