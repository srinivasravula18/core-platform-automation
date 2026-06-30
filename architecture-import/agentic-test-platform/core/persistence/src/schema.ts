import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, numeric } from "drizzle-orm/pg-core";

/** Target platform orgs (multi-tenant). Secrets live in org_credentials, never in the LLM context. */
export const orgs = pgTable("orgs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  isProduction: boolean("is_production").default(false).notNull(),
  allowlistHosts: text("allowlist_hosts").array().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const orgCredentials = pgTable("org_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => orgs.id).notNull(),
  keyName: text("key_name").notNull(), // referenced by handle ${CRED_<keyName>}
  ciphertext: text("ciphertext").notNull(), // envelope-encrypted; decrypted only at execution time
  allowMutations: boolean("allow_mutations").default(false).notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => orgs.id).notNull(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  githubInstallationId: text("github_installation_id"),
});

/** A captured metadata snapshot — every run pins one (staleness audit). */
export const metadataSnapshot = pgTable("metadata_snapshot", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => orgs.id).notNull(),
  version: text("version").notNull(),
  source: text("source").notNull(), // live_api | repo
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
});

export const mdObject = pgTable("md_object", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id").references(() => metadataSnapshot.id).notNull(),
  app: text("app").notNull(),
  apiName: text("api_name").notNull(),
  label: text("label").notNull(),
  idPrefix: text("id_prefix"),
});

export const mdField = pgTable("md_field", {
  id: uuid("id").defaultRandom().primaryKey(),
  objectId: uuid("object_id").references(() => mdObject.id).notNull(),
  apiName: text("api_name").notNull(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  required: boolean("required").default(false).notNull(),
  isPicklist: boolean("is_picklist").default(false).notNull(),
  referenceObject: text("reference_object"),
  searchable: boolean("searchable").default(false).notNull(),
  maxLength: integer("max_length"),
});

export const mdPicklistValue = pgTable("md_picklist_value", {
  id: uuid("id").defaultRandom().primaryKey(),
  fieldId: uuid("field_id").references(() => mdField.id).notNull(),
  value: text("value").notNull(),
  label: text("label").notNull(),
  active: boolean("active").default(true).notNull(),
});

export const renderProfile = pgTable("render_profile", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id").references(() => metadataSnapshot.id).notNull(),
  fieldType: text("field_type").notNull(),
  locatorTemplate: jsonb("locator_template").notNull(),
  sourceComponent: text("source_component"),
});

/** Synthesized, catalog-verified locators (the grounding output). */
export const elementCatalog = pgTable("element_catalog", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id").references(() => metadataSnapshot.id).notNull(),
  objectApiName: text("object_api_name").notNull(),
  fieldApiName: text("field_api_name").notNull(),
  strategy: text("strategy").notNull(),
  value: text("value").notNull(),
  role: text("role"),
  expression: text("expression").notNull(),
  stability: integer("stability").notNull(),
});

export const requirements = pgTable("requirements", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  code: text("code").notNull(),
  description: text("description").notNull(),
  type: text("type").notNull(),
  priority: text("priority").notNull(),
  sourceRef: text("source_ref"),
  status: text("status").default("provisional").notNull(),
});

export const testPlans = pgTable("test_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  content: jsonb("content").notNull(),
  version: integer("version").default(1).notNull(),
  status: text("status").default("draft").notNull(),
});

export const testSuites = pgTable("test_suites", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  type: text("type").notNull(), // sanity|regression|bvt|api
  name: text("name").notNull(),
  selectionRule: jsonb("selection_rule"),
});

export const testCases = pgTable("test_cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id), // nullable: chat-generated cases aren't bound to a project row
  sessionId: text("session_id"),
  code: text("code").notNull(),
  title: text("title").notNull(),
  object: text("object").notNull(),
  kind: text("kind").notNull(), // ui|api
  technique: text("technique").notNull(),
  priority: text("priority").notNull(),
  suiteTypes: text("suite_types").array().default([]).notNull(),
  preconditions: jsonb("preconditions").default([]).notNull(),
  steps: jsonb("steps").default([]).notNull(),
  expected: text("expected").default("").notNull(),
  automationStatus: text("automation_status").default("generated").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const suiteCases = pgTable("suite_cases", {
  suiteId: uuid("suite_id").references(() => testSuites.id).notNull(),
  caseId: uuid("case_id").references(() => testCases.id).notNull(),
});

/** Requirements Traceability Matrix — a join, not a document. */
export const rtm = pgTable("rtm", {
  requirementId: uuid("requirement_id").references(() => requirements.id).notNull(),
  caseId: uuid("case_id").references(() => testCases.id).notNull(),
});

export const testScripts = pgTable("test_scripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  caseId: uuid("case_id").references(() => testCases.id).notNull(),
  language: text("language").default("typescript").notNull(),
  framework: text("framework").default("playwright").notNull(),
  filePath: text("file_path").notNull(),
  contentRef: text("content_ref"),
  model: text("model"),
  version: integer("version").default(1).notNull(),
});

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id),
  orgId: uuid("org_id").references(() => orgs.id),
  sessionId: text("session_id"),
  object: text("object"),
  suiteType: text("suite_type"),
  env: text("env"),
  snapshotId: uuid("snapshot_id").references(() => metadataSnapshot.id),
  repoCommitSha: text("repo_commit_sha"),
  trigger: text("trigger").default("chat").notNull(),
  status: text("status").default("queued").notNull(),
  total: integer("total").default(0).notNull(),
  passed: integer("passed").default(0).notNull(),
  failed: integer("failed").default(0).notNull(),
  skipped: integer("skipped").default(0).notNull(),
  accuracy: integer("accuracy"),
  costUsd: numeric("cost_usd").default("0").notNull(),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
});

export const suiteResults = pgTable("suite_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").references(() => runs.id).notNull(),
  suiteType: text("suite_type").notNull(),
  status: text("status").notNull(),
  totals: jsonb("totals"),
});

export const runResults = pgTable("run_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  suiteResultId: uuid("suite_result_id").references(() => suiteResults.id).notNull(),
  testCaseId: uuid("test_case_id").references(() => testCases.id).notNull(),
  status: text("status").notNull(), // pass|fail|flaky|skipped|blocked
  attempts: integer("attempts").default(1).notNull(),
  durationMs: integer("duration_ms"),
  error: jsonb("error"),
});

export const stepResults = pgTable("step_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runResultId: uuid("run_result_id").references(() => runResults.id).notNull(),
  idx: integer("idx").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  assertion: jsonb("assertion"),
});

export const evidence = pgTable("evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  runResultId: uuid("run_result_id").references(() => runResults.id).notNull(),
  stepResultId: uuid("step_result_id").references(() => stepResults.id),
  kind: text("kind").notNull(), // screenshot|video|trace|har|console|dom|log
  objectKey: text("object_key").notNull(),
  bytes: integer("bytes"),
  contentType: text("content_type"),
  redacted: boolean("redacted").default(false).notNull(),
});

/** Deterministic pipeline state machine: one row per phase, idempotent + resumable. */
export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id).notNull(),
  runId: uuid("run_id").references(() => runs.id),
  phase: text("phase").notNull(),
  status: text("status").default("pending").notNull(), // pending|running|awaiting_approval|done|failed
  inputRef: jsonb("input_ref"),
  outputRef: jsonb("output_ref"),
  attempts: integer("attempts").default(0).notNull(),
  gateRequired: boolean("gate_required").default(false).notNull(),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").references(() => jobs.id).notNull(),
  gate: text("gate").notNull(),
  reviewer: text("reviewer"),
  decision: text("decision"), // approved|rejected
  at: timestamp("at"),
});

/** Per-step token/cost — the observability/cost spine. */
export const agentEvents = pgTable("agent_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").references(() => runs.id),
  role: text("role").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0).notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  cacheRead: integer("cache_read").default(0).notNull(),
  cacheWrite: integer("cache_write").default(0).notNull(),
  costUsd: numeric("cost_usd").default("0").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Conversational chat memory + per-agent memory + agent-to-agent transcript
// ---------------------------------------------------------------------------

/** A user's chat session with the Conversational Orchestrator (the Claude-style UI).
 *  id = the client-provided session id (text) so the thread is stable across reloads. */
export const chatSessions = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  title: text("title"),
  summary: text("summary"), // rolling compaction summary (chat memory)
  favorite: boolean("favorite").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: text("session_id").references(() => chatSessions.id).notNull(),
  role: text("role").notNull(), // user|assistant
  content: text("content").notNull(),
  steps: jsonb("steps"), // the agent's tool steps for this turn
  seq: integer("seq").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Generated artifacts (scripts / cases / runs) — saved to the DB and browsable in the UI. */
export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id"),
  kind: text("kind").notNull(), // script|cases|run
  object: text("object"),
  title: text("title").notNull(),
  ext: text("ext").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** The connected source-of-truth repo (local folder or remote URL). Single active row id='active';
 *  persisted so it survives restarts and the user can view / change / disconnect it. */
export const connectedRepo = pgTable("connected_repo", {
  id: text("id").primaryKey(), // 'active'
  source: text("source").notNull(), // local|remote
  ref: text("ref").notNull(),
  baseUrl: text("base_url"), // the RUNNING app's URL (localhost or live) — the execution target
  branch: text("branch"),
  sha: text("sha"),
  framework: text("framework"),
  fileCount: integer("file_count"),
  hasMetadata: boolean("has_metadata"),
  error: text("error"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** App settings (single row id='active') — provider config, default provider, cost, autonomy. */
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey(), // 'active'
  providers: jsonb("providers"), // { [name]: { apiKeyEnc, model, authMode, enabled } }
  defaultProvider: text("default_provider"),
  dailyCostLimit: numeric("daily_cost_limit").default("50"),
  autonomyLevel: text("autonomy_level").default("review"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** A target site/environment the agents test against (the live app login model). */
export const websites = pgTable("websites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  environment: text("environment").default("staging").notNull(), // dev|staging|prod|local|preview
  loginUrl: text("login_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Login credentials for a website — password AES-256-GCM encrypted, never returned in plaintext. */
export const websiteUsers = pgTable("website_users", {
  id: text("id").primaryKey(),
  websiteId: text("website_id").references(() => websites.id).notNull(),
  label: text("label"),
  username: text("username").notNull(),
  passwordEnc: text("password_enc").notNull(),
  role: text("role").default("standard").notNull(), // admin|standard|guest|service
  useForPlaywright: boolean("use_for_playwright").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Each agent's OWN memory: durable facts + working notes, isolated per agent. */
export const agentMemory = pgTable("agent_memory", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").references(() => projects.id),
  agentId: text("agent_id").notNull(),
  scope: text("scope").notNull(), // fact|note
  text: text("text").notNull(),
  tags: text("tags").array().default([]).notNull(),
  seq: integer("seq").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** Agent-to-agent message transcript (the bus log) — drives the chat "agent trace" panel. */
export const agentMessages = pgTable("agent_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").references(() => runs.id),
  correlationId: text("correlation_id").notNull(),
  kind: text("kind").notNull(), // request|reply|notify|publish
  fromAgent: text("from_agent").notNull(),
  toAgent: text("to_agent").notNull(),
  content: jsonb("content"),
  depth: integer("depth").default(0).notNull(),
  seq: integer("seq").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
