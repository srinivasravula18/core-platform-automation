/**
 * ponytail self-check: agent-to-agent comms + agents-as-tools (internal tool calling)
 * + transcript traceability + loop guard + pub/sub. Run: pnpm -F @atp/agent-bus test
 */
import assert from "node:assert/strict";
import { AgentBus } from "./bus.ts";

// --- internal tool calling + agent-to-agent request/reply ---
{
  const seen: string[] = [];
  const bus = new AgentBus({ onMessage: (m) => seen.push(`${m.kind}:${m.from}->${m.to}`) });

  // grounding agent: resolves a field to a real locator
  bus.register(
    { name: "grounding", description: "Resolve (object,field) to a grounded locator", skills: ["locator"] },
    async (content) => {
      const { field } = content as { field: string };
      return `page.getByLabel('${field === "start_date" ? "Start Date" : field}')`;
    },
  );

  // case-designer agent: from inside its turn, calls grounding (agent-to-agent)
  bus.register(
    { name: "case-designer", description: "Design ISTQB cases for an object", skills: ["cases"] },
    async (content, ctx) => {
      const { object } = content as { object: string };
      const locator = await ctx.request("grounding", { object, field: "start_date" });
      return { case: `TC-${object}-CREATE`, usesLocator: locator };
    },
  );

  // orchestrator invokes the specialist AS A TOOL (manager / agents-as-tools)
  const tool = bus.asTool("case-designer");
  assert.equal(tool.description, "Design ISTQB cases for an object");
  const result = (await tool.call({ object: "leave_request" })) as { usesLocator: string };
  assert.equal(result.usesLocator, "page.getByLabel('Start Date')");

  // the whole exchange is traceable: orchestrator->case-designer->grounding and back
  assert.deepEqual(seen, [
    "request:orchestrator->case-designer",
    "request:case-designer->grounding",
    "reply:grounding->case-designer",
    "reply:case-designer->orchestrator",
  ]);
  // one correlationId groups the entire exchange
  const corrIds = new Set(bus.getTranscript().map((m) => m.correlationId));
  assert.equal(corrIds.size, 1);
}

// --- loop guard: mutually-calling agents must not run away ---
{
  const bus = new AgentBus({ maxDepth: 5 });
  bus.register({ name: "ping", description: "", skills: [] }, async (_c, ctx) => ctx.request("pong", {}));
  bus.register({ name: "pong", description: "", skills: [] }, async (_c, ctx) => ctx.request("ping", {}));
  await assert.rejects(bus.request("orchestrator", "ping", {}), /depth .* exceeded/);
}

// --- pub/sub: a subscriber receives published progress in its inbox ---
{
  const bus = new AgentBus();
  bus.register({ name: "reporter", description: "", skills: [] }, async () => "ok");
  bus.register({ name: "executor", description: "", skills: [] }, async (_c, ctx) => {
    ctx.publish("run.progress", { pct: 50 });
    return "running";
  });
  bus.subscribe("reporter", "run.progress");
  await bus.request("orchestrator", "executor", {});
  const inbox = bus.inbox("reporter");
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0]!.content, { pct: 50 });
}

console.log("✓ agent-bus self-check passed (A2A comms + agents-as-tools + transcript + loop guard + pub/sub)");
