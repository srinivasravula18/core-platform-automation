/// <reference types="k6" />
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = (__ENV.OBSERVABILITY_SELF_BASE_URL || "http://127.0.0.1:5006").replace(/\/$/, "");
const USERNAME = __ENV.ADMIN_USERNAME || "admin";
const PASSWORD = __ENV.ADMIN_PASSWORD || "admin";
const THINK_SECONDS = Number(__ENV.THINK_SECONDS || 1);
const agentFailures = new Rate("agent_failure_rate");

export const options = {
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || "30s",
  thresholds: {
    agent_failure_rate: ["rate<0.05"],
    http_req_duration: ["p(95)<120000"]
  }
};

export const setup = () => {
  const response = http.post(`${BASE}/api/login`, JSON.stringify({ username: USERNAME, password: PASSWORD }), {
    headers: { "Content-Type": "application/json" },
    tags: { op: "observability_login" }
  });
  const token = response.status === 200 ? response.json("token") : null;
  if (!token) throw new Error(`observability login failed with ${response.status}`);
  return { token };
};

export default function ({ token }) {
  const response = http.post(
    `${BASE}/api/agent/respond`,
    JSON.stringify({
      message: "Summarize overall health using the current dashboard evidence.",
      from: "now-15m",
      to: "now",
      conversation: []
    }),
    {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: "120s",
      tags: { op: "agent_respond" }
    }
  );
  const ok = check(response, {
    "agent responds": (result) => result.status === 200,
    "agent returns text": (result) => typeof result.json("message") === "string" && result.json("message").length > 0
  });
  agentFailures.add(!ok);
  sleep(THINK_SECONDS);
}
