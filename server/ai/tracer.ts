import { promises as fs } from 'fs';
import path from 'path';
import { latestBlackboard } from '../features/agent/blackboard';
import { loadRunMemories } from './memory/runMemory';

const TRACE_FILE_PATH = path.resolve(process.cwd(), '.testflow-traces.jsonl');

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
      blackboardContents: blackboard,
      memoryOrRegistryState: memoryState,
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
  try {
    let out = `[SYSTEM]\n${system}\n\n`;
    for (const msg of messages) {
      out += `[${(msg.role || 'unknown').toUpperCase()}]\n`;
      if (msg.content) {
        out += `${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}\n`;
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out += `Tool Calls: ${JSON.stringify(msg.toolCalls)}\n`;
      }
      if (msg.toolCallId) {
        out += `Tool Call Result for ${msg.toolName} (${msg.toolCallId})\n`;
      }
      out += '\n';
    }
    return out.trim();
  } catch {
    return 'Failed to serialize prompt';
  }
}
