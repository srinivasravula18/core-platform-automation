# Software Requirements Specification — Reusable List View Capability

| | |
|---|---|
| **Document ID** | SRS-LV |
| **Version** | 2.0 |
| **Status** | Draft |
| **Feature** | Reusable List View Capability |

---

## 1. Introduction

### 1.1 Purpose
This SRS defines the required behavior of the **List View capability** — a configurable, reusable record-viewing surface shared across administrative and application screens. It supports saved filters, columns, sharing, sorting, multiple display modes, view preferences, specialized data adapters, and permission-controlled feature access.

### 1.2 Scope
The capability applies wherever a list of records is rendered in the administrative and application surfaces. It covers view provisioning, configuration, rendering/query behavior, permission gating, specialized views, and the embedded Flow list-view selector.

### 1.3 Definitions & Glossary

| Term | Definition |
|---|---|
| **List View** | A saved, named configuration of filters, columns, sorting, sharing, and display mode over a record set. |
| **Navigation Subject** | The administrative area currently active (apps, objects, roles, etc.) that a list view is bound to. |
| **All-Apps Scope** | A view whose records span every application. |
| **Selected-App Scope** | A view whose records are limited to the currently selected application. |
| **Default View** | A system-provisioned view created automatically when no user view exists. |
| **Specialized View** | A view backed by a dedicated data adapter (email logs, access logs, automations, etc.) with its own retrieval limits. |
| **List View Management permission** | The permission that authorizes creating, renaming, cloning, deleting, and reconfiguring views. *(Impl mapping in Appendix B.)* |

### 1.4 Actors & Roles

| Actor | Description | Relevant capability |
|---|---|---|
| **Viewer** | Can read and switch between views permitted to them. Cannot manage views. | Render, search, sort, filter (apply saved), switch, pin. |
| **List View Manager** | A user holding List View Management permission for the active role/app/object. | All Viewer rights **plus** create, rename, clone, delete, and configure (filters, columns, sharing, preferences, display mode, hierarchy, overrides). |
| **System** | Automated provisioning/recovery logic. | Bootstrap default views, recover malformed state, enforce lifecycle guards. |

> **Note on gating:** Throughout this document, "a **List View Manager** may…" means the action requires the List View Management permission for the active context. Feature-flag and view-type constraints further restrict this per requirement.

### 1.5 Requirement Conventions
- Each atomic requirement has a permanent ID: **`LV-<AREA>-NNN`**. IDs are never reused or renumbered; new requirements append.
- Priority uses **MoSCoW** (Must / Should / Could).
- Acceptance criteria are pass/fail. Selected edge cases include Given/When/Then scenarios.
- Internal identifiers (flags, storage keys, DOM hooks) do **not** appear in requirement text; they live in **Appendix B** (implementation mapping) and **Appendix C** (automation locators).

---

## 2. Overall Description

### 2.1 Product Perspective
The List View capability is a cross-cutting surface reused by many administrative subjects. Behavior differs by **navigation subject**, **scope**, **role/app/object feature flags**, and **view type**. A shared rendering surface provides common controls; specialized adapters provide subject-specific data with distinct limits.

### 2.2 Assumptions & Dependencies
- **A1** — A valid authenticated session (token) is available for provisioning and data loads.
- **A2** — Role/application/object feature-flag assignments are provisioned in metadata (see 3.2).
- **A3** — Specialized adapters (email logs, access logs, record access, automations) are available for their respective subjects.
- **D1** — Depends on the permission/feature-flag metadata service as the source of truth for capability availability.
- **D2** — Depends on the sharing service (roles/groups/users picklists) for sharing configuration.

---

## 3. Functional Requirements

### 3.1 Activation & Default View Provisioning

**LV-ACT-001 — Activation by navigation subject** *(Must)*
The system shall activate the list-view capability only when one of the supported navigation subjects is active.
- **Supported subjects:** apps, app_hierarchy, objects, roles, groups, users, tabs, permissions, access_controls, sharing_settings, logs.
- **AC:** For each listed subject the capability activates; for any other subject it does not.

**LV-ACT-002 — All-apps scope subjects** *(Must)*
The system shall render **app, role, group, user, permission, and audit-log** views in all-apps scope (records span all applications).
- **AC:** A view on any of these subjects returns records not limited to the selected application.

**LV-ACT-003 — Selected-app scope subjects** *(Must)*
The system shall render **object, tab, access-record, and sharing-rule** views in selected-app scope (records limited to the active application).
- **AC:** A view on any of these subjects returns only records belonging to the currently selected application.

**LV-ACT-004 — Default view bootstrap eligibility** *(Must)*
The system shall create a default list view **only when all** of the following are true: a valid session token exists; the acting user holds List View Management permission; a supported navigation subject is active; no view is currently loading; and no existing view is available.
- **AC:** If any single condition is false, no default view is created.
- **Scenario:**
  ```gherkin
  Scenario: No default is created when a view already exists
    Given a supported subject is active and the user can manage views
    And at least one list view already exists for that subject
    When the surface initializes
    Then no default list view is created
  ```

**LV-ACT-005 — Default view configuration** *(Must)*
A bootstrapped default view shall initialize with: empty filters combined with AND logic, private sharing, descending sort on creation date, and table display mode.
- **AC:** A newly bootstrapped view exhibits exactly these four defaults.

**LV-ACT-006 — Default view columns** *(Should)*
A bootstrapped default view shall use the configured default column set defined for its subject. *(Source mapping in Appendix B.)*
- **AC:** Default columns match the configured set for the subject.

**LV-ACT-007 — Standard default view names** *(Must)*
The system shall expose the configured standard names for default administrative views.
- **Names:** All Apps, All Objects, All Tabs, All Permissions, All Audit Logs, All Roles, All Groups, All Users, All Access Records, All Sharing Settings.
- **AC:** Each subject's default view displays its corresponding name exactly.

---

### 3.2 Metadata-Gated Feature Availability & Management

**LV-MGMT-001 — Feature flags are the capability source of truth** *(Must)*
The system shall enable or disable each list-view feature according to the feature flags assigned to the current **role, application, and object**.
- **Governed features:** PDF export, CSV export, create view, rename view, clone view, delete view, filters, columns, sharing, sorting, default view mode, column-header filters, hierarchy. *(Flag-name mapping in Appendix B.)*
- **AC:** For each feature, when its flag is disabled for the active role/app/object the feature's controls are not available; when enabled they are available (subject to permission).

**LV-MGMT-002 — Management actions require management permission** *(Must)*
A user shall be able to create, rename, clone, delete, or reconfigure a list view only if they hold List View Management permission for the active context.
- **AC:** Without the permission, all management and configuration-save controls are visibly disabled.
- **Scenario:**
  ```gherkin
  Scenario: Viewer cannot save configuration
    Given a user without List View Management permission
    When they open the list-view settings
    Then all Save controls (filters, columns, sharing) are disabled
    And create, rename, clone, and delete actions are unavailable
  ```

**LV-MGMT-003 — Fallback for missing/invalid selected view** *(Must)*
When a saved-view identifier is missing or invalid, the system shall fall back to the default view, or to the first available view if no default exists.
- **AC:** An invalid/missing view id never produces an error state; a valid view is shown.

**LV-MGMT-004 — Valid selection and searchable selector** *(Should)*
When a saved-view identifier is valid, the selector shall show that view and provide a searchable list of available views.
- **AC:** The selector displays the selected view and filters the available list by typed name.

**LV-MGMT-005 — Selector no-match message** *(Should)*
The view selector shall display **"No matching list views."** when no available view matches the search text.
- **AC:** Searching for a non-existent name shows this exact message.

**LV-MGMT-006 — Nonexistent view mutation error** *(Must)*
An update or clone operation targeting a nonexistent view shall be rejected with the message **"List view not found."**
- **AC:** Update and clone against an invalid target return this exact message and make no change.

---

### 3.3 List View Settings & Configuration

**LV-CFG-001 — Filter configuration** *(Must)*
A List View Manager shall be able to configure and save filters for the active view.
- Controls provided: Filters, Reset to Saved, Clear All, Save Filters.
- Supported logic/operators: AND and OR groups; equals, contains, in, null-check, and date expressions.
- **AC:** Configured filters persist and are applied on next load.

**LV-CFG-002 — Filter validation before save** *(Must)*
Save Filters shall not persist an invalid filter draft; it shall display a validation summary instead.
- **AC:**
  ```gherkin
  Scenario: Invalid filter draft is not saved
    Given a List View Manager has entered an invalid filter draft
    When they select Save Filters
    Then the draft is not persisted
    And a validation summary describing the errors is shown
  ```

**LV-CFG-003 — Column configuration** *(Must)*
A List View Manager shall be able to select, order, label, resize, and wrap the visible columns of the active view.
- Controls provided: Available Columns, Selected Columns, Select all, Clear all, Custom label, Width, Wrap, Save Columns.
- **AC:** Saved column selection, order, labels, widths, and wrap settings apply on next render.

**LV-CFG-004 — Column save requires selection** *(Must)*
Save Columns shall be disabled when no column is selected.
- **AC:** With zero selected columns the Save Columns control is disabled.

**LV-CFG-005 — Sharing configuration** *(Must)*
A List View Manager shall be able to set a view's sharing to **Private**, **Public**, or **Specific** (users, roles, and/or groups).
- Specific sharing provides Roles, Groups, and Users pickers and a Save Sharing control.
- **AC:** The selected sharing mode persists and governs view visibility.

**LV-CFG-006 — Specific sharing requires at least one principal** *(Must)*
Saving Specific sharing shall require at least one selected user, role, or group.
- **AC:** With no principal selected, Specific sharing cannot be saved.

**LV-CFG-007 — Sharing option load/error reporting** *(Should)*
The sharing surface shall report loading and fetch-error states for the sharing-option pickers.
- **AC:** While options load, a loading state is shown; on fetch failure, the returned error is displayed.

**LV-CFG-008 — Pin / unpin** *(Should)*
A List View Manager shall be able to pin or unpin the active view; the control shall read **Pin** or **Unpin** according to the current pinned state.
- **AC:** Toggling updates the pinned state and the control label accordingly.

**LV-CFG-009 — View preferences** *(Should)*
When permitted, a List View Manager shall be able to configure inline editing, column-header filters, grouped initial rows, and the default display mode as view preferences.
- **AC:** Each permitted preference persists per view.

**LV-CFG-010 — Display-mode selection** *(Must)*
A List View Manager shall be able to select the view's default display mode from the modes available to that view.
- **Modes:** table, group, excel, kanban, chart — each subject to the view's available modes and the relevant feature flags.
- **AC:** Only modes both supported by the view and enabled by flags are selectable; the chosen mode becomes the view's default.

**LV-CFG-011 — Hierarchy display selection** *(Could)*
For hierarchy-enabled views, a List View Manager shall be able to select exactly one hierarchy display mode.
- **Choices:** Duplicate Parent – Multiple Rows; Single Parent – Single Row; Single Parent – Multiple Rows; Single Parent – Multiple Child Columns.
- **AC:** Exactly one choice applies at a time.

**LV-CFG-012 — Hierarchy panel availability** *(Could)*
The hierarchy panel shall be unavailable when hierarchy is disabled by feature settings or the view does not support hierarchy.
- **AC:** In either condition the hierarchy panel is not shown.

**LV-CFG-013 — Column-filter row override validation** *(Should)*
Column-filter row overrides shall accept whole numbers from **100 through 2,000** inclusive; otherwise the system shall display **"Enter a whole number between 100 and 2,000"** and reject the value.
- **AC:** 100 and 2,000 are accepted; 99, 2,001, and non-integers are rejected with the exact message.

**LV-CFG-014 — Grouped initial-row override validation** *(Should)*
Grouped initial-row overrides shall accept whole numbers from **1 through 50,000** inclusive; otherwise the system shall display **"Enter a whole number between 1 and 50,000"** and reject the value.
- **AC:** 1 and 50,000 are accepted; 0, 50,001, and non-integers are rejected with the exact message.

**LV-CFG-015 — Remove per-view override** *(Could)*
The **Use default** action shall remove a per-view override and restore the configured default.
- **AC:** After Use default, the view uses the configured default value.

---

### 3.4 Rendering, Query & Interaction Behavior

**LV-REND-001 — Render available display modes** *(Must)*
The system shall render the active view in the selected mode (table, group, excel, kanban, or chart) when that mode is available for the view.
- **AC:** Each available mode renders; unavailable modes are not selectable.

**LV-REND-002 — ID columns hidden** *(Must)*
Rendered list views shall hide ID columns from display.
- **AC:** No ID column is visible in any rendered mode.

Each of the following shared controls is an independently verifiable requirement (LV-REND-003 … LV-REND-018). Each provides the named control on surfaces that support it, subject to permission.

| ID | Control | Priority |
|---|---|---|
| LV-REND-003 | List-view switching | Must |
| LV-REND-004 | Pinning | Should |
| LV-REND-005 | Summary | Could |
| LV-REND-006 | Refresh | Should |
| LV-REND-007 | Settings | Must |
| LV-REND-008 | Export | Should |
| LV-REND-009 | Search | Must |
| LV-REND-010 | Sorting | Must |
| LV-REND-011 | Column resize | Should |
| LV-REND-012 | Column reorder | Should |
| LV-REND-013 | Text wrapping | Could |
| LV-REND-014 | Row selection | Must |
| LV-REND-015 | Row numbers | Could |
| LV-REND-016 | Cell click | Should |
| LV-REND-017 | Cell double-click | Should |
| LV-REND-018 | Inline editing (optional, permission-gated — see LV-PERM-004) | Should |

**LV-REND-019 — Case-insensitive search over configured columns** *(Must)*
Search shall match input against the view's configured searchable columns without case sensitivity, and the result set shall contain only records whose configured-column values match.
- **AC:** Mixed-case input matches records regardless of case; non-matching records are excluded.

**LV-REND-020 — Apply saved/requested filters** *(Must)*
The system shall apply saved or requested filter groups using the configured logical operators (AND/OR) and supported field operators (equals, contains, in, null-check, date expressions).
- **AC:** Result set reflects the combined filter logic exactly.

**LV-REND-021 — Type-appropriate sorting** *(Must)*
The system shall sort results using comparison appropriate to each field's data type: datetime, number, boolean, and text.
- **AC:** Each field type sorts by its typed order, not lexical order (e.g., numbers sort numerically).

**LV-REND-022 — Specialized adapter retrieval limits** *(Must)*
Specialized adapters shall limit retrieval to their configured maxima:

| Specialized type | Max records |
|---|---|
| Email logs | 500 |
| Access logs | 1,000 |
| Record-access logs | 1,000 |
| Automation queries | 500 |

- **AC:** Each adapter returns no more than its stated limit. *(Rationale for limits in Appendix D.)*

**LV-REND-023 — Incremental grouped loading** *(Should)*
Grouped views shall initially load up to the configured grouped initial-row limit, divided evenly across groups, and provide **Load more in a group** to fetch additional records.
- **AC:** Initial load respects the limit and even distribution; Load more retrieves further records for a group.

---

### 3.5 Subject-Specific Permissions & Restrictions

**LV-PERM-001 — Object-list field restrictions** *(Must)*
Object lists shall exclude the access-log-deny field from display and shall prevent editing of the API-name and ID-prefix fields in object-list rows.
- **AC:** The access-log-deny field is not shown; API-name and ID-prefix cells are non-editable.

**LV-PERM-002 — Restricted inline editing / bulk actions** *(Must)*
Inline editing shall be disabled for roles, groups, access records, sharing settings, and audit logs; bulk actions shall be disabled for audit logs.
- **AC:** No editable-cell path is exposed for the listed subjects; no bulk action is available for audit logs.

**LV-PERM-003 — Permissions destructive-action restrictions** *(Must)*
Direct deletion of Permissions shall be prevented; create, selection, and bulk delete shall be disabled during global-search states; and all bulk deletion shall be disabled with the reason **"Permissions can't be deleted directly. Delete the related tab, button, app, or other owning configuration instead."**
- **AC:** No path deletes a Permission directly; the exact disabled reason is shown.

**LV-PERM-004 — Inline-editing eligibility** *(Should)*
Inline editing shall be enabled only for report or object list views that are **not** lookup-only, and only when object settings, field rules, user access, and List View Management permission all permit it. The Preferences control shall be disabled for unsupported view types, lookup-only views, or insufficient permissions.
- **AC:** Inline editing appears only when every listed condition is satisfied; otherwise Preferences is disabled.

---

### 3.6 Specialized Views & Lifecycle Resilience

**LV-SPEC-001 — Specialized default views** *(Must)*
The system shall provide the specialized default views defined by their adapters: My Automations, All Email Logs, All Access Logs, All Record Access, Deleted Records.
- **AC:** Each specialized subject exposes its named default view.

**LV-SPEC-002 — Recover malformed/absent local state** *(Should)*
When specialized locally-stored view data is absent or malformed, the system shall restore default views or preferences and leave the surface usable.
- **AC:**
  ```gherkin
  Scenario: Corrupt stored preferences are recovered
    Given a specialized view's stored data is malformed
    When the surface loads
    Then valid default views/preferences are restored
    And the surface is usable without error
  ```

**LV-SPEC-003 — Protect the last required specialized view** *(Must)*
Deletion of the last email-log, access-log, or record-access list view shall be rejected with **"At least one list view must remain."**
- **AC:**
  ```gherkin
  Scenario: Cannot delete the final required specialized view
    Given only one Email Log list view exists
    When a manager attempts to delete it
    Then deletion is blocked
    And "At least one list view must remain." is shown
    And the view still exists
  ```

**LV-SPEC-004 — Empty and fetch-error states** *(Should)*
When list-view data is unavailable or loading fails, the system shall display the appropriate empty or returned-error state.
- **AC:** Empty data shows the applicable empty state; a fetch failure shows the returned error message.

---

### 3.7 Embedded Flow List-View Selection

**LV-FLOW-001 — Selection anchors** *(Should)*
The embedded Flow list-view editor shall expose Object, List view, and Controls sections. *(DOM hook mapping in Appendix C.)*
- **AC:** All three sections are present in the editor.

**LV-FLOW-002 — Loading / empty placeholders** *(Should)*
The Flow editor shall show the appropriate selection placeholder while loading or when no choice is available: **Select an object**, **No objects available**, **Loading list views…**, **Select a list view**, **No list views available**.
- **AC:** Each placeholder appears in its corresponding state.

**LV-FLOW-003 — Skip load without required context** *(Must)*
The Flow editor shall not issue a list-view load when a session token or a selected object is unavailable; it shall remain in its unavailable/empty state.
- **AC:** With no token or no object, no list-view load occurs.

**LV-FLOW-004 — Flow fetch-error message** *(Should)*
When Flow list-view loading fails, the editor shall display the returned fetch-error message.
- **AC:** A failed load shows the returned error text.

---

## 4. Business Rules (Cross-Cutting Invariants)

These are truths that span multiple requirements. (Rules that map 1:1 to a single requirement have been promoted into that requirement and are not repeated here.)

- **BR-1** — Feature availability is always determined by role/app/object feature flags; flags are the single source of truth. *(governs LV-MGMT-001, LV-CFG-010)*
- **BR-2** — ID columns are never displayed in any mode. *(LV-REND-002)*
- **BR-3** — Scope is fixed per subject: all-apps for app/role/group/user/permission/audit-log; selected-app for object/tab/access-record/sharing-rule. *(LV-ACT-002/003)*
- **BR-4** — A configuration draft that fails validation is never persisted (filters, columns, sharing). *(LV-CFG-002/004/006)*
- **BR-5** — At least one list view must always remain for email-log, access-log, and record-access subjects. *(LV-SPEC-003)*
- **BR-6** — Permissions can never be deleted directly. *(LV-PERM-003)*
- **BR-7** — All user-facing error and empty-state strings are fixed and defined in the Error Catalog (Section 6).

---

## 5. Non-Functional Requirements

**LV-NFR-001 — Performance (grouped/large views)** *(Should)*
Grouped views loading up to their configured initial-row limit (max 50,000) shall render the first screen within an agreed performance budget *(target: TBD — define per environment)*, using incremental "Load more" rather than a single unbounded fetch.
> *Rationale for caps:* the 50,000 grouped-row and 2,000 column-filter limits exist to bound client memory and render time; see Appendix D.

**LV-NFR-002 — Security / authorization** *(Must)*
View visibility shall be enforced server-side according to sharing configuration (Private/Public/Specific). A Private view shall not be retrievable by a user who is not its owner or a designated principal, including by direct identifier reference.
- **AC:** Requesting another user's Private view by id is denied.

**LV-NFR-003 — Audit-log integrity** *(Must)*
Audit-log views shall be read-only (no inline edit, no bulk actions), consistent with LV-PERM-002, and shall not permit mutation through any list-view path.

**LV-NFR-004 — Concurrency** *(Should)*
Concurrent edits to the same shared view's configuration shall not silently lose data; the system shall apply a defined conflict policy *(policy: TBD — last-write-wins vs. optimistic version check)*.

**LV-NFR-005 — Accessibility** *(Should)*
List-view grids and controls shall be operable by keyboard and expose accessible names/roles to assistive technology (labels catalogued in Appendix C).

**LV-NFR-006 — Resilience** *(Should)*
Absent or malformed locally-stored view state shall never render the surface unusable (see LV-SPEC-002).

> Items marked *TBD* are open decisions to be resolved before this SRS exits Draft.

---

## 6. Error & Empty-State Catalog

All user-facing strings, in one place, so tests assert against a single source.

| ID | Trigger | Exact text | Req |
|---|---|---|---|
| ERR-1 | Update/clone a nonexistent view | `List view not found.` | LV-MGMT-006 |
| ERR-2 | Delete last required specialized view | `At least one list view must remain.` | LV-SPEC-003 |
| ERR-3 | Bulk-delete a Permission | `Permissions can't be deleted directly. Delete the related tab, button, app, or other owning configuration instead.` | LV-PERM-003 |
| ERR-4 | Column-filter override out of range | `Enter a whole number between 100 and 2,000` | LV-CFG-013 |
| ERR-5 | Grouped initial-row override out of range | `Enter a whole number between 1 and 50,000` | LV-CFG-014 |
| ERR-6 | Selector search with no match | `No matching list views.` | LV-MGMT-005 |
| EMPTY-1 | Flow: no objects | `No objects available` | LV-FLOW-002 |
| EMPTY-2 | Flow: no views | `No list views available` | LV-FLOW-002 |
| STATE-1 | Flow: loading views | `Loading list views…` | LV-FLOW-002 |
| PH-1 | Flow: object prompt | `Select an object` | LV-FLOW-002 |
| PH-2 | Flow: view prompt | `Select a list view` | LV-FLOW-002 |

---

## Appendix A — Requirements Traceability Matrix (template)

| Req ID | Requirement (short) | Priority | Test Case ID(s) | Defect ID(s) | Status |
|---|---|---|---|---|---|
| LV-ACT-001 | Activation by subject | Must | *(TC-…)* | | |
| LV-ACT-002 | All-apps scope subjects | Must | | | |
| LV-ACT-003 | Selected-app scope subjects | Must | | | |
| LV-ACT-004 | Default bootstrap eligibility | Must | | | |
| LV-ACT-005 | Default view configuration | Must | | | |
| LV-ACT-006 | Default view columns | Should | | | |
| LV-ACT-007 | Standard default view names | Must | | | |
| LV-MGMT-001 | Feature flags source of truth | Must | | | |
| LV-MGMT-002 | Management permission gate | Must | | | |
| LV-MGMT-003 | Fallback for missing/invalid view | Must | | | |
| LV-MGMT-004 | Valid selection & searchable selector | Should | | | |
| LV-MGMT-005 | Selector no-match message | Should | | | |
| LV-MGMT-006 | Nonexistent view mutation error | Must | | | |
| LV-CFG-001 | Filter configuration | Must | | | |
| LV-CFG-002 | Filter validation before save | Must | | | |
| LV-CFG-003 | Column configuration | Must | | | |
| LV-CFG-004 | Column save requires selection | Must | | | |
| LV-CFG-005 | Sharing configuration | Must | | | |
| LV-CFG-006 | Specific sharing requires principal | Must | | | |
| LV-CFG-007 | Sharing option load/error reporting | Should | | | |
| LV-CFG-008 | Pin / unpin | Should | | | |
| LV-CFG-009 | View preferences | Should | | | |
| LV-CFG-010 | Display-mode selection | Must | | | |
| LV-CFG-011 | Hierarchy display selection | Could | | | |
| LV-CFG-012 | Hierarchy panel availability | Could | | | |
| LV-CFG-013 | Column-filter override range | Should | | | |
| LV-CFG-014 | Grouped initial-row override range | Should | | | |
| LV-CFG-015 | Remove per-view override | Could | | | |
| LV-REND-001 | Render available display modes | Must | | | |
| LV-REND-002 | ID columns hidden | Must | | | |
| LV-REND-003…018 | Shared list-view controls | Must/Should/Could | | | |
| LV-REND-019 | Case-insensitive search | Must | | | |
| LV-REND-020 | Apply saved/requested filters | Must | | | |
| LV-REND-021 | Type-appropriate sorting | Must | | | |
| LV-REND-022 | Adapter retrieval limits | Must | | | |
| LV-REND-023 | Incremental grouped loading | Should | | | |
| LV-PERM-001 | Object-list field restrictions | Must | | | |
| LV-PERM-002 | Restricted inline edit / bulk | Must | | | |
| LV-PERM-003 | Permissions non-deletable | Must | | | |
| LV-PERM-004 | Inline-editing eligibility | Should | | | |
| LV-SPEC-001 | Specialized default views | Must | | | |
| LV-SPEC-002 | Recover malformed local state | Should | | | |
| LV-SPEC-003 | Last specialized view guard | Must | | | |
| LV-SPEC-004 | Empty and fetch-error states | Should | | | |
| LV-FLOW-001 | Selection anchors | Should | | | |
| LV-FLOW-002 | Loading / empty placeholders | Should | | | |
| LV-FLOW-003 | Skip load without context | Must | | | |
| LV-FLOW-004 | Flow fetch-error message | Should | | | |
| LV-NFR-001…006 | Non-functional requirements | Must/Should | | | |

> Fill Test Case IDs during test design; the matrix is the coverage proof for sign-off/audit.

---

## Appendix B — Implementation Mapping (requirement → code identifier)

*Kept separate so requirement text stays implementation-independent. Update this appendix on refactors; requirements above stay stable.*

| Requirement concept | Internal identifier |
|---|---|
| List View Management permission | `listViewManageAllowed` |
| Default column source | `adminDefaultListViews` |
| Default sort field | `created_at` (descending) |
| Feature flags | `download_pdf`, `download_csv`, `create_list_view`, `rename_list_view`, `clone_list_view`, `delete_list_view`, `filters`, `columns`, `sharing`, `sorting`, `default_view_mode`, `column_header_filters`, `hierarchy` |
| Object-list excluded field | `access_log_deny` |
| Non-editable object fields | `api_name`, `id_prefix` |
| View available-modes source | `availableViewModes` |
| Flow list-view field hook | `#flow-list-view` |
| Live metadata catalog | `metadataRefs` (currently empty — live catalog unavailable at capture time) |

---

## Appendix C — Automation Locators

The full aria-label / label / DOM-id / CSS-class / placeholder / field-id inventory belongs to the test-automation layer, not the requirements. It is maintained as page-object data and referenced by requirement ID where relevant (e.g., LV-FLOW-001 → `#flow-list-view`). Retain the captured locator list here verbatim for the automation team.

**aria-labels:** About attachment content search | About auto refresh | About record update refresh | Access | Access log denies cost information | Access logging cost information | Active object | Add Users | Add attachment | Agent panel options | Allowed Keystone themes | Apply all changed fields | Apps | Attachment field | Auto arrange options | Auto refresh interval unit | Available fields | Boolean value | Bulk inline edit actions | Changed field comparison | Chart | Checkbox value | Checkbox values | Choose voice reply

**labels:** API Name | Access | Access Level | Access log allows | Access log denies | Action | Actions | Active | Allow cancel | Allow decimals | Allowed Objects | Allowed file types | Allowed upload categories | App | Approval action | Attachment content search enabled | Behavior | Boolean input | Button Color | Code (TypeScript) | Compiled Expression | Component Type | Condition (formula) | Conditions

**ui hooks:** admin:button type="button" | admin:button role="option" type="button" | admin:button role="radio" type="button" | admin:button type="submit" | (repeating admin:button variants)

**css ids:** #access-record-object | #access-record-principal-id | #access-record-principal-type | #admin-email-template-body-template | #admin-email-template-trigger-events-error | #admin-pref-date-format | #admin-pref-page-size | #admin-pref-theme | #attachment-existing-search | #attachment-existing-upload-category | #attachment-existing-upload-notes | #attachment-upload-category | #attachment-upload-notes | #bulk-update-field | #bulk-update-value | #button-api | #button-behavior | #button-color | #button-component-type | #button-component-value | #button-component-value-error | #button-component-value-help | #button-help-text | #button-label

**css classes:** .access-controls-card-copy | .access-controls-card-title | .access-controls-download-logging-card | .access-controls-permissions-layout | .access-controls-right-stack | .access-permission-heading | .access-permission-help | .access-permission-label | .action-summary-anchor | .active | .activeDetailTab | .admin-access-log-detail-body | .admin-access-log-detail-header | .admin-access-log-detail-summary | .admin-access-log-detail-title | .admin-access-log-user-agent | .admin-active-sessions-panel | .admin-agent-panel | .admin-agent-surface | .admin-apps-primary-tabs | .admin-confirm-error | .admin-detail-audit-list-region | .admin-email-log-detail-label | .admin-email-log-status

**placeholders:** 1 AND (2 OR 3) | 1 OR (2 AND 3) | 500, true, or text | Add note | Choose a REST API | Core Platform | Custom label | Custom value, for example values.callbackToken | Default | Default (Apr 15, 2023) | Enter N | Enter a fixed value when not using a source | Enter a new password | Enter a plate or analysis plate id | Enter a temporary password | Enter a value | Enter number | Enter record id when not using a source | Enter value | Enter your password | Example: --allow-conflicts --industry-suite-mode auto | Explain what this app is for and when users should use it. | Explain what this button does and when users should use it. | Explain what this field means and how users should fill it.

**field ids:** Access=>#share-access-level | Access Level=>#create-sharing-rule-access-level | Access log allows=>#create-object-access-log-allow | Access log denies=>#create-object-access-log-deny | Action=>#create-permission-action | Active=>#flow-create-active | Allow cancel=>#flow-create-cancel | Allow decimals=>#field-number-allow-decimals | Allowed file types=>#field-file-extensions | Allowed upload categories=>#field-file-categories | API Name=>#button-api | API Name=>#create-app-api | API Name=>#create-object-api | API Name=>#create-tab-api | API Name=>#edit-tab-api | API Name=>#field-api-name | API Name=>#field-api-name-readonly | API Name=>#flow-create-api-name | App=>#create-group-app | App=>#create-object-app | App=>#create-role-app | Attachment content search enabled=>#create-object-attachment-content-search

---

## Appendix D — Rationale for Numeric Limits (open)

| Limit | Value | Rationale | Status |
|---|---|---|---|
| Email/automation adapter | 500 | Bound payload/render cost | Confirm |
| Access/record-access adapter | 1,000 | Bound payload/render cost | Confirm |
| Column-filter override | 100–2,000 | Bound client-side filter cost | Confirm |
| Grouped initial rows | 1–50,000 | Bound initial DOM/memory footprint | Confirm |
