# Test Runs UI Redesign — Plan/Suite/Case Lineage, Scale, Accessibility

**Status: Phase 0 — Analysis only. No code changed. Awaiting explicit approval before any implementation.**

Date: 2026-08-06
Branch at time of analysis: `Tags_ManualRuns_ManualTestData` (`e959ec5`)

---

## 1. Executive Summary

The request is a UI/UX redesign of the Test Runs area (and, necessarily, the Cases/Suites/Plans pages that feed it) so that:

1. Every case, suite, plan, and run visibly shows its **lineage** — which plan/suite a case belongs to, which cases/suites a run was built from — instead of the current single inline label.
2. Users can keep running directly from a Suite, a Plan, or a Case selection (header bulk action or per-row), with clearer confirmation of exactly what will run.
3. The UI stays fast and usable when a suite/plan has **hundreds of cases** (100–300+).
4. The whole area is **accessible** (keyboard navigation, ARIA semantics, focus management) as a designed property, not an afterthought.

Grounded investigation (see §2) found the run-creation flow is already solid and does not need to be rebuilt: `RunModeModal` → `POST /api/runs/from-selection` already correctly expands Plan → Suite → Case membership (including nested suites) and persists that lineage on the run row. Two memory items turned out to be **stale**: `runs.website_id` already exists and is populated (the credential-collision bug is fixed), and the manual runner (`run_case_results`, `ManualRunner.tsx`) is fully built and wired, not just planned.

The real gaps are:
- **No lineage UI** — the data to answer "which suite/plan is this case in" and "which cases/suites did this run come from" already exists in the database, but no breadcrumb or reverse-lookup panel renders it anywhere.
- **No scale handling** — all four list pages (Cases, Suites, Plans, Runs) are hand-written HTML `<table>`s that render the entire filtered array in one pass. No pagination, no virtualization, no grid library is in the dependency tree.
- **Accessibility is ad hoc** — scattered `aria-label`/`aria-live`/`role="switch"` usage, but zero keyboard row navigation and no ARIA grid semantics on any of the four dense tables.

This plan proposes a **UI-layer redesign with no schema changes and no changes to the run-creation contract**: a shared virtualized, keyboard-accessible table primitive; a client-side lineage index built from data already being fetched; breadcrumb + "linked entities" panels on Cases/Suites/Runs; and a resolved-case-count preview step added to `RunModeModal`. All of it is additive and page-by-page, so it can be rolled out and verified incrementally without breaking the existing run flow.

---

## 2. Existing Architecture

**Entities and composition** (`server/db/schema.sql`): Plans, Suites, Cases, Runs. Composition is **denormalized ID arrays**, not normalized junction tables:
- `cases.test_plan_id`/`test_suite_id` (singular, legacy) + `test_plan_ids`/`test_suite_ids` (plural, kept in sync) — a case can belong to multiple suites/plans.
- `suites.test_plan_id` + `test_plan_ids`, `parent_suite_ids` (suite nesting).
- `runs.suite_id`, `test_plan_id`, `case_ids TEXT[]`, plus richer `planIds`/`suiteIds`/`casePins` written at the app layer on creation.
- The only true relational junction table in the schema is `requirement_case_links` (unrelated to runs).
- `runs.website_id`/`credential_role` already exist and are populated via `pinRunWebsite()` (`server/features/resources/routes.ts:37-41`) — the previously-noted credential-collision bug is resolved, not open.
- `run_case_results` (one row per run×case) backs the manual runner; fully wired end to end.

**Run-creation flow**: every "Run" action — per-row on Cases (`TestCases.tsx:1615`) and Suites (`TestSuites.tsx:759`), header "Run Selected" bulk action on Cases/Suites/Plans/Runs, and plan-level run — funnels through the **same shared modal**, `src/components/RunModeModal.tsx`, into **one endpoint**, `POST /api/runs/from-selection` (`routes.ts:1734-1894`). That handler expands `planIds → suiteIds (incl. descendants) → caseIds`, inherits version pins, and persists the full lineage (`caseIds`, `casePins`, `suiteIds`, `planIds`) on the new run row. This is a single, well-factored path — the redesign should consume it better, not replace it.

**Frontend pages**: `src/pages/{TestCases,TestSuites,TestPlans,TestRuns}.tsx`, each 900–1700 lines, each with its own hand-rolled Tailwind `<table>`, its own filter/sort state, its own bulk-select checkbox logic. `TestRuns.tsx` detail view is mode-aware: manual runs render the full `ManualRunner`/`ManualStepRunner`/`OutcomeSelect`/`RunSummaryPanel` component set (a mature, purpose-built UI); automated runs still render a legacy read-only case table.

**Shared components already available to build on**: `RunModeModal.tsx` (run-trigger dialog), `EntityLinker.tsx` (tag-query composer with search/preview, used for suite/plan composition), `VersionPinSelect.tsx` (per-run version pinning), `src/lib/startSelectedRun.ts` (client helper that calls from-selection), `src/lib/testPlanHierarchy.ts` (plan parent/child tree builder — plan→plan only today, not plan→suite→case).

**No pagination/virtualization dependency exists** — confirmed via `package.json` (only `react`, no AG Grid/TanStack Table/MUI DataGrid/react-window/react-virtualized).

**Accessibility today**: native semantic HTML tables/buttons/selects, scattered `aria-label`/`aria-live`/`aria-expanded`/`role="switch"`, zero keyboard row-navigation handlers, no ARIA grid roles, no documented focus-trap audit for modals.

---

## 3. Dependency Graph

```
server/db/schema.sql
  └─ plans, suites, cases, runs, run_case_results (composition via ID arrays)

server/features/resources/routes.ts
  ├─ GET /api/{plans,suites,cases,runs}          (full-array list endpoints, no pagination)
  ├─ POST /api/runs/from-selection                (plan→suite→case expansion; UNCHANGED by this plan)
  ├─ POST /api/runs, PUT /api/runs/:id, /execute  (manual/automated run lifecycle)
  ├─ /api/runs/:id/results...                     (manual runner endpoints)
  ├─ /api/:target/:id/tag-drift|tag-accept|...    (tag composition engine)
  └─ pinRunWebsite()                               (credential pinning — already fixed, out of scope)

core/shared/manualRun.ts                           (rollup logic, shared client+server)

src/lib/startSelectedRun.ts                        (client → from-selection)
src/lib/testPlanHierarchy.ts                        (plan tree builder — reused/extended)

src/components/
  ├─ RunModeModal.tsx           (shared run-trigger dialog — EXTENDED, not replaced)
  ├─ EntityLinker.tsx           (tag-query composer — pattern reference for preview UX)
  ├─ VersionPinSelect.tsx       (per-run version pin — unaffected)
  └─ manualRunner/
      ├─ ManualRunner.tsx
      ├─ ManualStepRunner.tsx
      ├─ OutcomeSelect.tsx
      └─ RunSummaryPanel.tsx    (already shows Plan/Suite/Case labels for one result — pattern to generalize)

src/pages/
  ├─ TestCases.tsx    (table + inline plan/suite multi-select — table swapped in Phase 2)
  ├─ TestSuites.tsx   (table + nested sub-table — table swapped in Phase 3)
  ├─ TestPlans.tsx    (hierarchy table — table swapped in Phase 3)
  └─ TestRuns.tsx     (list table + mode-aware detail — table swapped, breadcrumb added in Phase 4)

NEW (this plan):
  src/components/DataTable/DataTable.tsx, useVirtualizedRows.ts, useKeyboardRowNav.ts
  src/components/LineageBreadcrumb.tsx
  src/components/LinkedEntitiesPanel.tsx
  src/lib/lineageIndex.ts
```

---

## 4. Runtime Flow

Unchanged by this plan, and confirmed correct today:

```
User selects case(s)/suite/plan (row checkbox or per-row action)
  → clicks Run (per-row icon or header "Run Selected")
  → RunModeModal opens (manual vs automated, headless/headed, agent, tags)
  → [NEW: preview step shows resolved case count + expandable list]
  → confirm → POST /api/runs/from-selection
  → server expands planIds→suiteIds(+descendants)→caseIds, inherits pins
  → run row created with caseIds/suiteIds/planIds/casePins persisted
  → navigate to Run detail (TestRuns.tsx)
  → mode==='manual'  → ManualRunner (full step-by-step UI, already built)
  → mode==='automated' → execute endpoint resolves linked Playwright scripts
```

The only new step is the **preview** insertion point inside `RunModeModal`, before the existing confirm action. No change to the request/response contract of `from-selection`.

---

## 5. Evidence Flow

Not materially affected. Manual-run evidence (screenshots/attachments) already flows through `run_case_results.attachments` → `ManualStepRunner`/`RunSummaryPanel`. The new `LinkedEntitiesPanel` (§9) may surface an evidence *count* per linked run (e.g. "3 attachments") by reading the same `run_case_results` data already fetched for the Run detail view — no new evidence storage or capture path is introduced.

---

## 6. Context Flow

Today, plan/suite/case linkage exists only as raw ID arrays passed down as props into each page's local component state; there is no shared, indexed view of "who references whom." This plan introduces one new client-side derived-data layer, `lineageIndex.ts`, built once per data-fetch from the already-loaded Cases/Suites/Plans/Runs collections:

- `caseId → { suiteIds, planIds, runIds }`
- `suiteId → { planIds, caseIds, runIds }`
- `planId → { suiteIds, caseIds, runIds }`

This is pure client-side derivation (no new network calls for the MVP scope) — the four list endpoints already return the full arrays needed to build these maps. `LineageBreadcrumb` and `LinkedEntitiesPanel` consume this index; they do not talk to the network directly.

---

## 7. Prompt Flow

Not applicable — this redesign is a CRUD/UI feature with no LLM prompt assembly involved. (The separate agent-run/chat-driven case-generation subsystem is out of scope here and untouched.)

---

## 8. Current Problems

1. **No lineage visibility.** A case's row shows editable Plan/Suite dropdowns, but there's no read-only breadcrumb (`Plan A › Suite B › Case C`) and no reverse lookup ("this case is in 3 suites, ran in 5 runs, click to see them"). Run detail shows one `Plan: X` label and a Suite column, nothing richer.
2. **No scalability ceiling.** Every list page renders the entire filtered array as `<tr>` elements with no windowing. A 300-case suite renders 300 rows (plus nested sub-tables on the Suites page) with only CSS `overflow-auto`.
3. **Accessibility is incidental.** No keyboard row navigation anywhere; no ARIA grid roles/`scope` attributes on any table; ad hoc `aria-label` coverage; no confirmed focus-trap behavior in `RunModeModal`/`EntityLinker`.
4. **RunModeModal does a lot at once** (manual/automated, headless/headed, agent picker, tags) with no preview of exactly which cases will be included before the user confirms — for a plan-level run this could silently include hundreds of cases across nested suites.
5. **Four independent, duplicated table implementations** (Cases/Suites/Plans/Runs), each hand-rolled, meaning every future feature (filtering, sorting, a11y, virtualization) has to be built and maintained four times.

---

## 9. Root Cause Analysis

- Composition was modeled as denormalized ID arrays on each entity rather than through a normalized junction table with a queryable index — reasonable for a flexible many-to-many model, but it means "who references this" has never had a natural place to be computed, so no UI was ever built to show it.
- Each of Cases/Suites/Plans/Runs was built independently, feature-by-feature (case authoring, then suites, then plans, then runs, then tags, then manual runner, then versioning), without a shared list/table primitive ever being extracted — so scale and accessibility concerns were never solved once and reused; they were never solved at all.
- Every new capability (tag composition, manual runner, version pinning) was added as new inline UI in the relevant page rather than through a shared design system, which is why accessibility attributes appear ad hoc wherever a specific developer happened to add them, rather than as a systemic pattern.

---

## 10. Proposed Architecture

1. **Shared `DataTable` primitive** (`src/components/DataTable/`): virtualized row rendering (windowing hook `useVirtualizedRows`), sticky header, column-def driven rendering, roving-tabindex keyboard navigation (`useKeyboardRowNav`: arrow keys move row focus, Enter/Space activates the row's primary action, Home/End jump to first/last), ARIA grid semantics (`role="grid"`/`row`/`gridcell`/`columnheader"` + `scope` on headers). Used by all four pages in place of their hand-rolled tables. Behavior-preserving: existing filter/sort/bulk-select/inline-edit logic is passed in as column renderers and row-selection callbacks, not rebuilt.
2. **`lineageIndex.ts`**: pure-function builder producing the three lookup maps described in §6, computed once per fetch and memoized.
3. **`LineageBreadcrumb`**: small inline component — `Plan A › Suite B › Case C` — rendered on Case rows/detail and Run detail, using the lineage index (no new endpoint).
4. **`LinkedEntitiesPanel`**: expandable panel ("Appears in 3 suites, 1 plan · Ran in 5 runs") with clickable, deep-linking navigation to the filtered Suites/Plans/Runs page. Rendered on Case detail, Suite detail, and Run detail (reusing/generalizing the pattern already proven in `RunSummaryPanel.tsx`, which shows this for a single manual-run case-result today).
5. **`RunModeModal` preview step**: before create, show the resolved case count and an expandable list of exactly which cases will run — reusing the same plan→suite→case expansion logic as `from-selection`, factored server-side into a shared helper and exposed via a new lightweight `POST /api/runs/preview-selection` (read-only, same expansion, no run created). This is the one backend addition in this plan; everything else is client-only.
6. **Accessibility baseline**: built into `DataTable` and the two new panels from the start (keyboard nav, ARIA roles, focus-visible styling, `RunModeModal`/`EntityLinker` focus-trap audit and fix if missing).

Explicitly **not** proposed: no schema changes, no change to `from-selection`'s request/response contract, no rebuild of the manual runner (already solid), no normalization of ID arrays into junction tables (out of scope — a much larger, separate migration with no concrete pain point identified here).

---

## 11. Complete Refactoring Strategy

Roll out per-page, pilot on Cases first (highest traffic, clearest lineage need), then Suites/Plans, then Runs + modal preview. Each page swap is independently revertable (see §17).

---

## 12. Files That Must Change

**New files:**
- `src/components/DataTable/DataTable.tsx`
- `src/components/DataTable/useVirtualizedRows.ts`
- `src/components/DataTable/useKeyboardRowNav.ts`
- `src/lib/lineageIndex.ts`
- `src/components/LineageBreadcrumb.tsx`
- `src/components/LinkedEntitiesPanel.tsx`

**Modified files:**
- `src/pages/TestCases.tsx` — swap table for `DataTable`, add breadcrumb + linked-entities panel
- `src/pages/TestSuites.tsx` — swap table (incl. nested sub-table) for `DataTable`, add linked-entities panel
- `src/pages/TestPlans.tsx` — swap table for `DataTable`, integrate with existing `testPlanHierarchy.ts`
- `src/pages/TestRuns.tsx` — swap list table for `DataTable`, add breadcrumb to detail header
- `src/components/RunModeModal.tsx` — add preview step
- `server/features/resources/routes.ts` — extract the plan→suite→case expansion block (`:1753-1780`) into a shared helper; add `POST /api/runs/preview-selection` reusing it

---

## 13. Why Each File Must Change

- `DataTable` + hooks: single reusable, accessible, virtualized table to replace four duplicated hand-rolled ones — solves §8.2 and §8.3 once instead of four times.
- `lineageIndex.ts`: single source of truth for "who references whom," needed by both new panel components.
- `LineageBreadcrumb` / `LinkedEntitiesPanel`: the actual UI surface the user asked for — "which case is from which suite/plan."
- Page files: each currently owns its own table markup; swapping is the only way to gain virtualization/keyboard-nav/lineage display without duplicating the new primitives four times.
- `RunModeModal.tsx`: closes the "run a plan with 200 cases and not know it until after" risk called out in §8.4.
- `routes.ts`: the preview endpoint needs the exact same expansion logic as `from-selection` — factoring it out avoids drift between preview and actual run creation.

---

## 14. Risk Level Per File

| File | Risk | Why |
|---|---|---|
| `DataTable.tsx` + hooks | Medium | New, isolated, unit-testable before any page consumes it |
| `lineageIndex.ts` | Low | Pure functions, no side effects, easy to unit test |
| `LineageBreadcrumb.tsx` | Low | Small, presentational |
| `LinkedEntitiesPanel.tsx` | Low-Medium | Presentational + navigation, moderate complexity |
| `TestCases.tsx` | Medium-High | Largest, most-used page; must preserve every existing action (inline edit, bulk run, filters, tag drift) |
| `TestSuites.tsx` | Medium-High | Nested sub-table for expanded rows adds complexity to the swap |
| `TestPlans.tsx` | Medium | Must preserve hierarchy rendering (`testPlanHierarchy.ts`) inside `DataTable` |
| `TestRuns.tsx` | Medium | Must preserve mode-aware detail view (`ManualRunner` vs legacy automated table) untouched |
| `RunModeModal.tsx` | Low-Medium | Additive step, existing confirm path unchanged |
| `routes.ts` (preview endpoint) | Low | Pure refactor + additive read-only endpoint; `from-selection` itself is not modified, only the shared helper it now calls |

---

## 15. Backward Compatibility Concerns

- No schema changes — nothing to migrate.
- No change to `from-selection`'s existing request/response shape — any external/automated caller (e.g. scripts, saved bookmarks to run flows) keeps working unchanged.
- The new preview endpoint is additive; omitting it entirely (if descoped) does not block the rest of the plan.
- `DataTable` must preserve every prop/callback contract the pages currently rely on (row click, checkbox select, inline dropdown edit, action icons) — this is the main compatibility risk and is why each page swap should be validated in isolation (§16) before moving to the next.

---

## 16. Migration Strategy

No data migration required. UI migration is page-by-page:
1. Build `DataTable`/`lineageIndex`/panels in isolation, unit-tested, unused by any page yet.
2. Swap `TestCases.tsx` first (pilot). Validate parity manually and via existing Playwright/manual QA before proceeding.
3. Swap `TestSuites.tsx`, then `TestPlans.tsx`, reusing the now-proven primitive.
4. Swap `TestRuns.tsx` list + add breadcrumb; add `RunModeModal` preview step + backend preview endpoint last (lowest risk, most isolated).
5. If any swap regresses behavior, revert that single page's commit — no cross-page or schema rollback is ever needed.

---

## 17. Testing Strategy

- Unit tests for `lineageIndex.ts` builder functions (given sample cases/suites/plans/runs, verify correct reverse-lookup maps).
- Manual QA checklist per page swap: every existing action still works (edit, delete, run, bulk-select, filter, sort, tag-drift), keyboard-only pass (Tab/Arrow/Enter/Home/End) for row navigation and run-triggering, and an automated accessibility pass (axe-core or equivalent) on each swapped page.
- Screen-reader spot check (NVDA or VoiceOver) on the new breadcrumb/panel components and the `DataTable` grid semantics.
- Scale test: seed a suite with 300 cases (this project's own automation platform can dogfood this via the recorder or a seed script) and confirm the list renders without jank and that run-selection still resolves the correct case count through the new preview step.

---

## 18. Rollback Strategy

Every change is additive or an isolated per-page swap with no schema/data migration. Rollback is simply reverting the specific page's commit back to its previous table markup; the new shared components (`DataTable`, `lineageIndex`, panels) can be left in place unused with no effect if only one page's swap needs to be undone.

---

## 19. Estimated Implementation Effort

- **Phase 1** (shared primitives: `DataTable` + hooks + `lineageIndex`): ~1–2 focused sessions.
- **Phase 2** (Cases page pilot: table swap + breadcrumb + linked-entities panel): ~1 session.
- **Phase 3** (Suites + Plans page swaps, reusing Phase 1/2 components): ~1–1.5 sessions.
- **Phase 4** (Runs page swap + `RunModeModal` preview + backend preview endpoint): ~1 session.
- Total: roughly 4–6 focused sessions, each phase within the 10–15 file / one-subsystem cap.

---

## 20. Recommended Implementation Order (Phase Checklist)

- **Phase 1 — Shared primitives.** Files: `DataTable.tsx`, `useVirtualizedRows.ts`, `useKeyboardRowNav.ts`, `lineageIndex.ts`. Risk: Medium (new, isolated, no consumers yet).
- **Phase 2 — Cases page pilot.** Files: `TestCases.tsx`, `LineageBreadcrumb.tsx`, `LinkedEntitiesPanel.tsx`. Risk: Medium-High (largest, most-used page).
- **Phase 3 — Suites + Plans pages.** Files: `TestSuites.tsx`, `TestPlans.tsx`. Risk: Medium (reuses proven Phase 1/2 components).
- **Phase 4 — Runs page + run-trigger preview.** Files: `TestRuns.tsx`, `RunModeModal.tsx`, `routes.ts` (expansion-helper extraction + `preview-selection` endpoint). Risk: Medium.
- **Phase 5 — Optional, only if needed.** Server-side pagination for list endpoints, if real-world case counts exceed comfortable client-side virtualization (e.g. beyond ~1000 per suite — well above the 100–300 stated in the request). Files: `routes.ts` list endpoints + page fetch hooks. Risk: Low-Medium, purely additive, deferred until proven necessary.

---

## Open Questions for Approval

1. Does the "linked entities" panel need to also show **which agent runs / defects** reference a case, or is Plan/Suite/Run linkage sufficient for this pass?
2. Is the `preview-selection` backend endpoint (Phase 4) wanted now, or is client-side count estimation (recomputing the expansion logic in JS from already-fetched data, no new endpoint) acceptable to keep this fully front-end-only?
3. Any preference on the virtualization approach — a lightweight custom windowing hook (proposed, zero new dependencies) vs. adopting a library (e.g. `@tanstack/react-table` + `react-window`)? The project currently has zero table/grid dependencies, so this is a real choice, not just an implementation detail.

This plan is analysis only. No files have been modified. Awaiting your go-ahead (and answers to the above, if you have a preference) before Phase 1 implementation begins.
