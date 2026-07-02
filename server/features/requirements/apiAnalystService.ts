/**
 * API & Metadata Analyst — a dedicated agent that reads the target application's
 * source code to produce a structured contract view of every API endpoint, metadata
 * object, data-population requirement, and inter-service connection related to a
 * given feature query. Runs as a separate agent alongside the Feature Analyst so
 * its results enrich the requirement card without slowing the main understanding step.
 */

import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { gitGrep, readRepoFile, resolveTargetRepo } from '../git-agent/gitAgentService';
import { resolveCredentials, getWebsite } from '../credentials/credentialsService';

/* ─── Schema ─────────────────────────────────────────────────────────────── */

const tf = (d = '') =>
  z.preprocess((v) => (v == null ? d : Array.isArray(v) ? v.filter(Boolean).join('; ') : String(v)), z.string().default(d));

const af = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(item).default([]));

const apiParamSchema = z.object({
  name: tf(),
  type: tf('string'),
  in: tf('body'),        // "body" | "query" | "path" | "header"
  required: z.boolean().default(false),
  description: tf(),
  example: tf(),
});

const apiContractSchema = z.object({
  endpoint: tf(),        // "POST /api/items"
  method: tf('GET'),     // HTTP verb
  path: tf(),            // "/api/items"
  description: tf(),
  authRequired: z.boolean().default(false),
  roles: af(tf()),
  requestParams: af(apiParamSchema),
  requestBodyExample: tf(),     // JSON example string
  responseShape: tf(),          // plain-text description of the response object
  responseExample: tf(),        // JSON example string
  successStatus: z.number().default(200),
  errorCodes: af(z.object({ code: z.number().default(400), description: tf() })),
  sourceFile: tf(),
});

const metadataFieldSchema = z.object({
  name: tf(),
  type: tf('String'),
  required: z.boolean().default(false),
  description: tf(),
  defaultValue: tf(),
});

const metadataObjectSchema = z.object({
  name: tf(),
  // keystone-list | prisma-model | postgres-table | mongoose-model | express-model
  kind: tf('model'),
  description: tf(),
  fields: af(metadataFieldSchema),
  relationships: af(z.object({
    field: tf(),
    relatedTo: tf(),
    cardinality: tf('many-to-one'),  // one-to-one | one-to-many | many-to-one | many-to-many
    description: tf(),
  })),
  sourceFile: tf(),
});

const serviceConnectionSchema = z.object({
  from: tf(),
  to: tf(),
  via: tf(),          // "REST API" | "direct DB call" | "event" | "shared table" | etc.
  direction: tf('bidirectional'),
  description: tf(),
});

export const apiAnalysisSchema = z.object({
  summary: tf(),
  apis: af(apiContractSchema),
  metadataObjects: af(metadataObjectSchema),
  dataPopulation: z.object({
    requiredState: tf(),     // what must exist before this feature can be used
    seedObjects: af(z.object({
      model: tf(),
      description: tf(),
      exampleFields: z.preprocess(
        (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
        z.record(z.string(), tf()).default({}),
      ),
    })),
    creationOrder: af(tf()),  // ordered list of objects to create (dependency order)
    cleanupNotes: tf(),
    testNotes: tf(),
  }).default({ requiredState: '', seedObjects: [], creationOrder: [], cleanupNotes: '', testNotes: '' }),
  serviceConnections: af(serviceConnectionSchema),
});

export type ApiAnalysis = z.infer<typeof apiAnalysisSchema>;

/* ─── Keyword extraction ─────────────────────────────────────────────────── */

function deriveApiKeywords(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const stop = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'test', 'feature', 'page']);
  return Array.from(new Set(words.filter((w) => !stop.has(w)))).slice(0, 8);
}

/* ─── File discovery ─────────────────────────────────────────────────────── */

/** Patterns that identify API route/controller files. */
const ROUTE_PATTERNS = [
  'router.get(', 'router.post(', 'router.put(', 'router.patch(', 'router.delete(',
  'app.get(', 'app.post(', 'app.put(', 'app.delete(',
  'registerRoutes(', 'Route(', 'Controller(',
  '@Get(', '@Post(', '@Put(', '@Delete(', '@Patch(',  // NestJS decorators
];

/** Patterns that identify metadata/model/schema files. */
const MODEL_PATTERNS = [
  'defineList(', 'list({', 'createSchema(', 'new Schema(',  // Keystone / Mongoose
  'model(\'', 'model("',                                     // Sequelize / Mongoose
  'z.object({', 'z.string()', 'z.number()',                 // Zod schemas
  'DataTypes.', 'sequelize.define(',                         // Sequelize
  'pgTable(', 'drizzle',                                     // Drizzle ORM
  'Entity()', '@Column(', '@ManyToOne(',                     // TypeORM
];

/** Patterns that identify service/repository files. */
const SERVICE_PATTERNS = [
  'Service(', 'Repository(', 'Dao(', 'crud(', 'findOne(',
  'db.query(', 'pool.query(', 'prisma.', 'knex(',
];

function searchForApiFiles(keywords: string[], repoPath?: string): string[] {
  const paths = new Set<string>();
  try {
    // Search by feature keywords first
    for (const kw of keywords.slice(0, 5)) {
      const hits = gitGrep([kw], undefined, 40, repoPath);
      hits.forEach((h) => paths.add(h.path));
    }
    // Then search for route/model patterns
    const routeHits = gitGrep(['router.get\\|router.post\\|app.get\\|app.post\\|registerRoutes'], undefined, 30, repoPath);
    routeHits.forEach((h) => paths.add(h.path));
    const modelHits = gitGrep(['defineList\\|z\\.object\\|new Schema\\|pgTable\\|@Entity\\|@Column'], undefined, 30, repoPath);
    modelHits.forEach((h) => paths.add(h.path));
  } catch { /* repo unavailable */ }
  // Prioritise likely API/model files (routes, controllers, schemas, models, services)
  const sorted = Array.from(paths).sort((a, b) => {
    const score = (p: string) => {
      if (/route|controller|endpoint/i.test(p)) return 10;
      if (/model|schema|entity|list/i.test(p)) return 8;
      if (/service|repository|repo|dao/i.test(p)) return 6;
      return 0;
    };
    return score(b) - score(a);
  });
  return sorted.slice(0, 20);
}

/* ─── Live context fetcher ───────────────────────────────────────────────── */

/** Resolve the target app's base URL and admin credentials for the given workspace/website.
 *  Priority: websiteId credential → env vars → localhost fallback (local dev only). */
function resolveAppConnection(opts: { websiteId?: string; ownerId?: string }): { baseUrl: string; username: string; password: string } {
  if (opts.websiteId || opts.ownerId) {
    const cred = resolveCredentials({ websiteId: opts.websiteId, role: 'admin', ownerId: opts.ownerId });
    if (cred?.baseUrl && cred?.username && cred?.password) {
      return { baseUrl: cred.baseUrl.replace(/\/$/, ''), username: cred.username, password: cred.password };
    }
    // fall back to the website's baseUrl with env var creds if no user found
    if (opts.websiteId) {
      const site = getWebsite(opts.websiteId);
      if (site?.baseUrl) {
        return {
          baseUrl: site.baseUrl.replace(/\/$/, ''),
          username: process.env.TARGET_USERNAME || 'admin',
          password: process.env.TARGET_PASSWORD || 'admin',
        };
      }
    }
  }
  // env vars — valid for single-tenant dev/staging deployments
  return {
    baseUrl: (process.env.TARGET_BASE_URL || 'http://localhost:5001').replace(/\/$/, ''),
    username: process.env.TARGET_USERNAME || 'admin',
    password: process.env.TARGET_PASSWORD || 'admin',
  };
}

async function fetchLiveContext(query: string, keywords: string[], conn: { baseUrl: string; username: string; password: string }): Promise<string> {
  const { baseUrl: CP_BASE_URL, username: CP_USERNAME, password: CP_PASSWORD } = conn;
  // 1. Login
  const loginRes = await fetch(`${CP_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: CP_USERNAME, password: CP_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error('core-platform login failed');
  const loginData = await loginRes.json() as any;
  const token: string = loginData.token || loginData.accessToken || loginData.access_token || '';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 2. Get all objects — GET /api/apps/__all_apps__/objects → { items: [...] }
  const objRes = await fetch(`${CP_BASE_URL}/api/apps/__all_apps__/objects`, { headers });
  const objData = await objRes.json() as any;
  const allObjects: any[] = Array.isArray(objData?.items) ? objData.items : (Array.isArray(objData) ? objData : []);

  // 3. Filter to relevant objects (keyword match on label/api_name/table_name)
  const relevant = allObjects.filter((o: any) =>
    keywords.some((kw) =>
      (o.label || '').toLowerCase().includes(kw) ||
      (o.api_name || '').toLowerCase().includes(kw) ||
      (o.table_name || '').toLowerCase().includes(kw),
    ),
  ).slice(0, 4);

  if (!relevant.length) throw new Error('no relevant objects found via live API');

  const sections: string[] = [];

  for (const obj of relevant) {
    // 4. Get fields — GET /api/apps/:appId/objects/:object/describe → { object:{}, fields:[] }
    let fields: any[] = [];
    try {
      const descRes = await fetch(`${CP_BASE_URL}/api/apps/${encodeURIComponent(obj.app_id)}/objects/${encodeURIComponent(obj.api_name)}/describe`, { headers });
      if (descRes.ok) {
        const descData = await descRes.json() as any;
        fields = Array.isArray(descData?.fields) ? descData.fields : [];
      }
    } catch { /* fields optional */ }

    // 5. Get sample records — GET /api/apps/__all_apps__/objects/:object/records?page_size=2 → { items:[] }
    let sampleRecords: any[] = [];
    try {
      const recRes = await fetch(`${CP_BASE_URL}/api/apps/__all_apps__/objects/${encodeURIComponent(obj.api_name)}/records?page_size=2`, { headers });
      if (recRes.ok) {
        const recData = await recRes.json() as any;
        sampleRecords = Array.isArray(recData?.items) ? recData.items : (Array.isArray(recData) ? recData : []);
      }
    } catch { /* sample records optional */ }

    sections.push([
      `OBJECT: ${obj.label} (${obj.api_name}) — table: ${obj.table_name || '?'} — app: ${obj.app_prefix || obj.app_id || '?'}`,
      fields.length ? `FIELDS: ${fields.map((f: any) => `${f.api_name}:${f.type}${f.required ? '*' : ''}`).join(', ')}` : '',
      sampleRecords.length ? `SAMPLE RECORDS (${sampleRecords.length}):\n${JSON.stringify(sampleRecords.slice(0, 2), null, 2)}` : '',
    ].filter(Boolean).join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/* ─── Main export ────────────────────────────────────────────────────────── */

/**
 * Dedicated API & Metadata Analyst agent.
 *
 * Reads API route files, model/schema files, and service files from the target
 * app's repo and returns a structured `ApiAnalysis` object — endpoint contracts,
 * metadata object schemas, data-population requirements, and service connections.
 * Called in parallel with the Feature Analyst inside `discoverRequirement`.
 */
export async function analyzeApiAndMetadataFromSource(
  query: string,
  opts: {
    workspaceId?: string;
    userId?: string;
    websiteId?: string;    // website whose baseUrl + credentials to use for live queries
    ownerId?: string;      // owner scope for credential resolution
    repoPath?: string;
    onProgress?: (label: string) => void;
  } = {},
): Promise<ApiAnalysis> {
  const cleanQuery = String(query || '').trim();
  const repoPath = opts.repoPath || resolveTargetRepo();
  const keywords = deriveApiKeywords(cleanQuery);

  opts.onProgress?.('Scanning API routes, models, and service files...');
  const filePaths = searchForApiFiles(keywords, repoPath);

  if (!filePaths.length) {
    return apiAnalysisSchema.parse({});
  }

  const conn = resolveAppConnection({ websiteId: opts.websiteId, ownerId: opts.ownerId });

  let sourceContext = '';
  try {
    sourceContext = await fetchLiveContext(cleanQuery, keywords, conn);
    opts.onProgress?.('Live DB and API data fetched — extracting focused contracts...');
  } catch {
    // fall back to static source grep
    sourceContext = filePaths.slice(0, 12).map((p) => {
      try { return `FILE: ${p}\n${readRepoFile(p, 3000, repoPath)}`; } catch { return null; }
    }).filter(Boolean).join('\n\n---\n\n');
    opts.onProgress?.('Extracting API contracts, metadata objects, and data requirements...');
  }

  const analyst = await getOrchestrator('featureAnalyst', opts);
  const res = await analyst.generateObject<ApiAnalysis>({
    prompt: `You are an API & Metadata Analyst. Given the source data below, extract EVERYTHING related to the feature: "${cleanQuery}".

SOURCE DATA (live DB objects + fields + sample records, or static code grep):
${sourceContext || '(no source found)'}

Produce a JSON object with these sections:

1. **apis** — every HTTP endpoint related to this feature.
   For each: endpoint (METHOD + path), method, path, description, authRequired, roles,
   requestParams (name/type/in/required/description/example for each field),
   requestBodyExample (a realistic JSON string), responseShape (human-readable description
   of what is returned), responseExample (a realistic JSON string), successStatus, errorCodes.

2. **metadataObjects** — every DB model, Keystone list, Prisma model, or schema type involved.
   For each: name, kind (keystone-list/prisma-model/postgres-table/mongoose-model/zod-schema),
   description, fields (name/type/required/description/defaultValue), relationships
   (field/relatedTo/cardinality/description).

3. **dataPopulation** — what must exist in the database BEFORE this feature can be used or tested.
   requiredState: describe the DB/app state required.
   seedObjects: list every object that must be created (model, description, exampleFields).
   creationOrder: ordered list of objects to create (dependencies first).
   cleanupNotes: what to clean up after the test.
   testNotes: any special data setup notes.

4. **serviceConnections** — how this feature's services/modules connect.
   For each: from, to, via (REST API / direct DB call / event / etc.), direction, description.

5. **summary** — 1–2 sentence overview of the API surface and data model for this feature.

Include ONLY the objects, fields, and endpoints that are DIRECTLY needed to implement or test "${cleanQuery}". Do NOT list unrelated objects. Be specific and focused — quality over quantity.
Only include items that are DIRECTLY related to "${cleanQuery}". Do not invent endpoints or models that don't appear in the source. If the source is incomplete, say so in the summary.`,
    schema: apiAnalysisSchema,
    userMessage: cleanQuery,
  });

  opts.onProgress?.('API & metadata analysis complete.');
  return (res as any).object || apiAnalysisSchema.parse({});
}
