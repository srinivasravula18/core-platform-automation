/**
 * Provider factory and orchestrator.
 *
 * The factory builds a Provider by name from the workspace's stored credentials.
 * The orchestrator wraps the provider with the guardrail pipeline, cost tracking,
 * and the DB-backed prompt store so the rest of the app does not have to repeat
 * that setup.
 *
 * Usage in routes:
 *   const ai = await getOrchestrator(workspaceId, agentName);
 *   const { object, usage, model, latencyMs } = await ai.generateObject({...});
 */

import type { AIProvider, ProviderName } from './providers/types';
import { DEFAULT_MODELS } from './providers/types';
import { GeminiProvider } from './providers/gemini';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { runGuardrailPipeline, type PipelineInput, type PipelineResult } from './guardrails';
import { getActivePrompt } from './promptStore';
import { recordUsage, getDailyCost } from './costTracker';
import { canonicalAgent } from './systemPrompts';
import { db } from '../shared/storage';

export interface ProviderCredentials {
  apiKey: string;
  model?: string;
}

export function getProviderCredentials(provider: ProviderName): ProviderCredentials | null {
  const settings = db.settings?.providerSettings?.[provider];
  if (!settings?.apiKey) {
    if (provider === 'gemini') {
      const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (envKey) return { apiKey: envKey };
    }
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      return { apiKey: process.env.OPENAI_API_KEY };
    }
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return { apiKey: process.env.ANTHROPIC_API_KEY };
    }
    return null;
  }
  return { apiKey: settings.apiKey, model: settings.model };
}

export function buildProvider(provider: ProviderName): AIProvider {
  const creds = getProviderCredentials(provider);
  if (!creds) {
    throw new Error(
      `No credentials configured for provider "${provider}". Add an API key in Settings → AI Providers.`,
    );
  }
  const model = creds.model || DEFAULT_MODELS[provider].default;
  switch (provider) {
    case 'gemini':
      return new GeminiProvider(creds.apiKey, model);
    case 'openai':
      return new OpenAIProvider(creds.apiKey, model);
    case 'anthropic':
      return new AnthropicProvider(creds.apiKey, model);
  }
}

export function listConfiguredProviders(): ProviderName[] {
  const out: ProviderName[] = [];
  for (const name of ['gemini', 'openai', 'anthropic'] as ProviderName[]) {
    if (getProviderCredentials(name)) out.push(name);
  }
  return out;
}

export function resolveProviderForAgent(agent: string): ProviderName {
  const map = db.settings?.agentProviderMap;
  if (map && (map as any)[agent]) return (map as any)[agent] as ProviderName;
  return (db.settings?.defaultProvider as ProviderName) || 'gemini';
}

export function resolveModelForAgent(agent: string, provider: ProviderName): string {
  const map = db.settings?.agentModelMap;
  if (map && (map as any)[agent]) return (map as any)[agent] as string;
  return DEFAULT_MODELS[provider].default;
}

export class AgentOrchestrator {
  constructor(
    private provider: AIProvider,
    private agent: string,
    private workspaceId: string,
    private userId?: string,
  ) {}

  private async assembleSystem(pipeline: PipelineResult): Promise<string> {
    const override = await getActivePrompt(this.agent);
    if (override && override.body) {
      return `${override.body}\n\n[Guardrail pipeline: ${pipeline.requestId}]`;
    }
    return pipeline.systemPrompt;
  }

  async generateObject<T>(opts: { prompt: string; schema: unknown; temperature?: number; maxTokens?: number; userMessage?: string }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
    const result = await this.provider.generateObject<T>({
      system,
      prompt: opts.prompt,
      schema: opts.schema,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { object: result.object, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async generateText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string }) {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
    });
    await recordUsage({
      workspaceId: this.workspaceId,
      userId: this.userId,
      agent: this.agent,
      provider: this.provider.name,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      costUsd: result.usage?.costUsd ?? 0,
      requestId: pipeline.requestId,
    });
    return { text: result.text, usage: result.usage, model: result.model, latencyMs: result.latencyMs, provider: this.provider.name };
  }

  async *streamText(opts: { prompt: string; temperature?: number; maxTokens?: number; userMessage?: string }): AsyncIterable<string> {
    const pipeline = runGuardrailPipeline({
      agent: this.agent as any,
      userMessage: opts.userMessage || opts.prompt,
      workspaceId: this.workspaceId,
      userId: this.userId,
      providerName: this.provider.name,
      modelName: (this.provider as any).defaultModel,
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
      const result = await this.provider.generateText({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens });
      yield result.text;
      return;
    }
    for await (const delta of this.provider.generateTextStream({ system, prompt: opts.prompt, temperature: opts.temperature, maxTokens: opts.maxTokens })) {
      if (delta) yield delta;
    }
  }
}

export async function getOrchestrator(agent: string, opts: { workspaceId?: string; userId?: string } = {}): Promise<AgentOrchestrator> {
  // Resolve legacy agent names onto the 7 canonical roles so prompt overrides,
  // provider/model routing, and usage logging all use one consolidated identity.
  const canonical = canonicalAgent(agent);
  const provider = resolveProviderForAgent(canonical);
  const model = resolveModelForAgent(canonical, provider);
  const base = buildProvider(provider);
  if (model && (base as any).defaultModel !== model) {
    (base as any).defaultModel = model;
  }
  return new AgentOrchestrator(base, canonical, opts.workspaceId || 'default', opts.userId);
}
