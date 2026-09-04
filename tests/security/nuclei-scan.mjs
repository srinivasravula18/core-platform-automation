import { spawn } from "node:child_process";
import fs from "node:fs";

// ProjectDiscovery Nuclei template scan against the authorized target.
// Emits the SecuritySummary shape (same as the ZAP runner) for engagement import.

const target = new URL(process.env.API_BASE ?? "");
const summaryPath = process.env.OBS_TEST_SUMMARY_PATH;
if (!summaryPath) throw new Error("OBS_TEST_SUMMARY_PATH is required");

const scanTarget = new URL(target);
if (["127.0.0.1", "localhost", "::1"].includes(scanTarget.hostname)) scanTarget.hostname = "host.docker.internal";

const order = ["info", "low", "medium", "high", "critical"];
const floor = order.includes(process.env.NUCLEI_SEVERITY ?? "low") ? (process.env.NUCLEI_SEVERITY ?? "low") : "low";
const severities = order.slice(order.indexOf(floor)).join(",");

const args = [
  "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
  "projectdiscovery/nuclei:latest",
  "-target", scanTarget.toString(), "-severity", severities, "-jsonl", "-silent", "-no-color"
];

console.log(`Nuclei scan starting for ${target.origin} (severity ${severities})`);
const child = spawn(process.env.DOCKER_BIN?.trim() || "docker", args, { shell: false, windowsHide: true });

let buffer = "";
const raw = [];
const ingest = (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try { raw.push(JSON.parse(line)); } catch { console.log(line); }
  }
};
child.stdout.on("data", ingest);
child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));

const exitCode = await new Promise((resolve) => {
  child.once("error", (error) => { console.error(`Could not start Docker/Nuclei: ${error.message}`); resolve(-1); });
  child.once("close", (code) => resolve(code ?? -1));
});
if (buffer.trim()) ingest("\n");

const normalize = (value) => (order.includes(String(value).toLowerCase()) ? String(value).toLowerCase() : "informational");
const sevToRisk = (value) => (value === "info" ? "informational" : value);
const counts = { high: 0, medium: 0, low: 0, informational: 0 };
const findings = raw.slice(0, 100).map((item) => {
  const severity = sevToRisk(normalize(item.info?.severity));
  if (severity === "critical" || severity === "high") counts.high += 1; else counts[severity] += 1;
  return {
    name: String(item.info?.name ?? item["template-id"] ?? "Nuclei finding"),
    risk: severity,
    confidence: "high",
    url: String(item["matched-at"] ?? item.host ?? target.origin),
    instances: 1,
    cweId: Array.isArray(item.info?.classification?.["cwe-id"]) ? String(item.info.classification["cwe-id"][0]).toUpperCase() : null,
    solution: String(item.info?.remediation ?? ""),
    description: String(item.info?.description ?? ""),
    impact: String(item.info?.tags ?? ""),
    evidence: { templateId: item["template-id"], matchedAt: item["matched-at"], type: item.type }
  };
});

fs.writeFileSync(summaryPath, JSON.stringify({
  security: {
    scanner: "nuclei",
    mode: "active",
    target: target.origin,
    generatedAt: new Date().toISOString(),
    counts,
    total: findings.length,
    truncated: raw.length > findings.length,
    findings
  }
}));

console.log(`Nuclei findings: ${counts.high} high/critical, ${counts.medium} medium, ${counts.low} low, ${counts.informational} info (docker exit ${exitCode})`);
process.exit(exitCode < 0 ? 3 : 0);
