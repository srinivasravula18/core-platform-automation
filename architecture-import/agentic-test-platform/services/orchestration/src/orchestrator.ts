import type { ApiRequestCase, ObjectDescriptor, TestCase } from "@atp/shared";
import type { Pipeline } from "./agents.ts";

export interface RunArtifacts {
  cases: TestCase[];
  requests: ApiRequestCase[];
  script: { script: string; lintOk: boolean; violations: unknown[] };
}

/**
 * The Conversational Orchestrator (manager pattern). It does NOT do the testing work — it invokes
 * specialist agents AS TOOLS (internal tool calling). The script engineer in turn talks to the
 * grounding agent (agent-to-agent), so every locator stays metadata-grounded.
 *
 * In the full app this is fronted by the chat/voice UI and may escalate to a Claude Agent SDK
 * planning call for ambiguous intents; here it runs the deterministic pipeline directly.
 */
export class Orchestrator {
  constructor(private pipeline: Pipeline) {}

  async runObject(descriptor: ObjectDescriptor): Promise<RunArtifacts> {
    const { bus } = this.pipeline;
    const caseTool = bus.asTool("case-designer");
    const apiTool = bus.asTool("api-test");
    const scriptTool = bus.asTool("script-engineer");

    const cases = (await caseTool.call({ descriptor })) as TestCase[];
    const requests = (await apiTool.call({ descriptor })) as ApiRequestCase[];

    const createCase = cases.find((c) => c.technique === "crud") ?? cases[0]!;
    const script = (await scriptTool.call({ descriptor, testCase: createCase })) as RunArtifacts["script"];

    return { cases, requests, script };
  }
}
