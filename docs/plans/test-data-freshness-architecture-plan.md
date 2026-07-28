# Test Data Freshness & Lifecycle — Architecture Plan (Phase 0, analysis only)

Status: **ALL phases COMPLETE — Phases 1–5 + UI-1–4 built and live-verified via Playwright MCP** (uncommitted, 2026-07-27).

Final additions (UI-3/UI-4/Phase 5), live-verified:
- **UI-3 manual entry:** `POST /api/automation/datasets/manual` + modal grid (columns mirror field labels, unsaved until Save). Verified: created "Hand typed via test" (2×2).
- **UI-4 keyboard/a11y:** per-field **Bind ▾** menu (Columns + Variables, no drag required) + `aria-live` announcements. Verified: menu-bind set `{{faker.city}}` and announced it.
- **Phase 5 faker breadth:** `{{faker.phone|city|country|jobTitle|street|url|int|boolean|word}}` added. Verified live: `{{faker.fullName}}` → "Radia Hopper", `{{faker.phone}}` → "+14509644743".

**Live E2E verification (Playwright MCP against localhost:3000 + fresh :3001):**
- Intent gate blocks a Unique-field-bound-to-column run with HTTP 400 (exact message); valid generator run creates the batch (runToken + stopOnFailure persisted).
- Resolved preview shows a real seeded value (`→ qa+db475f-2@example.test · fresh each run`).
- Template endpoint returns a valid 2201-byte `.xlsx` (`login-flow__template.xlsx`).
- Auto-map modal suggests `{{unique.email}}` for the email field, Skip for Password; Apply binds it (intent unique).
- Ledger: 3 rows, 3 distinct seeded emails (`aba4c8-1/2/3`) written before dispatch.
- Pooled: rows consumed, second pooled run rejected ("No unconsumed rows left"), grid shows `consumed`.
- Ephemeral: cancel→terminal→teardown ran, ledger cleanup → `skipped` (no hook configured).
- One display bug found + fixed during E2E (dataset `page` query wasn't selecting `state`).
Author context: extends the Data-Driven Record & Play subsystem (variableEngine / scriptMaterializer / execution batches).

**Build status (2026-07-27):** Phase 1 + UI-1 implemented and verified (lint + tests + smoke).
- Backend: run-seeded generators (`{{unique.*}}` `{{faker.*}}` `{{seq}}` `{{run.id}}`) + per-batch `run_token`; mapping `intent` (fixed/unique/reference); intent-aware pre-flight gate in batch create; preview returns per-field resolved values + intent. Files: `variableEngine.ts`, `scriptMaterializer.ts`, `routes.ts`, `db/schema.sql`, `db/repository.ts`.
- UI: responsive split (`minmax()`, stacks < lg), per-field intent selector, grouped variables palette (unique/faker/other), live resolved preview with "fresh each run", inline "unique needs a generator" warning. File: `DataBindings.tsx`.
- Requires backend restart to run live (no hot-reload). Not committed.

**UI-2 (2026-07-27):** Excel template download + Auto-map implemented and verified.
- Backend: `GET /api/automation/recordings/:id/template` streams a two-sheet .xlsx (Data = field-name headers, Guide = intent/tips) built with `archiver` inline strings; round-trips through the existing importer. Files: `templateService.ts` (new), `routes.ts`.
- UI: toolbar "Download Excel template" + "Auto-map columns → fields"; Auto-map is a review modal (exact→normalized→Levenshtein matching; suggests a generator for email/username-ish fields; user confirms every binding before Apply). File: `DataBindings.tsx`.
- Still TODO: run-data ledger + result gate + stop-on-failure (Phase 2), teardown (Phase 3), pooled datasets (Phase 4), faker breadth + manual-entry grid + keyboard DnD (UI-3/UI-4).

---

## 1. Executive summary

A recorded/generated Playwright script that **writes** to the app-under-test (SUT) is not safely repeatable: the second run replays the *same* inputs and fails, because the first run already persisted them in the SUT's database (unique-key violations, "already exists", non-idempotent state transitions). Static datasets only defer the problem — a finite row, once consumed by a write-flow, can never be replayed either.

The fix is a **test-data-management layer** that:

1. Classifies every input field by **data intent** — `fixed`, `unique`, or `reference`.
2. Generates `unique` fields **fresh on every run**, seeded by a per-run token so values are globally unique across reruns *and* human-traceable/greppable in the SUT.
3. Records every generated value in a **run-data ledger** so the pipeline can validate, reproduce, and (optionally) tear down what it created.
4. Enforces a **fail-fast validation pipeline**: a batch is rejected before dispatch if any field can't resolve or if a `unique`-intent field is bound to static data; a row is marked failed *with its generated data retained* if the script fails.

This turns "run once, then it breaks" into "run any number of times, each with clean new data."

## 2. Existing architecture (what we build on)

- `variableEngine.ts` — resolves `{{column}}`, `{{uuid}}`, `{{today}}`, `{{rowNumber}}`, `{{env.X}}`, pipe transforms. **Already supports non-deterministic generation.**
- `scriptMaterializer.ts` — compiles the immutable recording once, materializes a per-row runtime script by replacing bound values.
- `automation_execution_batches` + per-row `automation_jobs` (each stores `materialized_script`, `dataset_row_id`, `row_number`).
- Batch creation already **pre-materializes every row and fails before persistence** (no partial batches).
- `automation_data_mappings` — step → dataset column + `expression`.

## 3. Root cause

The pipeline treats all input data as **replayable**, but a write-flow's inputs are **single-use** against a stateful SUT. Nothing distinguishes "this field must be new every run" from "this field is a stable selection", and nothing tracks what was actually written, so re-execution is guaranteed to collide.

## 4. Design principles

1. **Every field has an intent.** The materializer must know whether a field is fixed, must-be-unique, or must-reference-existing-data.
2. **Uniqueness is run-scoped and traceable**, not random noise. A per-run token namespaces all generated values so reruns never collide and every value is auditable.
3. **Know what you wrote.** Nothing is generated without being recorded in a ledger keyed by batch/job/row.
4. **Fail fast, fail loud.** Invalid data configuration is rejected before a single browser launches; a failed row keeps its exact data for reproduction/cleanup.
5. **Backward compatible & flag-gated.** Existing recordings, static-column bindings, and manual overrides keep working unchanged.

## 5. Proposed architecture

### 5.1 Field intent model

Each mapping gains an `intent`:

| Intent | Meaning | Resolves from | Rerun-safe? |
|---|---|---|---|
| `fixed` | Same value every run (dropdown selection, country, a literal) | static column / literal expression | yes (read-only or non-unique) |
| `unique` | Must be new every run to satisfy a SUT uniqueness constraint (email, username, SKU, order ref) | run-seeded generator | **yes — the whole point** |
| `reference` | Must point to data that already exists in the SUT | static column / live lookup — never generated | yes |

Intent is stored on the mapping (validation needs it) and is inferable from the expression (a bare `{{unique.*}}`/faker generator ⇒ `unique`; a bare `{{Column}}` ⇒ `fixed`/`reference`).

### 5.2 Run-seeded generators (the core mechanism)

Each batch mints a short **run token** (`runToken`, e.g. base36 of the batch's creation time + a per-process counter) and each row carries a **row sequence** (`rowSeq`). The engine's `RowContext` is extended with both. New generators:

- `{{unique.email}}` → `qa+<runToken>-<rowSeq>@<domain>` (domain from `env.TEST_EMAIL_DOMAIN`, default `example.test`)
- `{{unique.username}}` → `qa_<runToken>_<rowSeq>`
- `{{unique.slug}}` / `{{unique.id}}` → `<prefix>-<runToken>-<rowSeq>`
- `{{seq}}` → monotonic per-batch counter; `{{run.id}}` → the runToken
- `{{faker.firstName|lastName|company|...}}` → realistic values (unique ones suffixed with the runToken)

Because `runToken` is unique per batch and `rowSeq` per row, **every generated value is globally unique across all runs**, and because it embeds a readable token it is trivially greppable in the SUT for debugging/cleanup. Values are computed at materialize time and **snapshotted into `materialized_script`**, so replay is deterministic.

### 5.3 Data lifecycle policy (per batch, default `fresh`)

| Policy | Behavior | When |
|---|---|---|
| `fresh` (default) | Generate new unique data each run; no teardown. Data accumulates in the SUT but never collides. | Create/write flows — the common case, zero SUT-side plumbing. |
| `ephemeral` | Generate fresh **and** tear down after (delete created entity by its known key). Keeps the SUT clean. | When accumulation is undesirable and the SUT exposes delete. |
| `pooled` | Consume finite dataset rows, mark them `consumed`, never reuse. | When data must be pre-provisioned (can't be synthesized). |

### 5.4 Teardown (the "clean rerun" guarantee for `ephemeral`)

Because the generated unique keys are in the ledger, teardown is deterministic — we know exactly what to delete:

- **API teardown (preferred):** call the SUT's REST API to `DELETE` by the generated key (configured per recording, or a paired teardown recording). For core-platform specifically this is available via its record API.
- **DB teardown:** direct delete by key when DB access exists.
- **None (`fresh`):** accept accumulation; rely on uniqueness.

Teardown runs as a distinct cleanup job in the batch pipeline; its success/failure is tracked per row in the ledger (`cleanup_status`).

### 5.5 The batch pipeline (fail-fast, well-constrained)

```
create batch
  │
  ├─(1) COMPILE + PRE-FLIGHT VALIDATION  ── fail ⇒ reject batch, dispatch nothing
  │      • every required field resolves to a non-empty value
  │      • every `unique`-intent field resolves to a generated (not static) value
  │      • every `reference`-intent field resolves to a non-generated value
  │
  ├─(2) LEDGER WRITE (per row, before dispatch)
  │      • persist { batch, job, row, field, intent, generated_value } so we
  │        know what will be created even if the run dies mid-way
  │
  ├─(3) EXECUTE per-row job (materialized script with unique data)
  │
  ├─(4) RESULT GATE
  │      • pass/fail from Playwright exit + success assertion
  │      • failed row keeps its generated data (reproducible + cleanable)
  │      • batch stop-on-failure vs continue-on-failure (configurable)
  │
  ├─(5) TEARDOWN (policy = ephemeral): delete created entities, record cleanup_status
  │
  └─(6) BATCH SUMMARY: passed / failed / cleaned; batch fails if a required row fails
```

Step (1) already exists in a basic form (pre-compile before persistence); this plan extends it with intent-aware checks. "If the script fails, the pipeline fails" is step (4)+(6).

## 6. Data model / DB constraints

New table — the run-data ledger:

```sql
CREATE TABLE IF NOT EXISTS automation_run_data (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL REFERENCES automation_execution_batches(id) ON DELETE CASCADE,
  job_id         TEXT,
  row_number     INTEGER NOT NULL,
  field_key      TEXT NOT NULL,          -- step id / logical field
  intent         TEXT NOT NULL,          -- fixed | unique | reference
  generated_value TEXT NOT NULL,
  entity_type    TEXT DEFAULT '',        -- optional hint for teardown (user, order, ...)
  cleanup_status TEXT NOT NULL DEFAULT 'none', -- none | pending | done | failed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, field_key, generated_value)   -- no accidental dup within a batch
);
CREATE INDEX IF NOT EXISTS automation_run_data_value_idx ON automation_run_data(generated_value);
CREATE INDEX IF NOT EXISTS automation_run_data_batch_idx ON automation_run_data(batch_id, row_number);
```

Additive column changes (idempotent `ADD COLUMN IF NOT EXISTS`, per repo schema rules):

- `automation_data_mappings.intent TEXT NOT NULL DEFAULT 'fixed'`
- `automation_execution_batches.data_policy TEXT NOT NULL DEFAULT 'fresh'`
- `automation_execution_batches.run_token TEXT NOT NULL DEFAULT ''`
- `automation_dataset_rows.state TEXT NOT NULL DEFAULT 'available'` + `consumed_by_batch TEXT` (pooled policy)

All changes remain idempotent for new and existing DBs; `scripts/setup-db.bat` verified in the same change.

## 7. Files that must change (per phase, not all at once)

| File | Change | Risk |
|---|---|---|
| `server/features/automation/variableEngine.ts` | run-seeded `unique.*` / `seq` / `run.id` / `faker.*` generators; `RowContext` gains `runToken`, `rowSeq` | Low |
| `server/features/automation/scriptMaterializer.ts` | thread `runToken`/`rowSeq`; expose per-field resolved values for the ledger | Low |
| `server/features/automation/routes.ts` | mint runToken; intent-aware pre-flight validation; ledger write on batch create | Medium |
| `server/features/automation/jobService.ts` | result gate; stop-on-failure; cleanup status | Medium |
| `server/features/automation/dataTeardownService.ts` (new) | API/DB teardown for `ephemeral` | Medium |
| `server/db/schema.sql` + `server/db/repository.ts` | ledger table, batch policy/token, mapping intent, row consumption | Medium |
| `src/pages/automation/DataBindings.tsx` | per-field intent selector; policy selector; "next run uses fresh data" affordance; ledger/result view | Medium |

## 8. Backward compatibility

- Default `intent = fixed` and `data_policy = fresh` reproduce today's behavior for existing mappings.
- New generators are additive; existing `{{column}}` / `{{uuid}}` expressions are unchanged.
- Ledger and teardown are opt-in; `fresh` policy needs no SUT-side plumbing.

## 9. Migration strategy

Additive schema only; no backfill required. Existing batches/jobs keep working. New columns default to today's semantics.

## 10. Testing strategy

- Unit: `variableEngine` uniqueness (same expression, different runToken/rowSeq ⇒ distinct values; determinism given fixed seed inputs).
- Unit: pre-flight validation rejects `unique` bound to static column, and `reference` bound to a generator.
- Integration: two consecutive batches over the same recording+dataset produce **disjoint** generated values (rerun-collision regression test).
- Integration: `ephemeral` teardown removes exactly the ledgered keys; `cleanup_status` transitions correctly.
- Pipeline: a failing row marks the batch failed under stop-on-failure, and the failed row's generated data is retained.

## 11. Rollback strategy

Gate the whole layer behind a flag (e.g. `TEST_DATA_LIFECYCLE_V1`). Disabling it: no run tokens minted, no ledger writes, no teardown; mappings resolve exactly as they do today. Additive columns/table are inert. No destructive rollback.

## 12. Recommended implementation order (phase checklist)

- **Phase 1 — Fresh unique data (the 80% win).** Run-seeded `unique.*`/`seq`/`run.id` generators + per-field `intent` + intent-aware pre-flight validation. Files: `variableEngine.ts`, `scriptMaterializer.ts`, `routes.ts`, `DataBindings.tsx`, small schema (`mappings.intent`, `batches.run_token`). Risk: Low–Medium. **Directly solves the rerun-collision problem for create flows.**
- **Phase 2 — Ledger + result gate.** `automation_run_data`, ledger write pre-dispatch, result gate + stop-on-failure, retained-on-failure data. Files: schema/repository, `routes.ts`, `jobService.ts`, UI result view. Risk: Medium.
- **Phase 3 — Ephemeral teardown.** `dataTeardownService.ts` (API/DB), `data_policy`, cleanup_status tracking. Risk: Medium.
- **Phase 4 — Pooled datasets.** Row consumption state + selection that skips consumed rows. Risk: Medium.
- **Phase 5 — faker breadth + variable library UI.** Realistic generator catalog surfaced in the palette. Risk: Low.

## 13. Estimated effort

Phase 1: ~1–2 days · Phase 2: ~2 days · Phase 3: ~2–3 days · Phase 4: ~1–2 days · Phase 5: ~1 day. Each phase is independently shippable and flag-gated.

---

## 14. UI/UX architecture (product design)

### 14.1 Product principles

1. **Zero-typing mapping.** The primary path is drag-and-drop; typing is always optional. A user should be able to go upload → auto-map → run without a keyboard.
2. **The template closes the loop.** Download an Excel whose **headers are exactly the recording's field names**, fill it, re-upload → columns line up 1:1 with fields, so drag-drop is trivial and **Auto-map** just works.
3. **Direct manipulation.** Data lives as physical chips you can pick up and drop onto a field. Strong affordances (grip handle, grab cursor), a drag ghost, a highlighted snap target, and an undoable result.
4. **Show the real value.** Every bound field renders a live **→ resolved preview** for the current row, so users see actual data (including fresh unique values) before running.
5. **Intent is a first-class, color-coded control.** Fixed / Unique / Reference is visible and switchable per field; the UI prevents the misconfiguration that breaks reruns.
6. **Accessible equivalent for everything.** Every drag has a click/menu/keyboard equivalent (WCAG 2.2 — no drag-only actions).

### 14.2 Overall layout (three zones: toolbar · split · run bar)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Automation Data · Data-Driven Runs                                                         │
│ Recording [ Login flow        ▾ ]   Dataset [ signups.xlsx · 250 ▾ ]   Agent [ WIN-01 ▾ ] │
│ ┌ Template & data ───────────────────────────────────────────────────────────────────────┐│
│ │  ⬇ Download Excel template     ⬆ Upload / re-upload .xlsx/.csv     ⇄ Auto-map by name    ││
│ └────────────────────────────────────────────────────────────────────────────────────────┘│
├───────────────────────────────── LEFT ┃ RIGHT split ────────────────────────────────────── ┤
│ RECORDED FIELDS  (drop targets)        ┃  DATA POOL  (drag sources)                          │
│ 3/5 bound · 2 need data                ┃  [ Columns ][ Rows ][ Variables ][ + Manual ]       │
│                                        ┃                                                     │
│ ┌────────────────────────────────────┐ ┃  Search […………]        250 rows · 5 columns          │
│ │ ⠿ Email or Username    ● UNIQUE ▾  │ ┃  ┌───────────┐┌───────────┐┌───────────┐            │
│ │   ƒx {{unique.email}}          🗑  │◀──┃─ ⠿ Email    ││ ⠿ Username ││ ⠿ Password │  drag me   │
│ │   → qa+3fz9-2@example.test         │ ┃  │  email     ││  text      ││  text      │            │
│ └────────────────────────────────────┘ ┃  └───────────┘└───────────┘└───────────┘            │
│ ┌────────────────────────────────────┐ ┃  ┌───────────┐┌───────────┐                         │
│ │ ⠿ Password             ○ FIXED ▾   │ ┃  │ ⠿ Plan     ││ ⠿ FullName │                         │
│ │   [ Sup3rSecret!        ]  ↶  ↷    │ ┃  │  text      ││  text      │                         │
│ └────────────────────────────────────┘ ┃  └───────────┘└───────────┘                         │
│ ┌────────────────────────────────────┐ ┃  ── Variables (drag onto a field) ──────────────    │
│ │ ⠿ Full name            ○ FIXED ▾   │ ┃  {{unique.email}} {{unique.username}} {{seq}}        │
│ │   ▓ drop a column or variable here ▓│ ┃  {{faker.firstName}} {{faker.lastName}} {{today}}   │
│ └────────────────────────────────────┘ ┃                                                     │
├────────────────────────────────────────┸──────────────────────────────────────────────────┤
│ PREVIEW row [ 2 ]/250 · fresh unique data every run   [ Run all ] [ Run selected ] [ Range ]│
└──────────────────────────────────────────────────────────────────────────────────────────── ┘
```

### 14.2.1 Responsive behavior (no fixed ratio, no manual resize)

The split is **intrinsically responsive** — a CSS grid with `minmax()` tracks that auto-fit the viewport and collapse to tabs when there isn't room. The user never sets a ratio or drags a divider; it always fits their screen.

```
WIDE  ≥1280px (monitors)      grid: minmax(440px,1fr)  minmax(360px,440px)
┌───────────────────────┬───────────────┐  Fields pane flexes to fill; data pool caps ~440px so
│  RECORDED FIELDS       │  DATA POOL     │  chips never stretch. Both fully visible. Drag-drop.
│  (flex, fills space)   │ (capped width) │
└───────────────────────┴───────────────┘

MEDIUM  900–1280px (laptops)  grid: minmax(360px,1fr)  minmax(300px,360px)
┌──────────────────┬───────────┐  Tighter; data-pool chips wrap 2-up; still side-by-side drag-drop.
│ RECORDED FIELDS  │ DATA POOL  │
└──────────────────┴───────────┘

NARROW  <900px (small laptops / tablets / phones)  → STACKED TABS
┌───────────────────────────────┐  One pane at a time via a segmented control. Cross-pane drag is
│ [ ● Fields ]  [ Data ]        │  impossible when stacked, so mapping switches to TAP-TO-ASSIGN:
├───────────────────────────────┤    • tap a field → bottom sheet of columns + variables → pick
│ ⠿ Email or Username  ●UNIQUE▾ │    • or tap a column → "Map to…" → pick a field
│   ƒx {{unique.email}}         │  A sticky "picked: Email ✕" chip lets you tap targets rapidly.
│   → qa+3fz9-2@example.test    │
└───────────────────────────────┘
```

Rule: one responsive layout, three intrinsic modes chosen by container width — never by device sniffing, never by a stored preference.

### 14.3 Left — recorded-field card states

```
UNBOUND (empty drop target)                 BOUND to a column (fixed)
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│ ⠿ Full name           ○ FIXED ▾    │      │ ⠿ Plan                ○ FIXED ▾     │
│  ┌──────────────────────────────┐  │      │  ƒx {{Plan}}                    🗑  │
│  │ ▓ drop a column / variable ▓ │  │      │  → Pro           (from column)      │
│  └──────────────────────────────┘  │      └────────────────────────────────────┘
│  or type a value  ↶  ↷             │
└────────────────────────────────────┘

BOUND to a generator (unique)               INVALID (unique bound to static data)
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│ ⠿ Email or Username   ● UNIQUE ▾   │      │ ⠿ Email or Username   ● UNIQUE ▾    │
│  ƒx {{unique.email}}            🗑  │      │  ƒx {{Email}}                   🗑  │
│  → qa+3fz9-2@example.test           │      │  ⚠ Unique fields must generate     │
│    (fresh each run)                 │      │     fresh data — pick a generator. │
└────────────────────────────────────┘      └────────────────────────────────────┘
   ● green = Unique   ○ grey = Fixed   ◐ blue = Reference
```

### 14.4 Right — data-pool tabs

```
[ Columns ]  chips, draggable, 1 per spreadsheet column, with inferred kind + "⋮ Map to…" menu
[ Rows ]     the imported grid (read-only preview, 50 rows, virtualized), row checkboxes for run
[ Variables] generator chips: {{unique.*}} {{faker.*}} {{seq}} {{run.id}} {{today}} … draggable
[ + Manual ] inline editable grid — add/edit/delete rows by hand; no file needed

+ Manual entry  (rows are UNSAVED until you click Save — nothing is stored automatically)
┌────┬───────────────────┬───────────┬───────────┬───────────┐
│ #  │ Email or Username │ Password  │ Full name │ Plan      │   ← headers mirror field names
├────┼───────────────────┼───────────┼───────────┼───────────┤
│ 1  │ ada@corp.test     │ ••••••••  │ Ada L.    │ Pro       │  [🗑]
│ 2  │ [ type…         ] │ [ type… ] │ [ type… ] │ [ Pro ▾ ] │  [🗑]
└────┴───────────────────┴───────────┴───────────┴───────────┘
 ● Unsaved · 2 rows      [ + Add row ]   [ Discard ]   [ 💾 Save as dataset ]
 └ used for this run only unless saved; Save prompts for a dataset name.
```

### 14.5 Drag-and-drop interaction (the core gesture)

```
1 IDLE            2 PICK UP (grab)        3 HOVER TARGET (snap)          4 DROPPED (bound + toast)
┌───────────┐     ┌───────────┐           ┌────────────────────────┐    ┌────────────────────────┐
│ ⠿ Email   │     │ ⠿ Email  ✋│  ─drag→   │ ⇢ ┏━━━━━━━━━━━━━━━━━━━━┓ │    │ ƒx {{Email}}        🗑 │
│  email    │     │  email    │           │   ┃ Full name  «drop» ┃ │    │ → ada@corp.test        │
└───────────┘     └───────────┘           │   ┗━━━━━━━━━━━━━━━━━━━━┛ │    │ ✓ "Full name" bound    │
   cursor: grab      ghost follows            target glows + dashed        undo in toast (5s)  ↩
```

### 14.6 Auto-map (payoff of the template)

```
⇄ Auto-map by name — REVIEW before applying (the USER decides; nothing binds until Apply)
┌───────────────────────────────────────────────────────────────────────────────┐
│ Field              Suggested binding             Intent      Use?             │
│ Email or Username  {{unique.email}}  (generate)  ● unique    [✓]  [ column ▾ ]│  ← unique cols
│ Password           Password          (column)    ○ fixed     [✓]              │    SUGGEST a
│ Plan               Plan              (column)     ◐ reference [✓]              │    generator; user
│ Full name          FullName          (column)    ○ fixed     [✓]              │    can switch to the
│ Country            — no match —                   —           [ pick ▾ ]      │    raw column.
│                                              [ Apply selected ]   [ Cancel ]  │
└───────────────────────────────────────────────────────────────────────────────┘
Matching: exact header → case/space-insensitive → fuzzy (Levenshtein). Every suggested binding is a
checkbox the user can uncheck or override — Auto-map never binds silently.
```

### 14.7 Excel template loop (download → fill → re-upload)

The template is generated **from the selected recording**, so headers == field labels and mapping is 1:1.
Two sheets: **Data** (what the importer reads) and **Guide** (human hints; ignored by the importer).

```
FILE:  signups__login-flow__template.xlsx

Sheet 1 · "Data"  (importer reads this; row 1 = headers = field names; NO fake data rows)
┌───────────────────┬───────────┬───────────┬───────────┐
│ Email or Username │ Password  │ Full name │ Plan      │  ← headers only; user types real rows below
├───────────────────┼───────────┼───────────┼───────────┤
│  ⌟ cell note on each header (hover): "ada@corp.test — unique; leave blank to auto-generate"     │
└───────────────────┴───────────┴───────────┴───────────┘
   Examples live as Excel cell NOTES on the header cells, not as a data row that could be run by
   accident. In-app, the ⬇ Download button shows a one-line how-to:
   ┌──────────────────────────────────────────────────────────────────────┐
   │ ⬇ Template ready.  1 Fill the "Data" sheet  2 Re-upload here          │
   │                    3 Auto-map → Run.  Leave unique cells blank.       │
   └──────────────────────────────────────────────────────────────────────┘

Sheet 2 · "Guide"  (instructions only — never imported)
┌───────────────────┬───────────┬──────────┬───────────────────────────────────────────┐
│ Field             │ Intent    │ Required │ Tip                                       │
├───────────────────┼───────────┼──────────┼───────────────────────────────────────────┤
│ Email or Username │ unique    │ yes      │ Leave blank to auto-generate fresh emails │
│ Password          │ fixed     │ yes      │ Same value every run                      │
│ Plan              │ reference │ yes      │ Must be a plan that already exists        │
└───────────────────┴───────────┴──────────┴───────────────────────────────────────────┘

FLOW:  [⬇ Download template] → user fills "Data" → [⬆ Upload] → [⇄ Auto-map] → [⏵ Run]
```

Constraint: the importer must read the worksheet named **"Data"** (falling back to the first sheet) so the "Guide" sheet is never parsed as data. `unique`-intent columns may be left blank in the sheet — the generator fills them per run.

### 14.8 Empty / onboarding states

```
NO DATASET YET (right pane)                       NO RECORDING SELECTED (whole body)
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│            ▟▙  Data pool               │          │        Select a recorded script       │
│  Drop an .xlsx/.csv here, or          │          │  to bind its fields to test data.     │
│  ⬇ Download the template to start.    │          │        [ Choose recording ▾ ]         │
│  [ ⬆ Upload ]   [ + Manual entry ]    │          └──────────────────────────────────────┘
└──────────────────────────────────────┘
```

### 14.9 Accessibility & keyboard path (no drag required)

- Column chip → `⋮ Map to…` menu lists every field; field card → `Bind ▾` lists every column + variable.
- Full keyboard DnD: focus a chip → `Space` lifts → `Tab`/arrows move to a field → `Space` drops (ARIA live region announces "Email bound to Full name").
- Color is never the only signal: intent shows a text label (UNIQUE/FIXED/REFERENCE) plus the ● ○ ◐ glyph.
- Drop targets have visible focus rings; the resolved-preview line is an `aria-live` status.

### 14.10 UI constraints (hard requirements)

1. Split is **intrinsically responsive** (CSS grid `minmax()` tracks) — no fixed ratio, no manual resize handle; auto-collapses to stacked **Fields/Data** tabs under ~900px, where mapping becomes tap-to-assign (§14.2.1).
2. Drag payload carries a typed token (`column` | `variable`); dropping a `column` on a `unique` field warns rather than silently mis-binding.
3. Large uploads: parse client-side stream, virtualize the grid (never render 100k DOM rows); show an import progress bar.
4. Every mapping action is undoable (toast + `Ctrl/Cmd-Z`); nothing is destructive without confirm.
5. Template filename encodes dataset + recording; re-upload of an edited template re-imports without losing existing mappings (mappings key on field name, not column id).
6. Live resolved-preview must reflect the actual run seed, so users see the *unique* value they'll get — not a placeholder.

### 14.11 UI implementation phases (interleaves with §12)

- **UI-1 (with Phase 1):** resizable split, field-intent selector, variables palette, drag-drop column→field + drop-file-to-import, live resolved preview.
- **UI-2 (with Phase 1/2):** **Excel template download** + **Auto-map by name** + invalid-binding inline warnings.
- **UI-3 (with Phase 2):** manual-entry grid + "save as dataset"; batch result/ledger view.
- **UI-4:** keyboard DnD, ARIA live regions, responsive stacked mode, large-file virtualization.

### 14.12 Resolved design decisions (from review)

1. **Responsive, not configurable.** No fixed split ratio and no manual resize handle. One intrinsically responsive layout with three width-driven modes (wide side-by-side · medium tighter · narrow stacked tabs with tap-to-assign). It always fits the user's screen automatically (§14.2.1).
2. **Template has no sample data row.** The "Data" sheet ships headers only; example values live as header **cell notes**, backed by the "Guide" sheet and a one-line in-app how-to. This prevents a stray example row from being executed.
3. **Manual entry never auto-saves.** Hand-typed rows are ephemeral (used for that run only) until the user explicitly clicks **Save as dataset**, which prompts for a name. `Discard` clears them.
4. **Auto-map is a suggestion the user confirms.** It proposes bindings (a generator for `unique` columns, the raw column otherwise) as per-row checkboxes with an override dropdown; nothing binds until **Apply**. The user decides every binding.
