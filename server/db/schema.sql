-- Test Flow AI — PostgreSQL schema
-- All entities support the approval state machine: proposed → pending_review → approved | rejected | in_revision
-- Soft deletes via deleted_at; audit log on every transition.

CREATE TABLE IF NOT EXISTS folders (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  parent_id     TEXT REFERENCES folders(id) ON DELETE CASCADE,
  description   TEXT DEFAULT '',
  kind          TEXT DEFAULT 'Feature',
  icon          TEXT DEFAULT 'folder',
  created_by    TEXT DEFAULT 'User',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  scope           TEXT DEFAULT '',
  objectives      TEXT DEFAULT '',
  in_scope        TEXT DEFAULT '',
  out_of_scope    TEXT DEFAULT '',
  strategy        TEXT DEFAULT '',
  test_types      TEXT DEFAULT '',
  environments    TEXT DEFAULT '',
  roles           TEXT DEFAULT '',
  entry_exit      TEXT DEFAULT '',
  schedule        TEXT DEFAULT '',
  risks           TEXT DEFAULT '',
  deliverables    TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  start_date      DATE,
  end_date        DATE,
  owner           TEXT DEFAULT '',
  tags            TEXT[] DEFAULT ARRAY[]::TEXT[],
  run_ids         JSONB DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'draft',
  risk_level      TEXT DEFAULT 'Medium',
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  approval_state  TEXT NOT NULL DEFAULT 'approved',
  proposed_by     TEXT DEFAULT 'human',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  source_run_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS owner TEXT DEFAULT '';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE plans ADD COLUMN IF NOT EXISTS run_ids JSONB DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS suites (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  parent_suite    TEXT,
  parent_suite_ids JSONB DEFAULT '[]'::jsonb,
  test_plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
  module          TEXT DEFAULT '',
  owner           TEXT DEFAULT '',
  tags            TEXT[] DEFAULT ARRAY[]::TEXT[],
  priority        TEXT DEFAULT 'Medium',
  status          TEXT DEFAULT 'Active',
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  approval_state  TEXT NOT NULL DEFAULT 'approved',
  proposed_by     TEXT DEFAULT 'human',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  source_run_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cases (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  preconditions   TEXT DEFAULT '',
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
  test_plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
  test_suite_id   TEXT REFERENCES suites(id) ON DELETE SET NULL,
  type            TEXT DEFAULT 'Manual',
  priority        TEXT DEFAULT 'Medium',
  status          TEXT DEFAULT 'Draft',
  tags            TEXT[] DEFAULT ARRAY[]::TEXT[],
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  confidence      INT,
  sources         TEXT[] DEFAULT ARRAY[]::TEXT[],
  approval_state  TEXT NOT NULL DEFAULT 'approved',
  proposed_by     TEXT DEFAULT 'human',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  source_run_id   TEXT,
  agent_run_id    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  suite_id        TEXT REFERENCES suites(id) ON DELETE SET NULL,
  test_plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
  case_ids        TEXT[] DEFAULT ARRAY[]::TEXT[],
  requested_by    TEXT DEFAULT 'human',
  execution_time  TEXT DEFAULT '',
  total_executions INT DEFAULT 0,
  passed          INT DEFAULT 0,
  failed          INT DEFAULT 0,
  progress        TEXT DEFAULT '',
  status          TEXT DEFAULT 'Pending',
  target_url      TEXT DEFAULT '',
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  steps           JSONB DEFAULT '[]'::jsonb,
  evidence        JSONB DEFAULT '[]'::jsonb,
  trigger_type    TEXT DEFAULT 'manual',
  trigger_meta    JSONB DEFAULT '{}'::jsonb,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  approval_state  TEXT NOT NULL DEFAULT 'approved',
  proposed_by     TEXT DEFAULT 'human',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  source_run_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS defects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT DEFAULT '',
  steps_to_reproduce TEXT DEFAULT '',
  expected        TEXT DEFAULT '',
  actual          TEXT DEFAULT '',
  severity        TEXT DEFAULT 'Medium',
  status          TEXT DEFAULT 'New',
  assigned_to     TEXT,
  linked_case_id  TEXT REFERENCES cases(id) ON DELETE SET NULL,
  linked_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
  evidence        JSONB DEFAULT '[]'::jsonb,
  tags            TEXT[] DEFAULT ARRAY[]::TEXT[],
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  approval_state  TEXT NOT NULL DEFAULT 'approved',
  proposed_by     TEXT DEFAULT 'human',
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  source_run_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scripts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  title           TEXT DEFAULT '',
  code            TEXT DEFAULT '',
  language        TEXT DEFAULT 'typescript',
  framework       TEXT DEFAULT 'playwright',
  status          TEXT DEFAULT 'Generated',
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  case_id         TEXT REFERENCES cases(id) ON DELETE SET NULL,
  target_url      TEXT DEFAULT '',
  agent_run_id    TEXT,
  created_by      TEXT DEFAULT 'QA Assistant',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reports (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plan_id         TEXT REFERENCES plans(id) ON DELETE SET NULL,
  suite_id        TEXT REFERENCES suites(id) ON DELETE SET NULL,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  plan_name       TEXT DEFAULT '',
  suite_name      TEXT DEFAULT '',
  requested_by    TEXT DEFAULT 'human',
  execution_time  TEXT DEFAULT '',
  total_executions INT DEFAULT 0,
  status          TEXT DEFAULT 'Passed',
  failure_reason  TEXT DEFAULT '',
  target_url      TEXT DEFAULT '',
  steps           JSONB DEFAULT '[]'::jsonb,
  evidence        JSONB DEFAULT '[]'::jsonb,
  narrative       TEXT DEFAULT '',
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                TEXT PRIMARY KEY,
  app_url           TEXT DEFAULT '',
  provider          TEXT DEFAULT '',
  model             TEXT DEFAULT '',
  prompt            TEXT DEFAULT '',
  status            TEXT DEFAULT 'running',
  messages          JSONB DEFAULT '[]'::jsonb,
  generated_cases   JSONB DEFAULT '[]'::jsonb,
  playwright_scripts JSONB DEFAULT '[]'::jsonb,
  evidence_screenshots JSONB DEFAULT '[]'::jsonb,
  inspection_context JSONB DEFAULT '{}'::jsonb,
  folder_id         TEXT,
  folder_path       TEXT DEFAULT 'Uncategorized',
  test_plan_id      TEXT,
  test_suite_id     TEXT,
  test_case_id      TEXT,
  credentials       JSONB DEFAULT '{}'::jsonb,
  artifact_name     TEXT DEFAULT '',
  raw               JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  actor       TEXT DEFAULT 'system',
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT DEFAULT '',
  meta        JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-website, multi-user credentials (replaces flat siteCredentials)
CREATE TABLE IF NOT EXISTS websites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  environment TEXT DEFAULT 'staging',
  description TEXT DEFAULT '',
  tags        TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifact_id_counters (
  website_key   TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('PLAN', 'SUITE', 'TC')),
  last_value    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (website_key, artifact_type)
);

CREATE TABLE IF NOT EXISTS website_users (
  id          TEXT PRIMARY KEY,
  website_id  TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  username    TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  role        TEXT DEFAULT 'standard',
  custom_role TEXT,
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A website can have multiple logins (child pages / personas) on the same URL.
-- These idempotent migrations fix login persistence and add the page fields.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE website_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE website_users ADD COLUMN IF NOT EXISTS page_name  TEXT DEFAULT '';
ALTER TABLE website_users ADD COLUMN IF NOT EXISTS page_url   TEXT DEFAULT '';

-- Professional defect reports (bug-investigation framework): structured signature/cluster/regression/risk
-- payload lives in an additive JSONB bag so the defects contract stays unchanged for existing readers.
ALTER TABLE defects ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Test-case classification fields: automation status, testing scope (Manual/Automation),
-- and testing type (Functional/Smoke/Sanity/Regression/...). Additive so existing readers are unaffected.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS automation_status TEXT DEFAULT 'Not Automated';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS testing_scope     TEXT DEFAULT 'Manual';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS testing_type      TEXT DEFAULT 'Functional';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS testing_types     JSONB DEFAULT '[]'::jsonb;
-- Multi-select plan/suite membership (edit form). Singular test_plan_id/test_suite_id stay in sync
-- with the first entry so existing run/linking logic keyed on the singular id is unaffected.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS test_plan_ids  JSONB DEFAULT '[]'::jsonb;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS test_suite_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE suites ADD COLUMN IF NOT EXISTS test_plan_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE suites ADD COLUMN IF NOT EXISTS parent_suite_ids JSONB DEFAULT '[]'::jsonb;

-- Test-run assignment/classification fields (Assign To, Tags, State). Additive so existing readers
-- are unaffected; `state` is a workflow state distinct from execution `status`.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS assigned_to TEXT DEFAULT '';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS tags        TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE runs ADD COLUMN IF NOT EXISTS state       TEXT DEFAULT '';

-- System prompt store: per-agent versioned overrides
CREATE TABLE IF NOT EXISTS prompts (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  version     INT NOT NULL,
  body        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT DEFAULT 'admin',
  notes       TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS prompts_agent_version_unique ON prompts(agent, version);
CREATE INDEX IF NOT EXISTS prompts_agent_active ON prompts(agent) WHERE is_active;

-- Cost / usage tracking
CREATE TABLE IF NOT EXISTS usage_log (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  user_id       TEXT DEFAULT 'anonymous',
  agent         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cache_read_tokens  INT DEFAULT 0,
  cache_write_tokens INT DEFAULT 0,
  cost_usd      NUMERIC(12, 6) DEFAULT 0,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_workspace_day ON usage_log(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS usage_log_created_at ON usage_log(created_at);
-- Backfill cache columns on an existing deployment (no-op if already present).
ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS cache_read_tokens  INT DEFAULT 0;
ALTER TABLE usage_log ADD COLUMN IF NOT EXISTS cache_write_tokens INT DEFAULT 0;

-- AI Inbox
CREATE TABLE IF NOT EXISTS inbox (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  source        TEXT NOT NULL,
  source_id     TEXT DEFAULT '',
  title         TEXT NOT NULL,
  summary       TEXT DEFAULT '',
  confidence    INT DEFAULT 70,
  proposed_by   TEXT DEFAULT 'AI Assistant',
  review_state  TEXT NOT NULL DEFAULT 'pending_review',
  payload       JSONB DEFAULT '{}'::jsonb,
  reason        TEXT,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  rejected_by   TEXT,
  rejected_at   TIMESTAMPTZ,
  revision_by   TEXT,
  revision_at   TIMESTAMPTZ,
  links         JSONB DEFAULT '[]'::jsonb,
  proposed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_workspace_state ON inbox(workspace_id, review_state);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT DEFAULT 'default',
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT DEFAULT '',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC);

-- Users (for future multi-tenant)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT DEFAULT 'engineer',
  avatar        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic JSON collection store: collections WITHOUT a dedicated table (projects, apps,
-- appKnowledge, repoSecrets, blackboard, recentActivity) persist here in PG mode so the
-- database — not .testflow-data.json — is the single source of truth. One row per collection.
CREATE TABLE IF NOT EXISTS json_store (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic key/value settings table (provider keys, autonomy, cost limit, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent Console conversation headers. `turns` is DEPRECATED (Conversational Runtime Phase 7):
-- chat_messages is the canonical ordered transcript; `turns` stays readable as the console's
-- rich-card snapshot until the UI migrates to canonical hydration. Dropping it requires a
-- separately approved data-retention migration after a production canonicalization audit.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  title         TEXT DEFAULT '',
  turns         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_ws ON chat_conversations(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind            TEXT NOT NULL DEFAULT 'text',
  content         TEXT NOT NULL DEFAULT '',
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_estimate  INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_created ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_content_search ON chat_messages USING gin (to_tsvector('simple', content));

-- Idempotent legacy backfill. The JSONB column stays readable until the migration flag is retired.
INSERT INTO chat_messages (conversation_id, seq, role, kind, content, payload, token_estimate, created_at)
SELECT c.id,
       t.ordinality,
       CASE WHEN t.turn->>'role' = 'assistant' THEN 'assistant' ELSE 'user' END,
       COALESCE(NULLIF(t.turn->>'kind', ''), 'text'),
       COALESCE(t.turn->>'content', t.turn->>'text', t.turn->>'summary', ''),
       t.turn,
       CEIL(LENGTH(COALESCE(t.turn->>'content', t.turn->>'text', t.turn->>'summary', '')) / 4.0)::INT,
       c.created_at + (t.ordinality * interval '1 millisecond')
FROM chat_conversations c
CROSS JOIN LATERAL jsonb_array_elements(c.turns) WITH ORDINALITY AS t(turn, ordinality)
ON CONFLICT (conversation_id, seq) DO NOTHING;

CREATE TABLE IF NOT EXISTS context_manifests (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT REFERENCES chat_conversations(id) ON DELETE CASCADE,
  path                TEXT NOT NULL,
  model               TEXT NOT NULL,
  total_turns         INT NOT NULL DEFAULT 0,
  verbatim_turns      INT NOT NULL DEFAULT 0,
  estimated_tokens    INT NOT NULL DEFAULT 0,
  entries             JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieved_refs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS context_manifests_conversation_created ON context_manifests(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_summary_segments (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  start_seq       BIGINT NOT NULL,
  end_seq         BIGINT NOT NULL,
  summary         TEXT NOT NULL,
  token_estimate  INT NOT NULL DEFAULT 0,
  source_hash     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, start_seq, end_seq),
  CHECK (start_seq > 0 AND end_seq >= start_seq)
);
CREATE INDEX IF NOT EXISTS chat_summary_segments_conversation ON chat_summary_segments(conversation_id, start_seq);

CREATE TABLE IF NOT EXISTS artifact_blobs (
  content_hash TEXT PRIMARY KEY,
  body         JSONB NOT NULL,
  byte_length  INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_artifacts (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  content_hash    TEXT NOT NULL REFERENCES artifact_blobs(content_hash) ON DELETE RESTRICT,
  run_id          TEXT,
  tool_name       TEXT NOT NULL,
  target_key      TEXT NOT NULL DEFAULT '',
  digest          TEXT NOT NULL,
  validity        JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, content_hash, tool_name, target_key)
);
CREATE INDEX IF NOT EXISTS conversation_artifacts_conversation_created ON conversation_artifacts(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS controller_plans (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  user_id      TEXT,
  status       TEXT NOT NULL,
  plan         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS controller_plans_workspace_updated ON controller_plans(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS run_memories (
  id            TEXT PRIMARY KEY,
  feature       TEXT,
  selector      TEXT,
  stability     TEXT NOT NULL,
  failure_cause TEXT,
  note          TEXT,
  run_id        TEXT,
  project_id    TEXT,
  app_id        TEXT,
  owner_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_memories_scope_created ON run_memories(project_id, app_id, owner_id, created_at DESC);

-- Git Agent multi-repo registry
CREATE TABLE IF NOT EXISTS git_repositories (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  path            TEXT NOT NULL,
  branch          TEXT DEFAULT 'main',
  trigger_type    TEXT DEFAULT 'webhook',
  schedule        TEXT DEFAULT '',
  enabled         BOOLEAN DEFAULT true,
  last_scan_at    TIMESTAMPTZ,
  last_status     TEXT DEFAULT 'idle',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Requirement-based testing: a requirement is the AI's grounded understanding of a
-- product feature/section (discovered by searching the target app's git source).
-- Cases are linked to requirements for traceability (existing coverage + generated gaps).
CREATE TABLE IF NOT EXISTS requirements (
  id                     TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  description            TEXT DEFAULT '',
  feature_query          TEXT DEFAULT '',
  business_rules         JSONB DEFAULT '[]'::jsonb,
  srs_modules            JSONB DEFAULT '[]'::jsonb,
  data_population_notes  TEXT DEFAULT '',
  admin_behavior         TEXT DEFAULT '',
  keystone_behavior      TEXT DEFAULT '',
  metadata_refs          JSONB DEFAULT '[]'::jsonb,
  ui_selectors           JSONB DEFAULT '{}'::jsonb,
  source_files           JSONB DEFAULT '[]'::jsonb,
  coverage_status        TEXT DEFAULT 'unknown',
  status                 TEXT DEFAULT 'Draft',
  folder_id              TEXT REFERENCES folders(id) ON DELETE SET NULL,
  approval_state         TEXT NOT NULL DEFAULT 'proposed',
  proposed_by            TEXT DEFAULT 'Feature Analyst',
  source_run_id          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS ui_selectors JSONB DEFAULT '{}'::jsonb;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS srs_modules JSONB DEFAULT '[]'::jsonb;

-- Many-to-many coverage links between a requirement and the test cases that cover it.
-- link_type 'existing' = case already in the repo reconciled as coverage;
-- link_type 'generated' = case the agent created to close a coverage gap.
CREATE TABLE IF NOT EXISTS requirement_case_links (
  id              TEXT PRIMARY KEY,
  requirement_id  TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  case_id         TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL DEFAULT 'existing',
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requirement_case_links_req ON requirement_case_links(requirement_id);
CREATE UNIQUE INDEX IF NOT EXISTS requirement_case_links_unique ON requirement_case_links(requirement_id, case_id);

-- ===== Projects → Apps scope (incremental, idempotent) =====
-- One project == one git repo; an app is a testable surface within it. Every QA entity
-- is scoped to a project (required once selected) and optionally an app (null = project-level).
-- Columns are added in place so existing data is preserved; rows are backfilled to the
-- seeded "Core Platform" project at startup (see projectService.seedDefaultProjectAndBackfill).
DO $$
DECLARE t text;
BEGIN
  ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS raw JSONB DEFAULT '{}'::jsonb;
  FOREACH t IN ARRAY ARRAY['plans','suites','cases','runs','defects','reports','scripts','folders','requirements','agent_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS project_id TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS app_id TEXT', t);
    -- owner_id: the app user who owns the row (per-user data isolation). NULL/empty
    -- = legacy/admin data (visible only to admins).
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_id TEXT', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(project_id)', t || '_project_idx', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(owner_id)', t || '_owner_idx', t);
  END LOOP;
END $$;

-- ===== API Intelligence — Phase A (run envelope + regression baselines) =====
-- The run envelope mirrors agent_runs (JSONB blobs for phases/endpoints/scenarios/executions/evidence;
-- payloads are REDACTED before persistence). Normalized intelligence tables (endpoints, graph link
-- tables, executions history) arrive in Phase B+. Idempotent so existing deployments upgrade in place.
CREATE TABLE IF NOT EXISTS api_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  app_id        TEXT,
  owner_id      TEXT,
  target_url    TEXT DEFAULT '',
  environment   TEXT DEFAULT 'unknown',
  status        TEXT DEFAULT 'running',
  mode          TEXT DEFAULT 'single',
  write_enabled BOOLEAN DEFAULT false,
  messages      JSONB DEFAULT '[]'::jsonb,
  raw           JSONB DEFAULT '{}'::jsonb,   -- endpoints/scenarios/executions/findings/evidence/report
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_runs_project_idx ON api_runs(project_id);
CREATE INDEX IF NOT EXISTS api_runs_created_idx ON api_runs(created_at DESC);

-- Regression baselines: the last-good contract hash + response SHAPE (never raw response bodies) for an
-- endpoint in an environment. Keyed by (baseline_key, environment); upserted on a successful run.
CREATE TABLE IF NOT EXISTS api_baselines (
  baseline_key  TEXT NOT NULL,
  environment   TEXT NOT NULL DEFAULT 'unknown',
  project_id    TEXT,
  app_id        TEXT,
  contract_hash TEXT DEFAULT '',
  response_shape JSONB DEFAULT '{}'::jsonb,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (baseline_key, environment)
);

-- ===== Evidence-Graph Phase 1 — Object Repository (persistent, VERSIONED UI knowledge) =====
-- Platform→Application→Module→Object→Control. Append-only: evidence is NEVER overwritten — when a control's
-- verified shape changes, the prior snapshot moves into `history` and a new `current` version is minted.
-- The Metadata Graph and Evidence Graph themselves are per-run views carried on agent_runs.raw (like
-- selector_registry), so only this cross-run persistent store needs a table. Idempotent for in-place upgrade.
CREATE TABLE IF NOT EXISTS object_repository (
  key          TEXT PRIMARY KEY,           -- platform/application/module/object/control (slugged)
  platform     TEXT DEFAULT 'Admin',
  application  TEXT DEFAULT 'none',
  module       TEXT DEFAULT 'none',
  object       TEXT DEFAULT 'none',
  control      TEXT NOT NULL,
  current      JSONB DEFAULT '{}'::jsonb,   -- latest RepoControl snapshot (selector/role/label/version/…)
  history      JSONB DEFAULT '[]'::jsonb,   -- append-only prior RepoControl snapshots (never overwritten)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS object_repository_scope_idx ON object_repository(platform, application, module, object);

-- ===== Agent Workflow Phase 1 — append-only run events =====
-- Durable, ordered, run-scoped audit stream for the LangGraph.js workflow runtime (server/features/agent/workflow).
-- NOT a second event bus: it is a durable record read by the SSE compatibility projector. Rows are never
-- updated or deleted — `seq` gives per-run ordering, `event_id` gives idempotent-append de-duplication.
-- LangGraph's own checkpoint tables are created separately by PostgresSaver.setup() (server/features/agent/workflow/checkpointer.ts).
CREATE TABLE IF NOT EXISTS agent_run_events (
  event_id     TEXT PRIMARY KEY,          -- caller-supplied idempotency key (dedupes retried appends)
  run_id       TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  seq          BIGINT NOT NULL,           -- monotonic per run_id; assigned by the append function, not the caller
  node         TEXT NOT NULL,
  status       TEXT NOT NULL,             -- start | success | error | interrupt | retry
  payload      JSONB DEFAULT '{}'::jsonb, -- redacted event fields only (see workflow/events.ts) — never secrets/DOM/prompts
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_events_run_seq_idx ON agent_run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS agent_run_events_run_idx ON agent_run_events(run_id, created_at);

-- ===== Record & Play — Local Desktop Agent (gated by REMOTE_AGENT_V1) =====
-- Execution moves off the cloud onto a downloadable TestFlow Desktop Agent that runs
-- Playwright locally and connects OUTBOUND (HTTPS + WebSocket) to the cloud. These tables
-- model the execution-environment boundary the app never had: agent identity, recordings,
-- jobs, schedules, artifacts, and an append-only event stream. All idempotent + scope-columned
-- so existing deployments upgrade in place with the feature flag off and nothing renders.

-- Registered desktop agents. token_hash/refresh_hash are scrypt "salt:hash" (never plaintext) —
-- durable across restarts, unlike the in-memory human session Map. fingerprint binds the agent
-- to a machine (hostname+os+stable machine id) and is re-checked per connection.
CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT,
  app_id             TEXT,
  owner_id           TEXT,
  name               TEXT DEFAULT '',
  machine_name       TEXT DEFAULT '',
  os                 TEXT DEFAULT '',
  fingerprint        TEXT DEFAULT '',
  token_hash         TEXT DEFAULT '',
  refresh_hash       TEXT DEFAULT '',
  version            TEXT DEFAULT '',
  playwright_version TEXT DEFAULT '',
  browsers           JSONB DEFAULT '[]'::jsonb,
  cpu                JSONB DEFAULT '{}'::jsonb,
  memory             JSONB DEFAULT '{}'::jsonb,
  status             TEXT DEFAULT 'offline',   -- offline | online | busy
  last_heartbeat_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_project_idx ON agents(project_id);

-- A recorded Playwright flow (script + metadata) captured by an agent via codegen.
CREATE TABLE IF NOT EXISTS recordings (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  app_id       TEXT,
  owner_id     TEXT,
  agent_id     TEXT,
  name         TEXT DEFAULT '',
  app_url      TEXT DEFAULT '',
  browser      TEXT DEFAULT 'chromium',
  environment  TEXT DEFAULT 'QA',
  status       TEXT DEFAULT 'draft',   -- draft | recording | ready
  script       TEXT DEFAULT '',
  metadata     JSONB DEFAULT '{}'::jsonb,
  stats        JSONB DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS recordings_owner_idx ON recordings(owner_id);
CREATE INDEX IF NOT EXISTS recordings_project_idx ON recordings(project_id);

-- One execution of a recording on an agent. Lifecycle: queued → dispatched → running → uploading → done/failed/cancelled.
CREATE TABLE IF NOT EXISTS automation_jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  app_id       TEXT,
  owner_id     TEXT,
  recording_id TEXT,
  agent_id     TEXT,
  schedule_id  TEXT,
  trigger      TEXT DEFAULT 'manual',   -- manual | schedule | webhook | ci
  status       TEXT DEFAULT 'queued',
  queued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  exit_code    INTEGER,
  summary      JSONB DEFAULT '{}'::jsonb,
  error        TEXT DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_jobs_owner_idx ON automation_jobs(owner_id);
CREATE INDEX IF NOT EXISTS automation_jobs_agent_idx ON automation_jobs(agent_id);
CREATE INDEX IF NOT EXISTS automation_jobs_status_idx ON automation_jobs(status);

-- Schedules that enqueue jobs. kind: now | daily | weekly | monthly | cron | webhook.
CREATE TABLE IF NOT EXISTS automation_schedules (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT,
  app_id             TEXT,
  owner_id           TEXT,
  recording_id       TEXT,
  agent_id           TEXT,
  kind               TEXT DEFAULT 'daily',
  cron               TEXT DEFAULT '',
  timezone           TEXT DEFAULT 'UTC',
  webhook_token_hash TEXT DEFAULT '',
  enabled            BOOLEAN NOT NULL DEFAULT true,
  next_run_at        TIMESTAMPTZ,
  last_run_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automation_schedules_owner_idx ON automation_schedules(owner_id);
CREATE INDEX IF NOT EXISTS automation_schedules_next_run_idx ON automation_schedules(next_run_at) WHERE enabled;

-- Binary artifacts uploaded by the agent after a run (video, trace.zip, screenshots, HTML report, junit).
CREATE TABLE IF NOT EXISTS automation_artifacts (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  kind       TEXT DEFAULT 'other',   -- video | trace | screenshot | html | junit | log | other
  filename   TEXT DEFAULT '',
  size       BIGINT DEFAULT 0,
  path       TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_artifacts_job_idx ON automation_artifacts(job_id);

-- Append-only agent/job event stream (mirrors agent_run_events): the durable record the SSE
-- projector replays so the UI recovers live state after a refresh and the scheduler recovers
-- orphaned jobs after a restart. Rows are never updated/deleted; seq orders per scope.
CREATE TABLE IF NOT EXISTS automation_events (
  id         TEXT PRIMARY KEY,
  seq        BIGSERIAL,
  scope_type TEXT NOT NULL,            -- agent | job | recording
  scope_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_events_scope_idx ON automation_events(scope_type, scope_id, seq);

-- ===== Conversational Intelligence Runtime — Phase 1 (persistence foundation) =====
-- Plan of record: docs/diagnostics/conversational-intelligence-runtime-architecture-plan-2026-07-17.md.
-- Everything here is ADDITIVE and idempotent: legacy chat_conversations.turns and agent_runs.raw stay
-- authoritative until later phases; these tables/columns have no runtime consumer yet.

-- Versioned conversation-scoped working-state snapshot (SessionContext aggregate).
CREATE TABLE IF NOT EXISTS conversation_sessions (
  conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  owner_id        TEXT,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  project_id      TEXT,
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  version         BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  schema_version  INT NOT NULL DEFAULT 1,
  last_event_seq  BIGINT NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_sessions_owner_ws_idx ON conversation_sessions(owner_id, workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversation_sessions_project_idx ON conversation_sessions(project_id, updated_at DESC);

-- Append-only session event stream: audit trail + idempotent run/artifact projection (source_key dedupe).
CREATE TABLE IF NOT EXISTS conversation_session_events (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_key      TEXT NOT NULL,
  correlation_id  TEXT,
  causation_id    TEXT,
  actor_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_session_events_source_key_idx ON conversation_session_events(conversation_id, source_key);
CREATE INDEX IF NOT EXISTS conversation_session_events_type_idx ON conversation_session_events(conversation_id, event_type, seq);

-- Deterministic entity recency index for reference resolution (indexed rows, not message-JSON scans).
CREATE TABLE IF NOT EXISTS conversation_entity_refs (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  relation          TEXT NOT NULL,            -- selected | current | latest | generated | mentioned | failed | linked
  source_message_id TEXT,
  source_event_seq  BIGINT,
  source_run_id     TEXT NOT NULL DEFAULT '',
  project_id        TEXT,
  app_id            TEXT,
  owner_id          TEXT,
  salience          INT NOT NULL DEFAULT 0,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (conversation_id, entity_type, entity_id, relation, source_run_id)
);
CREATE INDEX IF NOT EXISTS conversation_entity_refs_recency_idx ON conversation_entity_refs(conversation_id, entity_type, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS conversation_entity_refs_relation_idx ON conversation_entity_refs(conversation_id, relation, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS conversation_entity_refs_run_idx ON conversation_entity_refs(source_run_id) WHERE source_run_id <> '';

-- chat_conversations gains scope + lifecycle columns (turns stays until the canonicalization gate).
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS owner_id         TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS project_id       TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS app_id           TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS canonicalized_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS chat_conversations_owner_idx ON chat_conversations(owner_id, updated_at DESC);

-- chat_messages becomes canonical-capable: stable IDs, client idempotency, refs, trace.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_id        TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_message_id TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS entity_refs       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS artifact_refs     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS correlation_id    TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS causation_id      TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS schema_version    INT NOT NULL DEFAULT 1;
-- Deterministic backfill: message_id derives from (conversation, seq) so re-runs are stable.
UPDATE chat_messages SET message_id = conversation_id || ':' || seq WHERE message_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_message_id_idx ON chat_messages(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_id_idx ON chat_messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- agent_runs gains first-class conversation/execution columns (dual-written; raw stays readable).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS conversation_id  TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS execution_result JSONB;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS artifact_set_id  TEXT;
CREATE INDEX IF NOT EXISTS agent_runs_scope_created_idx ON agent_runs(owner_id, project_id, app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx ON agent_runs(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_conversation_status_idx ON agent_runs(conversation_id, status, created_at DESC) WHERE conversation_id IS NOT NULL;
-- Backfill from raw (guarded: a malformed timestamp in one legacy row must not abort the migration).
DO $$
BEGIN
  UPDATE agent_runs SET
    conversation_id  = COALESCE(conversation_id, NULLIF(raw->>'conversationId', '')),
    execution_result = COALESCE(execution_result, CASE WHEN jsonb_typeof(raw->'execution_result') = 'object' THEN raw->'execution_result' END),
    completed_at     = COALESCE(completed_at, NULLIF(raw->>'completed_at', '')::timestamptz)
  WHERE (conversation_id IS NULL AND raw ? 'conversationId')
     OR (execution_result IS NULL AND raw ? 'execution_result')
     OR (completed_at IS NULL AND raw ? 'completed_at');
EXCEPTION WHEN others THEN
  RAISE NOTICE 'agent_runs conversation backfill skipped: %', SQLERRM;
END $$;

-- conversation_artifacts generalizes from tool results to any conversation artifact.
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS artifact_kind   TEXT NOT NULL DEFAULT 'tool_result';
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS producer_kind   TEXT NOT NULL DEFAULT 'tool';
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS entity_refs     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS metadata        JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS schema_version  INT NOT NULL DEFAULT 1;
ALTER TABLE conversation_artifacts ADD COLUMN IF NOT EXISTS retention_class TEXT NOT NULL DEFAULT 'default';

-- context_manifests gains full decision/evidence/plan traceability.
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS request_id             TEXT;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS correlation_id         TEXT;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS session_version        BIGINT;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS capability             TEXT;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS capability_version     TEXT;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS resolution_trace       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS evidence_manifest      JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS plan_manifest          JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE context_manifests ADD COLUMN IF NOT EXISTS response_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ===== Test Case Versioning — append-only revision history (gated by CASE_VERSIONING) =====
-- Layer 1 of the versioning plan (docs/plans/test-case-versioning-and-recorder-grouping-plan.md).
-- `cases` stays the mutable HEAD (every read path unchanged); each content edit appends an immutable
-- snapshot here, mirroring object_repository's current+history and prompts.version precedents. Only
-- VERSIONED content (title/description/preconditions/steps) is snapshotted — operational fields
-- (status/folder/tags/scope) do NOT mint a revision, avoiding revision spam. Idempotent; feature inert
-- when the flag is off (rows simply never get written).
ALTER TABLE cases ADD COLUMN IF NOT EXISTS current_revision INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS case_revisions (
  revision_id        TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL,                 -- lineage id (references cases.id; no FK so history survives a soft-delete)
  revision_no        INT  NOT NULL,                 -- 1,2,3… unique per case_id
  parent_revision    TEXT,                          -- prior revision this was based on (null for the first); enables rollback chains
  -- frozen snapshot of the versioned content only:
  title              TEXT,
  description        TEXT,
  preconditions      TEXT,
  steps              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- provenance:
  change_summary     TEXT,
  change_kind        TEXT NOT NULL DEFAULT 'manual',-- manual | ai | recorded | rollback
  applies_to_release TEXT,                          -- optional product-release tag (Layer 2 hook)
  author             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS case_revisions_case_no_idx ON case_revisions(case_id, revision_no);
CREATE INDEX IF NOT EXISTS case_revisions_case_idx ON case_revisions(case_id, created_at);

-- ===== Test Case Versioning Layer 2 — release pinning (gated by CASE_VERSIONING) =====
-- A "release" reuses an existing test plan as its container (cheaper than a parallel releases table):
-- the plan groups the cases in scope, and a pin freezes a case to a specific revision within that
-- release. No pin row = the release follows the case's HEAD; a row = frozen to that revision_no.
-- So "run release vN" resolves each in-scope case to its pinned revision (or HEAD). Idempotent.
CREATE TABLE IF NOT EXISTS release_case_pins (
  plan_id            TEXT NOT NULL,        -- release container (references plans.id; no FK so a plan rename/soft-delete can't orphan a pin write)
  case_id            TEXT NOT NULL,        -- lineage id (cases.id)
  pinned_revision_no INT  NOT NULL,        -- the frozen revision for this case in this release
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, case_id)
);
CREATE INDEX IF NOT EXISTS release_case_pins_case_idx ON release_case_pins(case_id);

-- ===== Test Case Versioning Layer 3 — execution snapshot (gated by CASE_VERSIONING) =====
-- Each run result records the exact case revision it executed, so a historical result always resolves
-- to the frozen case content even after later edits. Nullable/backfill-null = "HEAD at run time".
ALTER TABLE reports ADD COLUMN IF NOT EXISTS case_revisions JSONB NOT NULL DEFAULT '{}'::jsonb;
