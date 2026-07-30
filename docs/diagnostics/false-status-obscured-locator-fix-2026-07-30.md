# False "Could not click Status button — timeout" — root cause & fix

Date: 2026-07-30. Class: false product defect from an obscured/mis-grounded locator.

## Symptom

A generated step `role=button[name="Status"]` clicked the grid **column header** behind the open
Create-Record modal. The header is obscured by the overlay → `locator.click` times out (10s) → the run
auto-files it as a product bug ("Step N — Could not click the 'Status' button — took too long"). The app was
actually correct: the real field is `#create-status` — a custom `<button>` combobox, label **"Status \*"**,
inside the modal and on top.

## Root cause (mechanistic, proven)

- `semanticNameFrom` in `graph/evidenceGraph.ts` strips the required-field `*`, so the field **"Status \*"**
  and the grid header **"Status"** both reduce to the handle **"Status"**.
- `uniqueSemantic` gives the clean handle "Status" to whichever node registers **first**. The resting list is
  explored before the modal is opened, so the **header wins** the clean name and the field is demoted to
  **"Status_2"**.
- `groundingEngine.resolveTarget` then exact-matches the plan target "Status" to the **header** — it did
  count-only matching and ignored `EvidenceNode.stateTag` (`'form'` vs `'page'`).

Same underlying cause behind the sibling false failures (toBeHidden modal-close, toHaveValue "",
row-on-detail): the locator/oracle was authored from a lossy, name-keyed model instead of the structural,
dialog-scoped truth.

## Fix (3 files; app-agnostic — no label/selector hardcoded)

1. **`graph/groundingEngine.ts` — `preferFormField()`.** When an exact name matches a resting-`page` node but
   exactly **one** trusted `stateTag:'form'` sibling shares the base name (suffix `_2` and trailing `* : ( )`
   stripped), resolve to the **field**. → "Status" now yields `#create-status`. Deterministic; only ever swaps
   to a fully verified node, so a genuine page-only target is untouched.
2. **`compiler/missionRunner.template.ts` — `reclassifyIfObscured()`.** Relabels an **already-failed** click
   whose element sits behind an open overlay as `TOOLING_OBSCURED [tooling]`. Never pre-empts a click that
   would succeed. ARIA/overlay heuristics only.
3. **`workflow/defectReporter.ts` — `classifyErrorKind` → `'tooling-obscured'`**, added to
   `NON_PRODUCT_DEFECT_KINDS` so a tooling fault is never auto-filed as a product defect. Genuine timeouts
   still file.

## Verification

- Unit tests: `scripts/test-grounding-engine.ts` (name-collision → in-modal field `#create-status`, form-
  scoped; page-only target unaffected) — 16/16 green. `scripts/test-defect-reporter.ts` (tooling-obscured
  gate) — 43/43 green.
- Live vs SUT: OLD `role=button[name="Status"]` count=0 / timeout; NEW `#create-status` clicks and opens the
  dropdown.

## Status & remaining gaps

- The three code changes are **uncommitted**; the local backend and the deployed environment run the old
  code until **restarted / redeployed** (server code has no hot-reload) — which is why the bug still
  reproduces live.
- **Not covered by this fix** (separate classes): (a) a validation assert that demands an error on a
  **validly-filled** form ("no error appeared"); (b) the failure-card readability (raw Playwright log dump /
  mislabeling).
