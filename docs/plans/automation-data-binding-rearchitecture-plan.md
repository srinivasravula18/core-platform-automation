# Automation Data — Binding Layer Re-Architecture (Phase-0 Analysis)

Status: **Analysis only.** No code changed. Implementation waits for explicit approval on a later turn.
Date: 2026-07-31
Scope of the ask: "Scripts carry placeholders; the user maps their own data / an Excel sheet onto the exact fields via drag-and-drop, then runs automatically." Plus the typed / derived / relational data needs surfaced in the preceding discussion (DOB→age, coherent records, masks, references).

---

## 1. Executive Summary

**Verdict: keep the runtime engine, re-architect the authoring/binding layer.**

The current Automation Data pipeline (behind `REMOTE_AGENT_V1`) has a genuinely strong *execution core* — a clean deterministic resolver, a per-run uniqueness token, a run-data ledger with constraint enforcement, and pool/reap data-lifecycle management. That part is hard-won and should NOT be thrown away; a from-scratch rebuild would discard the sophisticated lifecycle for no benefit.

The pain is entirely in the **authoring/binding layer** and its **mental model**:

1. **It's recording-centric, not script-placeholder-centric.** Your intention is "a script has placeholders; map sheet columns onto them." The current system binds to *captured recording steps* keyed by `step_id`, not to *placeholders declared in a script*. This is the single biggest mismatch with what you actually want.
2. **Binding is flat string interpolation** — no types, no field-to-field relationships, no derivation. DOB→age, coherent Country/State/City, checksummed values, and "must already exist" references are all inexpressible.
3. **Three overlapping ways to bind** (drag pill, "Bind ▾" menu, click-to-insert) + auto-map + profiles = decision paralysis. Users don't know which is canonical.
4. **Matching is by label string** (profiles apply by lowercased field label; auto-map by Levenshtein). Rename a field and bindings silently break or mis-map. No stable IDs bridging script ↔ sheet.
5. **The token registry is duplicated** in frontend and backend (hand-mirrored), so it drifts.

Recommendation: a **strangler-fig re-architecture of the binding layer** on top of the existing engine — introduce a script-first *Placeholder Registry*, a typed *Binding Sheet* (cells + dependency DAG), and a single binding surface — while leaving the resolver, ledger, and lifecycle intact.

---

## 2. Existing Architecture (code-cited)

**Frontend**
- `src/pages/automation/DataBindings.tsx` — the "Automation Data" screen. 3-column layout (`:448`): runnable picker (left), field rows with chip editors (middle), dataset columns + variable palette + Data Profile bar (right). Drag payload `application/x-binding` → `dropOnField()` (`:252`); `putMapping()` (`:202`). Three bind paths: drag, "Bind ▾" `<select>` (`bindFromMenu` `:355`), click-to-insert (`:544`). Auto-map by Levenshtein (`openAutoMap` `:318`).
- `src/pages/automation/FieldChips.tsx` — chip model: a bound value is an ordered list of `{kind:'text'} | {kind:'token'}` chips; `{{…}}` is generated only on serialize, never shown (`:5-7`, `:27`). Genuinely good UX primitive.
- `src/pages/automation/RunnablePicker.tsx` — picks a case/script/recording to bind. Each runnable already carries `caseId` + `tags` from its linked Test Case (`:7-10`), and a tag-search box + tag-filter chips exist (`:142-153`). **But** the primary organizing axis is still a legacy **folder tree** (`buildFolderTree`/`TreeNode` `:17-58`); tag/search is a secondary overlay.

**Backend**
- `server/features/automation/variableEngine.ts` — the resolver. `resolveExpression(expr, RowContext)` (`:199`); source precedence env → column → generator (`:172-182`); transform pipes (`:56-69`); `unique.*`/`faker.*`/date generators (`:125`); per-batch `newRunToken()` (`:31`, 48-bit birthday-safe). Single source of truth for tokens.
- `server/features/automation/scriptMaterializer.ts` — per row, calls `resolveExpression` (`:37`) to snapshot each bound value into a throwaway per-row script (deterministic replay).
- `server/features/automation/dataProfileService.ts` — `ProfileBinding = {fieldLabel, expression, intent}` (`:16`); capture/apply keyed by **case-insensitive field label** (`:85`, `:103`).
- `server/features/automation/routes.ts` — mappings, profiles, batches, pool/reset, reap, preview; mints run token at batch/preview.
- `server/features/automation/teardownService.ts` — `runTeardown`/`reapBatch` (ephemeral cleanup + orphan reap from the ledger).
- `server/features/automation/datasetService.ts` — sheet import; `inferKind` is regex-based and date-detection is ISO-only (`:90`).

**Data model** (`server/db/schema.sql`)
- `automation_data_mappings` (`:977`) — the binding: `{recording_id, step_id UNIQUE, dataset_id, column_id, expression, intent}`. Keyed on **step_id**.
- `automation_data_profiles` (`:1486`) — `bindings JSONB` = `[{fieldLabel, expression, intent}]`.
- `automation_datasets`/`automation_dataset_rows` (`:951`/`:962`) — imported sheet; rows carry `values JSONB` + pool `state`.
- `automation_execution_batches` (`:987`) — `run_token`, `data_policy`.
- `automation_run_data` (`:1008`) — the ledger; unique index enforces `unique`-intent values never repeat within a batch (`:1024`).

## 3. Dependency Graph

```
DataBindings.tsx / FieldChips.tsx / RunnablePicker.tsx
        │ (HTTP)
        ▼
routes.ts ── repository.ts (mappings/profiles/datasets/rows/run-data)
   │            dataProfileService.ts / datasetService.ts
   ▼
variableEngine.ts  ◀── the substrate everything resolves through
   ▲
scriptMaterializer.ts (per-row resolve) ──▶ execution ──▶ teardownService.ts
```

## 4. Runtime Flow (today)

Pick runnable → list its recording steps → bind each (drag / menu / click / auto-map / apply profile) → `PUT mapping` → create batch (mint run token) → for each dataset row: `resolveExpression(expression, row)` per field → materialize a per-row script → execute → write ledger → teardown/reap.

## 5. Data (Evidence) Flow

Excel/sheet import → `automation_datasets` + `automation_dataset_rows.values` → mapping `expression` references a column → `resolveExpression(row)` produces the concrete string → snapshotted into the per-row script → typed into the app.

## 6. Context Flow (how bindings reach the script)

Bindings live per `step_id`. The materializer walks the recording's editable calls and substitutes resolved values positionally. **There is no concept of a placeholder declared *inside a script*** — binding is a projection over recording steps, not over script variables.

## 7. Prompt Flow

Not applicable — the binding pipeline is deterministic and LLM-free (a strength; keep it that way). The only AI touch is upstream field-semantics inference (`server/features/agent/testdata/inferKind.ts`), which the binding flow does not currently use.

## 8. Current Problems (brutal)

- **P1 — Recording-centric, not script-first.** Can't take an arbitrary script with `{{placeholders}}` and map a sheet onto *those*. Binding is tied to `step_id`. This directly contradicts the stated intention.
- **P2 — Flat, untyped interpolation.** No field-to-field dependencies, no types, no math. DOB→age, confirm-password, Qty×Price, coherent Country/State/City, checksummed cards, "must already exist" lookups — all impossible.
- **P3 — Three binding paths + auto-map + profiles.** No single canonical gesture. Cognitive overload → the "dilemma" you're describing.
- **P4 — Label-string matching is fragile.** Profiles + auto-map match on field label text; renames silently break/mis-map. No stable slot IDs bridging script ↔ recording ↔ sheet column.
- **P5 — Duplicated token registry.** Palette + regex hand-mirrored in `DataBindings.tsx` vs `variableEngine.ts`; guaranteed to drift.
- **P6 — Type/format inference is ISO-only.** No declared input formats (dd/mm/yyyy vs mm/dd/yyyy), no masks, no locale.
- **P7 — No collections / parent-child sheets.** One value → one field only; can't fan a sub-sheet into repeated line items.

## 9. Root Cause Analysis

All seven trace to **one substrate decision**: a binding is a *flat string expression resolved independently per field against one flat row*. That single design forecloses (a) placeholders as first-class objects, (b) types, (c) inter-field dependencies, and (d) records/collections. Everything else (duplicated registry, label matching) is a symptom of never having a *typed, identified binding model* — only strings.

## 10. Proposed Architecture — the "Typed Binding Sheet"

Four additions on top of the untouched engine:

**(A) Placeholder Registry (makes it script-first).**
A normalizer that extracts bindable **Slots** from *any* runnable — a script's `{{placeholder}}`s, a recording's steps, or a test case's fields — into one shape:
```
Slot { id (stable), source: 'script'|'recording'|'case', label, locator?, declaredType?, semantics? }
```
This is the missing bridge: a script with placeholders and a recording both become a list of Slots you map onto. `id` is stable, so renames don't break bindings (fixes P1, P4).

**Selection is Test-Case-first and Tag-first, not folder-first.** You pick the script to bind either (a) *through its Test Case* (`caseId` is already on every runnable) or (b) *by tag search* (`tags` already flow from the linked case). The legacy folder tree (`RunnablePicker.tsx:17-58`) is retired as the primary axis — consistent with the repo-wide tags-native initiative (tags replace folders). Folder grouping may remain only as an optional fallback view. The picker becomes: search/tag-query at top → results grouped by Test Case → its script(s)/recording(s) underneath.

**(B) Typed Binding Cells + dependency DAG (replaces flat interpolation).**
Each Slot binds to a **Cell**, one of:
- `input` — a dataset column or a generator (today's behavior).
- `derived` — a pure function of other cells: `age = yearsBetween(DOB, today)`, `total = mul(qty, price)`, `confirm = ref(password)`.
- `reference` — resolved against a *coherent record* or *live app state* (see D).

Cells form a DAG; the resolver runs them in **topological order** with cycle detection. A plain column binding is just a `derived` identity cell — **100% backward compatible** (fixes P2). Add a small pure function library to `variableEngine.ts`: `yearsBetween`, `monthsBetween`, `dateAdd`, `parseDate(fmt)`, arithmetic, `if/then`, `concat`.

**(C) Declared types & formats.**
Each Slot/column carries a declared `type` (date/number/string/currency/…) and, for dates, an `inputFormat`. Parse to a canonical value once; render to the field's expected format on the way out. Kills date ambiguity and enables masks/checksummed generators (fixes P6).

**(D) Binding *modes*, one surface.**
Collapse the three paths into a single gesture: **drag a source onto a slot** (or the equivalent menu, which produces the identical chip model). The drag can carry: a column, a variable/generator, a *function* (opens the slot picker), a *coherent record* ("bind these slots from one row"), or a *live reference* (prior step output / app lookup). Auto-map stays but only as a *suggestion* you confirm (fixes P3). Coherent-record + live-reference modes fix the B/C classes from the discussion.

**(E) Unified registry.**
One server module exports the token/function catalog; the frontend fetches it. Delete the hand-mirrored copy (fixes P5).

**(F) Parent/child sheets (later phase).**
A dataset may declare a child sheet keyed by a foreign column; a collection slot fans the child rows into repeated fields (fixes P7).

## 11. Refactoring Strategy

**Strangler-fig, flag-gated.** Build the Placeholder Registry + typed Cell resolver alongside the current path; keep `variableEngine.resolveExpression` as the leaf evaluator (derived cells compile down to it). Old mappings keep working untouched. Flip the UI to the new surface behind a flag; retire the old bind paths only after parity is proven live.

## 12–14. Files that must change (with reason + risk)

| File | Change | Why | Risk |
|---|---|---|---|
| `variableEngine.ts` | Add pure function library (date math, arithmetic, if/then, ref); keep resolver | Substrate for derived cells | **Med** — core; guard with tests |
| `scriptMaterializer.ts` | Resolve cells in topological order; cycle detection | Derived cells need inputs first | **Med** — changes resolve order |
| new `placeholderRegistry.ts` | Extract Slots from script/recording/case | Script-first binding | Low — additive |
| new `bindingGraph.ts` | Cell/DAG model + validation | Typed relationships | Med — new core |
| `schema.sql` | Additive: slot id, declared type/format, cell kind on mappings; child-sheet ref on datasets | Persist new model | **Med** — must stay idempotent; update `scripts/setup-db.bat` |
| `repository.ts` | CRUD for new columns | Persistence | Low |
| `dataProfileService.ts` | Key profiles on Slot id, not label | Fix fragile matching | Med — migrate existing |
| `datasetService.ts` | Declared type/format on import; child-sheet linkage | Typed data | Low |
| `routes.ts` | Endpoints for registry, cells, coherent-record bind | API surface | Low |
| `DataBindings.tsx` | Single binding surface; drag modes; derived preview | The UX fix | **Med** — user-facing |
| `FieldChips.tsx` | Function chip with slots; field-reference chip | Express derivations | Med |
| new registry endpoint + FE fetch | Kill duplicated palette | Single source | Low |

Stays under the per-phase cap (10–15 files / one subsystem) only if split into phases (see §20).

## 15. Backward Compatibility

- A plain column binding = `derived` identity cell → existing expressions resolve identically.
- Existing `automation_data_mappings` / `automation_data_profiles` rows keep resolving through the unchanged leaf evaluator.
- New columns are nullable/additive; absent = today's behavior.

## 16. Migration

- Schema changes additive and idempotent (per repo rule); `scripts/setup-db.bat` updated in the same change.
- Backfill: existing mappings get a generated Slot id + `input` cell kind; profiles re-keyed label→slot-id with label kept as fallback.
- No destructive migration; old and new coexist behind the flag.

## 17. Testing Strategy

- Unit: resolver DAG (topological order, cycle detection), date-math functions across declared formats, if/then, references.
- Golden: a fixture sheet + fixture script → expected resolved rows (regression lock on the existing flat behavior first, before adding cells).
- Live: one real run per phase against the SUT (backend must be restarted per repo rule before "works live" claims).

## 18. Rollback

- Everything behind a flag (extend `REMOTE_AGENT_V1` or add `BINDING_GRAPH_V1`, shadow-default off). Flip off → old path, unchanged. No schema drops needed (additive columns are inert when the flag is off).

## 19. Estimated Effort

- Phase 1 (script-first + registry): ~1 subsystem.
- Phase 2 (typed cells + DAG + date math): core work, highest value.
- Phase 3 (coherent-record + live reference): the sheet-testing payoff.
- Phase 4 (collections / child sheets, masks, single-surface UX polish): cleanup.

## 20. Recommended Implementation Order (phase checklist)

- [ ] **Phase 1 — Script-first Placeholder Registry + Case/Tag selection.** `placeholderRegistry.ts`, `routes.ts`, `RunnablePicker` (case/tag-first, retire folder tree as primary), `DataBindings` read Slots. Files ≤6. Risk: Low. *Unblocks your core intention: pick a script via its Test Case or by tag, then map the sheet onto its placeholders.*
- [ ] **Phase 2 — Typed Cells + DAG resolver + date math.** `bindingGraph.ts`, `variableEngine.ts`, `scriptMaterializer.ts`, `schema.sql`, `repository.ts`, `FieldChips.tsx`. Files ≤8. Risk: Med. *Delivers DOB→age and all field relationships.*
- [ ] **Phase 3 — Reference modes.** Coherent-record bind + live/runtime reference; `datasetService.ts`, `routes.ts`, `DataBindings.tsx`. Files ≤6. Risk: Med. *Delivers Country/State/City + must-already-exist.*
- [ ] **Phase 4 — Collections, masks, single-surface UX, unified registry, retire old paths.** Files ≤8. Risk: Med.

Each phase: lint (tsc --noEmit) → tests → **restart backend** → live-verify → report, before starting the next.

## Decisions to confirm before Phase 1

1. **Formula authoring:** fixed menu of built-in functions (safe, no-code) vs. a free-form Excel-like formula bar. Recommend fixed menu first.
2. **Sheet shape:** one flat table only, or parent/child sheets (Orders + Line Items)? Decides whether §10-F lands in Phase 3 or Phase 4.
3. **Highest-value reference case for Phase 3:** coherent-record (Country/State/City) vs. must-already-exist lookup vs. prior-step output.
4. **Flag:** reuse `REMOTE_AGENT_V1` or add `BINDING_GRAPH_V1`.
