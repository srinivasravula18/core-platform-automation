# Access Groups: Default-Deny and Enforcement Architecture Plan

**Status: ANALYSIS ONLY — awaiting explicit approval for Phase 1.**

## 1. Executive Summary

The reported behaviour is confirmed: a non-admin user who belongs to no Access Group is deliberately resolved as `UNRESTRICTED`, so they receive every UI feature. This is not a persistence failure. It is the current policy in `server/features/auth/groupStore.ts` and is repeated in the Profiles UI.

The required policy is: **admins retain unrestricted access; every non-admin is denied by default unless at least one Access Group grants the requested capability.** Existing group membership and union-of-grants semantics must remain unchanged.

The smallest safe production fix is a default-deny Phase 1 that changes grant resolution, removes stale-client fallback-to-allow behaviour, provides an explicit no-access experience, corrects the administrator UI copy, and adds focused tests. It does not alter stored group records, users, projects, websites, providers, or sessions.

Complete server-side feature authorization is a separate architectural phase. The application has 225 API routes but feature grants are currently checked only in the frontend and selected resource paths; attaching a naive URL-to-feature middleware would incorrectly block shared APIs (for example folders, plans, cases and agent endpoints used by several features). It must be designed and tested as a capability map, not bundled into the default-deny fix.

## 2. Existing Architecture

1. `db.groups` is an array-backed JSON collection, persisted with the other JSON-store collections (`server/shared/storage.ts`). Each group contains `memberUserIds` and grants for `features`, `projects`, `websites`, and `providers`.
2. `effectiveGrantsForUser` in `server/features/auth/groupStore.ts` is the source of truth. It returns `UNRESTRICTED` for an admin, an unauthenticated/internal caller, and a non-admin with no matching group. For a grouped non-admin, it returns a union of that user's groups.
3. Authentication routes resolve grants at login and `GET /api/auth/me` (`server/features/auth/routes.ts`). Durable sessions contain only the user ID; identity and role are resolved live.
4. The browser stores those grants in scoped storage (`src/components/AuthGate.tsx`). `src/lib/features.ts` maps UI routes to feature IDs. `src/App.tsx` filters sidebar entries and redirects a user away from a non-granted route.
5. API authentication is globally installed in `apps/api/src/server.ts`. It authenticates API calls and establishes request scope, but does not currently impose a general `features` grant check.
6. Projects, websites, and providers have selected server-side checks (`server/features/projects/routes.ts`, `server/features/credentials/routes.ts`, `server/ai/orchestrator.ts`). These are resource-specific and not an application-wide feature authorization layer.

## 3. Dependency Graph

```text
Admin Profiles UI -> /api/groups -> groupStore -> db.groups -> JSON/PG json_store
                                         |
Login or /auth/me -> effectiveGrantsForUser -> AuthGate scoped storage
                                         |                 |
                                     reqGrants         Sidebar + FeatureGuard
                                         |                 |
                          project / website / provider checks    UI routes
```

## 4. Runtime Flow

1. The browser sends the bearer token on every same-origin `/api` request through the fetch wrapper in `src/lib/base-path.ts`.
2. `authContextMiddleware`, `apiAuthGate`, and `scopeMiddleware` run in that order in `apps/api/src/server.ts`.
3. Login and `/api/auth/me` resolve current grants from live user/group data.
4. The browser caches the response. It refreshes this cache on initial app load and sign-in, but not immediately when an administrator edits a group.
5. Sidebar and route guard use the cached grants. A full browser reload or re-login refreshes the result.

## 5. Evidence Flow

- Group membership is stored as user IDs, not usernames, which is stable across name changes.
- Group creation/update normalizes all grant values; `[]` means no grant and `'*'` means all within that category.
- `groupsForUser` performs live membership lookup each time grant resolution runs.
- No data migration is required for default-deny because the existing stored records already express the intended allow-list.

## 6. Context Flow

- `authContextMiddleware` resolves the session to `{ userId, username, role }`.
- `scopeMiddleware` stores that identity in `req.scope`.
- `reqGrants` asks `effectiveGrantsForUser` for current grants.
- Internal/unauthenticated callers intentionally remain unrestricted in the current resolver; public API routes are separately enumerated in `apiAuthGate`.

## 7. Prompt Flow

No system-prompt or agent-prompt assembly depends on Access Group UI feature grants. Provider selection is constrained at the orchestrator boundary by the `providers` grant. The default-deny phase must preserve internal/system calls that have no user ID, otherwise background execution can be disrupted.

## 8. Current Problems

1. **Confirmed policy mismatch:** `mine.length === 0` returns `UNRESTRICTED` for non-admin users. This is exactly the reported issue.
2. **Fail-open browser parsing:** absent, invalid, or malformed cached grants are interpreted as unrestricted in `AuthGate.getGrants` and `grantAllows`.
3. **Stale browser grants:** administrator edits do not invalidate a currently signed-in member's cached grants until refresh/re-login.
4. **No-access UX is misleading:** a zero-feature grouped user is redirected to `/settings`, where non-admin settings still expose providers, prompts, credentials and cost screens.
5. **Incomplete server-side feature enforcement:** the global API gate authenticates callers but does not authorize the `features` category. Only selected project, website, and provider paths use group grants.
6. **Potential regression trap:** generic APIs serve more than one UI feature. An endpoint-prefix middleware cannot safely infer permission from a single sidebar route.

## 9. Root Cause Analysis

The original implementation deliberately chose “ungrouped = full access” for backwards compatibility, as documented in code and UI. That choice conflicts with the desired least-privilege model. The apparent failure is therefore not caused by saving groups, bearer-token propagation, session resolution, or group-ID matching.

The broader enforcement gap comes from treating UI feature visibility as an authorization mechanism. The feature catalog maps browser paths, while server APIs express shared domain operations. Those are different boundaries.

## 10. Proposed Architecture

### Phase 1: safe default-deny policy correction

- Preserve `UNRESTRICTED` only for admins and explicitly internal/unauthenticated resolver use.
- Return a structurally valid all-empty `Grants` object for an ungrouped non-admin.
- Make the browser fail closed for missing/invalid grants after authentication, while retaining a short initial loading state until `/api/auth/me` completes.
- Direct zero-feature users to a dedicated access-denied screen containing only identity/help/sign-out controls; do not route them to Settings.
- Keep group union, `'*'`, and resource-level project/website/provider checks unchanged.
- Change UI explanations and delete confirmation text to reflect the new policy.

### Phase 2: explicit server capability enforcement

- Define a request capability catalog separate from the UI route catalog.
- Map API operations to domain capabilities only after enumerating shared consumers.
- Apply a single authorization middleware at route registration boundaries, with explicit exclusions for authentication, administrative settings, public health/config, and internal agents.
- Return a consistent 403 response with no data leakage.
- Add integration tests for direct API calls, not only client-side navigation.

## 11. Complete Refactoring Strategy

1. Add an explicit `noAccessGrants()` helper and make the resolver return it for ungrouped non-admins.
2. Harden client grant deserialization so an authenticated user never falls back to full access due to missing/corrupt cache data.
3. Add a reload-safe, zero-access route/component and make feature guard use it.
4. Remove Settings as the fallback for zero granted features and hide Settings from non-admin zero-access users.
5. Update group descriptions, empty-state copy, and deletion warning to eliminate the old policy statement.
6. Add unit tests for all resolver cases and client guard behavior.
7. Run typecheck and the relevant tests. Deploy only after the pre-rollout audit of ungrouped non-admin accounts is accepted.
8. Design Phase 2 independently from Phase 1; do not broaden the code change until the API-capability matrix is approved.

## 12. Every File That Must Change

### Phase 1 (implementation scope: one authorization-policy subsystem)

| File | Change |
|---|---|
| `server/features/auth/groupStore.ts` | Change ungrouped non-admin resolution from unrestricted to explicit empty grants; clarify internal-caller behaviour. |
| `src/components/AuthGate.tsx` | Replace fail-open stored-grant fallback with fail-closed authenticated handling and expose refreshed grant state safely. |
| `src/lib/features.ts` | Make malformed/missing grant categories deny instead of permit; retain explicit `UNRESTRICTED` and `'*'` semantics. |
| `src/App.tsx` | Add a no-access route/view; remove the Settings fallback for zero-feature users; prevent zero-access navigation surfaces. |
| `src/pages/Settings.tsx` | Correct policy copy and the group-deletion warning; ensure non-admin settings do not become an accidental no-access landing page. |
| `tests/unit/auth/groupStore.test.ts` (new) | Cover resolver, group union, admin, ungrouped, empty group, and malformed stored group grants. |
| `tests/unit/client/features.test.ts` (new) | Cover client permission evaluation and no-feature fallback behavior. |
| `tests/integration/auth/access-groups.test.ts` (new or existing suitable auth suite) | Verify login/`/me` grants and direct resource API behavior for admin, grouped and ungrouped users. |

### Phase 2 (not approved or implemented by this plan)

| File/area | Change |
|---|---|
| `server/features/auth/featureAccessGate.ts` (new) | Capability model and centralized 403 middleware. |
| `apps/api/src/server.ts` | Install capability middleware in the correct order. |
| Every registered route module under `server/features/*/routes.ts` plus `services/runtime/src/api/routes.ts` | Explicitly declare the capability required by each protected API operation after dependency mapping. |
| `src/lib/features.ts` and settings UI | Align visible feature labels with the approved capability catalog. |
| API integration tests | Direct-call authorization matrix for every capability. |

## 13. Why Each File Must Change

`groupStore.ts` is the actual defect location. The client files must change because they independently encode fail-open behavior and the current no-feature redirect. Settings is user-facing policy documentation and presently states the obsolete full-access fallback. Tests are required because this is an authorization default change. Phase 2 files are listed separately to prevent a misleading claim that Phase 1 makes every server endpoint feature-authorized.

## 14. Risk Level Per File

| File | Risk |
|---|---|
| `server/features/auth/groupStore.ts` | High: changes who can access the application. |
| `src/components/AuthGate.tsx` | Medium: affects sign-in/session restoration. |
| `src/lib/features.ts` | Medium: shared client authorization primitive. |
| `src/App.tsx` | Medium: route fallback and navigation behavior. |
| `src/pages/Settings.tsx` | Low: wording and safe rendering guard. |
| New tests | Low. |
| Phase 2 route modules/middleware | High: broad API behavior and shared endpoint dependencies. |

## 15. Backward Compatibility Concerns

- This intentionally breaks the old access default for ungrouped non-admin accounts.
- Admin access, group records, membership IDs, group union, wildcard grants, durable sessions, project ownership, and provider filtering remain compatible.
- Background/internal execution must retain its existing unrestricted resolver behavior when no user context is present.
- A stale browser tab must never show a previously allowed feature after a grant revocation once it next refreshes its identity state.

## 16. Migration Strategy

1. Before rollout, list all non-admin users with no group membership from `db.users`/`db.groups` (or the persisted JSON-store collections).
2. Have an administrator assign each intended user to at least one group with the required grants.
3. Take the normal database/JSON-store backup used for deployment.
4. Deploy Phase 1.
5. Force a one-time `/api/auth/me` refresh on app load; users with no grant receive the no-access page, not a broken dashboard.
6. Monitor 403/no-access events and retain the admin account as recovery path.

No schema migration is required and `server/db/schema.sql` / `scripts/setup-db.bat` do not need changes in Phase 1.

## 17. Testing Strategy

- Unit: resolver tests for admin, ungrouped non-admin, empty group, selected group, wildcard group, multiple groups, deleted user, and internal caller.
- Client unit: `grantAllows`, corrupt/missing cache handling, feature path resolution, and no-access route selection.
- API integration: login and `/me`; project/website/provider allowed and denied cases; verify admin remains unrestricted.
- UI smoke: an ungrouped tester sees the access-denied page; a selective group sees only granted sidebar items; a multi-group user sees the union.
- Regression: run repository typecheck and existing auth/project/credential/agent test suites.

## 18. Rollback Strategy

The change does not transform stored data. If an unexpected lockout occurs, roll back the application build; existing group/user JSON-store records remain valid and the previous build restores the former fallback. An administrator can also add the affected account to a temporary all-features group before rollout. Do not delete groups or alter user IDs as part of rollout.

## 19. Estimated Implementation Effort

- Phase 1 implementation and automated verification: 1–2 focused engineering days.
- Pre-rollout group-membership audit and administrator confirmation: dependent on account count; usually under one hour.
- Phase 2 capability model and direct API enforcement: 4–8 engineering days plus review, because 225 API routes and shared consumers must be classified and integration-tested.

## 20. Recommended Implementation Order

- [ ] **Phase 1A — Policy and client safety** (Files: `groupStore.ts`, `AuthGate.tsx`, `features.ts`, `App.tsx`, `Settings.tsx`; Risk: High/Medium). Implement only default-deny plus the no-access experience.
- [ ] **Phase 1B — Verification** (Files: new targeted unit/integration tests; Risk: Low). Test all grant states and regression paths; run typecheck.
- [ ] **Phase 1C — Controlled rollout** (Files: none; Risk: Operational). Audit and assign ungrouped non-admin users before enabling the build.
- [ ] **Phase 2 — API capability enforcement** (Files: new gate, API bootstrap, each affected route module, integration suite; Risk: High). Start only after the capability matrix is reviewed and approved.

