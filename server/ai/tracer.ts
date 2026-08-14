import { promises as fs } from 'fs';
import path from 'path';
import { latestBlackboard } from '../features/agent/blackboard';
import { loadRunMemories } from './memory/runMemory';

const TRACE_FILE_PATH = path.resolve(process.cwd(), '.testflow-traces.jsonl');
const TRACE_ARCHIVE_PATH = `${TRACE_FILE_PATH}.1`;
const TRACE_FIELD_MAX_CHARS = Math.max(1024, Number(process.env.TESTFLOW_TRACE_FIELD_MAX_CHARS) || 16_000);
const TRACE_FILE_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.TESTFLOW_TRACE_FILE_MAX_BYTES) || 25 * 1024 * 1024);
let traceBytes: number | null = null;
let traceWriteQueue: Promise<void> = Promise.resolve();

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
export function boundTraceValue(value: unknown, maxChars = TRACE_FIELD_MAX_CHARS): unknown {
  if (value === null || value === undefined) return value;
  let serialized: string;
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    serialized = json === undefined ? String(value) : json;
  }
  catch { return { truncated: true, preview: '[unserializable trace value]' }; }
  if (serialized.length <= maxChars) return value;
  return { truncated: true, originalChars: serialized.length, preview: serialized.slice(0, maxChars) };
}

function boundTraceText(value: string): string {
  const bounded = boundTraceValue(value);
  return typeof bounded === 'string' ? bounded : JSON.stringify(bounded);
}

async function appendTrace(step: Omit<ExecutionTraceStep, 'timestamp' | 'blackboardContents' | 'memoryOrRegistryState'>): Promise<void> {
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
      toolInputs: boundTraceValue(step.toolInputs) as Record<string, unknown> | null,
      toolOutputs: boundTraceValue(step.toolOutputs),
      contextReceived: boundTraceValue(step.contextReceived),
      contextPassed: boundTraceValue(step.contextPassed),
      finalPromptSent: boundTraceText(step.finalPromptSent),
      blackboardContents: boundTraceValue(blackboard),
      memoryOrRegistryState: boundTraceValue(memoryState),
      timestamp: new Date().toISOString()
    };

    const line = JSON.stringify(fullStep) + '\n';
    const lineBytes = Buffer.byteLength(line);
    if (traceBytes === null) traceBytes = await fs.stat(TRACE_FILE_PATH).then((stat) => stat.size).catch(() => 0);
    if (traceBytes + lineBytes > TRACE_FILE_MAX_BYTES) {
      await fs.rm(TRACE_ARCHIVE_PATH, { force: true });
      await fs.rename(TRACE_FILE_PATH, TRACE_ARCHIVE_PATH).catch((error: any) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      traceBytes = 0;
    }
    await fs.appendFile(TRACE_FILE_PATH, line, 'utf8');
    traceBytes += lineBytes;
  } catch (err) {
    console.error(`[Tracer] Failed to write execution trace:`, err);
  }
}

export function logExecutionTrace(step: Omit<ExecutionTraceStep, 'timestamp' | 'blackboardContents' | 'memoryOrRegistryState'>): Promise<void> {
  const queued = traceWriteQueue.then(() => appendTrace(step));
  traceWriteQueue = queued.catch(() => undefined);
  return queued;
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
    const serialized = out.trim();
    if (serialized.length <= TRACE_FIELD_MAX_CHARS) return serialized;
    return `${serialized.slice(0, TRACE_FIELD_MAX_CHARS)}\n[trace prompt truncated; ${serialized.length} chars total]`;
  } catch {
    return 'Failed to serialize prompt';
  }
}
