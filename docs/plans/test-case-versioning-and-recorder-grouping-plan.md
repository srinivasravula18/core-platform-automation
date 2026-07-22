# Test Case Versioning + Recorder Step-Grouping — Architecture Plan (Phase 0)

Status: **ANALYSIS ONLY — no code changed.** Awaiting explicit approval before implementation.
Date: 2026-07-22
Scope: two independent-but-related subsystems that both touch the case/step model.

- **Part A** — Version test cases as the product evolves over releases (login v1 id+pw → v2 + forgot-password → v3 + SSO providers → …).
- **Part B** — Stop the recorder from turning 200–300+ raw UI interactions into 200–300 flat steps.

Everything below is grounded in the actual current code (file:line). Industry references are cited at the end.

---

## PART A — TEST CASE VERSIONING

### A0. Executive summary

The instinct "the login case has a v1, v2, v3, v4" collapses **three different axes** that mature test-management tools (TestRail, Zephyr, Xray, TestCollab, Tricentis) deliberately keep separate. Building one `version` integer conflates them and paints us into a corner. The correct model is three thin layers:

1. **Revision history** — an append-only, immutable history of a *single* case as its wording/steps are edited (fix a typo, add a captcha step). Gives diff + rollback + "who changed what". *(Zephyr / TestCollab model.)*
2. **Release / baseline** — which *set* of cases (and which revision of each) constitutes the test set for product release v1 / v2 / v3. *(TestRail "baselines" model.)*
3. **Execution snapshot** — every run freezes the exact revision it executed, so a historical result is always reproducible. *(TestCollab / Tricentis model.)*

The single most important design decision: **new capability = new test case, not a new version of an old one.** "Forgot password" and "Sign in with Google" are *new cases*, discovered in the v2 and v3 releases. The login case only gets a *new revision* when its own steps change. The v1/v2/v3/v4 the user is picturing is mostly the **Release layer** (which cases are in scope for a release), plus revision history on the individual cases that changed. Getting this right means the login example needs almost no per-case "version number" at all — it needs a release dimension.

### A1. Current architecture (grounded)

- Cases live in one table `cases` — `server/db/schema.sql:69-93` (+ ALTERs `264-272`, `561-574`).
- **Steps are denormalized** into `cases.steps JSONB`, normalized to `{action, expected}` only — `server/shared/testCases.ts:1-8`. There is no step table to diff.
- **No `version` / `revision` / `history` / `snapshot` column exists on `cases`, `scripts`, or runs.** Only temporal columns are `updated_at` (bumped every upsert) and soft-delete `deleted_at`.
- Write path: `Cases.upsert` — `server/db/repository.ts:830-873` (`INSERT … ON CONFLICT (id) DO UPDATE`, serializes steps at `:838`). Main entry `POST /api/agent/save-cases` — `server/features/agent/routes.ts:6584-6655`; manual `POST /api/cases` — `server/features/resources/routes.ts:406-434`.
- Reuse gate (`server/features/agent/caseReuse.ts`) already enforces "one case per behavior, re-link don't duplicate" — the natural ally of this design.
- Traceability precedent: `requirement_case_links` (`schema.sql:545-554`).
- **Versioning precedents already in this codebase to copy, not invent:**
  - `prompts` — numbered versions + `is_active` (`schema.sql:275-286`).
  - `object_repository` — append-only `current JSONB` + `history JSONB` snapshot (`schema.sql:616-628`).
  - `conversation_sessions` — optimistic-concurrency `version BIGINT` (`schema.sql:785-796`).

### A2. Current problems this solves

- No audit trail: an edit silently overwrites the prior case; you cannot see what changed between releases or who changed it.
- No reproducibility: a run result from 3 months ago points at a case row that has since been edited — the evidence no longer matches the case.
- No release scoping: there is no way to say "the v2 regression set" vs "the v3 regression set". Today `test_plan_ids` / `test_suite_ids` are the only grouping and they carry no release semantics or version pinning.
- No safe rollback: a bad AI regeneration destroys the previous good case.

### A3. Proposed architecture — three layers

#### Layer 1 — Revision history (append-only snapshots)

Keep the existing `cases` table **exactly as the mutable HEAD** (zero disruption to every current read path). Add one append-only sibling that captures the prior state on each content change. This is the `object_repository` pattern applied to cases.

```
cases                     (HEAD / current — unchanged shape + one new pointer column)
  id                      lineage id, stable across the case's whole life (TC-XXXX-1)
  current_revision  INT   NEW — bumped only when versioned content changes
  ...all existing columns unchanged...

case_revisions            (NEW — immutable, append-only)
  revision_id       TEXT PK
  case_id           TEXT  FK -> cases.id        (lineage)
  revision_no       INT                          (1,2,3…; unique per case_id)
  parent_revision   TEXT  FK -> case_revisions   (nullable; enables branch/rollback)
  -- frozen snapshot of the VERSIONED content only:
  title             TEXT
  description       TEXT
  preconditions     TEXT
  steps             JSONB
  expected_result   TEXT
  -- provenance:
  change_summary    TEXT                          ("added forgot-password link step")
  change_kind       TEXT                          ('manual' | 'ai' | 'recorded' | 'rollback')
  applies_to_release TEXT                          (nullable release tag, e.g. "v2")
  author            TEXT
  created_at        TIMESTAMPTZ DEFAULT now()
```

Rules:
- Only **versioned content** (title, description, preconditions, steps, expected_result) is snapshotted. Operational fields (status, folder, scope, tags, approval_state) stay only on `cases` and do **not** create revisions — this avoids revision spam on a folder move.
- On `Cases.upsert`, if any versioned field changed vs the current row → append a new `case_revisions` row, bump `cases.current_revision`. If nothing versioned changed → plain update, no revision.
- Rollback = append a new revision whose content is copied from an older one (`change_kind='rollback'`, `parent_revision` = the target). History stays linear and immutable; you never delete.
- Diff = compare two `case_revisions.steps` JSON arrays (we already know the shape is `{action, expected}` — trivial to diff).

#### Layer 2 — Release / baseline dimension

Do **not** invent a heavyweight branching system. Reuse the existing plan/suite grouping and add release semantics:

- Add a lightweight `releases` concept (either a new `releases` table, or — cheaper — a `release` tag convention on `test_plans`). A release = a named product version (v1, v2, v3) with a set of cases in scope.
- Pin coverage with a join row: `release_case_versions(release_id, case_id, pinned_revision_no NULL)`. `NULL` = "always use HEAD"; a number = "this release is frozen to that revision". This is exactly TestRail's baseline behavior, minimal surface.
- The login example resolves cleanly:
  - **v1 release** contains case `Login (id+pw)`.
  - **v2 release** contains `Login` (possibly a newer revision) **+ a new case** `Forgot password`.
  - **v3 release** adds new cases `Sign in with Google`, `Sign in with Microsoft`, `Sign in with SSO`.
  - Regression for any release = "give me the pinned revision of every case in this release."

#### Layer 3 — Execution snapshot

Every run result records the `revision_id` it executed against (add `case_revision_id` to the run-result/report record). A historical result then always resolves to the frozen case content, regardless of later edits. Minimal: one nullable column on the existing results store; backfill = null (means "HEAD at the time", best-effort).

### A4. Files that must change (Part A)

| # | File | Change | Risk |
|---|---|---|---|
| 1 | `server/db/schema.sql` | Add `cases.current_revision`; new `case_revisions` table; `release_case_versions` (+ optional `releases`); add `case_revision_id` to results | **Low** (additive, idempotent DO-block like existing) |
| 2 | `server/db/repository.ts` | `Cases.upsert`: detect versioned-field change → append revision + bump pointer. New `CaseRevisions` repo (list/get/diff/rollback). New `Releases` repo | **Med** (touches the hottest write path) |
| 3 | `server/shared/testCases.ts` | Helper `versionedContentChanged(prev, next)` + stable step hash | Low |
| 4 | `server/features/agent/routes.ts` | `save-cases`: pass `change_kind='ai'|'recorded'`, `change_summary`; do not double-write | Low |
| 5 | `server/features/resources/routes.ts` | New endpoints: `GET /api/cases/:id/revisions`, `GET …/revisions/:a/diff/:b`, `POST …/rollback/:rev`; release endpoints | Med |
| 6 | `src/pages/TestCases.tsx` + a `CaseHistory` component | History panel (list revisions, diff view, rollback button); release selector | Med |
| 7 | Results/reporting store + `src/pages/Reports.tsx` | Persist + display the executed `revision_no` | Low |

Cap: this is >10 files across two subsystems, so per the repo's phase rule it is split into phases (A5).

### A5. Recommended phase order (Part A)

- **Phase A1 — Schema + revision write path (flag `CASE_VERSIONING`, default OFF). DONE 2026-07-22.**
  - `case_revisions` table + `cases.current_revision` added to `server/db/schema.sql` (append-only, idempotent).
  - `Cases.upsert` captures the pre-upsert row and appends a snapshot on content change; operational-only edits mint nothing; cases predating versioning get a lazy `baseline` revision on first edit so rollback works.
  - `CaseRevisions` repo: `list` / `get` / `rollback` (rollback writes a NEW `change_kind='rollback'` revision — history stays immutable).
  - Unit-tested: `npm run test:case-versioning` (8/8, change-detection semantics). `npm run lint` clean.
  - Nothing reads revisions yet (UI is A2). Postgres only; JSON-file mode skips versioning.
- **Phase A2 — Read APIs + History UI. DONE 2026-07-22.**
  - `GET /api/cases/:id/revisions` (+ `currentRevision`) and `POST /api/cases/:id/rollback/:revisionId` in `server/features/resources/routes.ts`; `mapCase` now exposes `currentRevision`.
  - `CaseHistoryModal.tsx` — revision list (kind badges, Current badge, author/time), per-revision step view, Restore. Wired into the Test Cases edit modal via a **History** button.
  - **Verified live with Playwright MCP**: created TC-IDN1, edited v1→v2 (mints rev 2), status-only change minted nothing, rollback appended an immutable rev 3; History UI showed all three with correct badges and Restore. Backend API smoke test + browser flow both green.
- **Phase A3 — Release dimension + execution snapshot. DONE 2026-07-22.**
  - Release layer reuses `test_plans` as release containers (no parallel table). New `release_case_pins(plan_id, case_id, pinned_revision_no)` freezes a case to a revision within a release; no pin = follows HEAD.
  - `ReleasePins` repo (`pin`/`unpin`/`listForCase`/`resolve`) + `CaseRevisions.getByNo`. Routes: `GET /api/cases/:id/pins`, `POST /api/plans/:planId/pins`, `DELETE /api/plans/:planId/pins/:caseId`, `GET /api/plans/:id/release` (resolves every in-scope case to pinned-or-HEAD content).
  - Execution snapshot: `reports.case_revisions` JSONB; `POST /api/reports` stamps each `caseIds` entry's current revision. `Reports.upsert`/`mapReport` updated.
  - Release-pinning UI added to `CaseHistoryModal` (pin the selected revision to a release, existing-pin chips, unpin).
  - **Verified live**: API test showed resolve = HEAD (rev 3, 2 steps) before pin → rev 2 (3 steps) after pin; report froze `caseRevisions={TC-IDN1:3}`. **Playwright MCP**: pin chip renders, unpin removes it, re-pin adds it back.
  - Follow-up (thin): auto-pass `caseIds` from the live run executor into `POST /api/reports` so snapshots capture automatically (the storage + API contract are done; today it stamps when caseIds are supplied).

### A6. Backward compatibility / migration / rollback

- All schema changes additive and idempotent (mirror the existing `DO $$ … $$` ALTER blocks at `schema.sql:561-574`). No column drops, no type changes.
- Existing rows: `current_revision` defaults to 1; a one-time backfill can seed a single revision from each live `cases` row (optional — HEAD still works without it).
- Flag-gated (`CASE_VERSIONING`); when OFF, `Cases.upsert` behaves exactly as today. Rollback of the *feature* = flip flag off; the extra table is inert.

---

## PART B — RECORDER STEP EXPLOSION

### B0. Executive summary

Recording is **Playwright `codegen`**, not a custom event listener. Steps are derived after the fact by `scriptToSteps()` which does **one script line → one step with zero merging** — `server/features/automation/recordingService.ts:107-119`. That is the entire cause of the 200–300 step explosion. Login looks fine only because codegen emits ~4 lines for it. The fix is a **tiered step model** inserted at exactly that one function, plus a collapsible UI. No change to how recording is captured.

### B1. Current architecture (grounded)

- Capture = `npx playwright codegen` spawned headed on the desktop agent — `agent/src/recorder.ts:52-77`; output `.spec.ts` polled every 1000ms — `:79-89`.
- The script is hardened (login double-submit collapse, goto→waitForURL) — `server/features/automation/scriptHardening.ts` (called at `recordingService.ts:88`). This is the existing precedent for transforming the script before it becomes steps.
- **Explosion point:** `scriptToSteps()` — `recordingService.ts:107-119` — splits on `\n`, regex-maps each line to `{action, expected}`, no batching, no grouping.
- Persisted step shape is `{action, expected}` (`server/shared/testCases.ts:1-8`); the rich selector/value data only lives inside the script text.
- Recorded steps → case + script via `reflectRecordingAsCase` — `recordingService.ts:124-174`.

### B2. Proposed architecture — a 4-tier model (collapse, don't flatten)

Tier 0 stays the source of truth; each higher tier is derived and additive.

- **Tier 0 — Raw script** (codegen `.spec.ts`). Unchanged. Always the executable truth.
- **Tier 1 — Atomic steps with a coalescing pass.** Before mapping 1:1, run a reducer over the parsed statements:
  - merge consecutive `.fill()` on the **same locator** → one step (codegen already coalesces keystrokes, but not corrections);
  - drop redundant navigations / duplicate waits / focus-only lines;
  - collapse `type`+`press('Enter')` submit pairs (extends existing `scriptHardening` logic).
  - Effect: ~300 lines → ~60–90 atomic steps.
- **Tier 2 — Logical groups (the real UX win).** Segment atomic steps into named, collapsible blocks using **boundary signals** already present in the script:
  - a navigation (`goto` / `waitForURL`) starts a new group;
  - an `expect(...)` assertion closes a group (it's a checkpoint);
  - a URL/route change or a form submit is a boundary.
  - Auto-name each group from its dominant target ("Fill *Shipping Address* form", "Login", "Open *Orders* page"). The tester sees **~6–12 groups**, each expandable to its atomic steps. 300 interactions become a readable outline.
- **Tier 3 — Reusable modules (optional, later).** Hash a group's signature; when the same group recurs (e.g. "Login" across 20 recordings), offer to extract it into a **callable sub-case** referenced by many cases — the Selenium-IDE `run` / Katalon test-in-test / Page-Object pattern. Turns duplication into one maintained module.

### B3. Data model change (minimal, additive)

Keep `{action, expected}` for 100% backward compatibility; add optional fields:

```ts
// server/shared/testCases.ts — additive, optional
{ action: string; expected: string; group?: string; groupIndex?: number; collapsed?: boolean }
```

Groups are derivable, so we don't strictly need to persist them, but persisting a parallel `stepGroups: [{ title, stepIndices }]` in case metadata makes the UI cheap and stable. Because `cases.steps` is JSONB, this is a non-breaking additive change — old readers ignore the new keys.

### B4. Where to change (Part B)

| # | File | Change | Risk |
|---|---|---|---|
| 1 | `server/features/automation/recordingService.ts:107-119` | Replace naive `scriptToSteps` with `coalesce → group` pipeline; emit `stepGroups` | **Med** (core mapping) |
| 2 | `server/features/automation/scriptHardening.ts` | Reuse/extend its transforms for Tier-1 coalescing (shared helpers) | Low |
| 3 | `server/shared/testCases.ts` | Extend normalizer to preserve optional `group`/`groupIndex` | Low |
| 4 | `src/components/GeneratedCases.tsx` / `EditableCaseCard.tsx` | Collapsible group accordion; expand → atomic steps; group rename | Med |
| 5 | (Tier 3, later) new `case_modules` concept + extract-module UI | Reusable sub-cases | Med |

### B5. Recommended phase order (Part B)

- **Phase B1 — Tier 1 coalescing** in `scriptToSteps`. **DONE 2026-07-22** — `stepGrouping.ts` coalesces same-field fills + dedups navigations; unit-tested (`npm run test:step-grouping`, 12/12); legacy flat path preserved byte-for-byte when disabled.
- **Phase B2 — Tier 2 grouping + collapsible UI.** **DONE 2026-07-22** — nav-boundary grouping in `stepGrouping.ts`; `group`/`groupIndex` persisted through `normalizeCaseSteps`; new read-only `StepGroupList.tsx` (collapsible groups, flat fallback) wired into `EditableCaseCard` read view. Type-checks clean.
- **Phase B3 — Tier 3 reusable modules** (separate plan; only if B1/B2 land well). Not started.

Grouping is **default-on product behavior** (not env-gated) — `isRecorderStepGroupingEnabled()` returns true unless `RECORDER_STEP_GROUPING` is explicitly set to `0/false/off` (escape hatch to the legacy flat path). Verified: `npm run lint` clean; `npm run test:step-grouping` 12/12. To see it live: **restart the backend** (no hot-reload), then record a session and open the created case.

### B6. Backward compatibility

- Only additive optional step fields; `{action, expected}` consumers unaffected.
- Flag-gated; OFF = today's exact behavior (1 line → 1 step).
- Tier 0 script is never altered by grouping, so **playback is unaffected** — grouping is purely a presentation/authoring layer over the same executable script.

---

## Cross-cutting

- **Testing strategy:** unit tests for `versionedContentChanged` + step hash; unit tests for the coalesce/group reducer with a synthetic 200-line script; an integration test that a v1→v2 login edit produces exactly one new revision; live verification per repo rule (lint → tests → **restart backend** before any live check, since `server.ts` has no hot-reload).
- **Both features flag-gated and independently shippable.** Part A and Part B share only the step shape; they can be built in either order.
- **Effort estimate (rough):** Part A ≈ 3 phases; Part B ≈ 2 phases. Each phase within the repo's 10–15 file cap.

## Industry references

- TestRail — baselines for parallel release branches; project history & case versioning.
- Zephyr — incremental per-field case versions, compare + rollback.
- TestCollab / Tricentis — immutable execution snapshot per run; version your tests.
- Xray — version control for test cases.
- Selenium IDE (`run` command) / Katalon (test-in-test) — reusable module grouping to fight step explosion.
- testRigor / Harness — intent-based semantic steps over brittle per-interaction locators.
