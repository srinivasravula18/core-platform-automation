/**
 * End-to-end integration demo + self-check on the REAL leave_request object.
 * Proves: orchestrator → agents-as-tools (internal tool calling) → agent-to-agent (script→grounding)
 * → grounded, lint-passing Playwright spec → payload mutator → per-agent memory → A2A transcript.
 * Run: pnpm -F @atp/orchestrator demo
 */
import assert from "node:assert/strict";
import type { A2AMessage } from "@atp/agent-bus";
import { AgentMemory } from "@atp/memory";
import { buildPipeline } from "./agents.ts";
import { Orchestrator } from "./orchestrator.ts";
import { leaveRequest } from "./fixtures.ts";

const trace: A2AMessage[] = [];
const pipeline = buildPipeline((m) => trace.push(m));
const orch = new Orchestrator(pipeline);

const artifacts = await orch.runObject(leaveRequest);

// --- assertions ---
assert.ok(artifacts.cases.length >= 4, "should design multiple cases");
assert.ok(artifacts.cases.some((c) => c.code === "TC-LEAVE_REQUEST-CREATE"));
assert.ok(artifacts.cases.some((c) => c.technique === "access-control"), "viewer access-control case");
assert.ok(artifacts.requests.some((r) => r.variant === "invalid" && r.caseId.includes("REQ-")), "required-omit API cases");
assert.equal(artifacts.script.lintOk, true, "generated spec must pass selector-lint (grounded locators only)");

// the A2A transcript shows the manager calling specialists AND script→grounding agent-to-agent
const edges = trace.map((m) => `${m.kind}:${m.from}->${m.to}`);
assert.ok(edges.includes("request:orchestrator->case-designer"), "manager calls case-designer as a tool");
assert.ok(edges.includes("request:script-engineer->grounding"), "script engineer talks to grounding (A2A)");

// per-agent memory accumulated facts (isolated per agent)
const designerMem = new AgentMemory(pipeline.memory, "case-designer").recall("leave_request");
assert.ok(designerMem.length >= 1, "case-designer remembers what it did");

// --- human-readable output ---
console.log(`\n=== Agentic Test Platform — pipeline on '${leaveRequest.object.api_name}' ===`);
console.log(`UI cases:        ${artifacts.cases.length} (techniques: ${[...new Set(artifacts.cases.map((c) => c.technique))].join(", ")})`);
console.log(`API cases:       ${artifacts.requests.length} (${artifacts.requests.filter((r) => r.variant === "invalid").length} negative, ${artifacts.requests.filter((r) => r.variant === "boundary").length} boundary)`);
console.log(`Script lint:     ${artifacts.script.lintOk ? "PASS (all locators grounded)" : "FAIL"}`);
console.log(`\n--- agent-to-agent transcript ---`);
for (const m of trace) console.log(`  ${m.seq.toString().padStart(2)} ${m.kind.padEnd(7)} ${m.from} -> ${m.to}`);
console.log(`\n--- generated spec (grounded) ---\n${artifacts.script.script}`);
console.log(`\n✓ orchestrator integration self-check passed`);
