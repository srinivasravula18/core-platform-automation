import { AgentBus, type A2AMessage } from "@atp/agent-bus";
import { AgentMemory, InMemoryStore, type MemoryStore } from "@atp/memory";
import { generateCases, generateRequests } from "@atp/generators";
import { buildCatalog, defaultRenderProfile, defaultChromeAllow, lintScript } from "@atp/grounding";
import type { ObjectDescriptor } from "@atp/shared";
import { renderSpec } from "./spec.ts";

/**
 * Wire the specialist agents onto the bus. Each agent has its OWN memory and talks to others via
 * A2A messages / agents-as-tools. Handlers here are the DETERMINISTIC path (zero LLM tokens) — the
 * exact seam where a Claude Agent SDK subagent call drops in for judgment-heavy work.
 */
export interface Pipeline {
  bus: AgentBus;
  memory: MemoryStore;
}

export function buildPipeline(onMessage?: (m: A2AMessage) => void): Pipeline {
  const memory: MemoryStore = new InMemoryStore();
  const bus = new AgentBus({ onMessage });

  const mem = (id: string) => new AgentMemory(memory, id);

  // grounding agent — resolves an object's fields to a real locator catalog
  bus.register(
    { name: "grounding", description: "Synthesize grounded locators for an object's fields", skills: ["locator", "catalog"] },
    async (content) => {
      const { descriptor } = content as { descriptor: ObjectDescriptor };
      return buildCatalog(descriptor, defaultRenderProfile);
    },
  );

  // case designer — deterministic ISTQB cases; records what it produced in its own memory
  bus.register(
    { name: "case-designer", description: "Design ISTQB test cases for an object", skills: ["cases", "istqb"] },
    async (content) => {
      const { descriptor } = content as { descriptor: ObjectDescriptor };
      const cases = generateCases(descriptor);
      mem("case-designer").remember(`Designed ${cases.length} cases for ${descriptor.object.api_name}`, [descriptor.object.api_name]);
      return cases;
    },
  );

  // api-test — payload mutator → valid/boundary/invalid request cases
  bus.register(
    { name: "api-test", description: "Derive API contract tests from object metadata", skills: ["api", "contract"] },
    async (content) => {
      const { descriptor } = content as { descriptor: ObjectDescriptor };
      return generateRequests(descriptor);
    },
  );

  // script engineer — REQUESTS the grounding agent (agent-to-agent), renders a spec, self-lints
  bus.register(
    { name: "script-engineer", description: "Generate grounded Playwright specs", skills: ["playwright", "codegen"] },
    async (content, ctx) => {
      const { descriptor, testCase } = content as { descriptor: ObjectDescriptor; testCase: import("@atp/shared").TestCase };
      const catalog = (await ctx.request("grounding", { descriptor })) as ReturnType<typeof buildCatalog>;
      const script = renderSpec(descriptor, testCase, catalog);
      const lint = lintScript(script, catalog, defaultChromeAllow);
      const m = mem("script-engineer");
      if (!lint.ok) m.note(`lint failed for ${testCase.code}: ${lint.violations.map((v) => v.reason).join("; ")}`);
      else m.remember(`Grounded spec generated for ${testCase.code}`, [descriptor.object.api_name, "script"]);
      return { script, lintOk: lint.ok, violations: lint.violations };
    },
  );

  // reporter — subscribes to run progress (pub/sub)
  bus.register(
    { name: "reporter", description: "Aggregate results and write the run report", skills: ["report", "rtm"] },
    async (content) => content,
  );
  bus.subscribe("reporter", "run.progress");

  return { bus, memory };
}
