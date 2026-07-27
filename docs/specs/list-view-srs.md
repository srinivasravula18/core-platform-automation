# Software Requirements Specification — Reusable List View Capability

| | |
|---|---|
| **Document ID** | SRS-LIST-VIEW |
| **Version** | 3.0 |
| **Status** | Code-grounded (Draft) |
| **Feature** | Reusable List View Capability |
| **Grounding** | Verified against `packages/list-view`, `apps/admin`, `apps/shockwave`, `apps/service/src/list-views` — see Appendix E for file:line evidence. |

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

### 1.6 How to Read This Document (plain-language guide)

This is a formal specification, so it uses some standard requirements-engineering terms. If a word below is unfamiliar, this table is the plain-English translation. (The terms in §1.3 are *feature* terms; these are *document/technical* terms.)

| Term you'll see | In plain English |
|---|---|
| **Requirement / "The system shall…"** | One rule the software must obey. "Shall" is the formal way of saying "must". |
| **Atomic requirement** | One rule per line — not two things bundled together — so each can be tested and ticked off on its own. |
| **Acceptance criteria (AC)** | The pass/fail test for a requirement: "if you do X, you must see Y." How we prove the rule is met. |
| **Given / When / Then (Gherkin)** | A tidy way to write a test scenario: *Given* a starting situation, *When* the user does something, *Then* this must happen. |
| **MoSCoW (Must / Should / Could)** | Priority. **Must** = required; **Should** = important but not a blocker; **Could** = nice to have. |
| **Functional requirement** | What the feature *does* (e.g. "can filter records"). |
| **Non-functional requirement (NFR)** | *How well* it must do it — speed, security, accessibility — rather than a new feature. |
| **Priority / MoSCoW tag** | See MoSCoW above. |
| **Principal** | Whoever is acting — a user, or the role/group they belong to. "Resolve for the principal" = "work out this person's permissions". |
| **Feature flag** | An on/off switch, set per role/app/object, that turns a capability on or off for that context. |
| **Deny-by-default** | If nothing explicitly grants access, the answer is "no". Safe default. |
| **Scope (all-apps vs selected-app)** | Which records a view can see: *all-apps* = across every application; *selected-app* = only the app you're currently in. |
| **Bootstrap / provision (a default view)** | Auto-create a starter list view the first time, so the screen isn't empty. |
| **Adapter** | A small piece of code that fetches a special kind of data (e.g. email logs) and plugs it into the normal list view. |
| **Inline edit** | Editing a value directly in the table cell, without opening the full record. |
| **Bulk action** | Doing one thing to many selected rows at once (e.g. delete 10 records). |
| **Lookup-only view** | A list shown only for *picking* a related record, not for browsing/editing. |
| **Pagination** | Loading a big list in pages/chunks instead of all at once. |
| **Point-in-time snapshot / read-consistency** | Pinning the data to how it looked at the moment you started scrolling, so rows don't jump around if someone else edits mid-scroll. |
| **Optimistic concurrency (row version)** | Two people edit the same record: the system lets both try, but rejects the second save if the record already changed — instead of silently overwriting. |
| **Case-insensitive** | Upper/lower case doesn't matter ("APPLE" matches "apple"). |
| **404 / "not found" masking** | When you're not allowed to see something, the system says "not found" rather than "access denied", so it doesn't even reveal that the thing exists. |
| **Server-side vs client-side enforcement** | *Client-side* = the browser hides a button. *Server-side* = the backend actually refuses the request. Real security must be server-side; hiding a button isn't enough. |
| **RTM (Requirements Traceability Matrix)** | A table linking each requirement to the test(s) that prove it — the audit trail (Appendix A). |
| **Impl mapping / grounding / file:line** | Notes tying a requirement to the exact code that implements it (Appendices B and E). Keeps the rules honest and checkable. |
| **Discrepancy (⚠) / Open item (O-)** | A place where the code contradicts itself, or a decision still owed. Flagged instead of pretending it's settled (Appendix F). |

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
- **⚠ Discrepancy (D-1):** Two bootstrap paths exist and disagree on sharing. The **client** bootstrap creates the default view as **private**; a **server-side** default-view provisioner creates it as **public**. This divergence must be reconciled — see Appendix F, D-1.

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
The system shall enable or disable each list-view feature according to the feature flags resolved for the acting **principal**, applying precedence **user > role > group > system default**.
- **Governed features:** PDF export, CSV export, XLSX export, create view, rename view, clone view, delete view, filters, columns, sharing, sorting, default view mode, column-header filters, hierarchy. *(Flag-name mapping in Appendix B; server resolution in Appendix E.)*
- **AC:** For each feature, when its flag is disabled for the acting principal the feature's controls are not available; when enabled they are available (subject to permission — LV-MGMT-002).

**LV-MGMT-001a — Deny-by-default when unassigned** *(Must)*
When no feature-assignment record resolves for a non–system-admin principal, the system shall treat **all** list-view features as disabled.
- **AC:** A principal with no matching user/role/group assignment sees every governed feature disabled.
- **Note:** A system-admin principal bypasses assignment resolution and receives the full default feature set.

**LV-MGMT-002 — Management actions require management permission** *(Must)*
A user shall be able to create, rename, clone, delete, or reconfigure a list view only if they hold List View Management permission for the active context. This gate shall be enforced **both client-side (control availability) and server-side (request rejection)**; the client gate is a convenience and is never the sole enforcement point.
- **AC:** Without the permission, all management and configuration-save controls are visibly disabled, **and** a management request submitted directly to the server is rejected (see Error Catalog ERR-9).
- **Scenario:**
  ```gherkin
  Scenario: Viewer cannot save configuration
    Given a user without List View Management permission
    When they open the list-view settings
    Then all Save controls (filters, columns, sharing) are disabled
    And create, rename, clone, and delete actions are unavailable
  ```

**LV-MGMT-002a — Per-action feature gating on the server** *(Must)*
Beyond the coarse management permission, the server shall independently gate each management sub-action (create, rename, clone, delete, save filters, save columns, save sharing, save sorting) by its corresponding feature flag (LV-MGMT-001). A principal holding the management permission but lacking a specific feature flag shall be denied that specific sub-action.
- **AC:** With the management permission but the `filters` flag disabled, a save-filters request is rejected server-side while other permitted sub-actions still succeed.
- **Note:** A system-admin principal bypasses both gates.

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
- **Note:** The server sharing model additionally recognizes single-principal scopes (`role`, `group`, `user`) that resolve identically to a Specific view carrying exactly one principal of that type; the UI presents these under **Specific**. *(Impl in Appendix E.)*

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
Column-filter row overrides shall accept whole numbers from **100 through 2,000** inclusive; otherwise the system shall display **"Enter a whole number between 100 and 2,000."** and reject the value.
- **AC:** 100 and 2,000 are accepted; 99, 2,001, and non-integers are rejected with the exact message.
- **Note:** Editing this override is additionally restricted to system-admin principals server-side.

**LV-CFG-014 — Grouped initial-row override validation** *(Should)*
Grouped initial-row overrides shall accept whole numbers from **1 through 50,000** inclusive; otherwise the system shall display **"Enter a whole number between 1 and 50,000."** and reject the value.
- **AC:** 1 and 50,000 are accepted; 0, 50,001, and non-integers are rejected with the exact message.
- **Note:** Editing this override is additionally restricted to system-admin principals server-side.

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
Grouped views shall initially load up to the configured grouped initial-row limit, divided evenly across groups (remainder distributed across leading groups), and provide **Load more in a group** to fetch additional records per group.
- **AC:** Initial load respects the limit and even distribution; Load more retrieves further records for a single group.

**LV-REND-024 — Paginated retrieval with read-consistency snapshot** *(Must)*
Non-grouped views shall retrieve records page-by-page (page + page size), stopping when a short page is returned or the reported total is reached, and shall pin retrieval to a point-in-time snapshot so a dataset changing mid-scroll does not duplicate or skip rows.
- **AC:** Paging returns each record at most once for a stable dataset; the reported total governs termination.

**LV-REND-025 — Export formats, scope & row cap** *(Should)*
Where the relevant export feature flag is enabled, a view shall be exportable to **CSV, PDF, and XLSX**. Export shall honor the active search text, column-header filters, and saved list-view filters, and shall be bounded by a configured maximum row count.
- **AC:** Exported output reflects the currently applied criteria; CSV/XLSX exports do not exceed the configured maximum rows (default cap: 10,000).
- **Note:** PDF, CSV, and XLSX are each independently flag-gated (LV-MGMT-001).

**LV-REND-026 — List-load access logging** *(Should)*
Each list-view data load shall emit a load access event for audit, subject to the platform access-logging policy (see SRS-SEC-PERM, SEC-LOG).
- **AC:** A successful list load produces one load audit event.

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
Deletion of the last email-log, access-log, or record-access list view shall be rejected and the view preserved.
- **AC:**
  ```gherkin
  Scenario: Cannot delete the final required specialized view
    Given only one Email Log list view exists
    When a manager attempts to delete it
    Then deletion is blocked
    And a "must remain" message is shown (see Error Catalog ERR-2 / ERR-2s)
    And the view still exists
  ```
- **⚠ Discrepancy (D-2):** The client-side guard message is **"At least one list view must remain."** while the server-side guard for the same condition returns **"At least one list view must remain for this object."** The two strings differ; tests must assert the correct string per enforcement point until reconciled. See Appendix F, D-2.

**LV-SPEC-004 — Empty and fetch-error states** *(Should)*
When list-view data is unavailable or loading fails, the system shall display the appropriate empty or returned-error state.
- **AC:** Empty data shows the applicable empty state; a fetch failure shows the returned error message.

---

### 3.7 Embedded Flow List-View Selection

**LV-FLOW-001 — Selection anchors** *(Should)*
The embedded Flow list-view editor shall expose Object, List view, and Controls sections. *(DOM hook mapping in Appendix C.)*
- **AC:** All three sections are present in the editor.

**LV-FLOW-002 — Loading / empty placeholders** *(Should)*
The Flow editor shall show the appropriate selection placeholder while loading or when no choice is available: **Select an object**, **No objects available**, **Loading list views...**, **Select a list view**, **No list views available**.
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
View visibility shall be enforced server-side according to sharing configuration (Private/Public/Specific). A Private view shall not be retrievable by a user who is not its owner or a designated principal, including by direct identifier reference. To avoid leaking existence, a denied direct-id retrieval shall return **"List view not found." (404)** — indistinguishable from a genuinely absent view — rather than a distinct authorization error.
- **AC:** Requesting another user's Private view by id returns the same 404 "List view not found." response as a nonexistent id; list responses omit views the caller cannot access.

**LV-NFR-003 — Audit-log integrity** *(Must)*
Audit-log views shall be read-only (no inline edit, no bulk actions), consistent with LV-PERM-002, and shall not permit mutation through any list-view path.

**LV-NFR-004 — Concurrency** *(Should)*
Record inline edits performed through a list view shall use **optimistic concurrency**: each edit carries the row's last-known version and the server shall reject the write if the underlying row changed in the interim, rather than silently overwriting.
- **AC:** An inline edit against a stale row version is rejected, not applied.
- **Open item (O-2):** The conflict policy for concurrent edits to the same *shared view configuration* (as opposed to a record row) is not evidenced in code — TBD. See Appendix F, O-2.

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
| ERR-1 | Update/clone a nonexistent view **or** direct-id retrieval of an inaccessible view | `List view not found.` | LV-MGMT-006, LV-NFR-002 |
| ERR-2 | Delete last required specialized view (**client** guard) | `At least one list view must remain.` | LV-SPEC-003 |
| ERR-2s | Delete last required view (**server** guard) | `At least one list view must remain for this object.` | LV-SPEC-003 (⚠ D-2) |
| ERR-3 | Bulk-delete a Permission | `Permissions can't be deleted directly. Delete the related tab, button, app, or other owning configuration instead.` | LV-PERM-003 |
| ERR-4 | Column-filter override out of range | `Enter a whole number between 100 and 2,000.` | LV-CFG-013 |
| ERR-5 | Grouped initial-row override out of range | `Enter a whole number between 1 and 50,000.` | LV-CFG-014 |
| ERR-6 | Selector search with no match | `No matching list views.` | LV-MGMT-005 |
| ERR-7 | Save Specific sharing with no principal | `Select at least one user, role, or group before saving sharing.` | LV-CFG-006 |
| ERR-8 | Save columns with none selected | `Select at least one column before saving.` | LV-CFG-004 |
| ERR-9 | Management request without permission (server) | `List view management not permitted.` (403) | LV-MGMT-002 |
| EMPTY-1 | Flow: no objects | `No objects available` | LV-FLOW-002 |
| EMPTY-2 | Flow: no views | `No list views available` | LV-FLOW-002 |
| STATE-1 | Flow: loading views | `Loading list views...` | LV-FLOW-002 |
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
| LV-MGMT-001a | Deny-by-default when unassigned | Must | | | |
| LV-MGMT-002 | Management permission gate | Must | | | |
| LV-MGMT-002a | Per-action feature gating (server) | Must | | | |
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
| LV-REND-024 | Paginated retrieval + snapshot | Must | | | |
| LV-REND-025 | Export formats, scope & cap | Should | | | |
| LV-REND-026 | List-load access logging | Should | | | |
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
| Feature flags | `download_pdf`, `download_csv`, `download_xlsx`, `create_list_view`, `rename_list_view`, `clone_list_view`, `delete_list_view`, `filters`, `columns`, `sharing`, `sorting`, `default_view_mode`, `column_header_filters`, `hierarchy` |
| Coarse management permission | feature resource `list_view_manage`, action `use` |
| Server sharing scopes | `private`, `public`, `specific`, `role`, `group`, `user` |
| Feature resolution | `resolveEffectiveListViewFeatures` (precedence user > role > group > default; unassigned non-admin ⇒ all-disabled; system-admin ⇒ full defaults) |
| Optimistic-concurrency token | `row_version` / `targetRowVersion` on inline edit |
| Export | `ListViewExportFormat = csv \| pdf \| xlsx`; row cap `exportCsvMaxRows`/`exportXlsxMaxRows` (default 10,000) |
| List-load audit action | `listview.load` |
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
| Export row cap | 10,000 (CSV/XLSX) | Bound export payload | Confirm |

---

## Appendix E — Code Evidence (requirement → source, file:line)

*Verified against the working tree at `D:\core-platform`. This appendix is the grounding proof; if code moves, update here — requirement text above stays stable.*

| Requirement | Evidence (file:line) |
|---|---|
| LV-REND-001 / display modes | `packages/list-view/src/types.ts:82` (`mode: table\|group\|excel\|chart\|kanban`); admin allow-set `apps/admin/src/hooks/useAdminListViews.ts:6` |
| LV-ACT-004 / bootstrap gate | `apps/admin/src/hooks/useAdminListViews.ts:422-455` (token+manage `:423`, subject `:426`, loading `:427`, no-existing `:428/:439`) |
| LV-ACT-005 / bootstrap defaults | `useAdminListViews.ts:442-446` (`filters {logic:AND}`, `sharing {scope:private}`, `sort created_at desc`, `view {mode:table}`) |
| LV-ACT-005 D-1 / server default is public | `apps/service/src/list-views/routes.ts:3940-4027`, sharing public `:4005` |
| LV-ACT-002/003 / scope mapping | `useAdminListViews.ts:58-93`; all-apps `:124,158,174,190,222,271`; selected-app `:140,206,238,255` |
| LV-ACT-007 / default names | `useAdminListViews.ts:320,328,334,341,348,355,362,369,376,389` |
| LV-SPEC-001 / specialized default names | `apps/admin/src/adapters/{emailLogs,userAccessLogs,userRecordReadLogs,agentAutomations,recycleBin}ListViewAdapter.ts:~16-54` |
| LV-MGMT-001 / feature flags | `apps/service/src/list-views/feature-assignments.ts:4-19` (incl. `download_xlsx :7`); mirror `packages/list-view/src/types.ts:120-135` |
| LV-MGMT-001a / resolution + deny-default | `feature-assignments.ts:107-149` (precedence `:131-139`; admin bypass `:115-117`; unassigned all-false `:142-143`) |
| LV-MGMT-002 / server manage gate | `apps/service/src/list-views/routes.ts:3544-3559` (`ensureListViewManagePermission`, 403 `:3557`) |
| LV-MGMT-002a / per-action flags | `routes.ts:4833(rename),4837(filters),4841(columns),4845(sharing),4849(sorting),4502/4508(create),5048(clone),5189(delete)` |
| LV-CFG-001/002 / filter model + validation | model `packages/ui/src/index.tsx:6445-6457`; operators `:8731-8765`; validate `:7753-7874`; wrapper `packages/list-view/src/filterValidation.ts:4-7` |
| LV-CFG-004 / ≥1 column | `packages/list-view/src/hooks/useListViewSettings.tsx:601-602` |
| LV-CFG-005 / sharing scopes | `packages/list-view/src/hooks/useListViewSettings.tsx:92-93,727-732`; server extra scopes `apps/service/src/list-views/utils.ts:471-486,533-535` |
| LV-CFG-006 / specific ≥1 principal | `useListViewSettings.tsx:711-718` |
| LV-CFG-013/014 / override ranges + admin-only | `packages/list-view/src/components/ListViewSettingsModal.tsx:1056-1057,1041-1042`; server admin-only `routes.ts:4760,4783` |
| LV-REND-002 / hide id + row_version | `packages/list-view/src/hooks/useListViewRows.tsx:519` |
| LV-REND-019 / case-insensitive search | `apps/service/src/list-views/utils.ts:349` (searchable), `:795,804,807` (`ilike`) |
| LV-REND-021 / type-aware sort | `apps/service/src/list-views/computed-postprocess.ts:154-178` |
| LV-REND-022 / adapter limits | email `emailLogsListViewAdapter.ts:16`; access `userAccessLogsListViewAdapter.ts:16`; record-access `userRecordReadLogsListViewAdapter.ts:16`; automations `agentAutomationsListViewAdapter.ts:293` |
| LV-REND-023 / grouped even split | `apps/service/src/list-views/grouped-pagination.ts:6-28` |
| LV-REND-024 / paginate + snapshot | `useListViewRows.tsx:412-451`; response `types.ts:95-111` |
| LV-REND-025 / export | `types.ts:35-51`; caps `packages/list-view/src/components/ListViewToolbar.tsx:321-323` |
| LV-REND-026 / list-load audit | `routes.ts:4087-4089` (`action: listview.load`) |
| LV-PERM-001 / object-list restrictions | `useAdminListViews.ts:5` (`access_log_deny`), `:147-148` (`nonEditableFields`) |
| LV-PERM-002/004 / inline-edit gating | `useAdminListViews.ts:161,177,241,258,274-275`; predicate `packages/list-view/src/hooks/useListView.tsx:2144-2148`; lookup-only `ListViewSettingsModal.tsx:1065` |
| LV-SPEC-003 / last-view guard (D-2) | client `useListViewSettings.tsx:358`; server `routes.ts:5247` |
| LV-NFR-002 / server visibility + 404 mask | list `routes.ts:4068-4078`; by-id `:4414-4426`; `canAccessListView` `utils.ts:516-537` |
| LV-NFR-004 / optimistic concurrency | `types.ts:60` (`targetRowVersion`) |
| LV-PERM-003 / permissions non-deletable | `routes.ts:7592`; `apps/service/src/permissions/routes.ts:583` |
| LV-FLOW-002/003 / placeholders + guard | `apps/admin/src/components/AdminFlowListViewBlock.tsx:315,332-339`; guard `:175` |

---

## Appendix F — Discrepancies & Open Items

Behaviors where the code contradicts itself or a decision is still owed. Written here rather than as false "shall" statements.

| ID | Type | Finding | Recommended resolution |
|---|---|---|---|
| **D-1** | Divergence | Client default-view bootstrap creates the view **private** (`useAdminListViews.ts:442-446`); the server default-view provisioner creates it **public** (`routes.ts:4005`). A user's first default view thus differs in visibility depending on which path ran. | Decide the intended default sharing for a bootstrapped admin view and make both paths agree. |
| **D-2** | Inconsistent string | The "last view must remain" guard returns two different messages: client `"At least one list view must remain."` vs server `"At least one list view must remain for this object."` | Unify on one string (recommend the server's, as it is the authoritative enforcement point), or document both intentionally. |
| **O-1** | TBD | LV-NFR-001 performance budget for grouped/large views is undefined. | Define a per-environment first-screen render target. |
| **O-2** | TBD | Conflict policy for concurrent edits to the same **shared view configuration** (not record rows) is not evidenced in code. | Decide last-write-wins vs optimistic version check for view config saves. |
| **O-3** | Confirm | Numeric limits (adapter 500/1,000; override 100–2,000 and 1–50,000; export 10,000) are enforced but their rationale is unconfirmed (Appendix D). | Product/perf owner to confirm or retune. |
