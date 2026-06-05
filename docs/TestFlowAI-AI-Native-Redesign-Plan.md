# TestFlowAI — High-Level Implementation Plan
## From "AI-Assisted Tool" to "AI-Native, Human-in-the-Loop Product"

---

## 1. Executive Summary

### What the Client Wants
The client rejected the current build because the **AI is treated as a button** on human-driven forms, not as the **primary actor**. The product should operate as:

> "AI watches your codebase, proposes and runs tests, and only interrupts the human when a decision is required."

### What We Have Today
A traditional QA management tool (plans/suites/cases/runs/reports/defects) with an "AI Auto" button on each form that fills in a single text field. The AI never actually executes tests, never runs continuously, and never delivers work to the human.

### What We Need to Deliver
A product where every one of the 11 nav sections is **AI-native** with a **global AI Inbox**, an **approval state machine**, **real Playwright execution**, and **per-entity confidence/sourcing**.

### Timeline
**4 sprints (8 weeks)** for full delivery. Critical path: Inbox + Approvals + Real Execution.

---

## 2. The Core Pattern (Applies to All Sections)

Every section follows this template:

```
┌─────────────────────────────────────────────────────────────┐
│  🤖 AI Status Bar                                           │
│  • Live agent activity (running, idle, blocked)             │
│  • Background tasks with pause / redirect / cancel          │
├─────────────────────────────────────────────────────────────┤
│  📥 Pending Decisions  (the human's real work)              │
│  • AI proposals with confidence % and source citations      │
│  • [Review] [Approve] [Edit] [Reject] per item              │
│  • Per-step approve/reject (not whole entity)               │
├─────────────────────────────────────────────────────────────┤
│  📋 AI-Curated Inventory                                    │
│  • Default filter: "needs my attention"                     │
│  • Each row shows: confidence, agent, sources, owner, age   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Global Infrastructure (Build First)

### 3.1 AI Inbox (topbar)
- New topbar component replacing/augmenting the user icon at `src/App.tsx:117`
- Badge count of pending decisions across all sections
- Dropdown list sorted by urgency, with `Ctrl+I` shortcut
- Audio + visual notification on new items
- Replaces the "AI is a button you click" mental model

### 3.2 Approval State Machine
Add `approvalState` to all entities with lifecycle:
```
proposed → pending_review → approved | rejected
                       ↓
                  in_revision (human sends back to AI)
                       ↓
                  pending_review (AI re-proposes)
```

API split for every entity:
- `POST /api/{entity}/propose`
- `POST /api/{entity}/:id/approve`
- `POST /api/{entity}/:id/reject`
- `POST /api/{entity}/:id/request-revision`

Audit trail on every transition (who, when, why, what changed).

### 3.3 Live Activity Stream
Replace the 6-item `recentActivity` log in `server/shared/storage.ts:89-92` with a proper event log:
- Every AI action, human approval, system event
- Real-time updates (SSE or 2s polling)
- Filterable by agent / user / time / entity type
- Exportable to JSON / CSV

### 3.4 Background Job Runner
A scheduler that runs every N minutes, configurable per workspace:
- Watch git repos for new commits / PRs
- Trigger scheduled test runs
- Check failed runs, propose defect creation
- Remind humans about stale drafts / pending approvals

### 3.5 Confidence + Source Citations
Every AI-generated artifact gets:
- `confidence: 0–100` (color-coded badge)
- `sources: string[]` (which pages, files, commits, test cases informed this)
- `previousVersion: id` (for diff view)
- Per-step approval (not whole-entity)

---

## 4. Section-by-Section Plan

### 4.1 Dashboard → "AI Command Center"

**Files:** `src/pages/Dashboard.tsx`, `src/App.tsx`

| Today | Tomorrow |
|---|---|
| Static KPI cards | Live AI status: "3 agents running, 1 needs you" |
| Bar chart, last 5 days | "AI Forecast" — predicted pass rate for next release |
| 6-item activity log | "AI Live Activity" stream, filterable by agent |
| Nothing else | **"AI Insights"** proactive cards with proposed actions |

**New behavior:**
- Proactive cards appear automatically based on repo state, run history, and time-since-last-touch
- Each insight is a one-click decision: *AI moves 12 new cases to folder → Approve*
- Click any agent name → jump to live activity for that agent

**Success metric:** Dashboard becomes the daily entry point; human never navigates cold.

---

### 4.2 Test Repository → "AI-Organized Knowledge"

**Files:** `src/pages/TestRepository.tsx`, `server/features/agent/`

| Today | Tomorrow |
|---|---|
| Manual folder creation (2 input boxes) | AI proposes folder structure on first use, based on codebase scan |
| Drag-and-drop-less tree | AI auto-organizes new artifacts into the right folder |
| Text search only | AI semantic search: "find tests related to checkout payment failures" |
| View-only | AI proposes moves / merges / splits of folders and artifacts |

**New behavior:**
- On fresh repo: AI scans codebase, suggests folder tree, applies with one click
- On new artifact creation: AI places it in the best folder, shows banner
- Semantic search returns plans, suites, cases, runs, evidence across folders

---

### 4.3 Test Plans → "AI Plans, Human Approves"

**Files:** `src/pages/TestPlans.tsx`, `server/features/agent/`

| Today | Tomorrow |
|---|---|
| Human fills 13 fields, optionally clicks "AI Auto" for name | Human describes goal, AI drafts full plan in `pending_review` |
| No review gate | Mandatory approval gate; edits inline before approve |
| No drift detection | AI monitors approved plans, alerts when reality diverges |
| No coverage gap view | AI shows coverage gaps, risk forecasts, execution freshness |

**New behavior:**
- Voice / prompt input is primary; manual form is "Advanced"
- "Pending Plans" tab shows `pending_review` plans with diff view
- AI alerts: *"Plan 'Q4 Release' has no runs in 5 days. Resume / archive / update?"*
- Coverage gap, risk forecast, and execution freshness shown on every plan card

---

### 4.4 Test Suites → "AI Groups by Intent"

**Files:** `src/pages/TestSuites.tsx`, `server/features/agent/`

| Today | Tomorrow |
|---|---|
| 9-field create form, manual list | AI suggests suite grouping for new cases based on similarity |
| Status badge | **Suite health score** (coverage, freshness, flakiness, staleness) |
| No reorganization tool | AI can split / merge suites with one click |
| Table only | Optional graph view showing case dependencies |

**New behavior:**
- New case from Git Agent: AI proposes a suite based on similarity to existing cases
- Suite health score replaces status badge
- AI flags stale cases (referencing removed UI), flaky cases, coverage holes
- One-click split / merge with preview

---

### 4.5 Test Cases → "AI Writes, You Curate"

**Files:** `src/pages/TestCases.tsx`, `server/features/agent/`

| Today | Tomorrow |
|---|---|
| 14-field modal, AI fills only name | **Case Composer** with voice / URL / branch / manual modes |
| Whole-case rework via AI | **Per-step approve / reject / rework** |
| No diff view | Step-level diff: "Step 3 changed from X to Y because Z" |
| Manual tags | AI auto-tags, human confirms in one click |

**New behavior:**
- Primary input: voice / prompt / Jira URL / branch name
- Each generated step shows: confidence %, source, alternative interpretations
- Click any step → see in isolation → approve / rework / reject just that step
- AI re-generates only that step, not the whole case
- Case diff view vs previous version
- AI suggests similar cases from a knowledge base

---

### 4.6 Test Runs → "AI Runs, You Watch"

**Files:** `src/pages/TestRuns.tsx`, `server/features/evidence/evidenceService.ts`

| Today | Tomorrow |
|---|---|
| Human clicks "Create Manual Run" | AI initiates runs on triggers (PR opened, merge, schedule) |
| One screenshot per case (fake execution) | **Real `npx playwright test` execution** with live progress |
| Manual result entry | Real-time step results, live browser stream, live logs |
| No failure triage | AI triages failures in real-time, asks human for decision |
| Static detail view | **Run replay** with video scrub, AI jumps to failure moment |

**New behavior:**
- Triggers: PR opened, merged to main, scheduled, manual
- Live detail view during a run: step progress, browser stream, network trace
- AI triages each failure: *"This looks like the same flake as 3 days ago. Known flake / log defect / re-run / investigate?"*
- Run inbox: failures needing human decision
- Auto-retry with AI reasoning
- Video replay with AI-curated failure moments

**Critical fix:** Replace `evidenceService.ts:217` single-URL screenshot with full `npx playwright test` execution loop. Parse JSON output, update step outcomes, capture per-step screenshots.

---

### 4.7 Reports → "AI Tells the Story"

**Files:** `src/pages/Reports.tsx` (932 lines, has dead code at line 638)

| Today | Tomorrow |
|---|---|
| 932-line table, dead inline expander at `Reports.tsx:638` | AI auto-generates stakeholder reports on schedule |
| Manual report creation modal | AI-generated narratives ("Release 4.2 had 14% regression in checkout...") |
| Row-level html2canvas "PDF" | Real multi-page PDF with cover, exec summary, screenshots |
| No defect mapping | One-click "create defect" from any failure with AI prefill |

**New behavior:**
- AI auto-generates: weekly exec summary, per-release coverage, per-defect repro
- AI writes narrative paragraphs, not just data tables
- Interactive evidence: click step → diff vs last run, network trace, timing
- Real PDF export (not `html2canvas` of one row at `Reports.tsx:253-267`)
- Custom report views: *"Report for the VP, customer-facing flows only, last 2 weeks"*
- "Needs human eyes" badge on low-confidence steps

**Cleanup:** Remove the `{false && ...}` dead code at `Reports.tsx:638`.

---

### 4.8 Defects → "AI Triages First"

**Files:** `src/pages/Defects.tsx` (244 lines, single-line title input at line 16)

| Today | Tomorrow |
|---|---|
| Single-line title input | AI pre-fills: title, description, steps, severity, assignee, screenshots, similar defects |
| Alphabetical list | **AI priority queue** (critical first, then by predicted business impact) |
| Status: Open / Closed | Real workflow: `New → Triaged → In Progress → In Review → Verified → Closed` |
| No investigation tool | **AI investigates on demand**: reads defect, run, code changes, similar past, posts findings |

**New behavior:**
- AI pre-fills everything: full description, repro steps, severity with reasoning, suggested assignee from git ownership, linked runs/cases, screenshots, similar past defects
- Priority queue: "Critical" first, then "Needs triage" (AI not confident), then "Auto-clustered" (duplicates)
- One-click AI investigation: posts a comment with cause, suggested fix, who to assign, similar Slack threads
- Visual repro: auto-recorded Playwright video of the failure
- AI proposes verification: which cases to re-run when defect is fixed

---

### 4.9 AI Agent → "Mission Control"

**Files:** `src/pages/AgentPanel.tsx`

| Today | Tomorrow |
|---|---|
| Single chat window | **Mission Control**: live view of all agents and their state |
| Stateless 2s polling (`AgentPanel.tsx:132-156`) | **Streaming responses** (SSE / WebSocket) |
| Lost on refresh | Persistent, searchable, shareable conversations |
| Text only | Multi-modal: drop screenshot, paste Figma URL, drop video |
| Black box | **Tool-use visibility**: human sees AI call tools, approves destructive ones |
| No cost visibility | Per-conversation token count, cost, model used |

**New behavior:**
- Each agent (`ApplicationInspector`, `TestGenerationAgent`, `PlaywrightAgent`, `EvidenceAgent`) shown as a live card with status, current step, queue
- Direct agent addressing: `@TestExecutor run smoke suite`
- Multi-modal input
- Shared context object across agents (currently stateless)
- Memory across sessions: "Remember: our staging URL is X, our auth flow uses Y"
- Tool-use visibility with confirmation for destructive actions
- Cost / usage transparency

---

### 4.10 Git Agent → "AI Watches Your Code"

**Files:** `src/pages/GitAgent.tsx`, `server/features/git-agent/gitAgentService.ts`

| Today | Tomorrow |
|---|---|
| 3 buttons (Sync, Scan, Generate) | **Background watcher** — no human clicks needed |
| Hardcoded single repo (`D:\\core-platform` at `gitAgentService.ts:7`) | **Multi-repo support** |
| Human must navigate to `/git-agent` | Results auto-post to **AI Inbox** for approval |
| No PR integration | AI comments on PRs via GitHub / GitLab integration |
| Side-by-side script display | **Real diff with merge UI** for "Updated Coverage" |

**New behavior:**
- Background watcher: polls repo on schedule or via webhook
- On PR opened: AI comments on the PR with drafted cases, suggested test runs
- On merged: AI triggers run
- Multi-repo: each with its own AI watcher, configurable
- Script versioning with real diff: [Keep new] [Keep old] [Merge]
- Auto-PR for AI-generated scripts
- Commit-level traceability on every AI-generated artifact

---

### 4.11 Settings → "AI Configuration, Not Forms"

**Files:** `src/pages/Settings.tsx`

| Today | Tomorrow |
|---|---|
| Theme picker, model dropdown, credentials table | **AI rules, not form fields** |
| Single hardcoded "Admin" user | **Team management** with roles (Admin, QA Lead, QA Engineer, Developer, Viewer) |
| No audit log | **Audit log** for every AI action and approval |
| No integrations | **Connected integrations** (Jira, Linear, Slack, Teams, GitHub, GitLab, Jenkins, etc.) |
| No data control | **Export / import / backup** of all data |

**New behavior:**
- Personality / autonomy level: "Ask me for every decision" / "Auto-approve BVT" / "Fully autonomous"
- Trigger preferences: "Run smoke on every PR, regression nightly"
- Notification rules: "Slack me on critical defects"
- Cost ceiling: "Don't spend more than $X/day without asking"
- Self-test panel: AI verifies all integrations work
- Integrations hub: defect trackers, chat, VCS, CI/CD, test case import (TestRail, Zephyr, Excel, Sheets)
- Audit log + team roles + data export

---

## 5. Implementation Phases

### Phase 1 — Foundation (Sprint 1, 2 weeks)
**Goal:** Change the product from "AI button" to "AI inbox."

| Task | Owner | Files |
|---|---|---|
| AI Inbox component in topbar | Frontend | `src/App.tsx`, new `src/components/AIInbox.tsx` |
| Approval state machine on all entities | Backend + Frontend | All `server/features/*/routes.ts`, all `src/pages/*.tsx` |
| Live Activity Stream (replace `recentActivity`) | Backend + Frontend | `server/shared/storage.ts`, `src/components/ActivityStream.tsx` |
| Dashboard redesign with AI Insights | Frontend | `src/pages/Dashboard.tsx` |
| Remove dead code at `Reports.tsx:638` | Frontend | `src/pages/Reports.tsx` |
| Replace `alert()` / `confirm()` with toast / modal | Frontend | All `src/pages/*.tsx` |

**Exit criteria:** Every entity has a `pending_review` state. The AI Inbox is the default landing surface. No `alert()` in the app.

### Phase 2 — Real Execution (Sprint 2, 2 weeks)
**Goal:** Make the AI actually run tests.

| Task | Owner | Files |
|---|---|---|
| Real `npx playwright test` execution loop | Backend | `server/features/runs/routes.ts` (new), `evidenceService.ts` |
| Live run view with browser stream, network trace | Frontend | `src/pages/TestRuns.tsx` |
| Real-time failure triage by AI | Backend | `server/features/agent/inspectionService.ts` |
| Run replay with video scrub | Frontend + Backend | `src/pages/TestRuns.tsx`, video storage |
| Per-step screenshots (replace single URL capture) | Backend | `evidenceService.ts:217` |
| Reports: AI narratives, real PDF export | Frontend | `src/pages/Reports.tsx` |
| Defects: AI prefill on creation | Backend + Frontend | `server/features/defects/`, `src/pages/Defects.tsx` |

**Exit criteria:** A test run actually executes Playwright. Failures stream live. AI triages them. Defects can be created from a failure with one click.

### Phase 3 — Continuous AI (Sprint 3, 2 weeks)
**Goal:** AI runs in the background, not on click.

| Task | Owner | Files |
|---|---|---|
| Background job runner (scheduler) | Backend | New `server/features/scheduler/` |
| Git Agent background watcher (replace button-driven flow) | Backend | `server/features/git-agent/gitAgentService.ts` |
| Multi-repo support (remove hardcoded `D:\\core-platform`) | Backend | `gitAgentService.ts:7` |
| PR integration (GitHub / GitLab comments) | Backend | New `server/features/integrations/` |
| Test Cases per-step approve / rework | Frontend | `src/pages/TestCases.tsx` |
| AI Agent: Mission Control + streaming + multi-modal | Frontend | `src/pages/AgentPanel.tsx` |
| Test Repository: AI folder structure proposal | Backend + Frontend | `server/features/agent/`, `src/pages/TestRepository.tsx` |
| Cost / usage transparency in AI Agent | Backend + Frontend | `AgentPanel.tsx` |

**Exit criteria:** AI runs every 5 min checking for new commits. PR comments appear automatically. Test Cases can be approved per-step.

### Phase 4 — Polish & Configuration (Sprint 4, 2 weeks)
**Goal:** Hand to client with full control.

| Task | Owner | Files |
|---|---|---|
| Settings: autonomy levels, trigger preferences, cost ceiling | Frontend | `src/pages/Settings.tsx` |
| Team management (replace hardcoded "Admin") | Backend + Frontend | New `server/features/team/`, all `src/pages/*.tsx` (replace `createdBy: 'Admin'`) |
| Audit log for every AI action and approval | Backend + Frontend | New `server/features/audit/` |
| Integrations hub (Jira, Linear, Slack, Teams, CI/CD) | Backend | New `server/features/integrations/` |
| Test case import (TestRail, Zephyr, Excel, Sheets) | Backend | New importer |
| Data export / import / backup | Backend | `server/shared/storage.ts` |
| Self-test panel (verify all integrations) | Backend + Frontend | `src/pages/Settings.tsx` |
| Suite health score + AI split/merge | Backend + Frontend | `src/pages/TestSuites.tsx` |
| Plan drift alerts | Backend | `server/features/plans/` |
| Confidence + source citations on every AI artifact | Backend + Frontend | All `src/pages/*.tsx` |

**Exit criteria:** Client can configure AI autonomy. Multiple users exist with roles. All data is exportable. Every AI action is audited.

---

## 6. Cross-Cutting Concerns

### 6.1 Multi-user / Auth
- Replace hardcoded `"Admin"` in `TestCases.tsx:44, 113` with real user from session
- JWT or session-based auth
- Role-based access: Admin, QA Lead, QA Engineer, Developer, Viewer
- Each approval is tied to a user, not a string

### 6.2 Real Database
- Replace `server/shared/storage.ts` JSON file with SQLite (Postgres for production)
- Transactions for approval state transitions
- Indexes on entity lookups
- Migration path from current JSON

### 6.3 Real-time Updates
- Server-Sent Events or WebSockets for: AI activity stream, run progress, inbox updates
- Replace `AgentPanel.tsx:132-156` 2s polling with SSE

### 6.4 Notifications
- In-app badge + audio
- Slack / Teams / Email integration
- Configurable per-user rules

### 6.5 Observability
- AI cost tracking (tokens, $) per workspace
- Agent performance metrics
- Approval latency metrics
- Background job health dashboard

---

## 7. What to Demo at Each Milestone

### After Sprint 1 (Foundation)
- *"Here's the AI Inbox. The AI proposed 3 new things while you were away. Click to review."*
- *"Here's the activity stream — every AI action, every approval, real-time."*
- *"Here's the dashboard — the AI is telling you what needs attention, not showing you stats."*

### After Sprint 2 (Real Execution)
- *"I'm opening a PR. The AI automatically drafted 5 test cases. Now it's running them against staging. Step 4 failed — the AI is triaging it. Here's what the AI thinks is wrong. [Create defect] [Re-run] [Known flake]."*
- *"Here's the report the AI wrote for the release. It has a narrative, a real PDF, and a defect mapping."*

### After Sprint 3 (Continuous AI)
- *"I haven't opened the app in 2 days. When I open it, the AI has 4 PRs to review, 2 runs to schedule, and 1 defect to verify. All in the Inbox."*
- *"I asked the AI a question with a screenshot. It analyzed the page, proposed 3 cases, and started a run."*

### After Sprint 4 (Polish)
- *"I set the AI to 'Auto-approve BVT cases, ask me on the rest'. It did 12 BVT cases overnight without bothering me. The one Critical defect needed my input."*
- *"Here's the audit log — every AI action, who approved it, what changed. Compliance-ready."*

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Real Playwright execution is slow / flaky | Demo delay | Run in parallel, with timeout, with retry; fall back to "scheduled" view |
| LLM cost spikes with new AI features | Budget | Per-workspace cost ceiling in Settings, daily limit |
| Approval state machine breaks existing flows | Data loss | Keep legacy `POST /api/{entity}` as deprecated, dual-write for one sprint |
| Multi-user migration loses data | Trust | Migration script from JSON file, dry-run mode, backup before deploy |
| Background scheduler overwhelms API | Performance | Rate limit, queue depth limits, back-off |
| Client wants more autonomy / less autonomy | Scope creep | Ship with 3 autonomy presets; configurable; not customizable per-entity initially |

---

## 9. Open Questions for the Client

Before starting Phase 1, confirm:

1. **Multi-tenancy:** Single workspace or multi-tenant SaaS? Affects auth, data model, and cost.
2. **Hosting:** Self-hosted (like now) or cloud? Affects background scheduler, real-time updates, storage.
3. **AI provider lock-in:** Gemini only, or also OpenAI / Anthropic? Affects cost ceiling logic and model selection UI.
4. **Real-time delivery:** SSE or WebSocket? Browser support, infra cost.
5. **PDF export:** Real PDF library (e.g. Puppeteer) or stay with html2canvas? Quality vs simplicity.
6. **Approval gates:** Mandatory for all entities, or opt-in per workspace? Default behavior.
7. **Cost ceiling defaults:** What's a reasonable daily AI spend? Affects default Settings values.
8. **Audit retention:** Forever, 1 year, configurable? Affects storage cost.
9. **Role granularity:** 5 roles enough, or custom? Affects team management UI complexity.
10. **First demo target:** Sprint 1 (foundation) or Sprint 2 (real execution) end? Affects phasing.

---

## 10. Definition of Done

### For each phase
- All phase tasks merged to main
- All existing tests still pass (when tests are added; lint must pass)
- New functionality has at least one happy-path E2E test
- Screenshots / recordings of new UX saved to `evidences/`
- AGENTS.md updated with new commands or structure
- Client-facing changelog entry

### For the overall product
- All 11 nav sections are AI-native (not just "have an AI button")
- AI Inbox is the primary entry surface for human decisions
- Every entity has a real approval state machine
- AI actually executes Playwright, not just screenshots
- Background AI runs continuously, not on click
- Multi-user with roles, audit log, data export
- Client can configure AI autonomy level
- No `alert()` or `confirm()` in the UI
- No dead code in the codebase
