/**
 * discoverAppProfile — the control-inversion agent (agent-native cutover).
 *
 * Replaces the deterministic app classifiers (platformTypeFromSurface / detectSurfaceKind / the
 * ADMIN|RUNTIME + ?nav= assumptions): instead of code deciding the connected app's shape from literals,
 * the AGENT explores the connected app with tools, REASONS about its structure, and emits a typed
 * AppProfile. The decision is published to the blackboard (A2A) and remembered per connected repo, so a
 * second run recalls it instead of re-discovering, and a brand-new repo triggers exactly one discovery.
 *
 * Provider-neutral: rides the existing AIProvider tool-loop (runToolLoop) + strict-output seam
 * (generateStrictObject) — NO Anthropic/OpenAI SDK here. App-agnostic: nothing about any specific app is
 * hardcoded; every fact comes from what the agent observed in the connected repo + live app + its API.
 * Additive + gated by AGENT_NATIVE_V1 at call sites — nothing consumes this until cutover.
 */
import { z } from 'zod';
import type { AgentRunResult, RunToolLoopOptions } from '../../ai/tools/types';
import { defineAppProfile, resolveAppProfile, type AppProfile } from '../appProfile';
import { getToolRegistry, type ToolRegistry } from '../registry/tools';
import { getBlackboard, type Blackboard } from '../bus/blackboard';
import { getMemoryStore, type MemoryScope, type MemoryStore } from '../memory/store';

/** The connected app the agent must learn — repo + URL + token come from USER config, never our code. */
export interface ConnectedApp {
  projectId?: string | null;
  appId?: string | null;
  ownerId?: string | null;
  repoPath?: string | null;
  appUrl?: string | null;
  appLabel?: string | null;
}

export interface DiscoverAppProfileInput {
  connectedApp: ConnectedApp;
  runId: string;
  agent?: string;
  overrides?: { provider?: string; model?: string; effort?: string };
  signal?: AbortSignal;
  /** Discovery tool names the agent may call (registry-resolved). Read-only exploration only. */
  toolNames?: string[];
  // Seams — real defaults imported lazily so tests inject stubs and nothing heavy loads at import.
  explore?: (opts: RunToolLoopOptions) => Promise<AgentRunResult>;
  synthesize?: (understanding: string, app: ConnectedApp) => Promise<AppProfile | null>;
  tools?: ToolRegistry;
  blackboard?: Blackboard;
  memory?: MemoryStore;
}

const DEFAULT_DISCOVERY_TOOLS = ['search_codebase', 'read_code_file', 'explore_page', 'list_surfaces', 'list_api_endpoints'];

/** App-agnostic reasoning prompt: learn THIS app by looking; assume no framework, surface, or routing. */
const EXPLORE_SYSTEM = `You are a test-automation engineer meeting an application for the FIRST time. You know nothing about it — no framework, no surface names, no URL/routing convention, no objects. Learn it ONLY by looking: read the connected repo, inspect its live pages, and list its API endpoints with the tools provided. Determine: what distinct surfaces it exposes, how it authenticates, how it NAVIGATES (does the URL use a query param, a path segment, or a hash?), and what its main sections/objects are. Never assume a convention from another app. When you have enough evidence, state plainly what you found; cite what you observed, do not guess.`;

const SYNTHESIZE_SYSTEM = `Turn the exploration notes into a structured AppProfile for the connected app. Use ONLY facts stated in the notes — never invent surfaces, endpoints, or a routing model that wasn't observed. routingModel is how the app changes sections in its URL (e.g. 'query-param', 'path', 'hash') as observed. Return only JSON matching the schema.`;

const profileWireSchema = z.object({
  appId: z.string().nullable(),
  appLabel: z.string().nullable(),
  surfaces: z.array(z.object({
    name: z.string(),
    baseUrl: z.string(),
    kind: z.string(),
    metadataEndpoint: z.string().nullable(),
  })),
  authMode: z.string().nullable(),
  loginUrl: z.string().nullable(),
  sessionInjected: z.boolean().nullable(),
  metadataEndpoint: z.string().nullable(),
  routingModel: z.string().nullable(),
});
type ProfileWire = z.infer<typeof profileWireSchema>;

function scopeOf(app: ConnectedApp): MemoryScope {
  return { projectId: app.projectId ?? undefined, appId: app.appId ?? undefined, ownerId: app.ownerId ?? undefined };
}

/** Default explorer — the existing multi-provider tool-loop; imported lazily. */
async function defaultExplore(agent: string, opts: RunToolLoopOptions): Promise<AgentRunResult> {
  const { getOrchestrator } = await import('../../ai/orchestrator');
  const orch = await getOrchestrator(agent, { workspaceId: opts.toolContext?.workspaceId, userId: opts.toolContext?.userId });
  return orch.runToolLoop(opts);
}

/** Default synthesizer — the existing strict-output seam (provider-neutral); imported lazily. */
async function defaultSynthesize(agent: string, understanding: string, app: ConnectedApp, overrides?: DiscoverAppProfileInput['overrides'], signal?: AbortSignal): Promise<AppProfile | null> {
  const { generateStrictObject } = await import('../../features/agent/workflow/nodes/authoring');
  const { value } = await generateStrictObject<ProfileWire, AppProfile>({
    node: 'discover_app_profile',
    agent,
    schema: profileWireSchema,
    schemaName: 'app_profile',
    system: SYNTHESIZE_SYSTEM,
    prompt: `CONNECTED APP: ${app.appLabel || app.appId || app.appUrl || 'unknown'}\nEXPLORATION NOTES:\n${understanding.slice(0, 8000)}`,
    validate: (raw: unknown) => {
      const parsed = profileWireSchema.safeParse(raw);
      if (!parsed.success) return { value: null, issues: parsed.error.issues.map((i) => i.message) };
      const d = parsed.data;
      const profile = resolveAppProfile({
        appId: d.appId || app.appId || undefined,
        appLabel: d.appLabel || app.appLabel || undefined,
        surfaces: d.surfaces.map((s) => ({ name: s.name, baseUrl: s.baseUrl, kind: s.kind, metadataEndpoint: s.metadataEndpoint })),
        authMode: d.authMode,
        loginUrl: d.loginUrl,
        sessionInjected: d.sessionInjected ?? false,
        metadataEndpoint: d.metadataEndpoint,
        routingModel: d.routingModel,
      });
      return { value: profile, issues: [] };
    },
    signal,
    overrides,
  });
  return value;
}

/**
 * Discover (or recall) the connected app's profile via agent exploration. Memory-first: a repo already
 * learned is recalled, not re-explored. The result is published to the blackboard as the agent's decision.
 */
export async function discoverAppProfile(input: DiscoverAppProfileInput): Promise<AppProfile> {
  const agent = input.agent || 'chatAssistant';
  const tools = input.tools ?? getToolRegistry();
  const blackboard = input.blackboard ?? getBlackboard();
  const memory = input.memory ?? getMemoryStore();
  const scope = scopeOf(input.connectedApp);

  // Memory-first (self-built, per connected app): recall a prior profile instead of re-discovering.
  const recalled = await memory.recall({ scope, kind: 'semantic', subject: 'app.profile', limit: 1 });
  if (recalled[0]?.value) {
    const profile = recalled[0].value as AppProfile;
    await blackboard.put(input.runId, 'app.profile', profile, agent, { causationId: 'memory-recall' });
    return profile;
  }

  // Explore: the agent LEARNS the connected app with read-only discovery tools.
  const explore = input.explore ?? ((opts) => defaultExplore(agent, opts));
  const agentTools = tools.toolsFor(input.toolNames ?? DEFAULT_DISCOVERY_TOOLS);
  const exploration = await explore({
    task: `Learn the connected application and report what you found. Repo: ${input.connectedApp.repoPath || '(none)'}. Live URL: ${input.connectedApp.appUrl || '(none)'}.`,
    system: EXPLORE_SYSTEM,
    tools: agentTools,
    toolContext: {
      runId: input.runId,
      projectId: input.connectedApp.projectId ?? undefined,
      appId: input.connectedApp.appId ?? undefined,
      workspaceId: input.connectedApp.ownerId ?? undefined,
    },
    signal: input.signal,
  });

  // Synthesize the agent's decision into a typed, validated AppProfile.
  const synthesize = input.synthesize ?? ((notes: string, app: ConnectedApp) => defaultSynthesize(agent, notes, app, input.overrides, input.signal));
  const profile = (await synthesize(exploration.finalText, input.connectedApp))
    // Fail safe: never fabricate; an unusable synthesis yields a minimal profile from the connected identity.
    ?? defineAppProfile({ id: input.connectedApp.appId || 'app', label: input.connectedApp.appLabel || undefined });

  // The connected live URL IS a surface — never report zero when the user gave us one to test.
  if (profile.surfaces.length === 0 && input.connectedApp.appUrl) {
    profile.surfaces.push({ name: input.connectedApp.appLabel || 'app', baseUrl: input.connectedApp.appUrl, kind: 'connected', metadataEndpoint: null });
  }

  // Publish the decision to the blackboard for THIS run regardless of confidence.
  await blackboard.put(input.runId, 'app.profile', profile, agent, { causationId: 'discovery' });
  // Confidence gate: only REMEMBER a profile the agent genuinely learned from (real routing, a surface
  // beyond the seeded one, or a metadata endpoint) — a thin profile must not poison future runs via recall.
  const learned = Boolean(profile.routingModel)
    || profile.surfaces.some((s) => s.kind !== 'connected')
    || Boolean(profile.metadataEndpoint);
  if (learned) await memory.write({ scope, kind: 'semantic', subject: 'app.profile', value: profile, runId: input.runId });
  else console.warn(`[discoverAppProfile] thin profile for '${profile.id}' not remembered (no routing/surfaces/metadata learned) — will re-discover next run.`);
  return profile;
}
