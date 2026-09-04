import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Semgrep static analysis (SAST) over the Core Platform source tree.
// No target traffic — scans code. Emits the SecuritySummary shape for import.

const summaryPath = process.env.OBS_TEST_SUMMARY_PATH;
if (!summaryPath) throw new Error("OBS_TEST_SUMMARY_PATH is required");

// The runner sets cwd to <repo>/tests/security; the repo root is two levels up.
const repoRoot = path.resolve(process.cwd(), "..", "..");
const config = process.env.SEMGREP_CONFIG?.trim() || "p/security-audit";
const scanSubdir = process.env.SEMGREP_SCAN_DIR?.trim() || "apps";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "core-semgrep-"));
const outFile = "semgrep.json";
const args = [
  "run", "--rm",
  "-v", `${repoRoot}:/src:ro`,
  "-v", `${work}:/out:rw`,
  "semgrep/semgrep:latest",
  "semgrep", "scan", "--config", config, "--json", "--quiet",
  "--output", `/out/${outFile}`, `/src/${scanSubdir}`
];

console.log(`Semgrep ${config} scan starting over ${scanSubdir}/`);
const child = spawn(process.env.DOCKER_BIN?.trim() || "docker", args, { stdio: ["ignore", "inherit", "inherit"], shell: false, windowsHide: true });
const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => { console.error(`Could not start Docker/Semgrep: ${error.message}`); resolve(-1); });
  child.once("close", (code) => resolve(code ?? -1));
});

const reportPath = path.join(work, outFile);
if (!fs.existsSync(reportPath)) {
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`Semgrep did not produce a report (exit ${exitCode})`);
  process.exit(3);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
fs.rmSync(work, { recursive: true, force: true });

const sevMap = { ERROR: "high", WARNING: "medium", INFO: "low" };
const counts = { high: 0, medium: 0, low: 0, informational: 0 };
const results = Array.isArray(report.results) ? report.results : [];
const findings = results.slice(0, 100).map((result) => {
  const risk = sevMap[String(result.extra?.severity ?? "INFO").toUpperCase()] ?? "low";
  if (risk === "high") counts.high += 1; else counts[risk] += 1;
  const rel = String(result.path ?? "").replace(/^\/src\//, "");
  const cwe = result.extra?.metadata?.cwe;
  return {
    name: String(result.check_id ?? "Semgrep finding").split(".").pop(),
    risk,
    confidence: String(result.extra?.metadata?.confidence ?? "medium").toLowerCase(),
    url: `${rel}:${result.start?.line ?? 0}`,
    instances: 1,
    cweId: Array.isArray(cwe) ? String(cwe[0]).match(/CWE-\d+/i)?.[0] ?? null : (typeof cwe === "string" ? cwe.match(/CWE-\d+/i)?.[0] ?? null : null),
    solution: String(result.extra?.fix ?? result.extra?.metadata?.["source-rule-url"] ?? ""),
    description: String(result.extra?.message ?? ""),
    impact: String(result.check_id ?? ""),
    evidence: { path: rel, line: result.start?.line, code: String(result.extra?.lines ?? "").slice(0, 500) }
  };
});

fs.writeFileSync(summaryPath, JSON.stringify({
  security: {
    scanner: "semgrep",
    mode: "baseline",
    target: `${scanSubdir}/`,
    generatedAt: new Date().toISOString(),
    counts,
    total: findings.length,
    truncated: results.length > findings.length,
    findings
  }
}));

console.log(`Semgrep findings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low (docker exit ${exitCode})`);
process.exit(exitCode < 0 ? 3 : 0);
