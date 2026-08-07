/**
 * App API contract — resolves a connected app's metadata endpoints from its OWN published OpenAPI spec,
 * so the data tools build paths from the app's real contract instead of hardcoded `/api/apps/...` literals.
 * App-agnostic: every path comes from the spec; a role absent from the spec is left undefined and the
 * caller skips it gracefully. Cached per service base. No product paths are hardcoded here.
 */
import { fetchOpenApiSpec, parseOpenApi } from '../../features/api-intelligence/discovery';
import type { ApiEndpoint } from '../../features/api-intelligence/types';

export interface AppApiContract {
  /** GET — list applications. */
  listApps?: string;
  /** GET — list an app's objects. Has an app-id path param. */
  listObjects?: string;
  /** GET — describe one object's fields. Has app-id + object path params. */
  describeObject?: string;
  /** GET — an object's access flags. */
  objectAccess?: string;
  /** POST — query an object's list view (records). */
  queryListView?: string;
  /** POST — create a record for an object. */
  createRecord?: string;
  /** GET — an app's tabs. */
  listTabs?: string;
  /** GET — an object's list views (definitions, not records). */
  listViews?: string;
  /** GET — an object's fields (admin surface, keyed by internal object id). */
  objectFields?: string;
  /** GET — an object's layouts (admin surface). */
  objectLayouts?: string;
  /** GET — an object's form (admin surface). */
  objectForm?: string;
}

const cache = new Map<string, { contract: AppApiContract; at: number }>();
const operationCache = new Map<string, { operations: ApiEndpoint[]; at: number }>();
const TTL_MS = 10 * 60 * 1000;

function match(endpoints: any[], method: string, re: RegExp): string | undefined {
  const e = endpoints.find((x) => String(x.method).toUpperCase() === method && re.test(String(x.path)));
  return e ? String(e.path) : undefined;
}

/** Fetch + parse the app's OpenAPI and derive its metadata endpoint templates. Empty when no spec. */
export async function resolveAppApiContract(serviceBase: string, token?: string): Promise<AppApiContract> {
  const key = String(serviceBase || '').replace(/\/+$/, '');
  if (!key) return {};
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.contract;
  const endpoints = await resolveAppApiOperations(key, token);
  const contract: AppApiContract = {
    listApps: match(endpoints, 'GET', /\/apps$/),
    listObjects: match(endpoints, 'GET', /\{[^}]+\}\/objects$/),
    describeObject: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/describe$/),
    objectAccess: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/access$/),
    queryListView: match(endpoints, 'POST', /\/list-views\/query$/),
    createRecord: match(endpoints, 'POST', /\/objects\/\{[^}]+\}\/records$/),
    listTabs: match(endpoints, 'GET', /\{[^}]+\}\/tabs$/),
    listViews: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/list-views$/),
    objectFields: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/fields$/),
    objectLayouts: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/layouts$/),
    objectForm: match(endpoints, 'GET', /\/objects\/\{[^}]+\}\/form$/),
  };
  cache.set(key, { contract, at: Date.now() });
  return contract;
}

/** Complete live operation catalog for the restricted OpenAPI escape hatch. */
export async function resolveAppApiOperations(serviceBase: string, token?: string): Promise<ApiEndpoint[]> {
  const key = String(serviceBase || '').replace(/\/+$/, '');
  if (!key) return [];
  const hit = operationCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.operations;
  let operations: ApiEndpoint[] = [];
  try {
    const spec = await fetchOpenApiSpec(key, token);
    if (spec) operations = parseOpenApi(spec, key).endpoints || [];
  } catch {
    operations = [];
  }
  operationCache.set(key, { operations, at: Date.now() });
  return operations;
}

/** Authentication is also contract-derived; connected apps do not share one hardcoded login path. */
export async function resolveAppLoginPath(serviceBase: string): Promise<string | undefined> {
  const operations = await resolveAppApiOperations(serviceBase);
  return operations.find((operation) =>
    operation.method === 'POST'
    && /(?:^|[\/_.-])login(?:$|[\/_.-])/i.test(`${operation.operationId || ''} ${operation.path}`)
    && !/forgot|reset|impersonat|login-as/i.test(`${operation.operationId || ''} ${operation.path}`),
  )?.path;
}

/** Substitute {appId}/{object}-style params (any param names) in a spec path template. */
export function fillApiPath(template: string, vars: { appId?: string; object?: string }): string {
  return String(template || '').replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const n = String(name).toLowerCase();
    if (/app/.test(n) && vars.appId != null) return encodeURIComponent(vars.appId);
    if (/(object|obj|model|entity)/.test(n) && vars.object != null) return encodeURIComponent(vars.object);
    return `{${name}}`;
  });
}
