import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const target = new URL(process.env.API_BASE);
const mode = process.env.ZAP_SCAN_MODE === "active" ? "active" : "baseline";
const minutes = Math.min(60, Math.max(1, Number(process.env.ZAP_SCAN_MINUTES) || 3));
const failOn = process.env.ZAP_FAIL_ON === "medium" ? "medium" : "high";
const summaryPath = process.env.OBS_TEST_SUMMARY_PATH;
if (!summaryPath) throw new Error("OBS_TEST_SUMMARY_PATH is required");

const scanTarget = new URL(target);
if (["127.0.0.1", "localhost", "::1"].includes(scanTarget.hostname)) scanTarget.hostname = "host.docker.internal";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "core-zap-"));
const reportName = "zap-report.json";
const command = mode === "active" ? "zap-full-scan.py" : "zap-baseline.py";
const args = [
  "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
  "-v", `${work}:/zap/wrk/:rw`, "ghcr.io/zaproxy/zaproxy:stable",
  command, "-t", scanTarget.toString(), "-m", String(minutes), "-J", reportName, "-I"
];

console.log(`OWASP ZAP ${mode} scan starting for ${target.origin}`);
const child = spawn(process.env.DOCKER_BIN?.trim() || "docker", args, { stdio: "inherit", shell: false, windowsHide: true });
const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => {
    console.error(`Could not start Docker: ${error.message}`);
    resolve(-1);
  });
  child.once("close", (code) => resolve(code ?? -1));
});

const reportPath = path.join(work, reportName);
if (!fs.existsSync(reportPath)) {
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`ZAP did not produce a report (exit ${exitCode})`);
  process.exit(3);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const alerts = (report.site ?? []).flatMap((site) => site.alerts ?? []);
const riskName = (risk) => ({ 3: "high", 2: "medium", 1: "low", 0: "informational" })[Number(risk)] ?? "informational";
const counts = { high: 0, medium: 0, low: 0, informational: 0 };
const findings = alerts.slice(0, 100).map((alert) => {
  const risk = riskName(alert.riskcode);
  counts[risk] += 1;
  const first = alert.instances?.[0] ?? {};
  return {
    name: String(alert.name ?? alert.alert ?? "Unnamed finding"),
    risk,
    confidence: String(alert.confidence ?? ""),
    url: String(first.uri ?? target.origin),
    instances: Number(alert.count ?? alert.instances?.length ?? 0),
    cweId: alert.cweid ? String(alert.cweid) : null,
    solution: String(alert.solution ?? "").slice(0, 2000)
  };
});

fs.writeFileSync(summaryPath, JSON.stringify({
  security: {
    scanner: "OWASP ZAP",
    mode,
    target: target.origin,
    generatedAt: new Date().toISOString(),
    counts,
    total: alerts.length,
    truncated: alerts.length > findings.length,
    findings
  }
}));
fs.rmSync(work, { recursive: true, force: true });

const failed = counts.high > 0 || (failOn === "medium" && counts.medium > 0);
console.log(`ZAP findings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.informational} informational`);
process.exit(exitCode < 0 || failed ? 2 : 0);
