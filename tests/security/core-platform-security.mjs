import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const tests = [
  "tests/unit/service/access-evaluator.test.ts",
  "tests/unit/service/aggregate-access-gate.test.ts",
  "tests/unit/service/apps-routes.test.ts",
  "tests/unit/service/db-tenant-routing.test.ts",
  "tests/unit/service/list-view-permission-filter.test.ts",
  "tests/unit/service/list-view-security.test.ts",
  "tests/unit/service/record-audit-visibility.test.ts",
  "tests/unit/service/record-sharing.test.ts",
  "tests/unit/service/sandbox-tenant.test.ts",
  "tests/unit/service/agent-jailbreak-detection.test.ts",
  "tests/unit/service/agent-prompts.test.ts"
];

console.log(`Running ${tests.length} predefined Core Platform security suites`);
const child = spawn(process.execPath, ["--test", "--import", "tsx", ...tests], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false,
  windowsHide: true
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});
