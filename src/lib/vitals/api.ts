/**
 * Typed client for the Vitals console. Every call goes to this app's own backend, which reads the
 * monitored product's observability store directly — there is no endpoint to connect to.
 */

export type MetricSeries = {
  refId: string;
  name: string;
  metric: string;
  labels: Record<string, string>;
  points: [number, number | null][];
};

export type MetricQueryResult = {
  series: MetricSeries[];
  resolution: '10s' | '1m' | '1h';
  fromMs: number;
  toMs: number;
  stepMs: number;
};

export type PanelTarget = {
  refId: string;
  metric: string;
  matchers?: { label: string; op?: 'eq' | 'neq' | 're'; value: string }[];
  groupBy?: string[];
  reducer?: string;
  legend?: string;
};

export type Panel = {
  id: number;
  type: 'timeseries' | 'stat' | 'bar' | 'table' | 'area';
  title: string;
  unit: 'ms' | 'bytes' | 'percent' | 'rps' | 'count' | 'short';
  gridPos: { x: number; y: number; w: number; h: number };
  targets: PanelTarget[];
  stacked?: boolean;
  description?: string;
};

export type DashboardModel = {
  schemaVersion: number;
  time: { from: string; to: string };
  refresh: string;
  templating: { variables: { name: string; label: string; metric: string; labelKey: string }[] };
  panels: Panel[];
};

export type ProfileParam = {
  key: string;
  label: string;
  help?: string;
  default: string | number | boolean;
  control:
    | { kind: 'number'; min: number; max: number; step?: number }
    | { kind: 'duration' }
    | { kind: 'text'; maxLength: number }
    | { kind: 'select'; options: { value: string; label: string }[] }
    | { kind: 'boolean' };
};

export type Profile = {
  id: string;
  label: string;
  category: string;
  summary: string;
  proves: string;
  /** Whatever the connected product calls its runner — this console does not own the list. */
  runner: string;
  danger: 'low' | 'medium' | 'high';
  estimate: string;
  thresholds: { p95Ms?: number; errorRatePct?: number };
  params: ProfileParam[];
  runCount?: number;
  /** True only when the control plane offers this profile; history-only entries cannot be started. */
  startable?: boolean;
};

export type ProfilesResponse = {
  profiles: Profile[];
  activeRunId: string | null;
  activeRunIds: string[];
  maxConcurrentRuns: number;
  defaultTargetBaseUrl: string;
  allowedTargetBaseUrls: string[];
  pentestTargetBaseUrls: string[];
  targets: { url: string; label: string; source: string; pentestAllowed: boolean }[];
  userPoolAvailable: boolean;
  /** False when no control plane is connected — the page is history only. */
  executionAvailable: boolean;
  executionMessage: string | null;
};

export type CredentialOption = {
  id: string;
  name: string;
  baseUrl: string;
  environment: string;
  logins: { id: string; label: string; username: string; role: string }[];
};

export type ConnectionView = {
  database: { configured: boolean; summary: string | null; source: 'stored' | 'environment' | 'none' };
  control: {
    configured: boolean;
    /** 'credential' points at Settings → Credentials; 'inline' holds its own copy. */
    mode: 'credential' | 'inline' | null;
    websiteId: string | null;
    loginId: string | null;
    credentialName: string | null;
    baseUrl: string | null;
    username: string | null;
    source: 'stored' | 'environment' | 'none';
  };
  alerting: { enabled: boolean; intervalSeconds: number; notify: boolean };
  sloTargetPct: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type ControlStatus = {
  configured: boolean;
  reachable: boolean;
  message: string;
  baseUrl: string | null;
  profileCount: number | null;
};

export type ConnectionResponse = {
  connection: ConnectionView;
  control: ControlStatus;
  store: VitalsStatus;
  alertEvaluatorRunning: boolean;
};

export type AgentCapabilities = {
  configured: boolean;
  storeConnected: boolean;
  executionAvailable: boolean;
  message: string;
};

export type AgentAnswer = {
  message: string;
  toolsUsed: string[];
  usage: { totalTokens: number; costUsd: number };
};

export type Annotation = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  startedAt: number;
  endedAt: number | null;
  refId: string | null;
};

export type DashboardSummary = {
  uid: string;
  title: string;
  tags: string[];
  version: number;
  is_builtin: boolean;
  updated_at: string | null;
  updated_by: string | null;
};

export type WindowStats = {
  requestRate: number | null;
  requestCount: number | null;
  errorCount: number | null;
  errorRate: number | null;
  latencyP95: number | null;
  latencyP50: number | null;
  cpuPercent: number | null;
  memoryRss: number | null;
  eventLoopLag: number | null;
  poolWaiting: number | null;
};

export type OverviewResponse = {
  range: { fromMs: number; toMs: number; resolution: string };
  current: WindowStats;
  previous: WindowStats;
  issues: { unresolved: number; newToday: number; critical: number; oldestUnresolvedAt: string | null };
  slo: { targetPct: number; availabilityPct: number | null; burnRate: number | null; budgetRemainingPct: number | null };
  capacity: { testedRps: number | null; headroomPct: number | null; sourceProfile: string | null; testedAt: string | null };
  slowRoutes: { route: string; p95: number | null; count: number }[];
  alertStates: Record<string, number>;
  health: 'good' | 'warning' | 'critical';
};

export type IssueRow = {
  id: string;
  title: string;
  culprit: string | null;
  error_type: string | null;
  level: string;
  status: string;
  platform: string;
  first_seen: string;
  last_seen: string;
  regressed_at: string | null;
  event_count: string | number;
  user_count: string | number;
  environment: string | null;
};

export type IssueDetail = {
  issue: IssueRow & { fingerprint_hash: string };
  events: {
    id: string;
    occurred_at: string;
    level: string;
    message: string;
    stack: { function: string | null; file: string | null; line: number | null; inApp: boolean }[];
    request: Record<string, unknown>;
    breadcrumbs: { at: string; category: string; message: string; level: string }[];
    tags: Record<string, string>;
    user_id: string | null;
    trace_id: string | null;
  }[];
  timeline: { at: number; count: number }[];
  tags: { key: string; value: string; count: number }[];
};

export type TransactionRow = {
  route: string;
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: number;
};

export type TraceRow = {
  trace_id: string;
  root_name: string;
  route: string | null;
  method: string;
  status_code: number | null;
  status: string;
  started_at: string;
  duration_ms: number;
  user_id: string | null;
  sampled_reason: string;
  span_count: number;
  db_time_ms: number | null;
};

export type TraceDetail = {
  trace: TraceRow;
  spans: {
    span_id: string;
    parent_span_id: string | null;
    name: string;
    op: string;
    started_at: string;
    duration_ms: number;
    status: string;
    attributes: Record<string, unknown>;
  }[];
  issue: { id: string; title: string } | null;
};

export type RunSummary = {
  requests: number | null;
  iterations: number | null;
  maxVus: number | null;
  errorRatePct: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  throughputRps: number | null;
  checksPassedPct: number | null;
  buckets: Record<string, number>;
  security?: {
    scanner: string;
    mode: 'baseline' | 'active';
    target: string;
    generatedAt: string;
    counts: { high: number; medium: number; low: number; informational: number };
    total: number;
    truncated: boolean;
    findings: { name: string; risk: string; confidence: string; url: string; instances: number; cweId: string | null; solution: string }[];
    teams?: SecurityTeams;
  };
};

export type RunRow = {
  id: string;
  profile_id: string;
  profile_label: string;
  params: Record<string, string>;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'aborted';
  target_base_url: string | null;
  started_at: string | null;
  finished_at: string | null;
  triggered_by: string | null;
  exit_code: number | null;
  summary: RunSummary | null;
  verdict: { passed: boolean; checks: { label: string; expected: string; actual: string; passed: boolean }[] } | null;
};

export type SecurityTeams = {
  red: {
    leadCount: number;
    leads: { id: string; title: string; vulnClass: string; location: string }[];
    findingCount: number;
    findings: { title: string; severity: string; endpoint: string | null }[];
  };
  blue: {
    available: boolean;
    summary: string;
    detections: { signal?: string; evidence?: string; relatedEndpoint?: string }[];
    blindSpotHints: string[];
    telemetry: { newIssues?: number; erroredTraceGroups?: number; alertsFired?: number; httpMetrics?: { metric: string; samples: number }[]; reason?: string };
  };
  purple: {
    window: { from: string; to: string };
    correlations: { title: string; endpoint: string | null; severity: string; detectionStatus: string; detectionRationale: string }[];
  };
};

export type SecurityEngagement = {
  id: string;
  name: string;
  target_base_url: string;
  environment: string;
  status: string;
  scope: { domains?: string[]; apis?: string[]; roles?: string[] };
  rules_of_engagement: { allowed?: string[]; prohibited?: string[]; emergencyContact?: string; stopProcedure?: string };
  phase_status: Record<string, string>;
  authorization_reference: string;
  authorization_confirmed: boolean;
  test_window_start: string | null;
  test_window_end: string | null;
  finding_count?: number;
  open_finding_count?: number;
  critical_count?: number;
  high_count?: number;
  medium_count?: number;
  low_count?: number;
  informational_count?: number;
};

export type SecurityFinding = {
  id: string;
  source: string;
  phase: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  status: string;
  cwe_id: string | null;
  cvss: number | null;
  asset: string | null;
  endpoint: string | null;
  description: string;
  impact: string;
  remediation: string;
  retest_status: string;
  evidence?: Record<string, unknown> | null;
};

export type ThreatIntelligenceItem = {
  id: string;
  title: string;
  source: string;
  asset: string | null;
  confidence: 'low' | 'medium' | 'high';
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'monitoring' | 'closed';
  summary: string;
  recommended_action: string;
  created_at: string;
  updated_at: string;
};

export type AlertRule = {
  id: string;
  title: string;
  description: string | null;
  metric: string;
  reducer: string;
  condition_op: string;
  threshold: number;
  window_seconds: number;
  for_seconds: number;
  interval_seconds: number;
  severity: string;
  group_by: string[];
  enabled: boolean;
};

export type AlertInstance = {
  rule_id: string;
  labels_hash: string;
  labels: Record<string, string>;
  state: 'normal' | 'pending' | 'alerting' | 'nodata' | 'error';
  state_since: string;
  value: number | null;
  last_evaluated_at: string;
};

export type ContactPoint = { id: string; name: string; type: string; settings: Record<string, unknown>; enabled: boolean };

export type Silence = {
  id: string;
  matchers: { label: string; value: string }[];
  starts_at: string;
  ends_at: string;
  comment: string | null;
  created_by: string | null;
};

export type FleetHealth = { level: string; reason: string };

export type FleetServer = {
  name: string;
  version: string | null;
  startedAt: string;
  lastSeen: string;
  cpuCount: number | null;
  loadAvg1m: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  memoryTotalBytes: number | null;
  memoryFreeBytes: number | null;
  health: FleetHealth;
};

export type FleetEnvironment = {
  name: string;
  databaseName: string;
  hostname: string | null;
  version: string | null;
  cohortId: string | null;
  server: string | null;
  running: boolean;
  lastSeen: string | null;
  lastStartedAt: string | null;
  webPort: number | null;
  servicePort: number | null;
  memoryBytes: number | null;
  dbBytes: number | null;
  filesBytes: number | null;
  metricsAt: string | null;
  processes: { name: string; status: string | null; memory_bytes: number | null; restarts: number | null }[];
  unresolvedIssues: number;
  health: FleetHealth;
};

export type FleetResponse = {
  servers: FleetServer[];
  environments: FleetEnvironment[];
  cohorts: { id: string; version_ref: string; sandbox_count: number; status: string; updated_at: string }[];
  operations: { sandbox_name: string; operation: string; status: string; finished_at: string | null }[];
  issuesByEnvironment: Record<string, number>;
  registryAvailable: boolean;
};

export type VitalsStatus = {
  configured: boolean;
  reachable: boolean;
  message: string;
  database: string | null;
  schemaPresent: boolean;
  oldestSampleAt: string | null;
  newestSampleAt: string | null;
};

/** Vitals reads the observability store through this app's own backend. */
export const VITALS_BASE = '/api/vitals';

export class VitalsApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** True when the failure is "the store isn't configured yet" rather than a real error. */
export const isNotConnected = (error: unknown): boolean =>
  error instanceof VitalsApiError && error.code === 'vitals_not_configured';

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${VITALS_BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    throw new VitalsApiError(response.status, body.message || body.error || response.statusText, body.error || '');
  }
  return body as T;
};

export const vitals = {
  // ---- the observability store ----
  status: () => request<VitalsStatus>('/status'),
  queryMetrics: (body: { from?: string; to?: string; maxPoints?: number; targets: PanelTarget[] }) =>
    request<MetricQueryResult>('/metrics/query', { method: 'POST', body: JSON.stringify(body) }),
  metricNames: () => request<{ metrics: { metric: string; labelKeys: string[]; seriesCount: number }[] }>('/metrics/names'),
  overview: (from: string, to: string) =>
    request<OverviewResponse>(`/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  annotations: (from: string, to: string) =>
    request<{ annotations: Annotation[] }>(`/annotations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  dashboards: () => request<{ dashboards: DashboardSummary[] }>('/dashboards'),
  dashboard: (uid: string) =>
    request<{ dashboard: { uid: string; title: string; tags: string[]; model: DashboardModel; is_builtin: boolean } }>(
      `/dashboards/${encodeURIComponent(uid)}`,
    ),
  saveDashboard: (body: { uid: string; title: string; tags: string[]; model: DashboardModel }) =>
    request<{ ok: boolean }>('/dashboards', { method: 'PUT', body: JSON.stringify(body) }),

  issues: (params: Record<string, string>) => request<{ issues: IssueRow[] }>(`/issues?${new URLSearchParams(params).toString()}`),
  issue: (id: string) => request<IssueDetail>(`/issues/${encodeURIComponent(id)}`),
  setIssueStatus: (ids: string[], status: 'unresolved' | 'resolved' | 'ignored') =>
    request<{ ok: boolean }>('/issues/status', { method: 'POST', body: JSON.stringify({ ids, status }) }),

  fleet: () => request<FleetResponse>('/fleet'),

  transactions: (from: string, to: string) =>
    request<{ transactions: TransactionRow[] }>(`/transactions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  traces: (params: Record<string, string>) => request<{ traces: TraceRow[] }>(`/traces?${new URLSearchParams(params).toString()}`),
  trace: (id: string) => request<TraceDetail>(`/traces/${encodeURIComponent(id)}`),
  slowLoads: (from: string, to: string) =>
    request<{ slowLoads: Record<string, unknown>[]; available: boolean }>(
      `/slow-loads?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  profiles: () => request<ProfilesResponse>('/tests/profiles'),
  /** Forwarded to the connected product's console, which owns profiles, bounds and targets. */
  startRun: (body: { profileId: string; params: Record<string, string | number | boolean>; targetBaseUrl?: string }) =>
    request<{ id: string }>('/tests/runs', { method: 'POST', body: JSON.stringify(body) }),
  abortRun: (id: string) => request<{ ok: boolean }>(`/tests/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' }),
  controlStatus: () => request<ControlStatus>('/tests/control'),
  runs: (limit = 50) => request<{ runs: RunRow[] }>(`/tests/runs?limit=${limit}`),
  run: (id: string) =>
    request<{ run: RunRow; logs: { seq: number; at: string; stream: string; line: string }[] }>(
      `/tests/runs/${encodeURIComponent(id)}`,
    ),

  securityEngagements: () => request<{ engagements: SecurityEngagement[] }>('/security/engagements'),
  securityEngagement: (id: string) =>
    request<{ engagement: SecurityEngagement; findings: SecurityFinding[] }>(`/security/engagements/${encodeURIComponent(id)}`),
  createSecurityEngagement: (body: Record<string, unknown>) =>
    request<{ id: string }>('/security/engagements', { method: 'POST', body: JSON.stringify(body) }),
  updateSecurityEngagement: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/security/engagements/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateSecurityFinding: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/security/findings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  importSecurityRun: (id: string, runId: string) =>
    request<{ imported: number }>(`/security/engagements/${encodeURIComponent(id)}/import-run/${encodeURIComponent(runId)}`, {
      method: 'POST',
    }),
  securityReport: (id: string) =>
    request<{ filename: string; markdown: string }>(`/security/engagements/${encodeURIComponent(id)}/report`),
  deleteSecurityEngagement: (id: string) =>
    request<{ ok: boolean }>(`/security/engagements/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  threatIntelligence: () => request<{ items: ThreatIntelligenceItem[]; available: boolean }>('/security/threat-intelligence'),
  createThreatIntelligence: (body: Record<string, unknown>) =>
    request<{ id: string }>('/security/threat-intelligence', { method: 'POST', body: JSON.stringify(body) }),
  updateThreatIntelligence: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/security/threat-intelligence/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),

  alertRules: () => request<{ rules: AlertRule[]; instances: AlertInstance[] }>('/alerts/rules'),
  createAlertRule: (body: Record<string, unknown>) => request<{ id: string }>('/alerts/rules', { method: 'POST', body: JSON.stringify(body) }),
  updateAlertRule: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/alerts/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAlertRule: (id: string) => request<{ ok: boolean }>(`/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  evaluateAlerts: () => request<{ evaluated: number; firing: number; notified: number }>('/alerts/evaluate', { method: 'POST' }),
  alertEvaluator: () => request<{ enabled: boolean; intervalSeconds: number; notify: boolean; running: boolean }>('/alerts/evaluator'),
  contactPoints: () => request<{ contactPoints: ContactPoint[] }>('/alerts/contact-points'),
  silences: () => request<{ silences: Silence[] }>('/alerts/silences'),

  // ---- connection (admin only) ----
  connection: () => request<ConnectionResponse>('/connection'),
  credentialOptions: () => request<{ credentials: CredentialOption[] }>('/connection/credentials'),
  saveConnection: (body: {
    databaseUrl?: string | null;
    control?:
      | { kind: 'credential'; websiteId: string; loginId?: string; baseUrlOverride?: string }
      | { kind: 'inline'; baseUrl: string; username: string; password?: string }
      | null;
    alerting?: { enabled?: boolean; intervalSeconds?: number; notify?: boolean };
    sloTargetPct?: number;
  }) => request<{ connection: ConnectionView; store: VitalsStatus; control: ControlStatus }>('/connection', { method: 'PUT', body: JSON.stringify(body) }),
  clearConnection: () => request<{ connection: ConnectionView }>('/connection', { method: 'DELETE' }),
  testConnection: (body: { databaseUrl?: string; control?: { baseUrl: string; username: string; password: string } }) =>
    request<{ store: VitalsStatus | null; control: ControlStatus | null }>('/connection/test', { method: 'POST', body: JSON.stringify(body) }),

  // ---- agent ----
  agentCapabilities: () => request<AgentCapabilities>('/agent/capabilities'),
  askAgent: (body: { message: string; from: string; to: string; conversation: { role: 'user' | 'assistant'; content: string }[] }) =>
    request<AgentAnswer>('/agent/respond', { method: 'POST', body: JSON.stringify(body) }),
};
