/** Learned per-target app profile. Onboarding a target = providing an AppProfile; nothing app-specific is hardcoded. */

/** A surface is any distinct entry point of a target app (an admin console, a runtime UI, an API host).
 * `kind` is a free-form, app-defined label — deliberately NOT a closed union. */
export interface AppSurface {
  name: string;
  baseUrl: string;
  kind: string;
  /** Optional per-surface metadata endpoint override. */
  metadataEndpoint?: string | null;
}

export interface AppAuthProfile {
  /** 'none' | 'form' | 'sso' | 'token' | any app-defined scheme — data, not a closed union. */
  mode: string;
  loginUrl?: string | null;
  /** True when the execution layer injects an already-authenticated session (scripts stay credential-free). */
  sessionInjected?: boolean;
}

export interface AppProfile {
  id: string;
  label: string;
  surfaces: AppSurface[];
  auth: AppAuthProfile;
  /** App-level metadata endpoint (a surface may override it). */
  metadataEndpoint?: string | null;
  /** How the app expresses navigation/routing (e.g. 'query-param', 'path', 'hash') — data, not a type. */
  routingModel?: string;
  /** Key namespace for per-app storage/memory isolation (defaults to id). */
  storageNamespace: string;
  /** Anything else an app needs to declare, without changing this type. */
  extras?: Record<string, unknown>;
}

export interface DefineAppProfileInput {
  id: string;
  label?: string;
  surfaces?: AppSurface[];
  auth?: Partial<AppAuthProfile>;
  metadataEndpoint?: string | null;
  routingModel?: string;
  storageNamespace?: string;
  extras?: Record<string, unknown>;
}

/** Build a validated AppProfile from data. Pure — fills defaults, never invents app-specific values. */
export function defineAppProfile(input: DefineAppProfileInput): AppProfile {
  if (!input.id) throw new Error('defineAppProfile: id is required.');
  return {
    id: input.id,
    label: input.label ?? input.id,
    surfaces: input.surfaces ?? [],
    auth: { mode: input.auth?.mode ?? 'form', loginUrl: input.auth?.loginUrl ?? null, sessionInjected: input.auth?.sessionInjected ?? false },
    metadataEndpoint: input.metadataEndpoint ?? null,
    // No hardcoded routing default — an undiscovered routing model is honestly absent, never guessed.
    routingModel: input.routingModel,
    storageNamespace: input.storageNamespace ?? input.id,
    extras: input.extras ?? {},
  };
}

/** Find a surface by name (exact) or kind (first match). Returns null when absent — callers branch on it. */
export function surfaceFor(profile: AppProfile, selector: { name?: string; kind?: string }): AppSurface | null {
  if (selector.name) return profile.surfaces.find((s) => s.name === selector.name) ?? null;
  if (selector.kind) return profile.surfaces.find((s) => s.kind === selector.kind) ?? null;
  return profile.surfaces[0] ?? null;
}

/** The metadata endpoint that applies to a surface (surface override → app default → null). */
export function metadataEndpointFor(profile: AppProfile, surface?: AppSurface | null): string | null {
  return surface?.metadataEndpoint ?? profile.metadataEndpoint ?? null;
}

/**
 * Derive an AppProfile from whatever run/mission data is available (base URL, resolved app row, surfaces).
 * A bridge for cutover: existing callers pass their current mission/app data and get a data-driven profile
 * WITHOUT the code needing to know any specific app. Every field is taken from the input, never hardcoded.
 */
export interface AppProfileSource {
  appId?: string | null;
  appLabel?: string | null;
  surfaces?: Array<{ name: string; baseUrl: string; kind: string; metadataEndpoint?: string | null }>;
  authMode?: string | null;
  loginUrl?: string | null;
  sessionInjected?: boolean;
  metadataEndpoint?: string | null;
  routingModel?: string | null;
}

export function resolveAppProfile(source: AppProfileSource): AppProfile {
  return defineAppProfile({
    id: source.appId || 'app',
    label: source.appLabel || source.appId || 'app',
    surfaces: (source.surfaces ?? []).map((s) => ({ name: s.name, baseUrl: s.baseUrl, kind: s.kind, metadataEndpoint: s.metadataEndpoint ?? null })),
    auth: { mode: source.authMode || 'form', loginUrl: source.loginUrl ?? null, sessionInjected: source.sessionInjected ?? false },
    metadataEndpoint: source.metadataEndpoint ?? null,
    routingModel: source.routingModel || undefined,
    storageNamespace: source.appId || undefined,
  });
}
