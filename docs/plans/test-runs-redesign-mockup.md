# Test Runs Redesign — ASCII Mockup

Companion to `test-runs-lineage-scale-accessibility-architecture-plan.md`. Illustrative only — no code changes.

## A. Test Runs — List View (redesigned)

```
┌─ Test Runs ──────────────────────────────────────────────────────────────────────────────┐
│ Search runs...        [Plan ▾] [Suite ▾] [Status ▾] [Mode ▾] [Tags ▾]     ☑ 12 selected    │
│                                                          [ Run Selected (12) ] [ Delete ]  │
├───┬──────┬────────────────────────┬──────────┬──────────────────────────┬────────┬────────┤
│ ☑ │ Run  │ Name                   │ Mode     │ Lineage                 │ Status │ Result │
├───┼──────┼────────────────────────┼──────────┼──────────────────────────┼────────┼────────┤
│ ☑ │ ▶    │ Checkout regression #42│ Automated│ Release 3.2 › Checkout   │ Done   │ 41/42 ✓│
│ ☑ │ ▶    │ Nightly smoke          │ Automated│ Release 3.2 › Smoke      │ Running│ 8/20   │
│ ☐ │ ▶    │ Manual OTP walkthrough │ Manual   │ Auth Hardening › Login   │ Paused │ 3/9    │
│ ☐ │ ▶    │ List view ad-hoc run   │ Manual   │ (no suite) · 2 cases     │ Draft  │ —      │
│ ☐ │ ▶    │ Refunds full pass      │ Automated│ Release 3.2 › Payments   │ Failed │ 12/30 ✗│
│ …   (virtualized — only visible rows are mounted; scroll loads more, no page limit)       │
├───┴──────┴────────────────────────┴──────────┴──────────────────────────┴────────┴────────┤
│ Showing 40 of 312 runs · ↑↓ move row · Enter run · Space select · Home/End jump           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- **Lineage column** replaces the old single "Suite" text column — shows `Plan › Suite` (or `(no suite) · N cases` for ad-hoc manual runs), truncated with a tooltip/click-through to the full breadcrumb.
- Row count footer + keyboard hints appear because rows are virtualized (only ~40 mounted at a time regardless of 312 total) and because the table now supports roving-tabindex keyboard navigation.
- Everything else (search, filters, bulk select, Run Selected, per-row ▶ Run icon) is the existing behavior, unchanged — this is a re-skin of the table, not a new interaction model.

## B. Test Run — Detail View (redesigned header)

```
┌─ ← Back to Test Runs ──────────────────────────────────────────────────────────────────────┐
│ Checkout regression #42                                    [Automated]  [ Re-run ] [ ⋮ ]   │
│                                                                                              │
│ Release 3.2  ›  Checkout Suite  ›  42 cases                          (breadcrumb, clickable)│
│                                                                                              │
│ ┌─ Linked entities ────────────────────────────────────────────────────────────┐  ▾ expand  │
│ │  Plan:    Release 3.2                            → open plan                │            │
│ │  Suite:   Checkout Suite (42 cases)               → open suite              │            │
│ │  Cases:   42 linked · 3 also appear in "Regression Pack" suite → view       │            │
│ │  Evidence: 41 screenshots captured this run       → view evidence           │            │
│ └───────────────────────────────────────────────────────────────────────────────┘           │
│                                                                                              │
│ ── Results ──────────────────────────────────────────────────────────────────────────────── │
│  [existing ManualRunner / automated results table renders below, unchanged]                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- Replaces today's single `Plan: X` label with a clickable breadcrumb plus a collapsible "Linked entities" panel — computed client-side from data already loaded, no new API calls.
- Everything below the panel (ManualRunner for manual runs, the case results table for automated runs) is untouched.

## C. Run trigger — preview step (new, inside RunModeModal)

```
┌─ Run "Release 3.2" ───────────────────────────────────────────────────────────────┐
│  Mode:  ( ) Manual   (•) Automated        Execution: (•) Headless  ( ) Headed     │
│                                                                                     │
│  This will run 216 cases across 6 suites:                              [ show ▾ ] │
│  ┌───────────────────────────────────────────────────────────────────────────┐    │
│  │ Checkout Suite (42) · Payments Suite (30) · Auth Suite (18) · +3 more     │    │
│  └───────────────────────────────────────────────────────────────────────────┘    │
│                                                                                     │
│                                                    [ Cancel ]   [ Run 216 cases ]  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- New: the resolved case/suite count and expandable breakdown, so triggering a plan-level run never silently launches an unexpectedly large batch.
- Confirm button labels the actual count (`Run 216 cases`) instead of a generic "Run" — same underlying `POST /api/runs/from-selection` call, just informed by the count now shown.
