# Application-wide Timestamping & Lifecycle Metadata — Architecture & Implementation Plan

_Status: Phase-0 plan of record. Awaiting approval before implementation._
_Revision 2 — hardened for a multi-year enterprise SaaS platform (metadata model, full attribution, execution-metadata panel, sorting/filtering, deterministic ordering, timeline-ready)._

## Context

Users need to track **when** every piece of data was created and last changed, **who** did it, and see it **throughout the UI** — not hidden in an audit log. Explicit asks:

1. **Agent Console** — every response shows the exact date + time (with **seconds**) plus the run's full execution metadata (pipeline, scope, AI/usage/cost).
2. **Cases, scripts, events** — exact date + time (with seconds) visible.
3. **Edited/Updated indicators** — anywhere a record changes, show "Edited/Updated by X" + timestamp.
4. Built the way real products do it (industry research below).

**Current state (from code exploration):** Postgres auto-stamps `created_at`/`updated_at`/`deleted_at` on nearly every table (`DEFAULT now()` + `ON CONFLICT … SET updated_at=now()`), but the **JSON/in-memory mode does not auto-stamp**; there is **no "who" (created_by/updated_by) as first-class record data** (only a free-text `proposed_by` on some tables, aliased to `createdBy`); `websites` lacks `updated_at`; and the UI shows almost no timestamps (only `Settings.tsx:1686` and `AgentConsole.tsx:2879`). `relativeTime` is duplicated in `Dashboard.tsx:23-33`. A durable audit sink exists but is **unused**: `Audit.push` → `audit_log` (`repository.ts:1489`, `schema.sql:366`); the owner+actor helper `logActivity` lives only in `resources/routes.ts:40`.

## Industry best practice (researched — the standard we follow)

Sources: [Cloudscape Timestamps](https://cloudscape.design/patterns/general/timestamps/), [PatternFly Timestamp](https://www.patternfly.org/components/timestamp/design-guidelines/), [UX Movement — Absolute vs Relative](https://uxmovement.com/content/absolute-vs-relative-timestamps-when-to-use-which/), [Store dates as UTC](https://dev.to/paulallies/the-timeless-truth-store-dates-as-utc-4dgi), [Slack edited timestamps](https://ithy.com/article/slack-message-timestamp-u9qd18yn). Execution-panel reference: OpenAI Playground, **LangSmith**, Vercel AI, Anthropic Console. List/metadata reference: GitHub, Jira, Linear, Notion.

- **Store UTC / ISO-8601** (app already does). Convert to the viewer's **local timezone + locale** at display time in the browser. Never format on the server.
- **Relative by default, absolute on hover** via a `<time datetime title>` element (down to **seconds + timezone** in the tooltip; dotted-underline hover cue).
- **Label edits with a verb + actor**: "Updated by Sam · 5 min ago".
- **Show seconds directly** in precise contexts (Agent Console, event streams, detail metadata panels).
- **Lists prioritize "Updated"; detail pages carry full metadata** (GitHub/Jira/Linear/Notion) — do not bloat tables with both Created and Updated.
- **One shared time package + reusable metadata/filter/sort components** for consistency.

---

## Architectural foundations (cross-cutting — built in Phase 1, used everywhere)

These four foundations are the backbone; every phase consumes them. They exist so future lifecycle work (approvals, timelines, SLAs) requires **no redesign**.

### A. Lifecycle Metadata model (improvements #1, #2, #10)

A single reusable `metadata` object is the canonical lifecycle envelope for **every** persisted entity, in **both** PostgreSQL and JSON/in-memory mode:

```ts
// server/shared/metadata.ts (new) — single source of truth
export type ActorKind = 'user' | 'agent' | 'system';
export interface Actor { id: string; name: string; kind: ActorKind; }   // id = user id | 'agent' | 'system'

export interface Metadata {
  createdAt: string;  createdBy?: Actor;
  updatedAt: string;  updatedBy?: Actor;
  deletedAt?: string | null;  deletedBy?: Actor | null;
  version?: number;   // monotonic edit counter (display + optimistic concurrency)
  // Future lifecycle fields slot in here with ZERO schema redesign:
  // approvedAt/approvedBy, archivedAt/archivedBy, reviewedAt/reviewedBy,
  // publishedAt/publishedBy, restoredAt/restoredBy …
}
```

- **API shape:** responses expose a nested `metadata` object. **DB shape:** flattened columns (`created_at`, `created_by`, `created_by_name`, `updated_at`, `updated_by`, `updated_by_name`, `deleted_at`, `deleted_by`, `deleted_by_name`, `version`). The mapper composes/decomposes — flat storage, structured contract. Backward-compatible: existing `createdAt`/`updatedAt`/`ownerId` keep working.
- **Actor is denormalized** (id **and** cached display name + kind). Rationale: names change and users get deleted; the audit/UI must still render "by Jane" or "by AI Agent" without a live join. Non-human writes use synthetic actors `{id:'agent',name:'AI Agent',kind:'agent'}` / `{id:'system',name:'System',kind:'system'}`.
- **Single choke point:** `stampCreate(scope)` and `stampUpdate(scope, prior)` (and `stampDelete`) in `metadata.ts` produce/advance these fields (bump `version`, set `updatedAt`/`updatedBy`). **Both** the PG `upsert` path and the JSON branch call these — no per-entity duplication.
- **Migration:** additive, nullable `*_by`/`*_by_name`/`version` columns backfilled to the row owner / `'system'`; PG `created_at`/`updated_at`/`deleted_at` already exist. Justified schema change; no destructive edits.

### B. Actor resolution (improvement #1)

`reqScope(req).userId/.username/.role` is already on every write path. Add `reqActor(req): Actor` in `scope.ts` that returns the human actor, or the synthetic `agent`/`system` actor when a write originates from the agent runtime / a background job (jobs pass an explicit actor). Feeds `stampCreate/Update/Delete`.

### C. Deterministic event ordering (improvement #8)

Timestamps alone cannot order events within the same second. Every ordered stream carries a **monotonic `seq`** (and stable `eventId`); queries and UI order by the tuple **`(timestamp, seq)`**, never timestamp alone.

- `chat_messages` already has per-conversation `seq` — reuse.
- Add per-run `seq` to `agent_run_events` (`schema.sql:675`) and `automation_events` (append-only streams that currently order by `created_at` only).
- `audit_log` rows get a `seq`/bigserial so same-second CRUD orders deterministically.
- `time/compare.ts` exposes `byTimeThenSeq(a,b)` used by every timeline/log view.

### D. Shared time package (improvement #9)

Replace the single `formatTime.ts` idea with a real package — the **single source of truth** for all time formatting/comparison; delete the duplicated `relativeTime` in `Dashboard.tsx:23-33`.

```
src/lib/time/
  index.ts       // barrel
  relative.ts    // relativeTime(iso) — promoted from Dashboard
  absolute.ts    // absoluteTime(iso,{seconds,tz}) via Intl.DateTimeFormat
  timezone.ts    // resolve viewer tz/locale; UTC tooltip helper
  duration.ts    // humanizeDuration(ms) → "1.8s", "2m 04s" (agent latency/stage timing)
  compare.ts     // byTimeThenSeq(), isEdited(created,updated,thresholdMs)
  sort.ts        // sort presets: newestCreated | oldestCreated | recentlyUpdated | oldestUpdated
  format.ts      // shared format tokens/constants
```

---

## Decisions (locked defaults; adjustable at approval)

- **Attribution = persisted createdBy + updatedBy (+deletedBy)** on the record itself (improvement #1) — the UI never queries the audit log to show "Last updated by John". The **audit log remains the historical source of truth**; the record stores the **latest** metadata.
- **Visibility** = records the per-user isolation already surfaces; no new cross-user exposure.
- **Column policy** (improvement #6): tables show **Updated (by)** by default; **Created lives in the detail metadata panel**; both columns only where genuinely useful (e.g. Test Runs). Follows GitHub/Jira/Linear/Notion.
- **Sequencing:** Phases 1–3 deliver visible timestamping/metadata (core ask); Phase 4 (durable audit + history/timeline) is a defined follow-up.

---

## Approach

### Phase 1 — Foundations: metadata model, attribution, time package, shared UI primitives

**Backend** (`server/shared/metadata.ts` new, `server/shared/scope.ts`, `server/db/repository.ts`, `server/db/schema.sql`):
- Implement the **Metadata model + `stampCreate/stampUpdate/stampDelete`** (foundation A) and **`reqActor`** (foundation B).
- Wire `stamp*` into **both** the PG `upsert`/soft-delete path **and** the JSON/in-memory branch of every QA repo (`plans, suites, cases, runs, defects, reports, scripts, folders, requirements, agentRuns`). Closes the no-DB stamping gap and adds `updatedBy`/`createdBy` uniformly.
- Additive migration: `*_by`, `*_by_name`, `version` columns (+ `websites.updated_at`, `agent_run_events.seq`, `automation_events.seq`, `audit_log.seq`).
- Mapper exposes nested `metadata` while keeping flat legacy fields.

**Frontend** (`src/lib/time/` new package — foundation D; `src/components/Timestamp.tsx` + `src/components/MetadataPanel.tsx` new):
- `<Timestamp value mode="relative|absolute" seconds label/>` → `<time datetime title>` with relative text + absolute-with-seconds tooltip.
- `<EditedTag metadata/>` → "Updated by {name} · {relative}" when `updatedAt > createdAt` (uses `time/compare.isEdited`).
- **`<MetadataPanel metadata version recordId/>`** (improvement #7) — the reusable detail-page block: Created (date/time/seconds + by), Last Updated (relative + absolute + by), Version, Record ID. One component, used on every detail page.

### Phase 2 — Lists & detail pages (columns, sorting, filtering)

Pages: `TestCases.tsx`, `TestPlans.tsx`, `TestSuites.tsx`, `TestRuns.tsx`, `Defects.tsx`, `Requirements.tsx`, `Reports.tsx`, Scripts view.
- **Columns (improvement #6):** add an **Updated (by)** column before `Actions` (relative + tooltip + edited tag). **Created** is shown in the record's `<MetadataPanel>` on the detail page, not as a second table column — except Test Runs where both add value.
- **Sorting (improvement #4):** every timestamped table supports `Newest`/`Oldest created` and `Recently`/`Least-recently updated`, driven by `time/sort.ts` presets. Add a small reusable sort control (extend the existing column-header/filter pattern; no per-page bespoke logic).
- **Filtering (improvement #5):** a **reusable `<TimeRangeFilter>`** (`src/components/filters/TimeRangeFilter.tsx` new) offering Updated **today / yesterday / last 7 / last 30 days / custom range**, wired into each list's existing filter panel (e.g. `TestPlans.tsx` filter drawer). Shared logic in `time/compare.ts`, not page-specific.
- **Exports:** add `Updated`/`Created` to the `ExportMenu` `columns` config (`exportData.ts`).

### Phase 3 — Agent Console execution metadata (headline ask)

`src/pages/AgentConsole.tsx` (+ turn renderer) and the agent-run payload (`server/features/agent/**`, mapper `repository.ts:499`/`896`):
- **Per-response footer** — exact absolute timestamp **with seconds** under each assistant turn (`chat_messages.created_at` + `seq`).
- **Collapsible "Execution details" panel** beneath every agent response (improvement #3), modeled on LangSmith/OpenAI Playground/Anthropic Console. Render whatever is available:
  - **Execution:** Started · Finished · Duration · Latency (first-token).
  - **AI:** Provider · Model · Reasoning effort · Temperature.
  - **Usage:** Prompt / Completion / Cached / Total tokens · Estimated cost.
  - **Pipeline:** Pipeline · stages · **per-stage duration** · tool calls · retries · memory retrievals.
  - **Context:** Workspace · Project · Application · User · Run ID · Conversation ID.
  - Durations via `time/duration.ts`; stage/event order via `(timestamp, seq)` (foundation C).
- Backend assembles a `runExecutionMeta` object from data already produced (per-phase timing, provider/model/effort, `usageLog` tokens/cost); add per-stage timestamps/`seq` where missing.
- "Edited" marker on conversations via `updatedAt`.

### Phase 4 — Durable history & timeline (follow-up; foundation already in place)

- Promote `logActivity` → `server/shared/recordAudit(req, {action, entityType, entityId, summary, actor})` writing BOTH the dashboard feed AND durable `audit_log` (with `seq`). Call from paths that currently log nothing (credentials, projects/apps, auth user-management, automation); keep existing resources/requirements calls.
- **Timeline-ready (improvement #10):** because every mutation records `{action/eventType, at, seq, actor}` in `audit_log`, and records carry the `metadata` lifecycle envelope, a future **`<Timeline>`** (Created → Assigned → Edited → Executed → Passed → Closed) is a thin read over `audit_log` filtered by `entityId` ordered by `byTimeThenSeq` — **no schema redesign**. Generalize `CaseHistoryModal.tsx` (already the model) into a per-record History popover; add an Activity page backed by `audit_log`.

---

## Improvement → phase map

| # | Improvement | Phase |
|---|---|---|
| 1 | Persist createdBy/updatedBy/deletedBy on the record (both modes) | 1 |
| 2 | Reusable Metadata model + `stamp*` choke point | 1 |
| 3 | Full Agent Console execution-metadata panel | 3 |
| 4 | Timestamp sorting on all tables | 2 |
| 5 | Reusable time-range filtering | 2 |
| 6 | Prioritize Updated in tables, Created in detail | 2 |
| 7 | Standardized reusable `<MetadataPanel>` | 1 (built) / 2 (applied) |
| 8 | Deterministic `(timestamp, seq)` ordering | 1 (foundation) / 3–4 (applied) |
| 9 | `src/lib/time/` utility package | 1 |
| 10 | Timeline-ready architecture | 4 (+ foundation in 1) |

## Key files
- Backend: `server/shared/metadata.ts` (new), `server/shared/scope.ts` (`reqActor`), `server/db/repository.ts` (stamp in both branches; mapper), `server/db/schema.sql` (additive `*_by`, `version`, `seq`, `websites.updated_at`).
- Shared FE (new): `src/lib/time/*`, `src/components/Timestamp.tsx`, `src/components/MetadataPanel.tsx`, `src/components/filters/TimeRangeFilter.tsx`; de-dupe `relativeTime` from `Dashboard.tsx`.
- Pages: `src/pages/{TestCases,TestPlans,TestSuites,TestRuns,Defects,Requirements,Reports,AgentConsole}.tsx`, Scripts view, `src/lib/exportData.ts`.
- Phase 4: `server/shared/recordAudit`; wire `credentials`/`projects`/`auth`/`automation`; `Audit.push`→`audit_log` already wired.

## Reuse (don't rebuild)
- `relativeTime` (`Dashboard.tsx:23-33`) → promote into `time/relative.ts`.
- `logActivity` owner+actor stamping (`resources/routes.ts:40`) → promote to `recordAudit`.
- `Audit.push`/`audit_log` (already end-to-end, uncalled).
- `chat_messages.seq` as the ordering precedent for foundation C.
- `ExportMenu` + `exportData.ts` column config; existing per-page filter drawers for `<TimeRangeFilter>`.
- `CaseHistoryModal.tsx` + `case_revisions` as the per-record-history/timeline model.
- `reqScope(req)` for attribution.

## Verification
- `npm run lint` (tsc) clean per phase; **restart backend after any `server/**` change** (no hot-reload).
- **Data (both modes):** create then edit a case/plan/suite/defect/requirement/report in PG mode **and** JSON mode; assert `metadata.createdAt`/`createdBy` set once, `updatedAt`/`updatedBy` advance, `version` increments, `deletedBy` set on delete; `websites.updated_at` advances. Verify the API returns a nested `metadata` object and legacy flat fields still populate.
- **Ordering:** emit ≥2 agent/pipeline events in the same second → they render in stable `(timestamp, seq)` order across reloads.
- **UI lists:** each list shows Updated (by); hover shows absolute time with **seconds + tz**; edited rows show "Updated by X"; sort presets reorder correctly; `<TimeRangeFilter>` (today/7d/30d/custom) filters correctly.
- **Detail pages:** `<MetadataPanel>` shows Created/Updated/by/Version/Record ID consistently.
- **Agent Console:** send a prompt as a tester → footer shows exact seconds; Execution details panel shows Execution/AI/Usage/Pipeline/Context with per-stage durations; conversation shows "edited" after a follow-up.
- **Isolation:** a second tester never sees another user's records/metadata.
- **Phase 4:** a credential/project/user CRUD writes a durable `audit_log` row (with `seq`) + dashboard activity, correct actor + timestamp; per-record History renders ordered by `byTimeThenSeq`.

## Open decisions (to confirm at approval)
1. **Actor storage:** denormalized `*_by` **id + cached name** (recommended, resilient to renames/deletes) vs id-only with read-time resolution.
2. **`version` field:** include the monotonic edit counter now (enables optimistic concurrency + "Version 18" display) or defer. Recommended: include — trivial and unlocks concurrency safety later.
3. **Phase 4 timing:** ship Phases 1–3 first (recommended) vs include the durable audit + history/timeline in this pass.
4. **Custom range UI:** date-range picker component — reuse an existing lightweight one or add a minimal native `<input type=date>` pair for the first cut.

## Estimated effort
- Phase 1 (foundations: metadata model, time package, primitives, migration): medium.
- Phase 2 (8 pages × Updated column + sort + shared filter + metadata panels): medium.
- Phase 3 (Agent Console execution panel + payload plumbing): medium.
- Phase 4 (audit wiring + history/timeline UI): medium/large (separable follow-up).
