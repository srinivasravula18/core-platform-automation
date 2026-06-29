import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderName,
  ProviderResponse,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  ChatMessage,
} from './types';
import { classifyError } from './types';
// Shared, NON-FABRICATING structured-output helpers (one copy for every provider).
import {
  coerceToSchemaShape, repairValidationError, normalizeTestCasePayload, normalizeScriptPayload,
} from './structuredOutput';

type CliTool = 'codex' | 'claude';

function commandFor(tool: CliTool) {
  if (tool === 'codex') return process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) return JSON.parse(objectMatch[0]);
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
    throw new Error('CLI model did not return valid JSON');
  }
}

// The default CLI call timeout. A large structured-output call (e.g. generating several
// full Playwright scripts at once) can legitimately exceed 5 min on the account/CLI
// provider, so allow raising it via env without code changes. App-agnostic infra knob.
const DEFAULT_CLI_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLI_PROVIDER_TIMEOUT_MS) || 300_000);

async function runProcess(command: string, args: string[], stdin: string, timeoutMs = DEFAULT_CLI_TIMEOUT_MS): Promise<string> {
  return await new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    // The Test Flow AI backend may be launched from inside a Codex session. Do not
    // pass parent-session internals to a nested `codex exec`; they can make the
    // child CLI choose the wrong auth/runtime path.
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SANDBOX_NETWORK_DISABLED;
    delete env.CODEX_MANAGED_BY_NPM;
    delete env.CODEX_MANAGED_PACKAGE_ROOT;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`.trim()));
    });
    child.stdin.end(stdin);
  });
}

/** Render a provider-agnostic ChatMessage as plain text for the CLI transcript. */
function renderCliMessage(m: ChatMessage): string {
  if (m.role === 'tool') return `TOOL RESULT (${m.toolName || 'tool'}):\n${m.content || ''}`;
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return `ASSISTANT called: ${m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}`;
  }
  if (m.role === 'assistant') return `ASSISTANT: ${m.content || ''}`;
  if (m.role === 'system') return `SYSTEM: ${m.content || ''}`;
  return `USER: ${m.content || ''}`;
}

export class AccountCliProvider implements AIProvider {
  readonly name: ProviderName;
  private defaultModel: string;
  private tool: CliTool;

  constructor(name: ProviderName, tool: CliTool, defaultModel: string) {
    this.name = name;
    this.tool = tool;
    this.defaultModel = defaultModel;
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  private buildPrompt(opts: GenerateTextOptions) {
    return `${opts.system ? `${opts.system}\n\n` : ''}${opts.prompt}`;
  }

  private async run(opts: GenerateTextOptions): Promise<string> {
    const model = this.modelId(opts);
    if (this.tool === 'codex') {
      const outFile = path.join(os.tmpdir(), `testflow-codex-${randomUUID()}.txt`);
      // In ChatGPT subscription auth mode, Codex should use its own local config
      // model/provider. Passing the app's SDK model can force API-key auth.
      const args = ['exec', '--cd', process.cwd(), '--sandbox', 'read-only', '--color', 'never', '--output-last-message', outFile, '-'];
      try {
        await runProcess(
          commandFor('codex'),
          args,
          this.buildPrompt(opts),
        );
        return (await fs.readFile(outFile, 'utf8')).trim();
      } finally {
        await fs.unlink(outFile).catch(() => undefined);
      }
    }

    // Pass the prompt via stdin to avoid ENAMETOOLONG on large prompts (OS arg-length limits).
    // `claude -p` reads from stdin when no inline prompt argument is given.
    return await runProcess(
      commandFor('claude'),
      ['-p', '--model', model, '--permission-mode', 'dontAsk', '--output-format', 'text'],
      this.buildPrompt(opts),
    );
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const text = await this.run({ prompt: 'Reply with OK only.', maxTokens: 8 });
      return { ok: /\bOK\b/i.test(text), provider: this.name, model: this.defaultModel, error: /\bOK\b/i.test(text) ? undefined : text.slice(0, 200), checkedAt };
    } catch (err: any) {
      return { ok: false, provider: this.name, model: this.defaultModel, error: err?.message || String(err), checkedAt };
    }
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const text = await this.run(opts);
    return {
      object: text,
      text,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      model: this.modelId(opts),
      provider: this.name,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Tool-calling EMULATED via prompting — the account/CLI tools (codex/claude
   * subscription) have no native function-calling API, so we ask the model to reply
   * with a single JSON object choosing either a tool call or a final answer, parse it,
   * and let the loop execute the tool. Less strict than native function-calling (the
   * loop retries on malformed output), but it lets the existing codex/claude login drive
   * the agents without an API key.
   */
  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const start = Date.now();
    const model = this.modelId(opts);
    const toolList = (opts.tools || [])
      .map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters)}`)
      .join('\n');
    const transcript = opts.messages.map(renderCliMessage).join('\n\n');
    const prompt = `You complete the task by calling tools one at a time.

AVAILABLE TOOLS:
${toolList || '(no tools)'}

CONVERSATION SO FAR:
${transcript}

Decide the single next action. Reply with EXACTLY ONE JSON object and NOTHING else (no markdown, no code fences):
- To call a tool: {"action":"tool_call","name":"<toolName>","arguments":{ ... }}
- To give your final answer when the task is done: {"action":"final","text":"<your answer>"}`;

    let raw = '';
    try {
      raw = await this.run({ system: opts.system, prompt, model, signal: opts.signal });
    } catch (err: any) {
      throw classifyError(this.name, undefined, err?.message || String(err));
    }
    const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    let parsed: any;
    try {
      parsed = extractJson(raw);
    } catch {
      // No parseable JSON — treat the whole reply as the final answer.
      return { text: raw.trim() || undefined, toolCalls: [], usage: zeroUsage, model, provider: this.name, stopReason: 'stop', latencyMs: Date.now() - start };
    }
    if (parsed && parsed.action === 'tool_call' && parsed.name) {
      return {
        toolCalls: [{ id: `call_${randomUUID().slice(0, 8)}`, name: String(parsed.name), arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {} }],
        text: undefined,
        usage: zeroUsage,
        model,
        provider: this.name,
        stopReason: 'tool_calls',
        latencyMs: Date.now() - start,
      };
    }
    const finalText = parsed?.action === 'final' ? String(parsed.text ?? '') : (typeof parsed === 'string' ? parsed : raw.trim());
    return { text: finalText || undefined, toolCalls: [], usage: zeroUsage, model, provider: this.name, stopReason: 'stop', latencyMs: Date.now() - start };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const schemaZ = opts.schema as z.ZodTypeAny;
    const prompt = `${opts.prompt}\n\nReturn ONLY a JSON object matching the requested schema. No markdown, no code fences, no commentary.`;
    const text = await this.run({ ...opts, prompt });
    try {
      const parsed = normalizeScriptPayload(normalizeTestCasePayload(coerceToSchemaShape(extractJson(text), schemaZ)));
      try {
        const object = schemaZ.parse(parsed) as T;
        return {
          object,
          text,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          model: this.modelId(opts),
          provider: this.name,
          latencyMs: Date.now() - start,
        };
      } catch (validationError: any) {
        const recovered = repairValidationError(parsed, validationError);
        const object = schemaZ.parse(recovered) as T;
        return {
          object,
          text,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          model: this.modelId(opts),
          provider: this.name,
          latencyMs: Date.now() - start,
        };
      }
    } catch (error: any) {
      // Never surface a raw Zod issues array as the "answer" — summarize the offending
      // fields into a clean, classified error (matches the OpenAI provider's behavior).
      const issues: any[] = Array.isArray(error?.issues) ? error.issues : [];
      if (issues.length) {
        const fields = issues.slice(0, 4).map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '?')).filter(Boolean).join(', ');
        throw classifyError(this.name, 200, `Model response did not match the expected schema${fields ? ` (fields: ${fields})` : ''}.`);
      }
      throw classifyError(this.name, 200, error?.message || 'CLI model did not return schema-valid JSON');
    }
  }
}
