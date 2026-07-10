# Core Platform App Knowledge for Playwright Automation

## Purpose

This pack is for AI automation agents testing `C:\repos\core-platform`.
It is grounded in repo source, existing Playwright coverage, and live UI exploration of the local stack on 2026-07-08.
Use it as operational context for Admin (`http://localhost:5002`) and Keystone / Shockwave runtime (`http://localhost:5003`), backed by App Service (`http://localhost:5001` in UI-facing local dev).

## Verified environment assumptions

- Local UI topology expected by the frontends:
  - App Service: `http://localhost:5001`
  - Admin: `http://localhost:5002`
  - Keystone runtime: `http://localhost:5003`
- Credentials must come from the configured credential store or authenticated storage-state setup, not from this knowledge pack.
- Authentication is rate-limited. Repeated fresh UI logins will trigger `Too many requests. Please retry later.`
- Preferred automation pattern:
  - create one authenticated storage state per run
  - reuse it across Admin and Keystone tests
  - avoid logging in in every test
- Local recovery when auth is rate-limited:
  - `npm run test:e2e:agent-api:reset-auth`

## Application overview for automation

Core Platform has two primary browser surfaces:

- **Admin App**
  - metadata control plane
  - manages apps, objects, tabs, flows, roles, groups, users, permissions, access records, logs, scheduler, system settings
- **Keystone / Shockwave**
  - runtime business-data workspace
  - renders app launcher, object tabs, list views, record pages, flows, search, recycle bin, data import, agent surfaces

Shared behavior across both surfaces:

- login form with heading `Sign in`
- strong reliance on metadata-driven list views and record layouts
- many surfaces are SPA-style state transitions controlled by query params, not full page route changes
- list views, filters, columns, sharing, preferences, and empty states are reused platform patterns

## Authentication and startup rules

- Do not assume the UI will work if App Service is on `:2000`; the frontends explicitly tried `http://localhost:5001` during live exploration.
- Stable login locators:
  - heading: `getByRole('heading', { name: /sign in/i })`
  - username: `getByLabel(/email or username/i)`
  - password: `getByLabel(/password/i)`
  - submit: `getByRole('button', { name: /sign in/i })`
- Keystone tests already use the following session markers:
  - cookie: `cp_access_token`
  - cookie: `cp_refresh_token`
  - sessionStorage: `core_platform.auth_token`
  - sessionStorage: `core_platform.current_username`
- For Keystone, a strong readiness hook exists in source/tests:
  - `[data-permissions-loaded="true"]`

## High-value route model

### Admin route shape

Admin is query-param driven from `/`.
Observed and source-backed params:

- `nav`
- `appId`
- `id`
- `subTab`
- `fieldId`
- `layoutId`
- `formId`

Observed examples:

- `/?nav=apps&appId=app0000001`
- `/?nav=objects&appId=app0000001`
- `/?nav=scheduled_jobs&appId=app0000001`

Important `nav` values verified from source or live UI:

- `apps`
- `objects`
- `tabs`
- `flows`
- `roles`
- `groups`
- `users`
- `permissions`
- `access_records`
- `sharing_settings`
- `scheduled_jobs`
- `system_settings`
- `system_info`
- `logs`-style areas are present in the sidebar, but exact internal keys for every log surface were not fully verified live

### Keystone route shape

Keystone is also query-param driven from `/`.
Observed and source-backed params:

- `appId`
- `view`
- `tab`
- `object`
- `id`
- `q`
- `flowSessionId`
- `flowId`
- `subObject`
- `subId`
- `subview`
- `subListView`
- `subWidget`
- `subLabel`
- `subFilterSummary`
- `subFilters`
- `ids`
- `payload`

Verified `view` values from source:

- `list`
- `record`
- `tab`
- `search`
- `agent`
- `data_import`
- `recycle_bin`
- `flows`
- `flow_run`

Observed examples:

- list page: `/?appId=app0000002&view=list&tab=tab0000186&object=agent_automation_rule`
- record page: `/?appId=app0000002&view=record&tab=tab0000004&object=project&id=prjaaaaaab`

## Reusable layout patterns

### Admin

- left sidebar uses `.admin-sidebar`
- sidebar buttons are reliable by visible text, for example `Apps`, `Objects`, `Scheduled Jobs`
- page content often renders as a list-view panel with:
  - title text
  - short description
  - list view selector
  - bulk action status line (`0 of N selected`)
  - action buttons like `New`, `Delete`
- modals are common and nested modals exist
  - verified example: `New App` -> `Select App Icon`

### Keystone

- top bar contains app/tab context, search help, user menu, and agent entry
- launcher menus use:
  - `.launcher-panel`
  - `.launcher-item`
- list pages may render as:
  - standard table
  - grouped card/kanban-style board
  - empty state
- record pages contain stacked collapsible sections:
  - `Details`
  - `System details`
  - `Related lists`
  - `Attachments`
  - `Audit log`
- nested list views can exist inside record pages, especially audit sections

## Verified page behavior

### Admin: Apps

- default local post-login landing observed at `nav=apps`
- table headers were present, but accessible names included width markers such as `LabelW` and `API NameW`
- implication: avoid exact accessible-name matching on Admin column headers
- global search placeholder observed as `Global Search`

### Admin: Objects

Observed live:

- description: `Metadata-defined business objects in the selected scope.`
- list view label: `All Objects`
- selected-state banner: `0 of 138 objects selected`
- actions: `New`, `Delete`, dropdown buttons
- table data is real and loaded
- clicking rows is expected to open detail context; existing test coverage looks for `Close Asset` on detail open

Useful selectors:

- sidebar nav: `.admin-sidebar`
- list search: `.list-view-search input.input`
- list panel: `section.panel` filtered by heading text
- table: role `table`

### Admin: Scheduled Jobs

Observed live:

- route: `?nav=scheduled_jobs&appId=app0000001`
- summary stats render above the list:
  - `Due`
  - `Running`
  - `Error`
  - worker status
- page description: `Create minute-level recurring jobs, monitor runs, and inspect logs.`
- list includes real rows and columns such as:
  - `Name`
  - `Job Type`
  - `Schedule`
  - `Status`
  - `Enabled`
  - `Next Run`
  - `Last Run`

Create modal behavior observed:

- opened from `New`
- heading text appears in body as `Create Scheduled Job`
- fields rendered include:
  - `Name *`
  - `Schedule (cron)`
  - `Misfire Policy`
  - `Description`
  - `Run As User *`
  - `Code *`
  - `Retry Policy JSON`
- actions:
  - `Verify Code`
  - `Cancel`
  - `Create Job`

Automation note:

- this surface includes textarea/code-editor behavior and scheduler-specific validation; when selector grounding is ambiguous, use Playwright MCP for DOM inspection before scripting editor interactions.

### Keystone: Automations list view

Observed live at startup:

- active app label: `Operations Hub`
- object/tab label: `Automations`
- route rendered as list view on `agent_automation_rule`
- empty-state message: `No records found`
- list view actions menu opens entries:
  - `New`
  - `Rename`
  - `Clone`
  - `Delete`
  - `Settings`
- settings modal heading: `List View Settings`
- settings tabs observed:
  - `Filters`
  - `Columns`
  - `Sharing`
  - `Preferences`
  - `Grouping`
  - `Hierarchy`
- empty filter state inside settings:
  - `No filters defined.`

### Keystone: Projects list view

Observed route:

- `?appId=app0000002&view=list&tab=tab0000004&object=project`

Important rendering behavior:

- despite `view=list`, the page rendered as a grouped card/board layout, not a table
- grouping controls shown:
  - `Group by`
  - `Status`
  - `Cards per lane`
- cards were clickable by visible record title, for example `Sterility Study`

Implication:

- query params alone do not guarantee table mode
- persisted list-view preferences can override the visual presentation
- if the test needs tabular rows, explicitly switch view mode rather than assuming `view=list` implies a table

### Keystone: Project record page

Observed after opening `Sterility Study`:

- route changed to `view=record` with `id=prjaaaaaab`
- top workspace tabs showed both object tab and record tab
- actions present:
  - `Merge`
  - `Share`
  - `Edit`
  - `Delete`
- main sections:
  - `Details`
  - `System details`
  - `Related lists`
  - `Attachments`
  - `Audit log`
- audit log area rendered its own list-view toolbar and initially showed `Loading records...`

Important async implication:

- the record page can look "loaded" while nested sections are still fetching
- do not treat first visible content as the end of rendering for nested widgets

### Keystone: Project create form

Observed from `New` on Projects:

- create surface appears inline/overlay while list page remains visible behind it
- visible texts:
  - `New Projects`
  - `Create Record`
- actions:
  - `Cancel`
  - `Create`
  - `Create & New`

Validation behavior verified:

- submitting empty form showed inline field errors:
  - `Name is required.`
  - `Project Code is required.`
- a summary banner also appeared:
  - `Review the following fields before continuing.`
- required errors were duplicated in both field-level and summary-level areas

### Keystone: Project edit form

Observed from record page `Edit`:

- edit mode kept the same URL
- section body switched from static values to inline editors
- save controls surfaced at the bottom:
  - `Cancel`
  - `Save`
- lookup field example:
  - `Select Site`
  - `Clear selected lookup`

Implication:

- do not expect a dedicated edit route or modal
- same-page morph from read mode to edit mode is common

## Table and list-view behavior

Shared patterns from live exploration and test coverage:

- list view selector: `select#list-view`
- search input: `.list-view-search input.input`
- refresh action: button name `/refresh list view/i`
- actions menu: button name `/list view actions/i`
- menu panel class: `.settings-menu-panel`
- empty state class: `.empty-state`
- table containers: `.object-home .list-view-table-wrap > table`, `.object-home .table-wrap > table`
- toolbar containers: `.list-view-toolbar`, `.list-view-bar`
- selection counter: `.list-view-selection-count`
- view-mode trigger: button name `/select view mode/i`
- export actions: button names `/export csv/i` and `/export pdf/i`

Capabilities verified from tests/source:

- search
- saved view switching
- create/rename/clone/delete list views
- filters
- columns
- sharing
- preferences
- grouping
- hierarchy
- view-mode switching
- export actions on supported objects
- inline editing on supported tables

Important rendering rule:

- a list view may render as table, board, chart, or empty state
- robust tests should wait for either the intended structure or a known alternate state

Recommended wait pattern:

- for table-oriented flows, race on:
  - first table visibility
  - empty-state visibility
  - permission-denied / error visibility

## List-view contracts

These contracts are verified by Core Platform list-view regression coverage and should be preferred before inventing selectors.

### UI selectors

- current list view selector: `select#list-view`
- search input: `.list-view-search input.input`
- toolbar scope: `.list-view-toolbar, .list-view-bar`
- table scope: `.object-home .list-view-table-wrap > table, .object-home .table-wrap > table`
- object-home scope: `.object-home`
- object api marker: `.object-home[data-object-api-name]`
- empty state: `.empty-state`
- selection count: `.list-view-selection-count`
- settings/action menu panel: `.settings-menu-panel`
- list actions trigger: `getByRole("button", { name: /list view actions/i })`
- list view trigger fallback: `getByRole("button", { name: /^list view:/i })`
- refresh trigger: `getByRole("button", { name: /refresh list view|refresh/i })`
- view mode trigger: `getByRole("button", { name: /select view mode/i })`
- table mode option: `getByRole("button", { name: "Table" })`
- export CSV trigger: `getByRole("button", { name: /export csv/i })`
- export PDF trigger: `getByRole("button", { name: /export pdf/i })`
- inline edit trigger: `button[aria-label="Edit cell"]`
- permission/error fallback: `.permission-denied, [role="alert"], .error`

### Settings modal

- modal heading: `getByRole("heading", { name: /list view settings/i })`
- tabs: `Filters`, `Columns`, `Sharing`, `Preferences`, `Grouping`, `Hierarchy`
- columns expanders: buttons named `/available columns/i` and `/selected columns/i`
- save buttons: `/save columns/i`, `/save sharing/i`
- sharing control: `getByLabel(/sharing scope/i)`
- preferences section: `.preferences-section`
- pin controls: buttons named `/pin|unpin/i`

### List-view CRUD dialogs

- open actions first: click `getByRole("button", { name: /list view actions/i })`, then wait for `.settings-menu-panel`
- scope all menu item clicks to `.settings-menu-panel`; do not click unscoped `New`, `Delete`, `Settings`, or `Rename`
- create action: `.settings-menu-panel` scoped button named `/new|create/i`
- rename action: `.settings-menu-panel` scoped button named `Rename`
- clone action: `.settings-menu-panel` scoped button named `Clone`
- delete action: `.settings-menu-panel` scoped button named `Delete`
- settings action: `.settings-menu-panel` scoped button named `Settings`
- export actions can appear either as toolbar buttons or `.settings-menu-panel` scoped buttons named `/export csv/i` or `/export pdf/i`
- dialog/headings after actions: `/new list view/i`, `/rename list view/i`, `/clone list view/i`, `/delete list view/i`, `/list view settings/i`
- name field: `getByLabel(/list view name/i)`
- successful create/rename/clone proof: `select#list-view` contains the expected name
- successful delete proof: `select#list-view` no longer contains the deleted name

### API contracts

- list apps: `GET /api/apps`
- list objects: `GET /api/apps/{appId}/objects`
- object describe: `GET /api/apps/{appId}/objects/{objectApi}`
- list views: `GET /api/apps/{appId}/objects/{objectApi}/list-views`
- create list view: `POST /api/apps/{appId}/objects/{objectApi}/list-views`
- update list view: `PATCH /api/apps/{appId}/objects/{objectApi}/list-views/{listViewId}`
- delete list view: `DELETE /api/apps/{appId}/objects/{objectApi}/list-views/{listViewId}`
- clone list view: `POST /api/apps/{appId}/objects/{objectApi}/list-views/{listViewId}/clone`
- preferences: `GET/PUT /api/apps/{appId}/objects/{objectApi}/list-views/preferences`
- query rows/cards/chart data: `POST /api/apps/{appId}/objects/{objectApi}/list-views/query`
- export: `POST /api/apps/{appId}/objects/{objectApi}/list-views/export`
- bulk actions: `POST /api/apps/{appId}/objects/{objectApi}/list-views/bulk`

### Query payload facts

- pagination uses `pagination.page` and `pagination.page_size`
- search uses `search`
- sort uses `sort: [{ field, direction: "asc" | "desc" }]`
- filters use `filters.logic`, `filters.filters`, and nested `filters.groups`
- date filters support `op: "date_expr"` with values such as `THIS_YEAR`
- summary supports `summary.fields` and `summary.operations`
- chart mode uses `view_mode: "chart"` with `chart.group_by`, `chart.operation`, and `chart.bucket`
- kanban mode uses `view_mode: "kanban"` with `kanban.group_by` and `kanban.limit_per_lane`

## Forms, dialogs, and drawers

Observed patterns:

- Admin uses modal stacks; inner modal close should not be confused with outer modal close
- icon picker uses custom classes:
  - `.tab-icon-picker-modal-body`
  - `.tab-icon-picker-select`
  - `.tab-icon-picker-actions`
- Admin create/edit app modal class:
  - `.new-app-modal`
- Keystone record create/edit forms are often inline panels rather than route changes
- field-level required markers use `*` in visible labels, but not all fields expose reliable `<label>` text

Recommended interaction approach:

- prefer role/name selectors when unique
- fall back to stable container classes scoped to the current modal/panel
- for nested modal flows, scope every selector to the active dialog root

## Async and loading behavior

Verified or source-backed behaviors:

- auth can be rate-limited
- permissions readiness in Keystone can be synchronized with `[data-permissions-loaded="true"]`
- nested record sections may load after the primary record shell
- list views can repaint after:
  - app switch
  - tab switch
  - settings save
  - view-mode switch
  - record create/update/delete

Wait guidance:

- after login, wait for a stable shell button, not just URL change
- after switching apps/tabs, wait for either:
  - `select#list-view`
  - object-home/table/board content
  - explicit empty state
- after opening a record, wait for a section heading such as `Details` plus at least one field value or section control
- after save/create, wait for either:
  - success state in the page
  - record tab/title presence
  - list refresh with changed row/card content

## Stable locator guidance

Use these first:

- login labels and buttons by role/name
- Admin sidebar buttons by exact visible text
- Keystone topbar app/tab buttons by visible text
- list view actions by role/name
- settings modal heading `List View Settings`
- record page section names: `Details`, `System details`, `Related lists`, `Attachments`, `Audit log`
- explicit action buttons: `New`, `Create`, `Create & New`, `Edit`, `Save`, `Cancel`, `Delete`, `Share`, `Merge`

Good structural selectors when role/text is insufficient:

- `.admin-sidebar`
- `.launcher-panel`
- `.launcher-item`
- `.list-view-search input.input`
- `.settings-menu-panel`
- `.empty-state`
- `.record-section-header`
- `.shockwave-info-dialog-heading`
- `.shockwave-info-dialog-list`
- `.new-app-modal`
- `.tab-icon-picker-modal-body`

## Stable DOM selector contracts

These selectors are source/test-backed and stable enough to use as scoped anchors. They should guide script generation, but live DOM or Playwright MCP must still verify visibility, uniqueness, and current page state before execution.

### Admin shell

- shell sidebar: `.admin-sidebar`
- shell main area: `.admin-main`
- sidebar nav: `page.locator(".admin-sidebar").getByRole("button", { name: "<section>" })`
- list panel scope: `page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "<panel>" }) })`
- generic modal scope: `.modal, [role="dialog"]`

### Admin app and metadata modals

- app create/edit modal: `.new-app-modal`
- icon picker body: `.tab-icon-picker-modal-body`
- icon cards: `.tab-icon-picker-modal-body .icon-card`
- icon select button: `.tab-icon-picker-select`
- icon picker actions: `.tab-icon-picker-actions`

### Admin flow and layout designers

- flow section name input: `input.flow-section-input`
- flow section add button: `button.flow-section-add-button`
- flow section controls: `.flow-section-controls select`
- flow field span control: `.flow-field-span-control select`
- layout designer section: `.layout-designer-section`
- layout section input: `.layout-designer-section-input`
- layout section controls: `.layout-designer-section-controls select`

### Keystone shell and launchers

- permissions ready marker: `[data-permissions-loaded="true"]`
- app launcher panel: `.launcher:not(.tabs-picker) .launcher-panel`
- tab launcher panel: `.launcher.tabs-picker .launcher-panel`
- launcher items: `.launcher-panel .launcher-list .launcher-item`
- app/tab launcher item fallback: `.launcher-item`

### Keystone list and object home

- object home root: `.object-home`
- current object API name: `.object-home[data-object-api-name]`
- table fallback: `.object-home .list-view-table-wrap > table, .object-home .table-wrap > table`
- list toolbar: `.list-view-toolbar, .list-view-bar`
- list search: `.list-view-search input.input`
- list actions button: `getByRole("button", { name: /list view actions/i })`
- view-mode menu button: `getByRole("button", { name: /select view mode/i })`
- export CSV action: `getByRole("button", { name: /export csv/i })`
- settings menu panel: `.settings-menu-panel`
- empty state: `.empty-state`
- permission/error fallback: `.permission-denied, [role="alert"], .error`
- inline cell edit: `button[aria-label="Edit cell"]`

### Keystone records and forms

- record page anchors: `.record-tabs, .record-panel, .record-page`
- record field container: `.record-field`
- record displayed value: `.record-value`
- field assertion pattern: `.record-field` scoped by exact field label, then `.record-value`
- lookup select action: button text such as `Select Site`
- lookup clear action: button text such as `Clear selected lookup`

### Keystone flows and custom panels

- flow panel roots: `.shockwave-flow-panel, .shockwave-flows-home`
- flow step fields: `.shockwave-flow-step-fields input`
- data import panel: `.data-import-panel`
- custom tab panel: `.custom-tab-panel`
- agent workspace: `[aria-label="Keystone Agent workspace"]`

## Dynamic locator strategies for hard surfaces

- **Duplicate buttons**
  - `Edit`, `Delete`, `Cancel`, and unnamed `▾` buttons appear multiple times
  - always scope to the nearest panel, dialog, row, or section
- **Admin tables**
  - column header accessible names may contain width suffixes like `LabelW`
  - prefer partial text or raw DOM text, not exact ARIA name equality
- **Grouped list views**
  - when no table exists, use card text or lane headings
  - do not assume `table tbody tr` exists
- **Lookup fields**
  - buttons like `Select Site` and `Clear selected lookup` are more stable than trying to target hidden inputs
- **Nested list views**
  - record audit sections contain embedded list-view toolbars; scope under the section before searching for search boxes or menus
- **Launcher menus**
  - use `.launcher-panel .launcher-item` after opening the corresponding trigger button

## Known fragile areas and anti-patterns

- Repeated login in each test will cause auth failures due to rate limiting.
- Query params do not fully determine rendered list-view mode because saved preferences can win.
- Unnamed chevron buttons (`▾`) are common; avoid using bare ordinal clicks unless scoped and verified.
- Not every page exposes a clean `h1`.
- Some create/edit flows are inline state transitions, not navigations or dialogs.
- Record pages can show primary content before nested widgets finish loading.
- Admin and Keystone rely on large monolithic components; DOM structure can be deep and locally inconsistent even when labels stay stable.

## Recommended Playwright patterns

- Build shared storage state once per run.
- On Keystone shell startup, prefer waiting for `[data-permissions-loaded="true"]` or a known topbar button.
- For list views:
  - wait for one of table, empty state, or alternate view container
  - explicitly switch to table mode when row-based assertions are needed
- For record pages:
  - open by visible title/card/row text
  - wait for section headers and a stable action button
- For forms:
  - trigger the action
  - wait for the form-specific button set (`Create`, `Create & New`, `Save`, `Cancel`)
  - validate both inline errors and summary banners
- For modal stacks:
  - locate the active dialog root first
  - keep all subsequent queries scoped under that root

## Recommended Playwright MCP usage points

Use Playwright MCP instead of guessing when:

- a button has only chevron text or no useful accessible name
- a list view renders in a non-table visualization and card structure is unclear
- a custom editor is present, especially scheduler code areas
- a nested modal/drawer stack makes it ambiguous which container is active
- an inline edit control appears only on hover or through row-level affordances
- a record section has hidden or lazy-mounted content

## Example agent heuristics before generating tests

1. Confirm which surface is under test: Admin or Keystone.
2. Reuse existing authenticated state; do not relogin unless required.
3. Read the current URL query params to understand intended context.
4. Verify the rendered mode instead of trusting the query params.
5. Prefer visible labels and role selectors first.
6. If labels are duplicated, scope to panel, dialog, row, or section.
7. For list views, detect `table` vs grouped cards vs empty state before acting.
8. After record open, wait for section content and not just the route change.
9. Treat inline validation and summary validation as separate assertions.
10. If the DOM shape is still unclear, switch to Playwright MCP for grounding instead of inventing selectors.

## Unknown or not fully verified

- Exact DOM structure of every Admin nav area beyond Apps, Objects, and Scheduled Jobs
- Exact internal `nav` key for every log surface
- Full behavior of dashboard tabs and custom tabs in Keystone
- Full selector model for flows designer canvas interactions
- Whether all objects support the same create/edit inline panel pattern

When a flow touches one of these areas, inspect live DOM first and extend this pack from observed behavior instead of assuming consistency.
