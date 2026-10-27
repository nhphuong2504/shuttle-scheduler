import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { ROOT, parseArgs } from "./core.mjs";

export function envValues(root, file) {
  if (!existsSync(path.join(root, file))) return {};
  return parseEnv(readFileSync(path.join(root, file), "utf8"));
}

export function isLoopback(value) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function localIntegration(root) {
  const values = { ...envValues(root, "integration/.env"), ...process.env };
  const urls = [values.SUPABASE_TEST_URL, values.SUPABASE_URL, values.VITE_SUPABASE_URL];
  return (
    urls.every(isLoopback) &&
    new Set(urls).size === 1 &&
    [
      "SUPABASE_TEST_PUBLISHABLE_KEY",
      "SUPABASE_TEST_SERVICE_ROLE_KEY",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
    ].every((key) => !!values[key])
  );
}

export function portState(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? "free" : "unavailable"));
    socket.setTimeout(700, () => finish("unavailable"));
  });
}

export async function diagnose({ root = ROOT, integration = false, probe = portState } = {}) {
  const checks = [];
  const add = (name, ok, next) =>
    checks.push({ name, status: ok ? "ready" : "missing", ...(ok ? {} : { next }) });
  const expected = Number(readFileSync(path.join(root, ".nvmrc"), "utf8").trim());
  add(
    "node",
    Number(process.versions.node.split(".")[0]) === expected,
    `Use Node ${expected} from .nvmrc`,
  );
  add(
    "dependencies",
    existsSync(path.join(root, "package-lock.json")) &&
      existsSync(path.join(root, "node_modules/.package-lock.json")),
    "npm ci",
  );
  try {
    const require = createRequire(path.join(root, "package.json"));
    add(
      "chromium",
      existsSync(require("@playwright/test").chromium.executablePath()),
      "npx playwright install chromium",
    );
  } catch {
    add("chromium", false, "npm ci, then npx playwright install chromium");
  }
  const values = { ...envValues(root, ".env"), ...process.env };
  add(
    "development configuration",
    ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"].every((key) => !!values[key]),
    "Configure the names in .env.example; never print their values",
  );
  const port = Number(process.env.PLAYWRIGHT_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PLAYWRIGHT_PORT");
  const state = await probe(port);
  add(
    `port ${port}: ${state}`,
    state === "free",
    "Inspect the listener or set PLAYWRIGHT_PORT; an occupied port is not proof of the correct server",
  );
  if (integration) {
    try {
      execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 5_000,
        stdio: "ignore",
      });
      add("docker", true);
    } catch {
      add("docker", false, "Start your container runtime, or use the integration CI workflow");
    }
    add(
      "integration target",
      localIntegration(root),
      "Use npm run integration:target -- local only with a local stack; preserve the original configuration",
    );
    add(
      "local API reachable",
      (await probe(54321)) === "occupied",
      "Start the local Supabase stack; reachability alone does not prove healthy services",
    );
  }
  return {
    status: checks.every((check) => check.status === "ready") ? "ready" : "missing-prerequisites",
    checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { paths, options } = parseArgs(
      process.argv.slice(2),
      ["json", "integration"],
      ["json", "integration"],
    );
    if (paths.length) throw new Error("doctor takes no positional paths");
    const result = await diagnose({ integration: !!options.integration });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else
      result.checks.forEach((check) =>
        console.log(`${check.status}: ${check.name}${check.next ? ` — ${check.next}` : ""}`),
      );
    process.exitCode = result.status === "ready" ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
