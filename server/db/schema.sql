-- TestFlowAI — PostgreSQL schema
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

CREATE TABLE IF NOT EXISTS suites (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  parent_suite    TEXT,
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
  cost_usd      NUMERIC(12, 6) DEFAULT 0,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_workspace_day ON usage_log(workspace_id, created_at);

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

-- Generic key/value settings table (provider keys, autonomy, cost limit, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent Console chat history (one row per conversation; turns stored as JSON)
CREATE TABLE IF NOT EXISTS chat_conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL DEFAULT 'default',
  title         TEXT DEFAULT '',
  turns         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_ws ON chat_conversations(workspace_id, updated_at DESC);

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
  data_population_notes  TEXT DEFAULT '',
  admin_behavior         TEXT DEFAULT '',
  keystone_behavior      TEXT DEFAULT '',
  metadata_refs          JSONB DEFAULT '[]'::jsonb,
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
