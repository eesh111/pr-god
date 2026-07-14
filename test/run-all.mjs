/**
 * Runs every test file as its own child process and aggregates results.
 * Assumes `npm run build` has produced dist/ (the `npm test` script does this).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const files = [
  "unit-diffutils.mjs",
  "unit-errors.mjs",
  "unit-client.mjs",
  "unit-loader.mjs",
  "mock-e2e.mjs",
  "config.spawn.mjs",
  "integration-mcp.mjs",
  "http-smoke.mjs",
];

const failed = [];
for (const f of files) {
  const path = fileURLToPath(new URL(`./${f}`, import.meta.url));
  const r = spawnSync(process.execPath, [path], { stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}

console.log("\n========================================");
if (failed.length === 0) {
  console.log(`ALL TEST FILES PASSED (${files.length}/${files.length})`);
  process.exit(0);
} else {
  console.log(`FAILED FILES (${failed.length}/${files.length}): ${failed.join(", ")}`);
  process.exit(1);
}
