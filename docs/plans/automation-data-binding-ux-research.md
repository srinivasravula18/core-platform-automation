# Automation Data — Binding UX Research (how the best tools do it)

Source: deep-research pass (105 agents, 23 sources fetched, 25 claims adversarially verified 3-0). Vendor primary docs. 2026-07-31.
Purpose: ground the Automation Data redesign in how leading tools solve column→field binding, because our current drag-and-drop screen tests as confusing.

## The headline (and it contradicts our current design)

**The best tools do NOT use drag-and-drop as the primary binding gesture.** They converge on a **menu/insert-picker**: a `+` / "Add value" affordance *inside the target field* that opens a dropdown of available sources.

- Zapier: click "the plus sign icon in the field you want to map… select one or more fields from a previous step." Mapped values become **colored pills**; plain typed text is a static literal. [zapier]
- BrowserStack Low-Code: click **+** → "Import a value from test data" → pick dataset → pick column → Import. Explicitly menu-driven, **no drag-and-drop**. [browserstack]
- UiPath Apps: binding via Data-source + Value-bind picker fields, not drag. [uipath]

Our screen offers drag pills **+** a bind menu **+** auto-map — three competing models at once. That is the root of the "I don't know which is going to work" feeling. **Commit to the menu-picker as the primary model; keep drag as a secondary accelerator at most.**

## Verified patterns worth adopting

1. **Insert-picker over drag.** Anchor on the target field; a `+`/"Get value from" control opens the source menu. [zapier, browserstack, uipath]

2. **Pills = varies per run; plain text = same every run.** Every dynamic value renders as a colored/typed pill, visually distinct from literal text. Zapier explicitly teaches this static-vs-dynamic contract — exactly our users' "real column vs fake value" confusion. [zapier, browserstack]

3. **Explicit source *types*, not a vague "bind."** Katalon's Variable Binding table lets each variable pick a **binding type**: Data Column (by header) / Data Column Index (by position) / Default / Script Variable. Transferable: offer a small explicit set — **real column / generated / unique-per-run / derived expression** — so the value's *kind* is visible, never guessed. [katalon]

4. **Name-match auto-map as the fast path.** Katalon "Map All" when headers = variable names; mabl binds purely by exact name match; TestComplete auto-names columns from the header row. Offer one-click auto-map, **partial with visible confidence** — fill confident matches, flag the rest. Avoid Flatfile's all-or-nothing (a documented friction point). [katalon, mabl, testcomplete, flatfile]

5. **Derived values get a first-class Expression Builder** — autocomplete, syntax checking, and **per-row live preview** against real input columns (Azure Data Factory). This is the right home for Age-from-DOB: not another pill through the same drag mechanism, but a dedicated editor showing the computed result before you commit. [adf]

6. **Split "field mapping" from "value mapping."** Flatfile separates *which column feeds a field* from *how source values map to a field's allowed options* (e.g. "United States"→"US"). For our dependent-dropdown/enum fields, don't overload one "bind." [flatfile]

7. **The row is the consistency unit — say so.** "One run per row" is universal (TestComplete, mabl name rows as *scenarios*). Because a whole row runs together, **Country/State/City from the same row stay consistent by construction.** Surface "this will run N times" and name rows as scenarios. [testcomplete, mabl]

8. **Smooth the on-ramp.** Auto-detect "first row = headers" (default-on), show a preview, let column names drive auto-map — before the mapping step users struggle with. [katalon, testcomplete]

## What this changes in our plan

- **Phase-2 interaction model flips**: primary gesture becomes the in-field **`+` "Get value from"** picker (categories: Column · Generated · Unique · Derived), not drag-onto-row. Our existing chip/pill model (`FieldChips.tsx`) is *validated* — keep pills, change how they're *created*.
- **Terminology**: drop "bind"/"faker". Use "Get value from", "Same for every row" (literal) vs "Varies per row" (mapped), "Generated", "Computed".
- **Derived values** get their own expression editor with live preview, not a pill.
- **Auto-map** stays but becomes partial + confidence-labelled.

## Caveats (from the research itself)

- All 25 claims are vendor primary docs, verified for *mechanism*, but **self-reported** — no independent A/B study proves menu-picker is objectively "most intuitive." It's strong *convergent-practice* evidence (what the leaders all do), not a controlled finding.
- The explicit usability-critique sources (forums/reviews) largely didn't survive verification, so pitfall guidance is inferred (overloaded "bind", Flatfile all-or-nothing) rather than from cited complaints.

## Sources

- Zapier — Send data between steps by mapping fields
- BrowserStack — Low-Code Automation: data-driven testing
- UiPath Apps — Work with data source and value bind
- Katalon — Manage data binding / DDT best practices
- mabl — Managing test data-driven variables / Getting started with DDT
- TestComplete (SmartBear) — Excel storages
- Flatfile — Mapping concepts / Automap plugin
- Azure Data Factory — Data flow expression builder
