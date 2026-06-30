/** ponytail self-check: spans nest, carry gen_ai attrs, capture errors. Run: pnpm -F @atp/tracing test */
import assert from "node:assert/strict";
import { Tracer } from "./index.ts";

const ended: string[] = [];
const t = new Tracer("trace-1", (s) => ended.push(`${s.kind}:${s.name}`));

const out = await t.span("Planner", "invoke_agent", { "gen_ai.agent.name": "analyst-planner" }, async () =>
  t.span("playwright.run", "execute_tool", { "gen_ai.tool.name": "playwright.run" }, async () => "ran"),
);
assert.equal(out, "ran");
assert.deepEqual(ended, ["execute_tool:playwright.run", "invoke_agent:Planner"]); // inner ends first

const spans = t.record();
assert.equal(spans[0]!.attributes["gen_ai.operation.name"], "invoke_agent");
assert.ok(spans.every((s) => s.traceId === "trace-1"));

await assert.rejects(t.span("boom", "chat", {}, async () => { throw new Error("kaboom"); }));
assert.ok(t.record().some((s) => s.error === "kaboom"));

console.log("✓ tracing self-check passed (gen_ai spans + nesting + error capture)");
