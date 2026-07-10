/**
 * API Intelligence — domain model (Phase A vertical slice).
 *
 * Source of truth: docs/diagnostics/api-intelligence-final-implementation-spec-2026-07-10.md.
 * Phase A is 100% deterministic (no LLM). The 5-agent roster is declared here as data so later
 * phases can register/invoke it where AI adds measurable value (semantic validation, flow synthesis).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type DiscoverySource = 'openapi' | 'postman' | 'source' | 'none';

export interface ApiParam {
  name: string;
  in: 'query' | 'path' | 'header';
  required: boolean;
  type?: string;
  example?: unknown;
}

export interface ApiContract {
  request: { params: ApiParam[]; headers: ApiParam[]; bodySchema?: unknown };
  /** Response schema keyed by status code (or 'default'). */
  responses: Record<string, { schema?: unknown; description?: string }>;
  auth: { required: boolean; scheme?: string };
}

export interface ApiEndpoint {
  id: string;
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  baseUrl: string;
  contract: ApiContract;
  /** Deterministic hash of the contract — drives versioning/regression later. */
  contractHash: string;
  source: DiscoverySource;
}

export interface DiscoveryResult {
  source: DiscoverySource;
  endpoints: ApiEndpoint[];
  warnings: string[];
}

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApiExpectation {
  /** The scenario passes if the response status is one of these. */
  statusOneOf: number[];
  /** Optional expected structural shape of the success body. */
  responseShape?: unknown;
  note?: string;
}

export type ScenarioKind = 'positive' | 'negative' | 'boundary' | 'authz' | 'validation' | 'contract';

export interface ApiScenario {
  id: string;
  endpointId: string;
  kind: ScenarioKind;
  title: string;
  request: ApiRequest;
  expected: ApiExpectation;
  /** True when the request mutates state (POST/PUT/PATCH/DELETE) — gated by write-safety. */
  mutating: boolean;
}

export interface ApiResponseCapture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ExecutionStatus = 'pass' | 'fail' | 'error' | 'skipped';

export interface ApiExecution {
  scenarioId: string;
  endpointId: string;
  /** REDACTED before persistence (see redact.ts). */
  request: ApiRequest;
  response: ApiResponseCapture | null;
  latencyMs: number;
  status: ExecutionStatus;
  reason?: string;
}

export type FindingSeverity = 'info' | 'warn' | 'error';

export interface ApiFinding {
  scenarioId: string;
  endpointId: string;
  kind: string;
  severity: FindingSeverity;
  message: string;
}

/** APIEvidence record (spec §7) — payloads are already redacted. Stored on run.api_evidence[]. */
export interface ApiEvidenceRecord {
  endpoint: string;
  method: HttpMethod;
  scenarioId: string;
  request: ApiRequest;
  response: ApiResponseCapture | null;
  status: ExecutionStatus;
  statusCode: number | null;
  latencyMs: number;
  expected: ApiExpectation;
  differences: string[];
  environment: string;
  confidence: 'verified-live' | 'inferred' | 'unverified';
  timestamp: string;
}

export interface ApiBaseline {
  key: string;
  environment: string;
  projectId?: string;
  appId?: string;
  contractHash: string;
  responseShape: unknown;
  capturedAt: string;
}

export type ApiRunStatus = 'running' | 'completed' | 'failed';

export interface ApiRunMessage {
  agent: string;
  status: 'running' | 'completed' | 'skipped' | 'failed';
  output?: unknown;
  at: string;
}

export interface ApiRun {
  id: string;
  projectId?: string;
  appId?: string;
  ownerId?: string;
  targetUrl: string;
  environment: string;
  mode: 'single' | 'flow';
  writeEnabled: boolean;
  status: ApiRunStatus;
  messages: ApiRunMessage[];
  endpoints: ApiEndpoint[];
  scenarios: ApiScenario[];
  executions: ApiExecution[];
  findings: ApiFinding[];
  api_evidence: ApiEvidenceRecord[];
  report?: ApiDeveloperReport;
  evidence_registry?: unknown;
  created_at: string;
  updated_at: string;
}

export interface ApiDeveloperReport {
  summary: string;
  totals: { endpoints: number; scenarios: number; passed: number; failed: number; errored: number };
  bySeverity: { error: number; warn: number; info: number };
  probableCauses: string[];
  findings: ApiFinding[];
}

/**
 * Agent roster (single-responsibility). Declared as data in Phase A; each agent is registered into the
 * global prompt registry and invoked in the later phase that first needs its reasoning — deterministic
 * code covers Phase A. This keeps AI usage to where it adds measurable value.
 */
export const API_AGENT_ROSTER = [
  { name: 'apiDiscovery', responsibility: 'reconcile OpenAPI/Postman/source into a clean contract; infer auth + dependencies', usedFrom: 'B' },
  { name: 'apiTestPlanner', responsibility: 'risk/dependency/rule-aware scenario + flow design', usedFrom: 'C' },
  { name: 'apiValidator', responsibility: 'semantic expected-vs-actual incl. business rules (single validator)', usedFrom: 'C' },
  { name: 'apiFailureAnalyst', responsibility: 'root-cause class + flaky likely-reason', usedFrom: 'D' },
  { name: 'apiReporter', responsibility: 'developer-ready report', usedFrom: 'F' },
] as const;
