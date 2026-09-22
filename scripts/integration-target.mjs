#!/usr/bin/env node
/**
 * Switches what `integration/.env` points at, without ever hand-editing it.
 *
 * ## Why this exists
 *
 * The integration suite needs six values, and they are not independent: three tell the
 * suite which project to use, and three tell the *application* which project it resolves -
 * and `setup-guard.ts` refuses to run unless the two agree. Editing six lines by hand every
 * time means one of them will eventually be left behind, and the failure that produces is
 * the confusing one: the suite writes to one project while the tests assert against another.
 *
 * Generating all six together from a single source removes that class of mistake.
 *
 * ## Targets
 *
 *   local    the Supabase stack running in Docker/Colima. Values are read from
 *            `supabase status`, so they always match the stack that is actually up.
 *   <name>   any snapshot previously taken with `save`.
 *
 * Switching to `local` first snapshots the current file to `.env.staging` if no such
 * snapshot exists, so the configuration it replaces is never lost.
 *
 * ## Usage
 *
 *   npm run integration:target -- show            what the suite currently points at
 *   npm run integration:target -- local           point at the local stack
 *   npm run integration:target -- save staging    snapshot the current file
 *   npm run integration:target -- use staging     restore a snapshot
 *
 * Snapshots are written as `integration/.env.<name>`, which matches `.gitignore`'s `.env.*`
 * rule. A snapshot that did not match would be a committed service-role key.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ENV_PATH = join(ROOT, "integration", ".env");

/**
 * The six values, and the `supabase status` key each is drawn from.
 *
 * `supabase status -o json` has changed its key casing across CLI versions, so lookups are
 * normalised rather than trusted: a missed lookup here is a broken target, and the error
 * would surface as a confusing auth failure rather than as a missing key.
 */
const LOCAL_MAPPING = [
  ["SUPABASE_TEST_URL", ["API_URL", "api_url"]],
  ["SUPABASE_TEST_PUBLISHABLE_KEY", ["ANON_KEY", "anon_key", "PUBLISHABLE_KEY", "publishable_key"]],
  ["SUPABASE_TEST_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "service_role_key"]],
  ["SUPABASE_URL", ["API_URL", "api_url"]],
  ["VITE_SUPABASE_URL", ["API_URL", "api_url"]],
  ["VITE_SUPABASE_PUBLISHABLE_KEY", ["ANON_KEY", "anon_key", "PUBLISHABLE_KEY", "publishable_key"]],
];

/** Every key this script owns. Anything else in the file is left exactly as it was. */
const MANAGED_KEYS = LOCAL_MAPPING.map(([name]) => name);

function readEnvFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Rewrites the managed keys in place, preserving comments, blank lines and ordering.
 *
 * The file's comments are the explanation of why these values must agree, so replacing the
 * whole file with generated lines would delete the only place that is written down. Keys not
 * managed here are also left alone rather than dropped.
 */
function applyValues(existing, values) {
  const remaining = new Map(Object.entries(values));
  const lines = existing.split("\n").map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !remaining.has(match[1])) return line;
    const name = match[1];
    const value = remaining.get(name);
    remaining.delete(name);
    return `${name}="${value}"`;
  });

  for (const [name, value] of remaining) lines.push(`${name}="${value}"`);

  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

function localValues() {
  let raw;
  try {
    raw = execFileSync("npx", ["supabase", "status", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      "Could not read `supabase status`. Is the local stack running?\n" +
        "  colima start          # if the container runtime is not up\n" +
        "  npx supabase start    # then the stack itself\n" +
        "Until Docker/Colima is running there is nothing for the suite to point at.",
    );
  }

  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    throw new Error("`supabase status -o json` did not return JSON; check the CLI version.");
  }

  const values = {};
  for (const [name, candidates] of LOCAL_MAPPING) {
    const key = candidates.find((candidate) => status[candidate] !== undefined);
    if (!key) {
      throw new Error(
        `The local stack reported no value for ${name} ` +
          `(looked for: ${candidates.join(", ")}).\nKeys present: ${Object.keys(status).join(", ")}`,
      );
    }
    values[name] = String(status[key]);
  }
  return values;
}

/** The project ref in the current file, for reporting - never the keys. */
function describe(existing) {
  const url = existing.match(/^\s*SUPABASE_TEST_URL\s*=\s*"?([^"\n]*)"?/m)?.[1];
  if (!url) return "nothing (no SUPABASE_TEST_URL)";

  const application = existing.match(/^\s*VITE_SUPABASE_URL\s*=\s*"?([^"\n]*)"?/m)?.[1];
  const ref = (value) => {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  };

  const agree = application && application === url;
  return (
    `${ref(url)}\n` +
    `  application resolves: ${application ? ref(application) : "(not set)"}` +
    `${agree ? "  - agrees" : "  - DISAGREES with the suite, setup-guard will refuse"}`
  );
}

function snapshotPath(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(`Snapshot name must be alphanumeric: got "${name}"`);
  }
  return join(ROOT, "integration", `.env.${name}`);
}

function main() {
  const [command, argument] = process.argv.slice(2);

  if (!command || command === "show") {
    console.log(`integration target: ${describe(readEnvFile(ENV_PATH))}`);
    return;
  }

  if (command === "local") {
    const existing = readEnvFile(ENV_PATH);
    const staging = snapshotPath("staging");
    // Only if absent: never overwrite a snapshot, since it may be the only copy of values
    // that are not recoverable from the repository.
    if (existing && !existsSync(staging)) {
      copyFileSync(ENV_PATH, staging);
      console.log("saved the previous target as integration/.env.staging");
    }

    const values = localValues();
    writeFileSync(ENV_PATH, applyValues(existing, values));
    console.log(`integration target: ${describe(readEnvFile(ENV_PATH))}`);
    return;
  }

  if (command === "save") {
    if (!argument) throw new Error("Usage: integration:target save <name>");
    const path = snapshotPath(argument);
    if (existsSync(path)) {
      throw new Error(
        `integration/.env.${argument} already exists. Delete it first if you really mean\n` +
          "to overwrite it - it may hold values that are not recoverable elsewhere.",
      );
    }
    if (!existsSync(ENV_PATH)) throw new Error("integration/.env does not exist; nothing to save.");
    copyFileSync(ENV_PATH, path);
    console.log(`saved integration/.env as integration/.env.${argument}`);
    return;
  }

  if (command === "use") {
    if (!argument) throw new Error("Usage: integration:target use <name>");
    const path = snapshotPath(argument);
    if (!existsSync(path)) {
      const available = ["staging", "local"].filter((n) => existsSync(snapshotPath(n)));
      throw new Error(
        `No snapshot at integration/.env.${argument}.` +
          (available.length ? `\nAvailable: ${available.join(", ")}` : "\nNo snapshots yet."),
      );
    }
    copyFileSync(path, ENV_PATH);
    console.log(`integration target: ${describe(readEnvFile(ENV_PATH))}`);
    return;
  }

  throw new Error(
    `Unknown command "${command}".\n` +
      `Managed keys: ${MANAGED_KEYS.join(", ")}\n` +
      "Commands: show, local, save <name>, use <name>",
  );
}

main();
