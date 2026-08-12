# Recycle Bin + Cascading Delete/Restore — Implementation Plan (Phase 0, analysis only)

Date: 2026-08-12 · Status: awaiting approval · Author: architecture pass

## 1. Executive Summary

Deleting a plan/suite/case today removes only that one row. The request is:

- **Delete cascades** down the hierarchy (plan → its suites/requirements/cases; suite → its cases and
  sub-suite links; case → itself).
- **Deleted items land in a Recycle Bin** and can be restored.
- **Restore prompts** the user: restore only the selected item, or the item plus everything that was
  deleted with it.

The good news: **soft delete already exists** on 12 tables (`deleted_at`, `deleted_by`,
`deleted_by_name`). Nothing is being hard-deleted on PostgreSQL today, so the data for a recycle bin
is already being retained. What is missing is (a) any way to *list* or *restore* deleted rows, and
(b) any cascade.

The hard problem: **every parent/child relationship in this schema is many-to-many.** A case can
belong to several plans and several suites; a suite can belong to several plans and have several
parent suites. A naive "delete the plan, delete its cases" cascade would destroy cases that are still
in use by other plans. This plan's central rule is therefore:

> **Cascade deletes only exclusively-owned descendants. Anything still referenced by a surviving
> parent is detached, not deleted** — and the user sees exactly what will happen before confirming.

## 2. Existing Architecture

Soft delete (PostgreSQL) is implemented in `server/db/repository.ts` as
`UPDATE <table> SET deleted_at = now(), deleted_by = $2, deleted_by_name = $3 WHERE id = $1 AND deleted_at IS NULL`
for: `plans`, `suites`, `cases`, `requirements`, `runs`, `reports`, `defects`, `scripts`,
`recordings`, `folders`, `automation_schedules`, `git_repositories`.

Every `list()`/`get()` filters `WHERE deleted_at IS NULL`, so deleted rows are already invisible
without being destroyed.

The **in-memory JSON fallback store** (`server/shared/storage.ts`, used when `DATABASE_URL` is unset)
**hard-deletes**: `db.cases = db.cases.filter(x => x.id !== id)`. This deployment runs PostgreSQL, so
the recycle bin is viable, but the JSON path must degrade gracefully rather than crash.

Delete endpoints live in the generic CRUD block, `server/features/resources/routes.ts:1258-1370`
(`DELETE /api/:entity/:id` and `POST /api/:entity/bulk-delete`).

## 3. Dependency Graph

```
plans ──parent_plan_id (single, FK SET NULL)──> plans        [tree]
suites ──parent_suite_ids[] (JSONB)──> suites                [DAG — cycles possible]
suites ──test_plan_ids[] (JSONB)──> plans                    [M:N]
cases  ──test_plan_ids[] (JSONB)──> plans                    [M:N]
cases  ──test_suite_ids[] (JSONB)──> suites                  [M:N]
requirements ──requirement_case_links──> cases               [M:N, FK ON DELETE CASCADE]
cases ──scripts.case_id──> scripts                           [1:N, already cascades on soft delete]
runs ──plans.runIds[]──> plans                               [M:N, already unlinked on delete]
```

Singular `test_plan_id`/`test_suite_id` columns still exist and are kept in sync with the plural
arrays (`schema.sql:319-324`). Both must be maintained by any link change.

## 4. Runtime Flow (proposed)

```
DELETE /api/plans/:id?preview=1  ->  impact report { willDelete[], willDetach[], blocked[] }
DELETE /api/plans/:id            ->  resolve closure -> stamp deleted_batch_id -> soft-delete set
GET    /api/recycle-bin          ->  grouped by batch, newest first
POST   /api/recycle-bin/:type/:id/restore { scope: 'self' | 'batch' }
```

## 5. Evidence / Data Flow

Deletion writes only `deleted_at`/`deleted_by`/`deleted_batch_id`. **No link arrays are mutated on
cascade delete** — membership is preserved verbatim so restore is lossless. Detaching a *shared*
child does mutate its link array (removing the dead parent), and that prior value is recorded in the
batch row so a batch restore can re-attach it.

## 6. Context Flow

Scope (`projectId`/`appId`/`ownerId`) is enforced on every recycle-bin read and restore via the
existing `scopeFilter`/`reqScope`, so one user cannot see or restore another's deleted rows. RBAC:
restore requires the same permission as delete on that entity type.

## 7. Prompt Flow

Not applicable — no LLM involvement.

## 8. Current Problems

1. Deleting a plan silently orphans its suites/cases; they remain listed but their parent is gone.
2. No way to see or recover a deleted item, despite the rows still being present.
3. `deleted_by` is captured but never surfaced.
4. Bulk delete has the same single-row semantics repeated N times.
5. JSON fallback hard-deletes, so behaviour differs by backend.

## 9. Root Cause Analysis

Soft delete was introduced for auditability, not recoverability: the write path was implemented
(`SET deleted_at`) but the read path (`WHERE deleted_at IS NULL`) was applied everywhere with no
counterpart query for deleted rows, and no UI. Cascade was never modelled because the link arrays are
JSONB rather than FK rows, so the database cannot express it declaratively.

## 10. Proposed Architecture

**A. Deletion closure resolver** (`server/features/resources/deletionGraph.ts`, new)

`resolveDeletionClosure(rootType, rootId, scope)` walks the graph and returns:

- `willDelete[]` — the root plus descendants **exclusively** owned by it.
- `willDetach[]` — descendants that survive because another live parent still references them, with
  the link that will be removed.
- `blocked[]` — anything that must not be touched (e.g. a case with an in-flight run).

Exclusivity test for a candidate child: every one of its parent links points at a row that is either
already deleted or inside `willDelete`. Traversal is a visited-set BFS, so the `parent_suite_ids` DAG
cannot loop.

Cascade scope by root type:

| Root | Cascades to | Notes |
|---|---|---|
| Plan | its sub-plans, suites, cases, requirements | only where exclusively owned |
| Suite | its sub-suites, cases | detaches from parent suites/plans |
| Case | its scripts | already implemented; unchanged |
| Requirement | nothing | links drop, cases survive |

**B. Batch stamping.** New nullable column `deleted_batch_id TEXT` on the 12 soft-delete tables, plus
a `deletion_batches` table (`id`, `root_type`, `root_id`, `root_label`, `actor`, `created_at`,
`detached JSONB`). Every row in one cascade shares a batch id. This is what makes the restore prompt
possible: "restore this item only" vs "restore all 14 items deleted with it".

**C. Restore.** `restore(type, id, scope)` clears `deleted_at`/`deleted_by`/`deleted_batch_id`.
Batch restore does the same for the whole batch and re-applies `detached` links. Restoring a child
whose ancestors are still deleted is allowed but warned about, with an offer to restore ancestors.

**D. Retention.** Rows are kept indefinitely (matching today). A purge job is explicitly out of scope
for this phase; the plan notes where it would attach.

## 11. Complete Refactoring Strategy

Three independently shippable phases; each leaves the app working.

- **Phase A — recoverability, no behaviour change.** Batch column + `deletion_batches` table,
  repository `listDeleted`/`restore`, recycle-bin routes, Recycle Bin UI. Delete still affects one
  row. Ships value immediately (existing deleted rows become recoverable) with near-zero risk.
- **Phase B — cascade delete.** Closure resolver + impact preview dialog + wiring into the delete
  endpoints behind flag `RECYCLE_BIN_CASCADE`.
- **Phase C — restore prompt + polish.** Scope choice on restore, ancestor warnings, bulk restore.

## 12-14. Files to Change, Why, Risk

| # | File | Why | Risk |
|---|---|---|---|
| 1 | `server/db/schema.sql` | `deleted_batch_id` on 12 tables + `deletion_batches` table; idempotent | **Med** — schema; must work on new + existing DBs |
| 2 | `server/db/repository.ts` | `listDeleted()`, `restore()`, batch-aware delete per entity | **High** — touches every entity's delete path |
| 3 | `server/features/resources/deletionGraph.ts` *(new)* | Closure resolver | **Med** — pure logic, unit-testable |
| 4 | `server/features/resources/routes.ts` | Preview + cascade wiring in generic CRUD | **High** — destructive endpoint |
| 5 | `server/features/resources/recycleBinRoutes.ts` *(new)* | List/restore/purge endpoints | Low |
| 6 | `server/shared/storage.ts` | JSON fallback: soft-delete parity or explicit unsupported | **Med** |
| 7 | `src/pages/RecycleBin.tsx` *(new)* | Recycle bin UI | Low |
| 8 | `src/components/DeleteImpactDialog.tsx` *(new)* | Pre-delete preview | Low |
| 9 | `src/components/RestoreScopeDialog.tsx` *(new)* | Restore prompt | Low |
| 10 | `src/lib/useBulkDelete.ts` | Route through preview | Med |
| 11 | `src/App.tsx` + nav | Route + sidebar entry | Low |
| 12 | `scripts/test-recycle-bin.ts` *(new)* | Closure + restore tests | Low |
| 13 | `server/features/auth/permissions.ts` | `recycle-bin:read` / `:restore` | Low |

Phase A is items 1, 2, 5, 7, 11, 12, 13 (7 files — within the 10-15 cap).
Phase B is 3, 4, 8, 10 (4 files). Phase C is 9 plus touch-ups.

## 15. Backward Compatibility

- `deleted_batch_id` is nullable: rows deleted before this change restore individually, which is
  correct — they had no cascade.
- No existing endpoint changes shape; cascade is added behind a flag and a preview step.
- `requirement_case_links` uses a real FK with `ON DELETE CASCADE`; soft delete does **not** fire it,
  so links survive and restore is lossless. Do not convert these to hard deletes.

## 16. Migration Strategy

Additive DDL only (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`), applied by the existing
`migrate()` on boot. No backfill. `scripts/setup-db.bat` re-verified per the repo rule.

## 17. Testing Strategy

- Unit: closure resolver — shared case across two plans is **detached, not deleted**; suite DAG with a
  cycle terminates; exclusively-owned chain fully cascades.
- Integration: delete plan → recycle bin shows batch of N → restore self → only root returns; restore
  batch → all return with links intact.
- Scope: user B cannot see or restore user A's deleted rows.
- Regression: existing delete tests still pass; `npm run lint`; JSON-store path.

## 18. Rollback Strategy

Flag `RECYCLE_BIN_CASCADE=false` restores single-row delete instantly. The schema additions are
inert if unused. Worst case, `UPDATE <table> SET deleted_at = NULL WHERE deleted_batch_id = $1`
reverses any cascade by hand.

## 19. Estimated Effort

Phase A ~1 day · Phase B ~1-1.5 days · Phase C ~0.5 day. Total ≈ 3 days including tests.

## 20. Recommended Implementation Order

- [ ] **Phase A — Recycle Bin (recover what already exists).** Files 1, 2, 5, 7, 11, 12, 13. Risk: Med.
- [ ] **Phase B — Cascade delete + impact preview.** Files 3, 4, 8, 10. Risk: High.
- [ ] **Phase C — Restore scope prompt + bulk restore.** File 9 + touch-ups. Risk: Low.

## Open decisions (recommendation first)

1. **Shared children on delete** — *Recommended:* detach, never delete, and show it in the preview.
   Alternative (delete everything reachable) risks silent data loss across plans.
2. **Requirements under a plan** — requirements link to *cases*, not plans, so a plan delete reaches
   them only transitively. *Recommended:* cascade only requirements exclusively linked to cascaded
   cases.
3. **Retention** — *Recommended:* keep indefinitely for now; add a purge policy later.
4. **JSON fallback** — *Recommended:* implement soft delete there too, so behaviour matches.
