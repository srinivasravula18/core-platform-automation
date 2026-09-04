/// <reference types="k6" />
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const DEFAULT_API_BASE = "https://ops.acchindra.com";

const API_BASE = __ENV.API_BASE || __ENV.VITE_API_BASE || DEFAULT_API_BASE;
const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || "change-me";

const latencyBuckets = buildLatencyBuckets();
const slowRequestsOver5s = new Counter("slow_requests_over_5s");

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || "1s"
};

export default function () {
  const res = http.post(
    `${API_BASE}/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    {
      headers: { "Content-Type": "application/json" }
    }
  );

  check(res, {
    "login status is 200": (r) => r.status === 200,
    "login returns token": (r) => {
      try {
        const body = r.json();
        return typeof body?.token === "string" && body.token.length > 0;
      } catch {
        return false;
      }
    }
  });

  recordLatencyBucket(res);
  recordSlowRequest(res);
}

export function handleSummary(data) {
  const duration = data.metrics?.http_req_duration?.values ?? {};
  const summaryLines = [
    `http_reqs: ${data.metrics?.http_reqs?.values?.count ?? 0}`,
    `http_req_failed_rate: ${((data.metrics?.http_req_failed?.values?.rate ?? 0) * 100).toFixed(
      2
    )}%`,
    `http_req_duration_avg_ms: ${(duration.avg ?? 0).toFixed(2)}`,
    `http_req_duration_p95_ms: ${(duration["p(95)"] ?? 0).toFixed(2)}`
  ];
  const latencyLines = buildLatencyBucketLines(data);
  const slowLines = buildSlowSummaryLines(data);
  const lines = [
    "",
    "Summary",
    ...summaryLines,
    "",
    "Latency Buckets",
    ...latencyLines,
    "",
    "Slow Requests (>5s)",
    ...slowLines
  ];
  const html = buildHtmlReport({
    title: "Login Test Report",
    summaryLines,
    latencyLines,
    slowLines
  });
  return {
    stdout: `${lines.join("\n")}\n`,
    "login-test-summary.html": html
  };
}

function buildHtmlReport({ title, summaryLines, latencyLines, slowLines }) {
  const summaryRows = buildKeyValueRows(summaryLines);
  const latencyRows = buildKeyValueRows(latencyLines);
  const slowRows = buildKeyValueRows(slowLines);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    h2 { font-size: 16px; margin: 20px 0 8px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef2f7; }
    th { color: #6b7280; font-weight: 600; width: 45%; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="grid">
    <div class="card">
      <h2>Summary</h2>
      <table>${summaryRows}</table>
    </div>
    <div class="card">
      <h2>Latency Buckets</h2>
      <table>${latencyRows}</table>
    </div>
    <div class="card">
      <h2>Slow Requests (&gt;5s)</h2>
      <table>${slowRows}</table>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildKeyValueRows(lines) {
  if (!lines || lines.length === 0) {
    return `<tr><td colspan="2">No data</td></tr>`;
  }
  return lines
    .map((line) => {
      const [rawKey, ...rest] = String(line).split(":");
      const key = escapeHtml(rawKey.trim());
      const value = escapeHtml(rest.join(":").trim());
      return `<tr><th>${key}</th><td>${value}</td></tr>`;
    })
    .join("");
}

function buildLatencyBuckets() {
  return {
    "latency_1_100_ms": new Counter("latency_1_100_ms"),
    "latency_100_1000_ms": new Counter("latency_100_1000_ms"),
    "latency_1000_3000_ms": new Counter("latency_1000_3000_ms"),
    "latency_3000_5000_ms": new Counter("latency_3000_5000_ms"),
    "latency_5000_10000_ms": new Counter("latency_5000_10000_ms"),
    "latency_over_10000_ms": new Counter("latency_over_10000_ms")
  };
}

function recordLatencyBucket(res) {
  if (!res || typeof res.timings?.duration !== "number") return;
  const ms = res.timings.duration;
  if (ms < 100) latencyBuckets.latency_1_100_ms.add(1);
  else if (ms < 1000) latencyBuckets.latency_100_1000_ms.add(1);
  else if (ms < 3000) latencyBuckets.latency_1000_3000_ms.add(1);
  else if (ms < 5000) latencyBuckets.latency_3000_5000_ms.add(1);
  else if (ms < 10000) latencyBuckets.latency_5000_10000_ms.add(1);
  else latencyBuckets.latency_over_10000_ms.add(1);
}

function recordSlowRequest(res) {
  if (!res || typeof res.timings?.duration !== "number") return;
  if (res.timings.duration > 5000) slowRequestsOver5s.add(1);
}

function buildLatencyBucketLines(data) {
  const buckets = [
    ["1-100ms", "latency_1_100_ms"],
    ["100-1000ms", "latency_100_1000_ms"],
    ["1000-3000ms", "latency_1000_3000_ms"],
    ["3000-5000ms", "latency_3000_5000_ms"],
    ["5000-10000ms", "latency_5000_10000_ms"],
    [">10000ms", "latency_over_10000_ms"]
  ];
  return buckets.map(([label, key]) => {
    const count = data.metrics?.[key]?.values?.count ?? 0;
    return `requests_${label}: ${count}`;
  });
}

function buildSlowSummaryLines(data) {
  const count = data.metrics?.slow_requests_over_5s?.values?.count ?? 0;
  return count > 0 ? [`requests_over_5s: ${count}`] : ["no_requests_over_5s: 0"];
}
