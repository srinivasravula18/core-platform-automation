# Automation Data — Scalable Test-Data Management Redesign (Phase 0)

**Status:** Analysis only. No code changed. Awaiting explicit approval on a later turn before implementation.
**Author role:** Principal QA Architect + Staff Engineer (per `CLAUDE.md` architecture-change process).
**Supersedes/extends:** `docs/plans/test-data-freshness-architecture-plan.md` (World-2 engine, already built) and `docs/plans/record-play-local-agent-architecture-plan.md` (the desktop-agent substrate). This plan **reuses** that engine, does not rebuild it.

---

## 1. Executive Summary

The panel's objections are all symptoms of one root cause: **the test-data machinery lives in a world your test cases can't reach.** There are two disconnected subsystems:

- **World 1 — Authoring:** `cases → scripts` (generated Playwright in `scripts.code`). Field values are synthesized inline at compile time by `server/features/agent/testdata/*` — **no dataset, no run token, no ledger, no rerun policy, no teardown.**
- **World 2 — Record & Play:** `recordings → steps → data_mappings → datasets → batches → jobs → run_data ledger`. This world has the *entire* mature freshness engine: per-run `run_token`, `{{unique.*}}`/`{{faker.*}}` generators, a `fixed|unique|reference` intent gate, a pre-dispatch ledger, `fresh|ephemeral|pooled` policies, and ephemeral teardown.

The Automation Data screen (`src/pages/automation/DataBindings.tsx`) is welded to World 2: its only "what to run" selector is a **recording**. So the panel asks "where do I select **cases**?" — and the honest answer is *you can't, because cases don't have datasets*. Every other complaint follows:

- **"No case selection"** → the engine keys off `recordingId`, never `caseId`/`scriptId`.
- **"Doesn't scale to many/large scripts"** → one-recording-at-a-time, flat unsearchable `<select>` dropdowns, unvirtualized field lists, `limit=50` data preview, per-script dataset duplication.
- **"I don't want curly braces"** → dragging a column inserts the **raw string `{{ColumnName}}`** into the field; variables **append** raw `{{unique.email}}` text. The syntax is exposed and typed, not rendered as a token.
- **"Auto-populate / manual not working"** → auto-map fires N sequential PUTs that abort mid-way on any error (non-atomic, partial binds); manual entry opens a modal that creates a *separate* dataset, competing with a second per-field "fixed value" model.
- **"Reruns fail against the server"** → the correct fix (unique-at-generation) is *built* but only reachable from recordings, is namespaced on a weak 3-byte token, tags nothing for cleanup, and never verifies `reference` data exists.

**The redesign, in one line:** unify both worlds onto a **Script/Runnable** the data engine binds to; make data binding a **first-class chip** (never raw `{{}}`); introduce **reusable Data Profiles** so hundreds of scripts share one data strategy; and **complete the lifecycle** (run-token record-tagging + janitor, backdoor seeding, reference verification, pool checkout) so reruns are collision-proof *by construction* — the industry-canonical answer.

---

## 2. Existing Architecture (verified, code-cited)

**Frontend** — `src/pages/automation/DataBindings.tsx` (586 lines) is the whole feature. Three flat `<select>`s (`:361-363`): recording / dataset / agent. Left "Recorded fields" list from `GET /api/automation/recordings/:id/steps`; right "Variables" palette (`VARIABLE_GROUPS`, `:6-32`) of draggable `{{token}}` chips; dataset preview capped at `limit=50` (`:121`). Drag a column → `mapColumn` → `PUT .../mappings/:stepId` stores `expression = {{colName}}` (`routes.ts:369`). Drag a variable → `appendToken` appends raw `{{…}}` text. Contrast: `Schedules.tsx:152` *does* pick Test-Repository **scripts** with a folder tree + search — proof the pattern exists in-repo.

**Backend** — `server/features/automation/`:
- Data model (`schema.sql:816-993`): `recordings`, `automation_recording_steps`, `automation_step_overrides`, `automation_datasets` (+`automation_dataset_rows`), `automation_data_mappings` (step↔column, `UNIQUE(step_id)`, `intent`), `automation_execution_batches` (`run_token`, `data_policy`, `stop_on_failure`), `automation_run_data` (per-(batch,row,field) ledger, partial unique index on `intent='unique'`).
- Engine: `variableEngine.ts` (`resolveExpression`/`resolveSource`/generators; columns win over generators, `:176`), `scriptMaterializer.ts` (TS-parses the script, substitutes per-row, snapshots into `job.materialized_script`), `teardownService.ts` (ephemeral HTTP-hook teardown), `templateService.ts` (Excel template + intent inference), `jobService.ts` (result gate / stop-on-failure).
- Intent gate (`routes.ts:162-168`): 400 if `unique` field lacks a generator, or `reference` field has one.

**Authoring world** — `cases → scripts` (`scripts.case_id`, `scripts.code`), values synthesized by `server/features/agent/testdata/*` at compile time (`playwrightCompiler.ts:11,140-141`). No FK links a `recording` to a `case`, or a `script` to a `recording`.

## 3. Dependency Graph

```
                         DataBindings.tsx  (the one screen — keyed off recordingId)
                                │
         ┌──────────────────────┼───────────────────────────┐
         ▼                      ▼                             ▼
 GET /recordings         GET /datasets                GET /agents
         │                      │
         ▼                      ▼
 recordings ── steps ── data_mappings ── datasets/rows ── batches ── jobs ── run_data
     (World 2 engine: variableEngine · scriptMaterializer · jobService · teardownService)

 WORLD 1 (disconnected):  cases ── scripts(.code) ── agent/testdata/*  (own synth, no engine)
                             └── runs · defects · requirements
```
Blast radius is contained: the bridge (Phase 1) adds a `script_id` path into the *same* engine; nothing in the World-2 resolver changes.

## 4. Runtime Flow (current data-driven run)

`POST /recordings/:id/batches` → intent gate → mint `run_token` (3-byte hex) → `createScriptMaterializer(recording.script, steps, mappings, columns, runToken)` → per selected row: resolve every mapping (`{{col}}`→value, generators embed `runToken`+`rowSeq`) → write ledger row → freeze `materialized_script` into a job → dispatch to desktop agent. Replay is deterministic (values snapshotted). **Cases/scripts cannot enter this flow at all.**

## 5. Evidence / Data Flow

Dataset rows (`values` keyed by `col_N`) + mappings (`expression`+`intent`) → `RowContext{columns,values,runToken,rowSeq}` → resolved value → **both** the materialized script **and** the `automation_run_data` ledger (written pre-dispatch, so "we know what we created" even if the run dies). Nothing is tagged onto the *created SUT record* for later cleanup — the ledger knows values, the SUT doesn't know the run.

## 6. Context Flow

Scope (`owner_id`/`project_id`/`app_id`) is stamped on datasets/mappings/batches and enforced on every route. A Data Profile (new) will carry the same scope so profiles are shareable within a project.

## 7. Prompt Flow

Not applicable to persistence, but relevant to authoring: the agent compiler (`agent/testdata/*`) chooses field values with no knowledge of the World-2 engine. Phase 1 lets the compiler emit **engine-native tokens** (`{{unique.email}}`) instead of frozen literals, so agent-authored scripts inherit freshness.

## 8. Current Problems

| # | Problem | Evidence | Severity |
|---|---|---|---|
| P1 | Cannot data-drive **cases/scripts** — engine is recording-only | `DataBindings.tsx:361`, batches under `/recordings/:id/*` | **Critical** |
| P2 | Raw `{{}}` exposed/typed; drag inserts literal text | `routes.ts:369`, `appendToken` | High (panel blocker) |
| P3 | Auto-map non-atomic (N PUTs, abort mid-way) | `DataBindings.tsx:302-308` | High |
| P4 | Manual entry = separate dataset; two "type a value" models | `saveManual` vs `saveOverride` | High |
| P5 | Doesn't scale: flat `<select>`, unvirtualized fields, `limit=50` preview, per-script dataset dup | `:361-363, :387, :121` | **Critical** |
| P6 | No reusable data strategy across scripts | no Data Profile concept | High (scale) |
| P7 | `fresh` accumulates data forever; teardown opt-in hook only | `teardownService.ts:28` | High |
| P8 | `reference` intent unverified against SUT | gate only checks "not a generator" | High |
| P9 | Uniqueness = 3-byte token, intra-batch only, untagged | `variableEngine.ts:29` | Medium |
| P10 | No setup/seed (backdoor) phase for prerequisites | none | Medium |
| P11 | `pooled` exhaustion terminal (no replenish) | `select`/`markConsumed` | Medium |
| P12 | Two worlds compute freshness differently (drift) | `agent/testdata/*` vs `variableEngine` | Medium |

## 9. Root Cause Analysis

The feature was built **inside** the Record & Play silo, where "the thing you run" is a recording. Test cases and generated scripts live in a different silo with their own value synthesis. Nobody bridged them, so the mature data engine is unreachable from the primary artifact users care about (cases). The UI then inherited the silo's assumptions (one recording, flat lists) and leaked its implementation detail (`{{}}`) straight into the field editor. The fix is architectural: **make the engine bind to a generic Runnable (a Script), lift binding into a structural chip, and add the lifecycle pieces the research shows are non-negotiable** — not a reskin.

## 10. Proposed Architecture

### 10.1 One runnable, one engine (bridge the two worlds) — P1, P12
Introduce a **Runnable** = anything with an executable Playwright body and derivable editable steps:
- a **Script** (`scripts.code`, agent-authored from a case), or
- a **Recording** (`recordings.script`, captured).

Generalize `scriptMaterializer` (already TS-parses a script string) and the steps/mappings/batches tables to key off a **`runnable_ref = {kind:'script'|'recording', id}`** instead of `recording_id` only. Add nullable `script_id` alongside the existing `recording_id` on `automation_recording_steps`/`_data_mappings`/`_execution_batches` (additive, back-compatible). Now a **case's script is data-drivable through the exact same engine.**

### 10.2 Bindings as first-class chips (never raw `{{}}`) — P2, P3, P4
A binding is already structural (`data_mappings` has `column_id`, `expression`, `intent`). The redesign makes the **UI** honor that:
- Dragging a column/variable onto a field inserts a **chip object** `{source, ref, transform}`, rendered inline as a labeled pill (e.g. `⟨Email · unique⟩`), **never** the string `{{…}}`.
- The `expression` is *serialized from* the chips under the hood (round-trips to the same engine syntax).
- **Auto-populate** becomes one atomic `PUT /runnables/:id/mappings` (bulk, transactional) with a review step — no partial binds.
- **Manual entry** edits the *same* binding model inline (a "Fixed value" chip), eliminating the separate-dataset fork. One mental model: every field holds zero or more chips.

### 10.3 Reusable Data Profiles (the scale answer) — P5, P6
A **Data Profile** is a named, scoped, reusable set of **column → strategy**:
`static | dataset-column | faker(type) | unique(pattern) | uuid | timestamp | sequence | extract(step) | pool-checkout(pool)`.
Bind **many scripts to one profile** instead of duplicating a dataset per script. This is precisely how mabl DataTables / Katalon variable-binding / UFT data tables scale to hundreds of tests. Profiles are searchable, taggable, versioned. A script's field chips reference *profile columns*, so re-pointing a whole suite to a new environment's data is one profile swap.

### 10.4 Scale the UI — P5
- Replace the three flat `<select>`s with **searchable, folder-grouped pickers** (reuse the `Schedules.tsx` script tree). Primary selector becomes **Test Case / Script** (multi-select to data-drive a *set*).
- **Virtualize** the fields list and dataset preview; **paginate** rows (already `?offset&limit` on the API — wire it).
- Responsive CSS-grid `minmax()` split (already speced in the freshness plan §14) that collapses to stacked tap-to-assign under 900px.

### 10.5 Complete the lifecycle (collision-proof by construction) — P7-P11
Per the research, uniqueness-at-generation is primary; cleanup is the safety net. Additions on top of the built engine:
1. **Strengthen the run token** to a UUID and **tag every created SUT record** with it where the flow allows (hidden field / metadata / naming convention), so orphans are reap-able. (P9)
2. **Out-of-band janitor**: a scheduled sweep that deletes anything tagged with an expired `run_token` — a crashed `fresh` run can never poison the environment. (P7)
3. **Backdoor seeding (setup phase)**: compile a Playwright **setup step** that provisions `reference` prerequisites and logs in via `APIRequestContext` → `storageState`, so the UI script only exercises its subject. (P10)
4. **Reference verification**: `reference` intent does a live existence lookup (API/DB) pre-flight; fail fast with a clear message instead of a mid-run UI error. (P8)
5. **Pool checkout with lock + replenish**: lease-a-row with a lock so parallel runs don't collide; auto-reset/replenish policy instead of terminal exhaustion. (P11)

### 10.6 Target model (data)
```
DataProfile(id, name, scope, columns[{name, strategy, config}], version)
   ▲ referenced by
Binding(runnable_ref, field_ref, source={profileColumn|variable|fixed}, transform, intent)
Batch(runnable_ref, profile_id|dataset_id, run_token:uuid, data_policy, selection, setup_ref?, teardown_ref?)
   └─ Job(row) → run_data ledger (+ created_record_tags for the janitor)
```

## 11. Refactoring Strategy (phase-by-phase, each independently shippable)

- **Phase 1 — Runnable bridge + case/script selection.** Generalize `scriptMaterializer` + steps/mappings/batches to accept `script_id`; add a `POST /runnables/:kind/:id/steps|mappings|batches` surface (thin alias over existing helpers); UI: add a Test-Case/Script picker (folder tree + search) as the primary selector. Closes P1, starts P5/P12.
- **Phase 2 — Chip binding UX + fix auto/manual + scale UI.** Chip model + renderer; atomic bulk mapping; inline manual chips; virtualization + pagination + searchable pickers. Closes P2, P3, P4, P5.
- **Phase 3 — Data Profiles.** Profile CRUD + column strategies; bind scripts to profiles; profile-aware resolution (extend `variableEngine` source precedence). Closes P6, deepens P5.
- **Phase 4 — Lifecycle hardening.** UUID run-token + record tagging; janitor sweep; backdoor setup phase; reference verification; pool checkout+lock+replenish. Closes P7-P11.

## 12-14. Files to change · why · risk (by phase)

**Phase 1** (bridge): `schema.sql` (nullable `script_id` on steps/mappings/batches + `runnable_kind`) — *Med*; `scriptMaterializer.ts` (accept any script source) — *Med*; `automation/routes.ts` + `recordingService`/`datasetService` (runnable-keyed aliases) — *Med*; `src/pages/automation/DataBindings.tsx` (case/script picker) — *Med*; a `runnableService.ts` (new, resolves script-vs-recording) — *Low*. ~7 files.

**Phase 2** (UX): `DataBindings.tsx` (chip model/renderer, virtualization, pagination) — *High*; new `FieldChip.tsx` / `DataPalette.tsx` / `EntityPicker.tsx` components — *Low*; `routes.ts` (bulk atomic `PUT mappings`) — *Low*; small `variableEngine` serializer helpers — *Low*. ~8 files.

**Phase 3** (profiles): `schema.sql` (`automation_data_profiles` + `_profile_columns`) — *Med*; `dataProfileService.ts` (new) — *Med*; `routes.ts` (profile CRUD) — *Low*; `variableEngine.ts` (profile source) — *Med*; `DataBindings.tsx` + `ProfileEditor.tsx` — *Med*. ~6 files.

**Phase 4** (lifecycle): `variableEngine.ts` (uuid token) — *Low*; `jobService.ts`/new `janitorService.ts` + a scheduled sweep — *Med*; `setupService.ts` (backdoor seed) — *Med*; `referenceService.ts` (existence lookup) — *Med*; `schema.sql` (`created_record_tags`, pool lock cols) — *Med*. ~7 files.

Every phase ≤ the 10-15-file / one-subsystem cap.

## 15. Backward Compatibility
Additive columns with defaults (`runnable_kind='recording'`, nullable `script_id`, `data_policy='fresh'`), so existing recordings/datasets/batches keep working unchanged. `run_token` widening is forward-only. World-1 `agent/testdata` stays until Phase 3 lets the compiler emit engine tokens; both can coexist behind a flag.

## 16. Migration Strategy
Ship behind **`AUTOMATION_DATA_V2`** (default OFF): the new runnable/chip/profile/lifecycle paths are dark until validated. Existing recording-based flows are untouched with the flag off. Backfill: none required (additive). When enabling, existing recordings appear as one kind of Runnable; existing datasets are importable as a "dataset-column" Data Profile.

## 17. Testing Strategy
- Unit: chip↔expression serialization round-trip; runnable resolution (script vs recording); profile column strategy resolution; reference-verify + pool-lease logic; janitor tag-matching.
- Integration: data-drive a **case's script** end-to-end (the P1 proof); atomic auto-map (no partial binds); rerun the same batch twice against a stateful SUT → **both pass** (the collision proof); pool exhaustion → replenish.
- UI (Playwright MCP): case picker + chip drag/insert (assert **no `{{` visible** in the field), pagination, manual inline chips.
- Regression: existing recording batches unchanged; `npm run lint`; restart backend before any live claim (no hot reload).

## 18. Rollback Strategy
`AUTOMATION_DATA_V2=OFF` instantly reverts to today's recording-only flow. New tables/columns are additive and inert when the flag is off. Per-phase revert = drop that phase's new files + flag branch.

## 19. Estimated Effort
| Phase | Scope | Est. |
|---|---|---|
| 1 Runnable bridge + case selection | ~7 files | 3-4 days |
| 2 Chip UX + auto/manual + scale | ~8 files | 4-5 days |
| 3 Data Profiles | ~6 files | 3-4 days |
| 4 Lifecycle hardening (janitor/seed/reference/pool) | ~7 files | 4-5 days |

## 20. Recommended Implementation Order (checklist)
- [ ] **Phase 1 — Bridge cases/scripts into the engine + case picker.** *Risk: Med.* Deliverable: a Test Case's script can be data-driven and run; the "where are my cases?" gap is closed.
- [ ] **Phase 2 — Chip binding + fixed auto/manual + scalable UI.** *Risk: High (UI).* Deliverable: no raw `{{}}` anywhere; drag inserts a token/chip; auto-populate atomic; manual inline; searchable/virtualized/paginated.
- [ ] **Phase 3 — Reusable Data Profiles.** *Risk: Med.* Deliverable: one data strategy bound to many scripts; scale to hundreds without duplication.
- [ ] **Phase 4 — Lifecycle hardening.** *Risk: Med.* Deliverable: UUID run-token + record tagging + janitor, backdoor seeding, reference verification, pool checkout — reruns collision-proof by construction.

---

## Target UX (ASCII mockup — Phase 1-2)

```
 Automation Data                                        [ Import data ▾ ]  [ Run ▸ ]
 ┌──────────────────────────┬───────────────────────────────┬────────────────────┐
 │ RUN WHAT  (search…)      │ FIELDS OF “Create Customer”   │ DATA                │
 │ ▸ 📁 Smoke               │  Full name   ⟨Faker · name⟩ ✕ │ Profile: [Signups ▾]│
 │   ▾ 📁 Onboarding        │  Email       ⟨Email · unique⟩✕│  ─ columns ─        │
 │     ☑ Create Customer TC │  Company     ⟨Company col⟩   ✕│  ⟨Email⟩  ⟨Name⟩    │
 │     ☐ Create Order TC    │  Plan        [ drop here ▾ ]   │  ⟨Company⟩ ⟨Plan⟩   │
 │   ▸ 📁 Regression        │  Phone       ⟨+1 fixed⟩      ✕ │  ─ variables ─      │
 │ (recordings appear here  │                               │  ⟨unique.email⟩     │
 │  too, as one kind)       │  [ Auto-map ]  [ Manual grid ]│  ⟨faker.name⟩ …     │
 ├──────────────────────────┴───────────────────────────────┴────────────────────┤
 │ Rows 1–50 of 12,340   ◀ ▶     Policy: (●fresh ○ephemeral ○pooled)   ☑ stop-on-fail│
 │ [✓] preview:  Email → qa+7f3a-1@example.test   (fresh each run)                  │
 └─────────────────────────────────────────────────────────────────────────────────┘
```
Chips carry `{source, column, transform, intent}`; users pick or drag — the `{{…}}` is generated, never shown or typed.

## Open decisions for approval (state a preference; Phase 1 can start without them)
1. **Primary artifact:** make **Test Case / Script** the primary runnable and treat recordings as one kind under it (recommended), or keep recordings separate and only *add* case support?
2. **Record tagging (Phase 4):** is it acceptable to have generated create-flows stamp a hidden `run_token` field / naming convention on SUT records so the janitor can reap orphans? (Needs a small convention the SUT tolerates.)
3. **Backdoor seeding:** may the setup phase call the SUT's API directly (fastest, most reliable per research), or must all provisioning go through the UI?

**No implementation begins until you approve on a later turn.** On approval I'll execute **Phase 1 only**, validate (lint + tests + backend restart + a live "data-drive a case" check), and report before Phase 2.
