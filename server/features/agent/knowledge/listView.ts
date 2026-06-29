import type { FeatureKnowledge } from './types';

/**
 * Shared List View — used by BOTH Admin and Keystone (they render the same
 * `@core-platform/list-view` ListViewObjectHome). Source: packages/list-view/src/components/
 * (ListViewToolbar.tsx, ListViewObjectHome.tsx, ListViewBody.tsx, ListViewSettingsModal.tsx,
 * ColumnFilterHeaderAction.tsx) + shared DataTable in packages/ui/src/index.tsx.
 */
export const listViewKnowledge: FeatureKnowledge = {
  id: 'list-view',
  title: 'List View (shared grid/toolbar — Admin & Keystone)',
  apps: ['admin', 'keystone'],
  navigation:
    'The same list-view component renders for most Admin sections (Apps, Objects, Tabs, Users, Roles, etc. at /?nav=<key>&appId=) and for Keystone object tabs. It is the grid + toolbar a user sees after opening a section/object.',
  matchTerms: [
    'list view', 'list-view', 'listview', 'grid', 'table', 'column', 'columns', 'sort', 'sorting',
    'filter', 'export', 'search', 'refresh', 'select all', 'row', 'rows', 'pagination', 'pin', 'view mode',
    'fit columns', 'resize column', 'bulk', 'records', 'settings',
  ],
  uiLevel: `TOOLBAR CONTROLS (real accessible names — these are mostly ICON buttons with NO visible text, so locate by getByRole/getByLabel, NEVER getByText):
- Named-view dropdown: aria-label="List view: <name>" (visible <label> "List view"); opens role="listbox" "List views" with role="option" per view.
- Pin/Unpin: "Pin list view" / "Unpin list view" (icon).
- View mode: "Select view mode" (icon) → menu items "Table" / "Kanban" / "Chart". (There is NO "Summary" mode.)
- Selection counter (visible text): "<n> of <m> <entity> selected" e.g. "0 of 6 apps selected"; "No records found" when empty.
- Search: an input with placeholder "Search results" (NO aria-label — locate by placeholder/role=searchbox).
- New/Create: aria-label & text "New" (default of createButtonLabel).
- Bulk Delete: aria-label & text "Delete"; when nothing selected the guard tooltip is the literal (misspelled) "Please select atleast one record."
- Refresh: "Refresh list view" (icon).
- Actions/overflow menu: aria-label="List view actions" (icon) → items: "New", "Rename", "Clone", "Delete", "Settings". (This is the "more"/"settings"/"options" menu — it is NOT labelled "More".)
- Fit columns (auto-resize): "Fit columns" (icon).
- Export: trigger aria-label "Export options" (icon) → dialog "Export Records": Format radios CSV/PDF/XLSX, Scope "All records"/"Filtered records", criteria checkboxes; primary button "Export CSV"/"Export PDF"/"Export XLSX".
GRID:
- Column sort: click the column HEADER button (its accessible name = the column label); a sort indicator (asc/desc) appears on the active column. There is no separate "sort" button.
- Column filter: funnel icon aria-label="Filter <Column>" → role="dialog" "<Column> filter" (distinct-values or manual-rule modes; footer "Clear filter"/"Cancel"/"Apply").
- Column resize handle: role="separator" aria-label="Resize <Column> column".
- Select-all checkbox (header): aria-label="Select all rows". Individual ROW checkboxes have NO accessible name — locate by row (e.g. page.locator('tr',{hasText}).locator('input[type=checkbox]')).
- No page-size dropdown in the grid; infinite scroll "Load more" footer button.
SETTINGS MODAL ("List View Settings", opened via List view actions → Settings): left-nav panels "Filters" / "Columns" / "Sharing" / "Preferences" / "Hierarchy". Each panel has its OWN save: "Save Filters" / "Save Columns" / "Save Sharing" / "Save Sorting" / "Save Hierarchy". There is NO single "Apply all changed fields" button. SORTING is configured under Preferences → Sorting (field select + radiogroup aria-label="Sort order" Ascending/Descending + "Add Sort Field" + "Save Sorting"). NOTE: "Default List View Page Size" is an app-level Preferences control in Keystone (aria-label="Default List View Page Size"), NOT in this modal.`,
  codeLevel: `Key files: packages/list-view/src/components/ListViewToolbar.tsx (toolbar, ~lines 638-1145), ListViewSettingsModal.tsx (settings panels + per-panel saves), ColumnFilterHeaderAction.tsx (column filter), packages/ui/src/index.tsx (DataTable: select-all ~5341 "Select all rows", sort header ~5393-5410, resize ~5450 "Resize <col> column").
Rules: most toolbar controls disable while bulkActionBusy; Delete disabled (with the "atleast one record" tooltip) when no rows selected; Fit columns enabled only in table mode; Export disabled unless exportAllowed; view-mode menu only when >1 mode.`,
  intentMap: [
    { saysAny: ['settings', 'options', 'configure', 'list view settings'], realControl: 'getByRole("button",{name:"List view actions"}) then the "Settings" item', accessFlow: 'click "List view actions" (the overflow/actions icon) → click "Settings" → the "List View Settings" modal opens on the Filters panel' },
    { saysAny: ['more', 'overflow', '⋯', 'actions menu', 'kebab'], realControl: 'getByRole("button",{name:"List view actions"})', accessFlow: 'it is the actions/overflow icon button; open it to reach New/Rename/Clone/Delete/Settings' },
    { saysAny: ['resize columns', 'fit', 'autosize', 'auto-size'], realControl: 'getByRole("button",{name:"Fit columns"})', accessFlow: 'single icon button in the toolbar (table mode only)' },
    { saysAny: ['export', 'download', 'csv', 'pdf', 'xlsx'], realControl: 'getByRole("button",{name:"Export options"}) → dialog → "Export CSV"/"Export PDF"/"Export XLSX"', accessFlow: 'open "Export options" → choose format/scope → click "Export <FORMAT>"; assert the download event' },
    { saysAny: ['refresh', 'reload'], realControl: 'getByRole("button",{name:"Refresh list view"})', accessFlow: 'single icon button' },
    { saysAny: ['sort', 'order by', 'sort direction'], realControl: 'the column header button (name = column label)', accessFlow: 'click the column header to toggle asc/desc; assert the sort indicator / row order' },
    { saysAny: ['select all', 'check all'], realControl: 'getByRole("checkbox",{name:"Select all rows"})', accessFlow: 'header checkbox; row checkboxes have no name (scope by row text)' },
    { saysAny: ['new', 'create', 'add record'], realControl: 'getByRole("button",{name:"New"})', accessFlow: 'primary toolbar button' },
    { saysAny: ['delete', 'remove', 'bulk delete'], realControl: 'getByRole("button",{name:"Delete"})', accessFlow: 'select row(s) first; with none selected it is guarded with tooltip "Please select atleast one record."' },
  ],
  testNotes: `ASSERTIONS: export → assert the download event (page.waitForEvent("download")); sort → assert order/indicator changed; selection → assert the "<n> of <m> ... selected" counter text; setting change → reopen Settings and assert it persisted. NEVER assert transient toasts or hover-only tooltips. DISAMBIGUATE repeated cell text (record names) with .first() or a row-scoped locator (strict-mode matches 2+). WAITS: after navigation wait for grid rows (table tbody tr / [role=row]) — NEVER networkidle (the app keeps streams open). The grid shows "Loading records…" while fetching.`,
};
