import type { LLMProvider } from "@atp/llm";
import { TOOL_MAP, toolCatalogPrompt, type ToolContext } from "@atp/tools";
import { parseAction } from "./parse.ts";

export type AgentEvent =
  | { type: "user"; content: string }
  | { type: "tool_call"; tool: string; input: unknown; thought?: string }
  | { type: "tool_result"; tool: string; result: unknown; isError: boolean }
  | { type: "final"; content: string; artifacts?: Array<{ type: string; ref: string }> }
  | { type: "error"; message: string };

const DEFAULT_TEMPLATE = `You are the Conversational Orchestrator. The user only chats; YOU do all the work by calling tools.
Respond with a SINGLE fenced \`\`\`json block: either {"thought","tool","input"} to call a tool, or
{"thought","final","artifacts"} to answer the user. Never invent object/field names — describe first.

## Tools
{{TOOLS}}`;

export function buildSystemPrompt(template = DEFAULT_TEMPLATE): string {
  return template.replace("{{TOOLS}}", toolCatalogPrompt());
}

export interface RunOptions {
  provider: LLMProvider;
  ctx: ToolContext;
  systemPrompt?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  onEvent?: (e: AgentEvent) => void;
  maxSteps?: number;
}

export interface RunResult {
  final: string;
  artifacts?: Array<{ type: string; ref: string }>;
  steps: number;
}

const EXECUTION_TOOLS = new Set(["run_suite", "run_headless"]);
const hasExecutionApproval = (history: Array<{ role: "user" | "assistant"; content: string }> | undefined, userMessage: string): boolean => {
  const approved = /\b(approve|approved|execute|run now|start execution|go ahead)\b/i.test(userMessage);
  const lastAssistant = [...(history ?? [])].reverse().find((m) => m.role === "assistant")?.content ?? "";
  return approved && lastAssistant.includes("Execution approval required");
};

/**
 * The conversational orchestrator loop. Provider-agnostic (JSON ReAct protocol) so it works with
 * Anthropic/OpenAI/Google APIs AND the local claude/codex CLIs. The agent calls tools that do the
 * real groundwork (metadata, generation, runs, DB CRUD); we stream events for the chat UI.
 */
export async function runOrchestrator(opts: RunOptions): Promise<RunResult> {
  const system = opts.systemPrompt ?? buildSystemPrompt();
  const maxSteps = opts.maxSteps ?? 50; // tool steps per turn — high enough to read deep related context
  const emit = opts.onEvent ?? (() => {});
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    ...(opts.history ?? []),
    { role: "user", content: opts.userMessage },
  ];
  emit({ type: "user", content: opts.userMessage });

  for (let step = 0; step < maxSteps; step++) {
    const res = await opts.provider.complete({ system, messages });
    const action = parseAction(res.text);

    if (action.tool) {
      const tool = TOOL_MAP[action.tool];
      emit({ type: "tool_call", tool: action.tool, input: action.input, thought: action.thought });
      let result: unknown;
      let isError = false;
      if (EXECUTION_TOOLS.has(action.tool) && !hasExecutionApproval(opts.history, opts.userMessage)) {
        result = { error: "Execution blocked. Show the generated cases, steps, suites, and script to the user first. End with: Execution approval required." };
        isError = true;
      } else if (!tool) {
        result = { error: `unknown tool '${action.tool}'. Valid: ${Object.keys(TOOL_MAP).join(", ")}` };
        isError = true;
      } else {
        try {
          result = await tool.run((action.input ?? {}) as Record<string, unknown>, opts.ctx);
        } catch (e) {
          result = { error: (e as Error).message };
          isError = true;
        }
      }
      emit({ type: "tool_result", tool: action.tool, result, isError });
      messages.push({ role: "assistant", content: res.text });
      messages.push({ role: "user", content: `OBSERVATION (${action.tool}): ${JSON.stringify(result).slice(0, 4000)}` });
      continue;
    }

    if (typeof action.final === "string") {
      emit({ type: "final", content: action.final, artifacts: action.artifacts });
      return { final: action.final, artifacts: action.artifacts, steps: step + 1 };
    }

    // protocol violation — nudge once and continue
    messages.push({ role: "assistant", content: res.text });
    messages.push({ role: "user", content: "Respond ONLY with the JSON protocol: a tool call or a final answer." });
  }

  const msg = "I wasn't able to finish within the step budget for this turn. Could you narrow the request?";
  emit({ type: "final", content: msg });
  return { final: msg, steps: maxSteps };
}
