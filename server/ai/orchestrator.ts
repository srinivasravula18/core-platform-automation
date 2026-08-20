/**
 * Codex runtime factory and orchestrator.
 *
 * The factory builds the Codex provider from the workspace's stored credentials. The
 * orchestrator wraps it with the guardrail pipeline, cost tracking, and the DB-backed
 * prompt store so the rest of the app does not have to repeat that setup.
 *
 * Usage in routes:
 *   const ai = await getOrchestrator(workspaceId, agentName);
 *   const { object, usage, model, latencyMs } = await ai.generateObject({...});
 */

import type { AIProvider, ProviderAuthMode, ProviderName, ProviderResponse, ProviderImage, ProviderUsage } from './providers/types';
import { DEFAULT_MODELS, listAvailableModels } from './providers/types';
import type { AgentStep, AgentRunResult, RunToolLoopOptions, ToolInvocation } from './tools/types';
import { CodexProvider } from './providers/codex';
import { openBridgeSession } from './codex/mcpBridge';
import { isKnownCodexModel } from './codex/runtime';
import { runGuardrailPipeline, type PipelineInput, type PipelineResult } from './guardrails';
import { getActivePrompt } from './promptStore';
import { recordUsage, getDailyCost } from './costTracker';
import { canonicalAgent } from './systemPrompts';
import { db } from '../shared/storage';
import { logExecutionTrace, serializePrompt } from './tracer';
import { rememberToolResult } from './memory/artifactMemory';
import { getUserById } from '../features/auth/userStore';
import { effectiveGrantsForUser, isAllowed } from '../features/auth/groupStore';

export interface ProviderCredentials {
  apiKey: string;
  model?: string;
  authMode: ProviderAuthMode;
}

/** One runtime. The name survives because usage/trace records and RBAC grants key on it. */
export const CODEX: ProviderName = 'codex';
const PROVIDERS: ProviderName[] = [CODEX];

/**
 * Codex credentials: an API key when one is configured (stored or `OPENAI_API_KEY`),
 * otherwise the machine's ChatGPT/Codex login. Account auth needs no key, so — unlike the
 * old multi-provider factory — "no key" is a valid, fully usable configuration.
 */
export function getProviderCredentials(provider: ProviderName = CODEX): ProviderCredentials | null {
  const settings = db.settings?.providerSettings?.[provider];
  if (settings?.enabled === false) return null;
  const apiKey = settings?.apiKey || process.env.OPENAI_API_KEY || '';
  if (apiKey && settings?.authMode !== 'account') {
    return { apiKey, model: settings?.model, authMode: 'api_key' };
  }
  return { apiKey: '', model: settings?.model, authMode: 'account' };
}

export function buildProvider(provider: ProviderName = CODEX, modelOverride?: string): AIProvider {
  const creds = getProviderCredentials(provider);
  if (!creds) throw new Error('The Codex runtime is disabled. Enable it in Settings → AI Runtime.');
  const model = modelOverride || creds.model || DEFAULT_MODELS[provider].default;
  // explicitModel: only pin a model id when the user actually chose one — account auth
  // otherwise defers to the local Codex config, which is what `codex` itself would use.
  return new CodexProvider(creds.apiKey, model, { explicitModel: !!(modelOverride || creds.model) });
}

// The runtime is usable by `userId` when an Access Group grants it. No userId (internal/system)
// or an admin/ungrouped user is UNRESTRICTED. Config is global, so this is a per-user allow-list.
function providerAllowedForUser(userId: string | undefined, provider: ProviderName): boolean {
  if (!userId) return true;
  return isAllowed(effectiveGrantsForUser(getUserById(userId)), 'providers', provider);
}

export function listConfiguredProviders(userId?: string): ProviderName[] {
  return PROVIDERS.filter((name) => getProviderCredentials(name) && providerAllowedForUser(userId, name));
}

// User-facing message shown when the runtime cannot run. Kept in one place so every agent entry
// point fails fast with the SAME actionable text instead of starting work that then errors.
export const NO_PROVIDER_MESSAGE = 'The Codex runtime is not available. Sign in with "codex login", or add an OpenAI API key in Settings → AI Runtime.';

/** True when the Codex runtime is enabled and permitted. */
export function isAnyProviderConfigured(): boolean {
  return listConfiguredProviders().length > 0;
}

/**
 * Why the runtime cannot run, in the user's terms. Returns '' when it CAN run. Codex
 * authentication itself is checked asynchronously by the health endpoint; this covers the
 * synchronous config-level blockers only.
 */
export function providerBlockerReason(): string {
  if (isAnyProviderConfigured()) return '';
  if (db.settings?.providerSettings?.[CODEX]?.enabled === false) {
    return 'The Codex runtime is switched off — enable it in Settings → AI Runtime.';
  }
  return 'Your account is not granted access to the Codex runtime. Ask an admin to grant it in Access Groups.';
}

/** Single runtime — kept as a function so callers and traces keep a stable seam. */
export function resolveProviderForAgent(_agent: string, _userId?: string): ProviderName {
  return CODEX;
}

/** Settings offers every model the live runtime lists, so both sources count as valid here. */
function isSelectableModel(model: string, provider: ProviderName): boolean {
  return !!model && (listAvailableModels(provider).includes(model) || isKnownCodexModel(model));
}

export function resolveModelForAgent(agent: string, provider: ProviderName = CODEX, override?: string): string {
  if (isSelectableModel(String(override || ''), provider)) return String(override);
  // 1) per-agent override (Settings → AI Runtime → per-agent model)
  const map = db.settings?.agentModelMap;
  const agentModel = map && (map as any)[agent] ? String((map as any)[agent]) : '';
  if (isSelectableModel(agentModel, provider)) return agentModel;
  // 2) runtime-level model chosen in Settings. Without this, getOrchestrator overwrites the
  //    UI-selected model with the hard default, so the Settings choice never reached agents.
  const providerModel = db.settings?.providerSettings?.[provider]?.model;
  if (isSelectableModel(providerModel, provider)) return providerModel;
  return DEFAULT_MODELS[provider].default;
}

type ReasoningEffort = string;

/**
 * Agents whose output quality depends directly on reasoning depth. These run at
 * 'high' effort unless the user explicitly configured an effort for them — the
 * shallow default was a major source of thin, low-coverage generated artifacts
 * (test cases, feature inventories) compared to the same prompt run manually in
 * a full reasoning model. Role-based, app-agnostic.
 */
const HIGH_EFFORT_AGENTS = new Set(['caseWriter', 'featureAnalyst', 'featureDiscoveryAgent', 'e2eFlowAgent', 'testPlanner']);

function isEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(v);
}

/**
 * Resolve the reasoning effort for an agent:
 *   explicit caller override (the topbar effort selector, carried on the run)
 *   → per-agent settings override → high-effort role floor → provider setting → medium.
 * The caller override is authoritative: when the user picks an effort in the Agent
 * Console topbar, that choice governs every agent in that run.
 */
export function resolveEffortForAgent(agent: string, provider: ProviderName, override?: string): ReasoningEffort {
  if (isEffort(override)) return override;
  const map = (db.settings as any)?.agentEffortMap;
  const perAgent = map && map[agent];
  if (isEffort(perAgent)) return perAgent;
  if (HIGH_EFFORT_AGENTS.has(agent)) return 'high';
  const stored = (db.settings?.providerSettings?.[provider] as any)?.effort;
  if (isEffort(stored)) return stored;
  return 'medium';
}

export class AgentOrchestrator {
  constructor(
    private provider: AIProvider,
    private agent: string,
    private workspaceId: string,
    private userId?: string,
    private effort?: ReasoningEffort,
  ) {}

  private async assembleSystem(pipeline: PipelineResult): Promise<string> {
    const override = await getActivePrompt(this.agent);
    if (override && override.body) {
      return `${override.body}\n\n[Guardrail pipeline: ${pipeline.requestId}]`;
    }
    return pipeline.systemPrompt;
  }

  async generateObject<T>(opts: { prompt: string; schema: unknown; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean; images?: ProviderImage[] }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      return { shortCircuit: pipeline.policyVerdict.reply, object: undefined, usage: undefined, model: '', latencyMs: 0 };
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    // GLOBAL resilience: a provider can occasionally return off-schema JSON (esp. smaller /
    // low-effort models like a Codex mini). Rather than fail the whole agent stage on a
    // one-off bad response, retry the structured-output call once with a firm reminder to
    // emit ONLY valid JSON for the schema. This is a retry — NOT fabrication — so a real,
    // persistent mismatch still surfaces honestly.
    // Retry when the model's output is unusable — EITHER off-schema OR malformed/truncated
    // JSON (a parse error). Both are "the model produced bad structured output"; a fresh
    // attempt usually fixes it. NOT a retry for auth/network (callWithRetry handles those).
    const isBadOutput = (e: any) => /schema|invalid_type|invalid_value|expected .*received|did not match|valid json|received undefined|unexpected token|unexpected end of (json|input)|in json at position|after property value|not valid json|json\.parse/i.test(String(e?.message || ''));
    let result: ProviderResponse<T>;
    try {
      result = await this.provider.generateObject<T>({ system, prompt: opts.prompt, schema: opts.schema, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort, images: opts.images });
    } catch (err: any) {
      if (!isBadOutput(err)) throw err;
      const retrySystem = `${system}\n\nIMPORTANT: Your previous reply was not usable — it was not a single valid JSON object matching the required schema (it was malformed, truncated, or off-schema). Reply with ONLY one complete, valid JSON object that exactly matches the schema — all required fields present, correct types, properly closed braces/brackets, no prose, no markdown, no code fences.`;
      result = await this.provider.generateObject<T>({ system: retrySystem, prompt: opts.prompt, schema: opts.schema, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort, images: opts.images });
    }
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    
    // --- Trace Execution (generateObject) ---
    logExecutionTrace({
      stepNumber: 1,
      agentName: this.agent,
      toolInvoked: null,
      toolInputs: null,
      toolOutputs: result.object,
      contextReceived: opts.userMessage || opts.prompt,
      contextPassed: result.object,
      tokenUsage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : null,
      informationTruncated: false,
      evidenceDiscarded: false,
      assumptionsMade: "Not explicitly provided by model",
      whyNextToolSelected: "Single-shot generation",
      finalPromptSent: serializePrompt(system, [{ role: 'user', content: opts.prompt }]),
      runId: pipeline.requestId
    }).catch(console.error);
    // ----------------------------------------
    
    return { object: result.object, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  // meta: prepared-invocation trace correlation (Conversational Runtime) — no routing logic here.
  async generateText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean; signal?: AbortSignal; meta?: { requestId?: string; capability?: string; manifestId?: string } }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      return { shortCircuit: pipeline.policyVerdict.reply, text: '', usage: undefined, model: '', latencyMs: 0 };
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    const result = await this.provider.generateText({
      system,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      effort: this.effort,
      signal: opts.signal,
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    
    // --- Trace Execution (generateText) ---
    logExecutionTrace({
      stepNumber: 1,
      agentName: this.agent,
      toolInvoked: null,
      toolInputs: null,
      toolOutputs: result.text,
      contextReceived: opts.userMessage || opts.prompt,
      contextPassed: result.text,
      tokenUsage: result.usage ? { promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0 } : null,
      informationTruncated: false,
      evidenceDiscarded: false,
      assumptionsMade: "Not explicitly provided by model",
      whyNextToolSelected: "Single-shot generation",
      finalPromptSent: serializePrompt(system, [{ role: 'user', content: opts.prompt }]),
      runId: opts.meta?.requestId || pipeline.requestId
    }).catch(console.error);
    // ----------------------------------------

    return { text: result.text, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async *streamText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string; hasHistory?: boolean; signal?: AbortSignal }): AsyncIterable<string> {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: opts.hasHistory,
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'respond') {
      yield pipeline.policyVerdict.reply;
      return;
    }
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = await this.assembleSystem(pipeline);
    if (!this.provider.generateTextStream) {
      // Providers without native streaming (the account/CLI runner) return the whole
      // answer at once. Emit it in small word-grouped chunks so the UI still renders
      // progressively instead of dumping a wall of text. (True low-latency token
      // streaming still requires an API-key/SDK provider.)
      const result = await this.provider.generateText({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort, signal: opts.signal });
      // This branch returns early, so it needs its own accounting — streamed turns were billing as zero.
      await this.bookUsage(result.usage, result.model, pipeline.requestId);
      const full = result.text || '';
      const tokens = full.match(/\S+\s*/g) || (full ? [full] : []);
      let buf = '';
      for (let i = 0; i < tokens.length; i += 1) {
        buf += tokens[i];
        // Flush every few words so the client paints incrementally.
        if ((i + 1) % 4 === 0) { yield buf; buf = ''; }
      }
      if (buf) yield buf;
      return;
    }
    let streamed: { usage?: ProviderUsage; model?: string } | null = null;
    try {
      for await (const delta of this.provider.generateTextStream({     system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens, effort: this.effort, signal: opts.signal , onUsage: (usage, model) => { streamed = { usage, model }; } })) {
        if (delta) yield delta;
      }
    } finally {
      // In a finally so an aborted or failed stream still books what the provider already spent.
      if (streamed) await this.bookUsage(streamed.usage, streamed.model, pipeline.requestId);
    }
  }

  /** One place to write a usage_log row for an egress that does not pass through generateText/Object. */
  private async bookUsage(usage: ProviderUsage | undefined, model: string | undefined, requestId: string) {
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: model || (this.provider as any).defaultModel || '',
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
      requestId,
    }).catch(() => { /* accounting must never break a turn */ });
  }

  /**
   * Run a grounded agentic tool loop on ONE Codex thread.
   *
   * The application's tools are exposed through a scoped, loopback-only MCP bridge, so Codex
   * calls them natively — no prose-emulated tool protocol, and no re-sending the whole transcript
   * every round-trip. Codex iterates internally; this method owns what stays application business:
   * guardrails, usage/tracing, artifact memory, the honesty gate on an empty answer, and Reflexion
   * retries driven by `accept`. Each retry is a follow-up turn on the SAME thread, so the agent
   * keeps everything it already learned.
   */
  async runToolLoop(opts: RunToolLoopOptions): Promise<AgentRunResult> {
    const runtime = (this.provider as CodexProvider).codex;
    if (!runtime) throw new Error('The active runtime does not support tool loops.');
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.guardrailInput || opts.task,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
      hasHistory: true, // a tool loop is an ongoing task, never a bare one-liner to short-circuit
    } as PipelineInput);
    if (pipeline.policyVerdict.kind === 'reject') {
      const err: any = new Error(pipeline.policyVerdict.error);
      err.status = pipeline.policyVerdict.code;
      throw err;
    }
    const system = opts.system || (await this.assembleSystem(pipeline));
    const ctx = opts.toolContext || {};
    const maxAcceptRetries = opts.maxAcceptRetries ?? 2;

    const steps: AgentStep[] = [];
    const toolResults: AgentRunResult['toolResults'] = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    let stepIndex = 0;

    // Tool calls settle inside the bridge; this is where each becomes a visible step, a trace
    // row, and — when the call belongs to a conversation — a remembered artifact.
    const bridge = await openBridgeSession({
      tools: opts.tools,
      ctx,
      maxToolCalls: opts.maxSteps ?? 12,
      onInvocationStart: (invocation) => {
        opts.onToolStart?.({
          id: invocation.id,
          name: invocation.name,
          arguments: invocation.arguments,
        });
      },
      onInvocation: (invocation) => {
        const inv: ToolInvocation = {
          id: invocation.id, name: invocation.name, arguments: invocation.arguments,
          result: invocation.result, error: invocation.error, ms: invocation.ms,
        };
        const step: AgentStep = { index: stepIndex++, toolCalls: [inv] };
        steps.push(step);
        opts.onStep?.(step);
        if (!invocation.error) toolResults.push({ name: invocation.name, arguments: invocation.arguments, result: invocation.result });
        if (!invocation.error && ctx.conversationId) {
          rememberToolResult({
            conversationId: String(ctx.conversationId),
            runId: ctx.runId ? String(ctx.runId) : undefined,
            toolName: invocation.name,
            arguments: invocation.arguments,
            result: invocation.result,
          }).catch((error) => console.warn('[memory] artifact persistence failed:', error?.message || error));
        }
        logExecutionTrace({
          stepNumber: step.index + 1,
          agentName: this.agent,
          toolInvoked: invocation.name,
          toolInputs: invocation.arguments,
          toolOutputs: invocation.result ?? invocation.error,
          contextReceived: opts.task,
          contextPassed: invocation.result ?? invocation.error,
          tokenUsage: null,
          informationTruncated: false,
          evidenceDiscarded: false,
          assumptionsMade: 'Not explicitly provided by model',
          whyNextToolSelected: 'Chosen by the agent during its own tool loop',
          finalPromptSent: serializePrompt(system, [{ role: 'user', content: opts.task }]),
          runId: opts.contextManifestId || pipeline.requestId,
        }).catch(console.error);
      },
    });

    // Each bridge URL is scoped to this request and revoked in finally. App Server retains the
    // MCP URL on a resumed thread, so cross-request thread reuse would call the revoked URL and
    // return 401. Seed application-owned history into a fresh thread; retries within this request
    // may still reuse that thread while this bridge remains alive.
    let threadId: string | undefined;
    const history = (opts.seedMessages || [])
      .filter((m) => (m.content || '').trim())
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    let finalText = '';
    let acceptRetries = 0;

    try {
      let prompt = history ? `CONVERSATION SO FAR:\n${history}\n\nTASK:\n${opts.task}` : opts.task;
      for (;;) {
        if (opts.signal?.aborted) return { finalText, steps, accepted: false, stoppedReason: 'aborted', toolResults, totalUsage };
        if (opts.maxTotalTokens && totalUsage.totalTokens >= opts.maxTotalTokens) {
          return { finalText, steps, accepted: false, stoppedReason: 'budget', toolResults, totalUsage };
        }

        const runTurn = (resumeFrom?: string) => callWithRetry(() => runtime.run({
          system,
          prompt,
          model: (this.provider as any).defaultModel,
          effort: this.effort,
          signal: opts.signal,
          onTextDelta: opts.onTextDelta,
          threadId: resumeFrom,
          mcpServers: bridge.mcpServers,
          env: bridge.env,
            }), opts.signal);

        let turn: Awaited<ReturnType<typeof runTurn>>;
        try {
          turn = await runTurn(threadId);
        } catch (err: any) {
          // A retry on this request's thread may still fail if App Server discarded it.
          if (!threadId || opts.signal?.aborted) throw err;
          console.warn(`[codex] resuming thread ${threadId} failed (${err?.message || err}); starting a new thread`);
          threadId = undefined;
          turn = await runTurn(undefined);
        }
        threadId = turn.threadId || threadId;
        finalText = turn.text || '';

        totalUsage.inputTokens += turn.usage.inputTokens ?? 0;
        totalUsage.outputTokens += turn.usage.outputTokens ?? 0;
        totalUsage.totalTokens += turn.usage.totalTokens ?? 0;
        totalUsage.costUsd += turn.usage.costUsd ?? 0;
        await recordUsage({
          workspaceId: this.workspaceId,
          userId: this.userId,
          agent: this.agent,
          provider: this.provider.name,
          model: turn.model,
          inputTokens: turn.usage.inputTokens ?? 0,
          outputTokens: turn.usage.outputTokens ?? 0,
          cacheReadTokens: turn.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: turn.usage.cacheWriteTokens ?? 0,
          costUsd: turn.usage.costUsd ?? 0,
          requestId: opts.contextManifestId || pipeline.requestId,
        });

        const answerStep: AgentStep = { index: stepIndex++, text: finalText, toolCalls: [], usage: turn.usage };
        steps.push(answerStep);
        opts.onStep?.(answerStep);
        logExecutionTrace({
          stepNumber: answerStep.index + 1,
          agentName: this.agent,
          toolInvoked: null,
          toolInputs: null,
          toolOutputs: finalText,
          contextReceived: opts.task,
          contextPassed: finalText,
          tokenUsage: { promptTokens: turn.usage.inputTokens ?? 0, completionTokens: turn.usage.outputTokens ?? 0 },
          informationTruncated: false,
          evidenceDiscarded: false,
          assumptionsMade: 'Not explicitly provided by model',
          whyNextToolSelected: 'Goal is complete',
          finalPromptSent: serializePrompt(system, [{ role: 'user', content: prompt }]),
          runId: opts.contextManifestId || pipeline.requestId,
        }).catch(console.error);

        // HONESTY GATE: an empty answer is NOT a success. Reporting accepted:true with no real
        // content is exactly the fake-green failure this pipeline exists to eliminate.
        if (!finalText.trim()) {
          if (acceptRetries < maxAcceptRetries) {
            acceptRetries += 1;
            prompt = 'Your result was not accepted because you returned an empty final answer. Produce a complete, non-empty final answer.';
            continue;
          }
          return { finalText, steps, accepted: false, stoppedReason: 'empty_response', toolResults, totalUsage };
        }

        if (opts.accept) {
          const verdict = await opts.accept({ finalText, steps, ctx });
          if (!verdict.ok && acceptRetries < maxAcceptRetries) {
            acceptRetries += 1;
            // Grounded Reflexion: append the critique and let the agent try again on the same thread.
            prompt = `Your result was not accepted. ${verdict.feedback || 'It did not meet the acceptance criteria.'} Diagnose why and try again — do not repeat the same approach.`;
            continue;
          }
          return { finalText, steps, accepted: verdict.ok, stoppedReason: verdict.ok ? 'accepted' : 'max_steps', toolResults, totalUsage };
        }

        return { finalText, steps, accepted: true, stoppedReason: 'final_text', toolResults, totalUsage };
      }
    } finally {
      bridge.close();
    }
  }
}

/** Retry transient provider errors (rate_limit / network / 429 / 5xx) with exponential
 * backoff. Gemini and Anthropic SDKs do not retry on their own, so a single 503 would
 * otherwise abort a whole agent run. Non-transient errors (auth, bad_request) throw
 * immediately. */
async function callWithRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i += 1) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      const status = err?.status;
      const retryable = code === 'rate_limit' || code === 'network' || status === 429 || (status >= 500 && status < 600);
      if (!retryable || i === attempts - 1) throw err;
      const delayMs = Math.min(8000, 500 * 2 ** i);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** The Codex runtime always supports tool calling, so this is `getOrchestrator` with a guard. */
export async function getToolCapableOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string; model?: string; effort?: string } = {}): Promise<AgentOrchestrator> {
  if (!listConfiguredProviders(opts.userId).length) {
    throw new Error(providerBlockerReason() || NO_PROVIDER_MESSAGE);
  }
  return getOrchestrator(agent, opts);
}

export async function getOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string; model?: string; effort?: string } = {}): Promise<AgentOrchestrator> {
  // Resolve legacy agent names onto the canonical roles so prompt overrides,
  // model routing, and usage logging all use one consolidated identity.
  const canonical = canonicalAgent(agent);
  const provider = resolveProviderForAgent(canonical, opts.userId);
  const model = resolveModelForAgent(canonical, provider, opts.model);
  const base = buildProvider(provider, model);
  return new AgentOrchestrator(base, canonical, opts.workspaceId || 'default', opts.userId, resolveEffortForAgent(canonical, provider, opts.effort));
}
