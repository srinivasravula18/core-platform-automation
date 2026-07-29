/**
 * AppUnderstanding — evidence-carrying, app-agnostic record of what agents LEARNED about a connected app
 * (surfaces, routing, nav, auth keys, API base), replacing hardcoded product facts. Each field carries
 * Evidence so low/no confidence means "ground or ask", never guess. Additive; populated by the producer.
 */

export type EvidenceSource = 'repo' | 'live' | 'api' | 'memory' | 'config' | 'derived' | 'none';

export interface Evidence {
  source: EvidenceSource;
  /** 0..1 — how strongly the value is grounded. 0 = honest unknown, never a guess. */
  confidence: number;
  /** Optional citations (repo paths, URLs, endpoints) backing the value. */
  cites?: string[];
}

/** A distinct entry point of the connected app. `targetsTenantApp` replaces the ADMIN/RUNTIME guess:
 *  true = the surface scopes to a tenant application (URL carries an app scope); false = platform root. */
export interface UnderstoodSurface {
  name: string;
  baseUrl: string;
  kind: string;
  targetsTenantApp: boolean;
}

/** How the app expresses navigation in its URL — learned, not assumed. Param names are the app's own. */
export interface RoutingModel {
  model: 'query-param' | 'path' | 'hash' | 'unknown';
  appIdParam?: string | null;
  navParam?: string | null;
  objectParam?: string | null;
}

/** How the app authenticates. storageKeys replace hardcoded token keys (e.g. product-specific *.auth_token). */
export interface AuthUnderstanding {
  mode: string;
  loginUrl?: string | null;
  sessionInjected: boolean;
  storageKeys: string[];
}

/** Where the app's data/metadata API lives — learned, replacing hardcoded hosts/endpoints. */
export interface ApiUnderstanding {
  baseUrl?: string | null;
  metadataEndpoint?: string | null;
  listEndpointShape?: string | null;
}

export interface AppUnderstanding {
  appId: string;
  appLabel: string;
  surfaces: UnderstoodSurface[];
  routing: RoutingModel;
  navModules: Array<{ id: string; name: string }>;
  objects: Array<{ apiName: string; label: string }>;
  auth: AuthUnderstanding;
  api: ApiUnderstanding;
  /** Per-field evidence, keyed by field path (e.g. 'routing', 'auth.storageKeys', 'api.baseUrl'). */
  evidence: Record<string, Evidence>;
  /** Overall grounding confidence 0..1. */
  confidence: number;
}

export interface UnderstandingInput {
  appId?: string | null;
  appLabel?: string | null;
  surfaces?: UnderstoodSurface[];
  routing?: Partial<RoutingModel>;
  navModules?: Array<{ id: string; name: string }>;
  objects?: Array<{ apiName: string; label: string }>;
  auth?: Partial<AuthUnderstanding>;
  api?: Partial<ApiUnderstanding>;
  evidence?: Record<string, Evidence>;
  confidence?: number;
}

const NONE: Evidence = { source: 'none', confidence: 0 };

/** Build a validated AppUnderstanding with HONEST defaults — unknown routing, empty sets, zero confidence.
 *  Never invents app-specific values; absence is expressed, not guessed. */
export function defineUnderstanding(input: UnderstandingInput): AppUnderstanding {
  return {
    appId: input.appId || 'app',
    appLabel: input.appLabel || input.appId || 'app',
    surfaces: input.surfaces ?? [],
    routing: {
      model: input.routing?.model ?? 'unknown',
      appIdParam: input.routing?.appIdParam ?? null,
      navParam: input.routing?.navParam ?? null,
      objectParam: input.routing?.objectParam ?? null,
    },
    navModules: input.navModules ?? [],
    objects: input.objects ?? [],
    auth: {
      mode: input.auth?.mode ?? 'unknown',
      loginUrl: input.auth?.loginUrl ?? null,
      sessionInjected: input.auth?.sessionInjected ?? false,
      storageKeys: input.auth?.storageKeys ?? [],
    },
    api: {
      baseUrl: input.api?.baseUrl ?? null,
      metadataEndpoint: input.api?.metadataEndpoint ?? null,
      listEndpointShape: input.api?.listEndpointShape ?? null,
    },
    evidence: input.evidence ?? {},
    confidence: input.confidence ?? 0,
  };
}

/** Generic floor: derive only what the URL alone proves (a surface targets a tenant app iff its URL
 *  carries an app-scope param); everything else stays unknown for the producer/downstream to fill. */
export function deriveUnderstandingFromUrl(appUrl: string, appId?: string | null, appLabel?: string | null): AppUnderstanding {
  let targetsTenantApp = false;
  let appIdParam: string | null = null;
  try {
    const u = new URL(String(appUrl || ''));
    // App-scope is signalled by a param the URL already carries; we read it, we do not assume its name.
    for (const candidate of ['appId', 'app', 'application']) {
      if (u.searchParams.has(candidate)) { targetsTenantApp = true; appIdParam = candidate; break; }
    }
  } catch { /* non-URL input → nothing derivable */ }
  const surface: UnderstoodSurface = {
    name: appLabel || appId || 'app',
    baseUrl: String(appUrl || ''),
    kind: 'connected',
    targetsTenantApp,
  };
  return defineUnderstanding({
    appId: appId || undefined,
    appLabel: appLabel || undefined,
    surfaces: appUrl ? [surface] : [],
    routing: { model: appIdParam ? 'query-param' : 'unknown', appIdParam },
    evidence: {
      surfaces: { source: appUrl ? 'derived' : 'none', confidence: appUrl ? 0.3 : 0 },
      routing: { source: appIdParam ? 'derived' : 'none', confidence: appIdParam ? 0.3 : 0 },
    },
    confidence: appUrl ? 0.2 : 0,
  });
}
