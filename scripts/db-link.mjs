#!/usr/bin/env node
/**
 * `supabase link` against the project named by SUPABASE_PROJECT_ID.
 *
 * The npm script used to read `"$SUPABASE_PROJECT_ID"` inline, which is POSIX shell syntax:
 * npm runs scripts through cmd.exe on Windows, so the CLI received that literal text. Reading
 * the variable here behaves the same on every platform (see scripts/e2e-final.mjs).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ref = process.env.SUPABASE_PROJECT_ID;
if (!ref || !/^[a-z0-9]+$/.test(ref)) {
  console.error("Set SUPABASE_PROJECT_ID to the project ref to link (lowercase letters and digits).");
  process.exit(2);
}
const cli = createRequire(import.meta.url).resolve("supabase/dist/supabase.js");
const result = spawnSync(process.execPath, [cli, "link", "--project-ref", ref], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
