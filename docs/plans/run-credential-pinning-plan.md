# Implementation Plan — Pin the credential website on every run (Fix #3)

Status: **Phase 0 (analysis) — awaiting approval before implementation.**
Author context: follow-up to the credential-collision fix (path-aware `matchWebsiteByUrl`) already shipped.

## 1. Problem being solved

Runs in the **Test Cases / Suites / Plans / Runs** section do not record *which* saved website (credential set) they use. The `runs` table has **no `website_id` / `credential_role` column**, so at execution time `resources/routes.ts` passes `authContext: { websiteId: run.websiteId, role: run.credentialRole }` — both **`undefined`** — and credential resolution is forced to **guess from the target URL's hostname**.

The path-aware matcher fix makes that guess reliable for the *current* data, but it is still a guess: it breaks again if a third app is added on the same host+path prefix, if a run's `target_url` is blank/wrong, or when resolution is genuinely ambiguous (now returns null → "no credentials"). This plan removes the guessing entirely by **pinning the exact website on the run at creation time**.

Out of scope of the live bug but included as an **optional Phase B**: manual/recorded scripts that hardcode credentials bypass the resolver. Today's audit found **0** such scripts with wrong/placeholder creds, so Phase B is deferred unless requested.

## 2. Current behavior (code-cited)

- `server/db/schema.sql:109` — `runs` table: no `website_id` / `credential_role`.
- `server/features/resources/routes.ts:1062` and `:1126` — the two run-creation sites build `newRun` with `targetUrl` + owner scope but never a website id.
- `server/features/resources/routes.ts:380` — execution reads `run.websiteId` / `run.credentialRole` (currently always undefined).
- `server/features/playwright/routes.ts:69` — `resolveCredentials({ targetUrl, websiteId: originRun?.websiteId || authContext?.websiteId, role, ownerId })` → falls to URL matching when websiteId is absent.
- `server/db/repository.ts:236` (`mapRun`) and `:1245` (`Runs.upsert`) — column read/write mapping; neither knows the new columns.

## 3. Proposed change

At **run creation**, resolve the website **once** (using the existing, now-path-aware `resolveCredentials` with `targetUrl` + `ownerId`) and store `websiteId` + `credentialRole` on the run. At **execution**, resolution becomes an **exact websiteId match** — deterministic, auditable, no hostname guessing.

## 4. Files to change (scoped: 4 core files)

| # | File | Change | Risk |
|---|------|--------|------|
| 1 | `server/db/schema.sql` | Add idempotent `ALTER TABLE runs ADD COLUMN IF NOT EXISTS website_id TEXT;` and `... credential_role TEXT DEFAULT '';` next to the existing run ALTERs (line ~302). No FK (soft link; websites can be deleted). | Low |
| 2 | `scripts/setup-db.bat` | Verify it re-applies `schema.sql` unchanged (per repo rule). Expected: **no edit needed** — confirm only. | Low |
| 3 | `server/db/repository.ts` | `mapRun`: expose `websiteId: r.website_id`, `credentialRole: r.credential_role`. `Runs.upsert`: add both to INSERT column list + `ON CONFLICT` SET + params. JSON-mode path already round-trips arbitrary fields. | Medium (SQL) |
| 4 | `server/features/resources/routes.ts` | At both creation sites (`:1062`, `:1126`): after `targetUrl` is known, call `resolveCredentials({ targetUrl, ownerId: scope.userId })`, set `websiteId = resolved?.websiteId`, `credentialRole = resolved?.role`. Leave execution (`:380`) as-is — it already reads these fields. | Medium |

Optional **Phase B (deferred, not in this pass)**: `server/features/playwright/routes.ts` `applySettingsCredentials` — also consult `resolveCredentials({ targetUrl, websiteId, ownerId })` so a manual script's hardcoded login is overwritten with the saved credential. Deferred: audit shows no current wrong-cred scripts, and script-rewriting is pattern-fragile.

## 5. Backward compatibility

- New columns are nullable / defaulted → existing rows unaffected; old runs simply have `website_id = NULL` and fall back to today's (fixed) URL matching. No data migration required.
- `resolveCredentials` signature unchanged; execution path unchanged (it already reads the fields).
- No API shape change; `websiteId`/`credentialRole` are additive on the run object.
- JSON (no-PG) mode: fields persist automatically via the generic run object.

## 6. Migration

Additive columns via `ADD COLUMN IF NOT EXISTS` — idempotent for new and existing databases (matches the existing `assigned_to`/`tags`/`state` ALTERs). No backfill; new runs populate going forward. Optional one-off backfill script could set `website_id` on recent open runs, but is **not** required.

## 7. Testing

1. `npm run lint` (tsc) clean.
2. Read-only tsx harness (like the ones already used): create a run via the real code path, assert the stored run has the correct `websiteId` for admin vs keystone targets.
3. Re-run the real DB scripts end-to-end (as already done) with a run that carries `websiteId` → confirm admin→admin, keystone→keystone, both authenticate.
4. Restart backend; confirm clean boot + hydration.

## 8. Rollback

Pure additive change. Rollback = revert the 3 code files; the nullable columns can stay harmlessly (or be dropped). No data loss either way.

## 9. Effort & order

Small — ~4 files, no subsystem redesign. Single phase:

- [ ] Step 1: schema.sql columns + confirm setup-db.bat.
- [ ] Step 2: repository.ts mapRun + Runs.upsert.
- [ ] Step 3: resources/routes.ts resolve+store at both creation sites.
- [ ] Step 4: lint, harness test, real-script e2e, backend restart, report.

Phase B (manual-script credential rewrite) only if you later want it.
