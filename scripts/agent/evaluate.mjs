import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT, contextFor, unique } from "./core.mjs";
import { section } from "./documents.mjs";

const baseline = JSON.parse(
  readFileSync(path.join(ROOT, "scripts/agent/discovery-baseline.json"), "utf8"),
);
const scenarios = {
  ui: ["src/components/capacity-estimate.tsx"],
  registration: ["src/lib/tournament/registration/participant.ts"],
  "scheduling-rpc": [
    "src/lib/tournament/scheduling/live-constraints.ts",
    "src/lib/auth/authorization.ts",
    "supabase/migrations/new-guard.sql",
  ],
};
const results = {};
for (const [name, files] of Object.entries(scenarios)) {
  const start = performance.now(),
    context = contextFor(files);
  const references = unique([...context.instructions, ...context.documents]);
  // Count each file once; if a whole file is required, its sections add no input again.
  const grouped = new Map();
  for (const ref of references) {
    const [file, anchor] = ref.split("#");
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file).push(anchor);
  }
  const texts = [...grouped].map(([file, anchors]) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    return anchors.includes(undefined)
      ? text
      : unique(anchors)
          .map((anchor) => section(text, anchor))
          .join("\n");
  });
  const before = baseline.scenarios[name];
  const after = {
    bytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    words: texts.reduce((sum, text) => sum + text.trim().split(/\s+/).length, 0),
    references,
    contextCommands: 1,
    contextElapsedMs: Number((performance.now() - start).toFixed(2)),
  };
  results[name] = {
    paths: files,
    before,
    after,
    reductionInRequiredWordsPercent: Number((100 * (1 - after.words / before.words)).toFixed(1)),
    risk: context.risk,
    integration: context.integration,
  };
}
const result = {
  baselineRevision: baseline.revision,
  method: "Deterministic required-read scenarios, not token/runtime or model-quality benchmarks",
  tokensMeasured: false,
  taskExecutionTimingMeasured: false,
  scenarios: results,
};
mkdirSync(path.join(ROOT, "test-results/agent"), { recursive: true });
writeFileSync(
  path.join(ROOT, "test-results/agent/discovery.json"),
  JSON.stringify(result, null, 2) + "\n",
);
for (const [name, row] of Object.entries(results))
  console.log(
    `${name}: ${row.before.words} → ${row.after.words} required words (${row.reductionInRequiredWordsPercent}% less); ${row.risk}; integration=${row.integration}`,
  );
console.log(
  "Method/inputs: test-results/agent/discovery.json; actual token savings and full-task speed are not measured.",
);
