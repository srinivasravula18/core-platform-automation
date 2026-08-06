import { promises as fs } from 'fs';
import path from 'path';
import { latestBlackboard } from '../features/agent/blackboard';
import { loadRunMemories } from './memory/runMemory';
import { redactSecrets } from './memory/artifactMemory';

const TRACE_FILE_PATH = path.resolve(process.cwd(), '.testflow-traces.jsonl');
const bounded = (value: unknown, limit = 4_000): any => {
  const text = JSON.stringify(redactSecrets(value)) ?? 'null';
  return text.length <= limit ? JSON.parse(text) : `${text.slice(0, limit)}…[truncated]`;
};

export interface ExecutionTraceStep {
  stepNumber: number;
  agentName: string;
  toolInvoked: string | null; // null if answering without a tool
  toolInputs: Record<string, unknown> | null;
  toolOutputs: unknown;
  contextReceived: unknown;
  contextPassed: unknown;
  memoryOrRegistryState: unknown;
  blackboardContents: unknown;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
  } | null;
  informationTruncated: boolean;
  evidenceDiscarded: boolean;
  assumptionsMade: string;
  whyNextToolSelected: string;
  finalPromptSent: string;
  timestamp: string;
  runId?: string;
}

/**
 * Appends a trace step to the JSONL log file.
 * This is fire-and-forget; it will not throw and disrupt the agent loop if logging fails.
 */
export async function logExecutionTrace(step: Omit<ExecutionTraceStep, 'timestamp' | 'blackboardContents' | 'memoryOrRegistryState'>): Promise<void> {
  try {
    let blackboard = null;
    try {
      blackboard = latestBlackboard();
    } catch {
      // ignore
    }

    let memoryState = null;
    try {
      const memories = await loadRunMemories();
      memoryState = { runMemoriesCount: memories.length, latestMemories: memories.slice(0, 5) };
    } catch {
      // ignore
    }

    const fullStep: ExecutionTraceStep = {
      ...step,
      toolInputs: bounded(step.toolInputs),
      toolOutputs: bounded(step.toolOutputs),
      contextReceived: bounded(step.contextReceived),
      contextPassed: bounded(step.contextPassed),
      blackboardContents: bounded(blackboard),
      memoryOrRegistryState: bounded(memoryState),
      assumptionsMade: String(step.assumptionsMade || '').slice(0, 1_000),
      whyNextToolSelected: String(step.whyNextToolSelected || '').slice(0, 1_000),
      finalPromptSent: String(step.finalPromptSent || '').slice(0, 1_000),
      timestamp: new Date().toISOString()
    };

    const line = JSON.stringify(fullStep) + '\n';
    await fs.appendFile(TRACE_FILE_PATH, line, 'utf8');
  } catch (err) {
    console.error(`[Tracer] Failed to write execution trace:`, err);
  }
}

/**
 * Utility to extract the system prompt + messages into a readable string
 * for the 'finalPromptSent' field.
 */
export function serializePrompt(system: string, messages: any[]): string {
  const roles = messages.map((message) => String(message?.role || 'unknown')).join(',');
  return `[prompt metadata] systemChars=${system.length} messages=${messages.length} roles=${roles}`.slice(0, 1_000);
}
