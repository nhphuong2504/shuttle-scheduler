import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, contextFor, parseArgs } from "./core.mjs";
import { section } from "./documents.mjs";

try {
  const { paths, options } = parseArgs(
    process.argv.slice(2),
    ["json", "expand"],
    ["json", "expand"],
  );
  const context = contextFor(paths);
  if (options.json) console.log(JSON.stringify(context, null, 2));
  else {
    console.log(
      `Areas: ${context.areas.join(", ") || "unknown"} | risk: ${context.risk} | integration: ${context.integration}`,
    );
    for (const name of ["instructions", "documents", "entries", "tests", "browserTests"]) {
      console.log(`${name}: ${context[name].join(", ") || "none mapped"}`);
    }
    if (context.unknown.length)
      console.log(`Unknown paths (full checks required): ${context.unknown.join(", ")}`);
    console.log(
      "Checks: npm run agent:check -- --changed (plan); add --stage=checkpoint --run to execute.",
    );
    if (options.expand) {
      for (const reference of [...context.instructions, ...context.documents]) {
        const [file, anchor] = reference.split("#");
        console.log(
          `\n--- ${reference} ---\n${section(readFileSync(path.join(ROOT, file), "utf8"), anchor)}`,
        );
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
