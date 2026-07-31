# Tag-Native Organization + Manual Step Runner + Tag-Based Versioning — Architecture Plan (Phase 0)

Status: **ANALYSIS ONLY — no code changed.** Awaiting explicit approval on a later turn before any implementation.
Date: 2026-07-30
Author mode: Principal Architect (per `CLAUDE.md` Phase-0 process).

Everything below is grounded in the current code (file:line). This plan covers three related-but-separable subsystems the user requested in one session:

- **Part A — Tag-native organization.** Replace folders as the *primary* way to organize and select Test Cases, Suites, Plans, and Runs with a first-class tagging system. Users create their own tags. Suites/Plans/Runs are composed by choosing tags (static snapshot or live tag-query). Remove the "color tags" feature.
- **Part B — Manual step-by-step test runner.** Add an Azure-DevOps-Test-Plans-style manual execution mode alongside the existing automated (Playwright) runs: per-step Outcome / Action / Expected / Actual / Comment / screenshot, per-case outcome, bulk outcome setting, run summary + analysis + linked work items + "Create bug".
- **Part C — Git-like version graph.** Every content change to a case (or its script) automatically becomes an immutable node in a Git-style graph with a parent link; users see the history graph and can restore any prior version (n−1 … n−99) via revert semantics (append, never destroy). Label tags say *which* cases (`sanity`); the graph holds *which* version. "The v1 sanity set" = a static/pinned or named-release snapshot over that graph.

> These three are deliberately ordered so each is independently shippable and independently valuable. Part A is the foundation; Part B is orthogonal (it can ship on folders too); Part C is a thin layer on top of A + the existing versioning tables.

---

## 1. Executive summary

The user's instinct is correct and — importantly — **most of the data foundation already exists**. This is a *cutover and completion* effort, not a from-scratch build.

- Tags are already a first-class, denormalized concept: `tags TEXT[]` on `cases`/`suites`/`plans`/`runs`/`defects`/`websites` with GIN indexes (`server/db/schema.sql:38,72,97,118,158,255,318,641-645`), plus a scoped tag **catalog** (`tags` table, `schema.sql:626-638`) with name + color + usage counts + rename-write-through. The frontend already ships `TagEditor`, `TagMultiSelect`, `TagManagerModal`, and a server-side `buildListQuery({q, tags, folderId, tagMatch})` (`src/lib/entityLinking.ts`) that filters by tags **and** folder in parallel.
- Folders are a *mandatory* parallel tree: single-parent adjacency list (`folders.parent_id`, `schema.sql:5-17`), one `folder_id` per artifact, enforced at create by `requireRepositoryFolder` (`server/features/resources/routes.ts:90`), with cascade delete of the whole subtree + contained artifacts (`routes.ts:737`). This mandatory single-location model is the pain the user describes.
- Runs are two separate lineages: the repository/manual **`runs`** table (`schema.sql:113-143`) and the AI **`agent_runs`** table. The `runs` entity is *nominally* manual (`trigger_type DEFAULT 'manual'`) but its **only execution path requires Playwright scripts and hard-400s without them** (`routes.ts:433`). There is **no per-step result store** (step outcomes live only in `runs.steps[]` JSONB, written only by `executionSteps()` at `routes.ts:219-229`), **no per-step/per-case outcome UI, no bulk outcome control, no manual screenshot upload**. The run-detail "Configurations" column is a hardcoded `"--"` (`src/pages/TestRuns.tsx:662`).
- Versioning primitives already exist behind `CASE_VERSIONING`: `case_revisions` (append-only history, `schema.sql:1205-1223`), `release_case_pins` (freeze a case to a revision per release, `schema.sql:1230-1236`), and `reports.case_revisions` (execution snapshot, `schema.sql:1242`). The missing piece is that **membership carries no revision** — `runs.case_ids TEXT[]`, `cases.test_suite_ids`, etc. store only ids.

**The single most important design decision (repeated across all three parts):** *tags select **which** entities; they do not by themselves freeze **which content/version**.* Version is a separate axis resolved through the revision layer, surfaced in the UI as a special kind of tag. Suites/Runs must therefore be able to store **(case lineage id, pinned revision)** pairs, not bare ids.

---

## 2. Existing architecture (grounded)

### 2.1 Organization (folders + tags)
- **Folders:** `folders` table `schema.sql:5-17` (self-referential `parent_id`, denormalized `path`, `kind`, `icon`, soft-delete). Scope columns `project_id/app_id/owner_id` added in `schema.sql:652-678`; active-sibling name uniqueness `folders_active_sibling_name_unique` `schema.sql:725`. Helpers in `server/shared/folders.ts` (`getFolderPath`, `resolveFolderPath`, `resolveFolderForAgent`, `@Folder` mention parsing). CRUD + cascade in `server/features/resources/routes.ts:574-758`. Mandatory-on-create via `requireRepositoryFolder` (`routes.ts:90`, applied at `931,971,1034,1326`). Filter by `req.query.folderId` in `filterListByQuery` (`routes.ts:258-286`).
  - Frontend: tree in `src/pages/TestRepository.tsx` (`buildTree`, `FolderTreeItem`, move/reparent); picker `src/components/FolderSelect.tsx`; badge `src/components/FolderBadge.tsx`; folder filter inside `src/components/EntityLinker.tsx`; folder buckets in `src/pages/automation/RunnablePicker.tsx`.
- **Tags:** arrays + catalog (see §1). Catalog routes `server/features/tags/routes.ts` (list/create/rename/recolor/delete, `computeTagUsage`, `ensureTagsInCatalog`, `Tags.renameInEntities`). Normalization `normalizeCaseTags`/`normalizeTag` → canonical `@lowercase-dashed` (`server/shared/testCases.ts`, `src/lib/tags.ts`). UI: `TagEditor.tsx`, `TagMultiSelect.tsx`, `TagManagerModal.tsx` (`SWATCHES` palette, recolor PUT). Search contract `buildListQuery({q,tags,folderId,tagMatch:'any'|'all'})` (`src/lib/entityLinking.ts`).

### 2.2 Composition (suite/plan/run membership)
- Denormalized on child rows with dual singular/plural fields kept in sync: `cases.test_suite_id`+`test_suite_ids JSONB`, `cases.test_plan_id`+`test_plan_ids`, `suites.test_plan_id`+`test_plan_ids`, `suites.parent_suite`+`parent_suite_ids`, `plans.parent_plan_id` (`schema.sql:67-69,92-93,308-313`).
- Server assembly: `POST /api/suites/:id/cases` (`routes.ts:1002-1031`), `POST /api/runs/from-selection` (`routes.ts:1182-1323`, expands plan→suite→case and flattens steps), `POST /api/runs` (`routes.ts:1326-1388`).
- Client: `src/lib/suiteCaseSelection.ts`, `src/components/EntityLinker.tsx` ("map existing cases…", "Create suite/run from selection"), hierarchy `src/lib/testPlanHierarchy.ts`.

### 2.3 Runs execution
- `runs` `schema.sql:113-143`: aggregate results only (`total_executions/passed/failed/status`), step/evidence blobs `steps JSONB`/`evidence JSONB`, `trigger_type`/`trigger_meta`, `assigned_to`/`tags`/`state`, `website_id`/`credential_role`.
- Step shape (machine-written) `{step,action,expected,outcome,reason,screenshot,screenshots[]}` at `routes.ts:219-229`. No per-step timing/duration; no per-case result row.
- Execute path `POST /api/runs/:id/execute` `routes.ts:402-566` — resolves linked `scripts`, **400s if none** (`:433`), runs `runPlaywrightRequest`, writes `steps`, `createReportFromRun` (`routes.ts:194-215`).
- Evidence: `/evidence` static (`apps/api/src/server.ts:128`), aggregated by `core/shared/runEvidence.ts` (`collectRunEvidence`), gallery+lightbox in `TestRuns.tsx`.
- Frontend run detail `src/pages/TestRuns.tsx`: stat bar `getRunStats()` (`:42-75`), case table is **display-only** (`:629-692`), "Configurations" hardcoded `"--"` (`:662`), execute gated by `runs:execute`. Manual scaffolding `src/lib/manualTestRun.ts` (`runExecutionState`, `manualRunSelection`), read-only `src/components/StepGroupList.tsx`.
- Cases: `cases.steps JSONB` normalized to `{action,expected,group?,groupIndex?}` (`server/shared/testCases.ts:1-16`); authored in `src/components/EditableCaseCard.tsx`.

### 2.4 Versioning (behind `CASE_VERSIONING`)
- `cases.current_revision` + append-only `case_revisions` (`schema.sql:1203-1223`); `release_case_pins` (`schema.sql:1230-1236`); execution snapshot `reports.case_revisions JSONB` (`schema.sql:1242`). Prior plan: `docs/plans/test-case-versioning-and-recorder-grouping-plan.md` (releases = plans reused as containers; **new capability = new case, not a new version**).

---

## 3. Dependency graph

```
Part A (tags-native org)
  ├─ DB: tags[] arrays + tags catalog        (EXISTS)
  ├─ tag "kind"/namespace + saved queries    (NEW, additive column + table)
  ├─ buildListQuery / filterListByQuery       (EXTEND: tag-first, folder optional)
  ├─ EntityLinker / TagEditor / pages         (EXTEND: compose by tag)
  └─ folder → tag migration + de-mandate      (NEW backfill + drop requireRepositoryFolder gate)

Part B (manual runner)                         mostly independent of A
  ├─ run.mode discriminator                    (NEW column)
  ├─ run_case_results (+ step_results JSONB)    (NEW table)  ← the core gap
  ├─ manual result endpoints + bulk + upload    (NEW routes)
  ├─ ManualRunner UI (points list + step grid)  (NEW components in TestRuns)
  └─ Create-bug-from-result                     (EXTEND defects)

Part C (git-like version graph)                 builds on existing case_revisions
  ├─ case_revisions graph (parent links)        (EXISTS — wire the write path)
  ├─ script_revisions graph                     (NEW — mirror for scripts)
  ├─ restore = append revert node               (NEW — non-destructive checkout)
  ├─ revisions list / diff / restore API + UI   (NEW — the graph users "see")
  ├─ membership pin case_pins {caseId,revNo}    (EXTEND suites/runs)
  └─ release = optional git-tag over the graph  (EXISTS: release_case_pins)
```

Part B does **not** depend on Part A and can ship first or in parallel. Part C depends on Part A's tag model and Part B's `run_case_results` (for the execution snapshot).

---

## 4. Runtime flow (target)

**Compose a suite by tags (static):** user opens Suite → "Add cases by tags" → picks `sanity` + `module:billing` (+ optional `version:v1`) → `buildListQuery` resolves matching cases → user confirms → membership is **snapshotted** as `{caseId, revisionNo}` pairs → suite is reproducible.

**Compose a dynamic (query) suite:** user saves the tag query as the suite's `definition` → suite membership is resolved live at view/run time (Azure "query-based suite"). No snapshot; always current HEAD unless a version tag pins it.

**Run a manual test (Part B):** user creates a Run with `mode='manual'` from a suite/tag-query → server seeds one `run_case_results` row per case (revision frozen) with step_results = case steps at `outcome='Not Run'` → tester opens the step runner → sets per-step Outcome + Actual + Comment + screenshot → per-case outcome rolls up (or is set directly / in bulk) → run status rolls up → optional "Create bug" spawns a prefilled defect → `createReportFromRun` persists the report with `case_revisions` snapshot.

**Run automated (unchanged):** `mode='automated'` keeps the existing Playwright path (`POST /api/runs/:id/execute`).

---

## 5. Evidence flow (target)
- Automated: unchanged (`runPlaywrightRequest` → `/evidence` → `runs.steps[].screenshots`).
- Manual: **new** authenticated upload endpoint writes tester screenshots into the same `/evidence` store; references land on `run_case_results.step_results[i].screenshots[]`. `collectRunEvidence` extended to also walk `run_case_results` so the gallery/ZIP export work identically for manual runs.

---

## 6. Context / prompt flow
- "Create bug" reuses the run's frozen step_results (action/expected/**actual**/comment/screenshots) to prefill `defects.steps_to_reproduce/expected/actual/evidence` — no LLM required, but the existing bug-investigation agent can enrich.
- Agent-authored cases already emit `tags`; Part A adds the ability for the agent to also emit **faceted** tags (e.g. `module:*`, `type:sanity`) via test-data/understanding config, never hardcoded (per `CLAUDE.md`).

---

## 7. Current problems this solves
1. **One-location tyranny.** A case lives in exactly one folder; choosing the right folder is hard and doesn't scale. Tags are many-per-case and orthogonal.
2. **Rigid composition.** Suites/plans/runs are assembled by walking a folder tree; there's no "give me all sanity billing cases." Tag queries make grouping declarative.
3. **No real manual execution.** The "manual" run can't actually be executed by a human step-by-step; it demands Playwright scripts and offers no per-step outcome/actual/comment/screenshot, no bulk marking, no analysis section.
4. **Version ambiguity.** "The v1 sanity set" is unexpressible: tags on the mutable HEAD row can't distinguish v1 vs v2 content, and membership carries no revision.
5. **Color-tag clutter.** Manual per-tag color management adds UI weight the user wants gone.

---

## 8. Root-cause analysis
- Folders were the original org primitive; tags were bolted on later (`buildListQuery` already carries both), but the *mandatory* `requireRepositoryFolder` gate and folder-first UI keep folders primary.
- The `runs` table was designed around automated Playwright output (`executionSteps()` machine-writes `runs.steps`), so no human-writable per-step result model was ever added.
- Membership was denormalized as bare id arrays before versioning existed, so it can't reference a revision.

---

## 9. Proposed architecture

### 9.1 Part A — Tag-native organization *(decisions resolved: folders removed, color removed)*

**Tag kinds / facets (light, additive).** Add `kind TEXT DEFAULT 'label'` to the `tags` catalog: `label` (free — `sanity`, `login`), `facet` (namespaced `key:value` — `module:billing`, `priority:p1`, `owner:mark`). Users still type free tags; facets are just a `key:value` convention the UI understands (autocomplete groups by key). **No app-specific facet values are hardcoded** — keys/values are learned from usage + the understanding layer (per `CLAUDE.md`). Version is **not** a tag kind — versioning is its own graph (§9.3); a named release is an *optional* pointer over that graph, not a free tag.

**Composition = single tag-query composer, review-gated dynamic membership (decisions D4/D6 resolved 2026-07-31).** One reusable composer replaces every scattered link control (Link Individual Cases / Link Suites / Link Runs). The flow the user specified: **pick/search a tag that actually exists in the app → composer previews the matched cases → user selects from the preview → creates the suite/run/plan.** Preview is mandatory (never blind).

Membership is **dynamic but review-gated** — it is NOT auto-synced and NOT frozen:
- The group stores its `tagQuery` AND an explicit **accepted set** of members the user has reviewed. `definition JSONB DEFAULT '{}'` on `suites`/`plans`/`runs`: `{"tagQuery":{"all":["sanity"],"any":["module:billing"],"not":[]},"accepted":[{"caseId","revisionNo"}],"pin":{...}}`.
- When new cases later match the `tagQuery` but are NOT in `accepted`, the group shows a **notification dot** ("N new cases match `@sanity`"). The user reviews and picks one of a **three-way choice**: (a) **Add to this group** (merge new matches into `accepted`), (b) **Create a new group** (spin the new matches into a separate suite/run/plan, leaving this one unchanged), (c) **Dismiss** (ignore; keep current set).
- **Execution semantics = Option A.** A run/suite/plan only ever executes its **`accepted` set** — the cases the user has reviewed. Unreviewed new matches never run until explicitly accepted via the notification. Nothing executes that the user hasn't seen.
- `pin` still optionally freezes which *version* each accepted case resolves to (default HEAD; §9.3).

**Folders — removed (flag `TAG_NATIVE_ORG`).** Per the user: no attachment to folders, relabel purely on tags.
- Remove the `requireRepositoryFolder` gate; `folder_id` becomes vestigial (stops being read/written by app code).
- One-time idempotent backfill: each artifact's folder `path` `A / B / C` → appended tags (`A`,`B`,`C`) so nothing organizational is lost.
- Remove the folder tree, `FolderSelect`, `FolderBadge` from the UI; `TestRepository.tsx` becomes a **tag/facet explorer** (facets in a left rail, artifacts on the right). The `folders` table + `folder_id` columns are left in the DB **unused** during the cutover release (no migration risk), then physically dropped in a small follow-up plan once the tag cutover is confirmed live. Users never see folders again from Phase A2 on.

**Remove color — entirely.** Per the user: no color at all. Delete the `SWATCHES`/recolor UI in `TagManagerModal.tsx`, stop reading/writing `tags.color` in `tags/routes.ts` and the frontend, and render chips **monochrome** (theme border/text tokens only). Leave the `tags.color` column in the DB unused for one release (zero-risk), dropped in the same follow-up as the folder columns. No auto-color, no swatches.

### 9.2 Part B — Manual step runner

**Run mode discriminator.** Add `runs.mode TEXT DEFAULT 'automated'` (`manual` | `automated`). At create, `mode='manual'` seeds results and never requires scripts; the existing execute path stays `automated`-only.

**New result store (the core gap).** One row per case in a run; step results as a typed JSONB sub-array (matches Azure "test point → step results"; avoids overloading the flat `runs.steps`):
```
run_case_results
  id             TEXT PK
  run_id         TEXT   (FK runs.id, ON DELETE CASCADE)
  case_id        TEXT   (lineage id)
  revision_no    INT    (frozen execution snapshot; null = HEAD at run time)
  outcome        TEXT   DEFAULT 'Not Run'   -- configurable vocab (§9.2 outcomes)
  comment        TEXT
  run_by         TEXT
  analysis_owner TEXT
  analysis_note  TEXT
  configuration  TEXT                        -- e.g. environment/browser/data-profile label
  priority       TEXT
  started_at     TIMESTAMPTZ
  completed_at   TIMESTAMPTZ
  duration_ms    BIGINT
  step_results   JSONB DEFAULT '[]'          -- [{action,expected,actual,outcome,comment,screenshots[]}]
  created_at/updated_at
UNIQUE(run_id, case_id)
```
Aggregate `runs.passed/failed/status` roll up from these rows; `runs.steps` remains for automated back-compat.

**Outcome vocabulary (configurable, not hardcoded product facts).** Default set drawn from Azure/TestRail conventions: `Not Run`, `Passed`, `Failed`, `Blocked`, `Retest`, `Not Applicable`, `Paused`/`In Progress`. Exposed as a small config list so teams can adjust; "Attention needed" maps to `Blocked`. Bulk actions operate on this same vocab.

**New endpoints** (`server/features/resources/routes.ts`, additive):
- `POST /api/runs` extended with `mode:'manual'` → seed `run_case_results` from resolved cases (frozen revisions).
- `PATCH /api/runs/:id/results/:caseId` — set case outcome/comment/analysis/config/priority; stamps timing.
- `PATCH /api/runs/:id/results/:caseId/steps/:index` — set step outcome/actual/comment; append screenshot ref.
- `POST /api/runs/:id/results/bulk` — set outcome on many cases (the bulk dropdown: "Pass all", "Mark selected Blocked", "Reset to Not Run").
- `POST /api/runs/:id/results/:caseId/attachments` — authenticated screenshot/file upload → `/evidence` (manual evidence; today evidence only comes from Playwright).
- `POST /api/runs/:id/results/:caseId/bug` — create a `defects` row prefilled from the failed steps + evidence; link via `linked_run_id`/`linked_case_id`.

**UI (extend `src/pages/TestRuns.tsx`, new components):**
- Run detail gains a **mode-aware** body. Manual mode shows:
  1. **Summary panel** (Run by, Configuration, Completed time, Test plan / Test suite / Test case, Priority) + **Analysis** (owner + comment) + **Linked work items** — mirrors the screenshots.
  2. **Test points list** (cases) with a per-case **Outcome dropdown** + a **bulk toolbar** (select rows → set outcome) + Create-bug.
  3. Drill into a case → **step-by-step runner grid**: Step | Outcome | Action | Expected Result | **Actual** | Comment | 📎 screenshot, plus a "Show images" toggle and per-run Start time / Duration (exactly the screenshot layout — *pattern, not pixel copy*).
- Reuse: `StepGroupList.tsx` as the read model, `collectRunEvidence` for the gallery, `Modal`/`MultiSelectDropdown`/`RowMoreMenu` primitives, `manualTestRun.ts` (`runExecutionState`) for progress.
- New shared component `ManualStepRunner` (editable counterpart of `StepGroupList`); new `OutcomeSelect` chip-dropdown; new `RunSummaryPanel`.

### 9.3 Part C — Git-like version graph *(decision resolved: automatic graph + restore-any-version, not manual v1/v2 labels)*

The user's requirement, precisely: *don't make me label v1/v2 by hand — whenever a case (or its script) changes, record it as a node in a Git-like graph, let me see the history, and let me restore any previous version (n−1 … n−99).* This is exactly Git's **commit graph + revert** model, and the DB already has the bones for it (`case_revisions.parent_revision`, `change_kind` incl. `'rollback'`). Part C promotes those bones into a real version-control subsystem for cases **and** scripts.

#### C.1 The model (mapping to Git — so the mental model is familiar)

| Git concept | Our entity | Meaning |
|---|---|---|
| repository | a **lineage** (`cases.id` / `scripts.id`) | one case (or script) across its whole life |
| working copy / HEAD | the mutable `cases` / `scripts` row | current content everyone reads today |
| commit | a **revision node** (`case_revisions` / new `script_revisions`) | immutable snapshot of the content at one change, with parent link |
| `git log` / graph | **version-history graph** | the chain/DAG of revision nodes |
| `git diff` | **revision diff** | field/step-level diff between any two nodes |
| `git revert` | **restore** | append a *new* node whose content = an old node's (never destroys history) |
| `git tag` | **release** (`release_case_pins`) | an *optional*, named pointer freezing a set of cases to specific revisions |
| `git checkout <sha>` for a run | **membership pin** (`case_pins`) | a suite/run pinned to exact revisions |

Key invariants (all Git-faithful):
- **Append-only, immutable, non-destructive.** Editing never overwrites history; restoring an old version creates a *new* node on top (revert semantics, not reset). You can always get back to anything — including n−99 — because nothing is ever deleted.
- **Automatic.** A node is minted whenever *versioned content* changes (title/description/preconditions/steps for cases; code for scripts). Operational fields (tags, status, scope) do **not** mint nodes — no version spam. This is already the documented rule at `schema.sql:1200-1202`.
- **Linear by default, DAG-capable.** `parent_revision` supports branching if ever needed, but the default UX is a single linear timeline + restore.

#### C.2 Schema (mostly already present; small additions)

- **Cases:** `cases.current_revision` + `case_revisions{revision_id, case_id, revision_no, parent_revision, title, description, preconditions, steps, change_summary, change_kind, applies_to_release, author, created_at}` — **already exists** (`schema.sql:1203-1223`). No change needed beyond wiring the write path (§C.3).
- **Scripts (NEW — mirror of case_revisions):** the user explicitly called out "same case, same script, something different in v2." Add:
  ```
  scripts.current_revision INT DEFAULT 1
  script_revisions(revision_id PK, script_id, revision_no, parent_revision,
                   code, language, framework,
                   source_case_revision INT,     -- which case revision this script was generated from (traceability)
                   change_summary, change_kind ('manual'|'ai'|'regenerated'|'rollback'), author, created_at)
  ```
  So a script has its own Git graph, and each script node knows which *case* revision produced it — letting the UI show "case v3 → script v5" lineage.
- **Membership pin (Part C ↔ Part A/B):** add `case_pins JSONB DEFAULT '[]'` = `[{caseId, revisionNo}]` to `suites` and `runs`. Bare `case_ids TEXT[]` stays for back-compat; readers prefer `case_pins` when present. `revisionNo` null / absent = follow HEAD.
- **Release (git-tag) — already exists:** `release_case_pins(plan_id, case_id, pinned_revision_no)` (`schema.sql:1230-1236`). A "release" reuses a plan as its container. Making a release = snapshot every in-scope case's current revision into pins. Optional; only when a team wants a named baseline.

#### C.3 Write path (where nodes get minted)

Single choke point so behavior is uniform: `Cases.upsert` (`server/db/repository.ts:830-873`) and the script save path.
- On save, diff versioned fields vs the current row. If changed → append a `*_revisions` node (`parent_revision` = current HEAD node, `revision_no = current+1`), bump `current_revision`, set `change_kind` by caller (`manual` | `ai` | `recorded`/`regenerated`). If unchanged → plain update, no node.
- **Restore(v k):** append a new node with content copied from node k, `change_kind='rollback'`, `parent_revision` = current HEAD, `change_summary='Restored v{k}'`. HEAD row is updated to that content. History stays intact; the restore itself is a node you can later undo.
- Gated by the existing `CASE_VERSIONING` flag → fully inert when off (no nodes written, current behavior preserved).

#### C.4 Read / API surface (NEW, additive)
- `GET /api/cases/:id/revisions` — the graph (nodes + parent links + author + change_summary + change_kind + timestamp).
- `GET /api/cases/:id/revisions/:a/diff/:b` — field/step diff between any two revisions.
- `POST /api/cases/:id/revisions/:k/restore` — Git-revert-style restore of version k.
- Same trio for `/api/scripts/:id/revisions...`.
- Release: `POST /api/plans/:id/release` (snapshot pins), `GET /api/plans/:id/release` (resolved revision per case).

#### C.5 UI — the version graph the user asked to "see"
- A **"History" tab / side panel** on a case (and script): a vertical Git-graph timeline (node per revision) — like the commit graph — showing `v{n}`, author, timestamp, change summary, change kind badge. `mermaid` is already a dependency and can render the gitGraph, or a lightweight custom rail.
- Each node: **View**, **Diff vs previous** (or vs any selected node — steps shown with add/remove/modify highlighting), **Restore this version** (revert). This is exactly "how they see it and how they demote to n−1 … n−99."
- Suite/run compose UI shows the pinned revision per case (`case_pins`) and a "follow latest vs pin to version" toggle; optional "Save as release" to mint a named baseline.

#### C.6 How this answers the sanity v1/v2 question
- `sanity` (label tag) selects **which** cases (the lineage set). The **version graph** is what holds v1 vs v2 content per case.
- "The v1 set" = either a **release** (named git-tag over the graph) or a **static suite** whose `case_pins` freeze each case to its v1 revision node.
- Moving a case to v2 = a new node; the v1 suite/release still resolves to the v1 nodes and runs v1 content. Restoring to any older node (down to n−99) is a revert node — always reachable, never lost.
- **Execution snapshot:** `run_case_results.revision_no` (Part B) + `reports.case_revisions` record exactly which node each run executed, so historical results stay reproducible.

#### C.7 Cross-entity version propagation — the permutation problem (resolved 2026-07-31)

This is the user's central concern: *"if a case changes to v2, does the suite become v2? the plan? the run? does everything re-transform?"* Left unanswered it becomes a combinatorial explosion. It is resolved by **one principle + one directional invariant**, below.

**The one principle — two kinds of change, only ONE mints a version:**
1. **Content change** — a *leaf* (Case or Script) has its steps/title/code edited. This mints a new **revision node on that leaf only** (§C.3). Nothing else auto-versions.
2. **Composition change** — a *container* (Suite / Plan) changes *which children and which of their versions* it includes. This mints a new revision **on that container only**.

A container's "version" is *nothing more than its recorded set of `{child, pinnedRevision}`.* So "is the suite v2?" literally means "has its accepted set of `{case, revision}` changed?" — not "did some case inside it change."

**The one invariant — version flows DOWN as pins, never cascades DOWN as bumps; it rises UP only by opt-in re-pin:**
- A container **points down** to specific child revisions (a pin). Editing a container (rename, reorder, add a case) **never changes any child's version** — parents can't rewrite children.
- A child changing (case v1→v2) **does not silently bump its parents.** It surfaces as **drift** in the parent's review-notification. The parent's version bumps **only when the user accepts** the newer child revision (a re-pin). Upward movement is always opt-in and reviewed — never automatic, never cascading.

This is exactly Git submodules: editing a file in a submodule doesn't rewrite every super-project; bumping the submodule pointer is a deliberate commit in the parent. No permutation explosion, because there is no automatic multi-level cascade — each level versions independently and only when *its own* accepted set changes.

**Unifying with the review-gate (D6).** The `accepted` set is `[{caseId, revisionNo}]` — it records **which** cases *and* **which version** of each. The notification therefore surfaces **two** kinds of drift with the same three-way choice:
- *Membership drift* — a new case now matches the tag query but isn't in `accepted` → **add / create-new / dismiss**.
- *Content drift* — an accepted case has a newer revision (v2) than the one pinned → **update-to-v2 / keep-current / create-new-version-of-group**.

Accepting either kind is a composition change → the container's own revision bumps (Suite v1→v2). Execution always runs exactly the accepted `{caseId, revisionNo}` pairs = fully reproducible (Option A, extended to versions).

**Runs are never re-versioned.** A Run is an **immutable execution record**, not a container you edit. It snapshots the exact `{case, revision}` set it ran (`run_case_results.revision_no`). To run newer content you create a **new run** (or a new execution) — the old one is preserved forever with its original results. So "does the run's version change?" → no; you get a *new* run, never a mutated one.

**Version-as-tag (user requirement 2026-07-31 — stay 100% in tag world).** The revision graph is the source of truth, but the user never manipulates revision numbers directly — **version is exposed as a system-managed tag facet** in the same composer: `@latest` (follow HEAD), `@v1`/`@v2`/… (pin to that revision node), and named releases as `@release:<name>`. These are *not* free-text tags — they are derived from the graph and rendered as selectable facets. So composing a group is always "tags + version tag": e.g. `@sanity @module:billing @v2`. Selecting `@latest` = follow-HEAD (content drift will notify); selecting `@v2`/`@release:*` = pinned (reproducible, no drift). This keeps the entire mental model tag-based while the graph guarantees correctness underneath.

**The user's exact scenario, resolved.** Plan → Suite of 10 cases, also used by a Run. Days later the 10 cases are edited (→ v2) and 3 new cases gain the tag (→ 13 matches):
- The **3 new matches** raise *membership drift* on the suite → user picks add / create-new-suite / dismiss.
- The **10 edited cases** raise *content drift* on the suite → user picks update-to-v2 / keep-v1 / fork-a-new-version.
- If the user accepts, the **Suite** bumps v1→v2 (its accepted `{case,rev}` set changed). The **Plan** does *not* auto-bump; it shows its own drift ("suite is now v2 — adopt?") and bumps only if the user adopts. Nothing cascades unasked.
- Any **Run** already executed stays exactly as it ran (its own frozen `{case,rev}`). Running the new set = a **new run**.
- The suite **keeps its name** ("Sanity Suite") across versions — *name is a stable label on the lineage; version is the separate `@vN` facet.* You never rename to express a version.

**Applies to Plans, Suites, and Runs uniformly** (user: "everywhere — plans, suites, runs"): same `definition`/`accepted` model, same drift notification, same three-way choice; Runs additionally get the immutable-execution rule above.

**Requirement — run an OLDER version in one place while the rest stay on the latest (2026-07-31).** Scenario: a case has advanced across releases to **v9**; the Suite, Plan, and Run all currently hold it at v9. The user now wants **this Run to execute v2 of that case again** (e.g. reproduce an old defect / verify a regression), without disturbing anyone else.

This works because **the version pin is per-container AND per-case — pins are independent, never shared.** The `accepted` set is `[{caseId, revisionNo}]` *on each container separately*. So:
- In the Run's composer, that one case's version facet is switched from `@latest`/`@v9` to **`@v2`** → the Run's `accepted` entry becomes `{caseId, revisionNo:2}`. Every *other* case in the Run stays at whatever it was.
- The **Suite and Plan are untouched** — they still pin v9. The **case's HEAD is untouched** — still v9. Only this Run points at the v2 node.
- Because revision nodes are **immutable and never deleted** (down to n−99), v2 is always reachable and runnable years later.
- On execution, `run_case_results.revision_no = 2` snapshots it, so the report reproducibly records that this run executed v2.
- A single Run may hold **mixed versions** (case A @v9, case B @v2, case C @latest) — each is just its own `{caseId, revisionNo}` pair. No conflict, because nothing is global.

Distinction: **pinning a run to v2** (above) only affects that run's execution. If instead the user wants v2 to become current *everywhere*, that is a **Restore** (§C.3) — appends a new HEAD node (v10 = copy of v2) on the case lineage, which then surfaces as content drift on its containers. Two different intents, two different actions: *pin* = "run the old one here, once"; *restore* = "make the old one current again."

#### C.8 Versioning is uniform across ALL FOUR entity types (2026-07-31)

The versioning concept is **not** case-only — every entity is versioned, each with a `@vN` graph, a History timeline, diff, and restore. What *counts as a versioned change* differs by whether the entity is a **leaf** (owns content) or a **container** (owns composition), but the surface (History tab, `@vN` tag facet, restore) is identical everywhere:

| Entity | Kind | A new version (`@vN`) is minted when… | Restore means | Runs it? |
|---|---|---|---|---|
| **Case** | leaf (+ its **Script** is a parallel leaf) | its content changes — title/preconditions/steps (script: its code) | HEAD becomes a copy of the chosen old node | — |
| **Suite** | container | its accepted set of `{case, version}` changes (add/remove a case, or re-pin a case to a different `@vN`) | the suite's membership+pins revert to the chosen old node's set | — |
| **Plan** | container | its accepted set of `{suite/case/run, version}` changes | the plan's composition reverts to the chosen old node's set | — |
| **Run** | execution record | *(immutable — never re-versioned)* each execution is a new frozen record of `{case, version}` + results | n/a — you create a **new run**, old ones are permanent | executes its accepted set (Option A) |

Invariants restated for all four: **append-only / immutable / non-destructive** (nothing ever overwritten or deleted; restore = a new node); **automatic** (a node is minted on the qualifying change, no manual v-labeling); **no downward cascade** (a container version bump never rewrites its children); **upward only by opt-in** (child drift is accepted via the D6 notification). Version is always surfaced as the `@vN`/`@latest`/`@release:*` tag facet (§C.7), so the entire four-entity model stays inside the tag world.

#### C.9 Version identity — how a version is stored, numbered, and shown (decision, 2026-07-31)

**Do not choose one representation — use three layers, each doing one job.** Version-in-the-title is rejected outright; a hand-typed `v2` free tag is rejected as a source of truth.

| Layer | Representation | Role |
|---|---|---|
| **Truth (storage)** | **immutable revision ID** per node (`case_revisions.revision_id`, Git-SHA-like) | never reused, survives renames; **this is what containers pin to** |
| **Human number** | **monotonic `revision_no`** per lineage (1,2,3…), system-incremented | what people read/say ("v2"); derived, never hand-typed |
| **Selection (UX)** | **`@vN` / `@latest` / `@release:*` tag facet**, computed from `revision_no` | keeps the whole model in the tag world; cannot be typo'd or faked |

Rules:
- **Containers pin to the immutable revision ID, never to the `@vN` string.** The `accepted` set stores the stable id (with `revision_no` alongside for display). Rename/relabel can never break a pin; `@v2` always resolves to the exact same immutable content. *(This refines §9.1/§C.7 where the pin was written as `revisionNo` for brevity — the stored anchor is the immutable `revision_id`; `revision_no` is display only.)*
- **Version is NEVER encoded in the title/name.** Title = stable lineage label; version is the orthogonal `@vN` facet. Renaming never changes a version; a new version never renames.
- **`@vN` is derived, not stored as a free tag** — rendered from `revision_no`, so it is always correct and unambiguous (no two nodes can claim the same `@vN`).
- **Named releases** (`@release:<name>`) are optional human-friendly pointers over the same graph for milestones, when "v9" is less meaningful than "the Q1 release."
- Mirrors Git exactly: SHA = truth, `v2.0` tag = friendly name, version never in the filename. The schema already carries the bones (`revision_id` + `revision_no`, `schema.sql:1203-1223`).

---

## 10. Complete refactoring strategy
Additive-first, flag-gated, reversible. New columns/tables are `IF NOT EXISTS`/nullable; existing readers untouched. Folders demoted behind `TAG_NATIVE_ORG`, not dropped. Manual runner behind `MANUAL_RUNNER_V1`. Versioning reuses existing `CASE_VERSIONING`. No API removed; only extended. Every phase ends with lint + tests + backend restart before "works live" claims (per `CLAUDE.md`).

---

## 11–14. Files to change (with reason + risk)

### Part A — Tag-native org
| File | Change | Why | Risk |
|---|---|---|---|
| `server/db/schema.sql` | `tags.kind`; `definition JSONB` on suites/plans/runs; folder→tag backfill; make `folder_id` optional (drop NOT-NULL intent at app layer) | facets + query composition + migration | **Med** (schema, must stay idempotent + update `scripts/setup-db.bat`) |
| `server/features/resources/routes.ts` | remove/relax `requireRepositoryFolder`; teach `filterListByQuery` to be tag-first; resolve `definition.tagQuery` for dynamic membership | de-mandate folders; dynamic suites | **Med** |
| `server/features/tags/routes.ts` | add `kind`; stop managing color (D2) | facets; remove color mgmt | Low |
| `src/lib/entityLinking.ts` | `buildListQuery` tag-first; saved tag-query type | compose by tag | Low |
| `src/components/EntityLinker.tsx` | tag-query builder (all/any/not) + static-vs-dynamic toggle | core compose UX | **Med** |
| `src/pages/TestRepository.tsx` | folder tree → tag/facet explorer | primary nav shift | **Med** |
| `src/components/FolderSelect.tsx`, `FolderBadge.tsx` | hide behind flag | folder demotion | Low |
| `src/components/TagManagerModal.tsx`, `TagEditor.tsx` | remove color swatches; auto-color; facet grouping | remove color tags | Low |
| `src/pages/TestCases/TestSuites/TestPlans/TestRuns.tsx` | tag filters primary; folder optional | 4 pages | **Med** |

### Part B — Manual runner
| File | Change | Why | Risk |
|---|---|---|---|
| `server/db/schema.sql` | `runs.mode`; new `run_case_results` table | result store | **Med** |
| `server/features/resources/routes.ts` | manual create seeding + result/bulk/attachment/bug endpoints; roll-up | execution model | **High** (largest new surface) |
| `core/shared/runEvidence.ts` | also walk `run_case_results` | manual evidence in gallery/ZIP | Low |
| `src/pages/TestRuns.tsx` | mode-aware detail; points list; bulk toolbar | runner shell | **High** |
| `src/components/ManualStepRunner.tsx` (new), `OutcomeSelect.tsx` (new), `RunSummaryPanel.tsx` (new) | step grid + outcome + summary | runner UI | **Med** |
| `src/lib/manualTestRun.ts` | roll-up + result client helpers | progress/state | Low |

### Part C — Git-like version graph
| File | Change | Why | Risk |
|---|---|---|---|
| `server/db/schema.sql` | `scripts.current_revision` + `script_revisions` table; `case_pins JSONB` on suites/runs | script version graph + revision-pinned membership | **Med** |
| `server/db/repository.ts` | mint revision node on content-change in `Cases.upsert` + script save; restore = append rollback node | the write choke point (§C.3) | **Med** |
| `server/features/resources/routes.ts` | revisions list / diff / restore endpoints (cases + scripts); release snapshot; write `case_pins`; seed `run_case_results.revision_no` | history + restore + reproducible sets | **Med** |
| `src/pages/TestCases.tsx` + new `VersionHistoryPanel.tsx` | Git-graph timeline, diff viewer, "Restore this version" | the graph the user asked to see | **Med** |
| `src/components/EntityLinker.tsx` | follow-latest vs pin-to-version toggle; show pinned revision | pick which version a suite/run runs | Low |

---

## 15. Backward compatibility
- All new columns/tables additive + nullable; existing `runs.steps`/`case_ids` readers unaffected.
- Automated execution path untouched. `mode` defaults preserve current behavior for existing rows.
- Folder paths backfilled into tags before UI removal, so no organizational data is lost. The unused `folders`/`folder_id` columns stay in the DB during the cutover release (dropped in a later tiny plan) → zero-risk cutover; if `TAG_NATIVE_ORG` is flipped off mid-cutover, folder reads still resolve.
- `case_pins` is read-preferred but optional; absence = today's id-array behavior. Version graph is inert unless `CASE_VERSIONING` is on.

## 16. Migration strategy
1. Ship schema additively (idempotent; update `scripts/setup-db.bat`).
2. Backfill folder path → tags (idempotent, one-time).
3. Enable `MANUAL_RUNNER_V1` (independent of org change).
4. Enable `TAG_NATIVE_ORG` (hides folder UI; tags primary).
5. Later plan: drop `folders`/`folder_id` once adoption confirmed.

## 17. Testing strategy
- Unit: tag-query resolver (all/any/not, facets), version-tag→revision resolver, outcome roll-up, manual-create seeding, bulk outcome.
- API: manual result/bulk/attachment/bug endpoints; dynamic vs static suite resolution; folder-optional create.
- E2E (Playwright, `.testflow-pw/`): create manual run → set step outcomes + upload screenshot → per-case + run roll-up → create bug; compose `sanity`+`v1` suite → verify frozen revisions.
- Regression: automated execute path unchanged; existing folder-filtered lists still work with `folder_id` present.

## 18. Rollback strategy
- Per-part flags off → code inert. Folder columns retained (unused) through the cutover release → org rollback is a flag flip back to folder reads. New tables unused when flags off. Version graph non-destructive by construction (restore = append). No destructive migration until a separate, later "drop folders/color columns" plan.

## 19. Estimated effort
- Part A: ~2 phases (schema/backend; UI). Part B: ~2 phases (backend result model + endpoints; UI). Part C: ~1 phase. Total ~5 phases, each ≤10–15 files per `CLAUDE.md` scope cap.

## 20. Recommended implementation order (phase checklist)

- [ ] **Phase B1 — Manual result model + endpoints** (backend). Files: `schema.sql` (`runs.mode`, `run_case_results`), `resources/routes.ts` (seed + result/bulk/attachment/bug), `runEvidence.ts`, `setup-db.bat`. Risk: High. *Ships value independent of org change.*
- [ ] **Phase B2 — Manual runner UI.** Files: `TestRuns.tsx`, `ManualStepRunner.tsx`, `OutcomeSelect.tsx`, `RunSummaryPanel.tsx`, `manualTestRun.ts`. Risk: High.
- [ ] **Phase A1 — Tag-query composition engine + review-gate (backend).** The core gap: `definition.tagQuery` is stored today but **never resolved**. Build the resolver + accepted-set + new-match detection. Files: `schema.sql` (`tags.kind`, `definition` with `tagQuery`/`accepted`), `resources/routes.ts` (resolve `tagQuery` → candidate cases via `buildListQuery`; compute "new matches not in `accepted`"; endpoints to accept-into-group / create-new-from-matches / dismiss; execution reads `accepted` only = Option A; relax folder gate), `tags/routes.ts`, `entityLinking.ts` (shared query type + resolver client). Risk: Med.
- [ ] **Phase A2 — Single tag-query composer + review notification (UI) + remove color.** Rework `EntityLinker` into the one composer (tag search from live catalog → matched-case preview → select → create) and REMOVE the scattered Link-Individual-Cases/Suites/Runs controls in the 4 pages. Add the notification dot + three-way choice (add / create-new / dismiss). Files: `EntityLinker.tsx`, new `TagQueryComposer.tsx` + `NewMatchesBanner.tsx`, `TestRepository.tsx` (tag/facet explorer), `TagManagerModal/TagEditor` (drop color), `TestCases/TestSuites/TestPlans/TestRuns.tsx`. Risk: Med.
- [ ] **Phase C1 — Version graph write path + API.** Files: `schema.sql` (`script_revisions`, `case_pins`), `repository.ts` (mint node on change; restore), `resources/routes.ts` (revisions list/diff/restore for cases + scripts; release snapshot; `case_pins` + `run_case_results.revision_no`). Risk: Med.
- [ ] **Phase C2 — Version graph UI.** Files: `VersionHistoryPanel.tsx` (new — git-graph timeline + diff + restore), `TestCases.tsx`, `EntityLinker.tsx` (pin-to-version). Risk: Med.
- [ ] **Phase F — Folder removal.** Backfill folder paths → tags, delete folder UI, flip `TAG_NATIVE_ORG`; a later tiny plan physically drops the now-unused `folders`/`folder_id`/`tags.color` columns. Risk: Med.

---

## 21. Decisions — RESOLVED (2026-07-30)

- **D1 — Folders → REMOVED.** No attachment to folders; relabel purely on tags. Remove the folder gate + UI, backfill folder paths into tags, leave the unused `folders`/`folder_id` columns in place only during the cutover release, then drop them in a small follow-up. (§9.1)
- **D2 — Color → REMOVED ENTIRELY.** No color on tags at all — no swatches, no auto-color. Monochrome chips using theme tokens; stop reading/writing `tags.color`. (§9.1)
- **D3 — Versioning → GIT-LIKE GRAPH, automatic.** No manual v1/v2 labeling. Every content change auto-mints an immutable revision node with a parent link; users see the history graph and restore any prior version (n−1 … n−99) via Git-revert semantics (append, never destroy). Applies to **cases and scripts**. A named "release" is an *optional* git-tag-style pointer over the graph. (§9.3)
- **D4 — Composition → SINGLE tag-query composer with mandatory preview (refined 2026-07-31).** One reusable composer everywhere: pick/search an existing tag → preview matched cases → select → create the suite/run/plan. It REPLACES the old Link-Individual-Cases / Link-Suites / Link-Runs controls entirely (not kept as fallback). "Feature" is not a separate entity — it is just a tag (the agent already auto-creates the tag family, e.g. `login` → `@login`/`@ui`/`@regression`). (§9.1)
- **D6 — Membership → DYNAMIC but REVIEW-GATED, with three-way notification (new 2026-07-31).** Groups store `tagQuery` + an explicit reviewed `accepted` set. New cases that later match the query are NOT auto-added; they raise a notification dot offering: (a) add to this group, (b) create a new group from the new matches, (c) dismiss. **Execution = Option A:** a run/suite/plan only ever executes its `accepted` set; unreviewed matches never run. (§9.1)
- **D5 — Configurations → DE-SCOPED.** End users won't hand-configure a config matrix. Drop it for v1: `run_case_results.configuration` is an optional free-text/environment label only, never required. "What changed" is answered by the version graph, not configurations. (§9.2)

### Remaining confirmations (small)
- **Scripts versioning** — confirmed in scope (user: "same case, same script, something different in v2") → `script_revisions` added (§C.2). Flag: reuse `CASE_VERSIONING` or a sibling `SCRIPT_VERSIONING`? *Recommend one shared flag.*

---

*Per `CLAUDE.md`, this is Phase 0 (analysis only). No files were modified. On a later turn, tell me which part/phase to implement first (recommended: **Phase B1**, since the manual runner is independently valuable and unblocked), and I'll implement one phase at a time with lint + tests + backend restart before reporting.*
