# Object + Metadata + Background Data Population — Lifecycle Benchmark

**App:** Test Flow AI (`core-platform-automation`)
**Pipeline under test:** Requirements drafting agent (`POST /api/requirements/draft/stream`)
**Target codebase:** `D:\core-platform` (Admin + Keystone/Shockwave + Service)
**Grounding source:** direct-DB metadata catalog (`corePlatformData.ts:fetchCorePlatformObjectCatalog`) + git source
**Date:** 2026-06-23
**Result:** 20/20 drafts completed, zero failures, zero hallucinations in sampled cross-verification.

---

## 1. Purpose

Verify that the requirements AI can correctly map the **object → metadata → Keystone lifecycle** and the **background data population** — i.e. when an admin does CRUD on object metadata (fields, layouts, forms, record types, buttons, validation/trigger rules), does the AI correctly describe what happens for the Keystone (Shockwave) end user, and the server-side population (defaults, auto-name, triggers, audit, computed fields)?

This is the **first half** of the MCP comparison (own direct-DB grounding); the second half re-runs the same 20 prompts via srinivas's API-based MCP for a head-to-head decision.

## 2. The propagation chain (confirmed in code)

The benchmark is grounded in this verified chain (all file:line confirmed by source inspection):

- **Describe hub** (admin metadata → Keystone): `apps/service/src/apps/routes.ts:1373-2070` (`GET /api/apps/:appId/objects/:object/describe`) assembles fields, record types, layout, form, buttons, list-view features per user → consumed by Shockwave `fetchObjectDescribe` (`apps/shockwave/src/api.ts:2227`) → `ShockwaveRecordPanel.tsx`.
- **Layout/form resolution:** `resolveAssignedLayout` (`apps/routes.ts:467`), `resolveAssignedForm` (`:522`), using `meta.layout_assignment` / `meta.form_assignment` + record type.
- **Button gating:** `resolveButtonsForObject` (`:1737`) filtered by `checkPermission(resource_type:"button")` (`:1741`).
- **Write-time engines** (background population): ValidationEngine (`validations/engine.ts`), TriggerEngine (`triggers/engine.ts`), auto-name (`records/name-policy.ts`), computed fields (`records/computed-fields.ts`), audit (`records/audit-log.ts`), email (`email-notifications/templates.ts`).

## 3. Methodology

20 prompts across 3 tiers, each POSTed to the requirements draft SSE endpoint with `X-Project-Id: PRJ-CORE-PLATFORM`; the final draft JSON saved per prompt. Per-prompt: source files (real/total), metadata refs (real api_names), business-rule count, admin/keystone/data surface population. A sample per tier was grepped against the real code to confirm claim accuracy.

## 4. Full per-prompt results

Legend: **Src** real/total source files · **Meta** real metadata refs · **Rules** business-rule count · **A/K/D** Admin/Keystone/Data populated.

### Tier 1 — Object record lifecycle (+ background population)
| # | Prompt | Src | Meta refs | Rules | A/K/D |
|---|---|---|---|---|---|
| 1 | Create lifecycle | 23/24 | object, field, access_record, trigger_audit_log, contact | 52 | ✅✅✅ |
| 2 | Inline-edit lifecycle | 10/12 | object, field, trigger_audit_log, object_audit_log | 19 | ✅✅✅ |
| 3 | Soft-delete lifecycle | 14/15 | access_record, meta_audit_log, trigger_audit_log | 37 | ✅✅✅ |
| 4 | Restore lifecycle | 11/12 | access_record, field, flow, scheduled_job, sharing_rule, tab, trigger_audit_log | 28 | ✅✅✅ |

### Tier 2 — Object metadata → Keystone (describe-driven)
| # | Prompt | Src | Meta refs | Rules | A/K/D |
|---|---|---|---|---|---|
| 5 | Field add | 15/15 | field, object | 26 | ✅✅✅ |
| 6 | Field edit (required/picklist/type) | 15/15 | field, access_record, meta_audit_log | 43 | ✅✅✅ |
| 7 | Field delete (with data) | 6/6 | field | 9 | ✅✅✅ |
| 8 | Layout change | 10/10 | object | 25 | ✅✅✅ |
| 9 | Form change | 3/3 | object | 25 | ✅✅✅ |
| 10 | Record type add | 8/8 | object, field | 10 | ✅✅✅ |
| 11 | Button add | 10/10 | object | 15 | ✅✅✅ |
| 12 | Assignments change | 14/14 | *(none)* | 16 | ✅✅✅ |
| 13 | List-view assignments change | 11/11 | object, role, group, user | 28 | ✅✅✅ |

### Tier 3 — Background data population (write-time engines)
| # | Prompt | Src | Meta refs | Rules | A/K/D |
|---|---|---|---|---|---|
| 14 | Default population on create | 10/10 | field | 18 | ✅—✅ |
| 15 | Validation rule add | 6/6 | object | 20 | ✅✅✅ |
| 16 | Trigger rule add | 14/16 | trigger_audit_log, object_audit_log | 30 | ✅✅✅ |
| 17 | Computed fields (formula/summary) | 8/8 | field, object | 34 | ✅—✅ |
| 18 | Auto-name generation | 7/7 | object | 25 | ✅—✅ |
| 19 | Audit log lifecycle | 7/9 | meta_audit_log, object_audit_log, object | 15 | ✅✅✅ |
| 20 | Email template lifecycle | 12/12 | object | 43 | ✅✅✅ |

## 5. Cross-verification against code (sampled per tier — every claim matched)

| Tier | Draft claim | Code location | Verdict |
|---|---|---|---|
| 1 | Create resolves record-type/layout/form metadata via describe | `apps/routes.ts:467,522,1630-1672` | ✅ |
| 2 | Buttons filtered by `checkPermission(resource_type:"button")` | `apps/routes.ts:1737-1741` | ✅ |
| 2 | List-view features resolved per user | `apps/routes.ts:1764` | ✅ |
| 3 | Trigger engine + audit + 6-event list | `triggers/engine.ts`, `audit.ts`, migrations `0072/0073/0076` | ✅ verbatim |
| 3 | Computed summary ops `count/sum/avg/min/max/join` | `computed-fields.ts:10` | ✅ verbatim |
| 3 | Auto-name via `name_generation_mode`/`name_auto_prefix` | `name-policy.ts:8-76` | ✅ |
| 3 | Email template from `meta.email_template` | `email-notifications/templates.ts:792` | ✅ |

**Zero hallucinations** in every claim checked.

## 6. Aggregate scorecard

| Metric | Value |
|---|---|
| Completion | 20/20 (100%) |
| Source files real / total | **214/223 (96%)** |
| Drafts with populated metadata refs | **19/20 (95%)** |
| Avg business rules / draft | 26 (range 9–52) |
| Admin behaviour populated | 20/20 |
| Keystone populated | 17/20 (3 correctly blank — pure backend) |
| Data-population notes | 20/20 |

### Per-tier
| Tier | Prompts | Avg rules | Src real% | Meta avg |
|---|---|---|---|---|
| 1 — Record lifecycle | 4 | 34 | 92% | 4.8 |
| 2 — Metadata → Keystone | 9 | 22 | 100% | 1.7 |
| 3 — Background population | 7 | 26 | 94% | 1.6 |

## 7. Findings (honest)

1. **Metadata grounding fix is holding** — 19/20 populated real meta api_names. Only **#12 Assignments-Change** returned 0: assignments are a junction concept (`layout_assignment`/`form_assignment`), not a top-level catalog object, so there was nothing to map. Expected, not a defect.
2. **Keystone correctly blank on 3** (#14, #17, #18) — these are pure server-side population; the AI correctly avoided inventing UI behavior.
3. **#5 Field-Add was admin-flow-heavy** — nailed the admin field-creation flow but leaned less on the describe→Keystone render half (the propagation is covered by #1). A prompt tweak could rebalance it.
4. **Source grounding excellent (96% real)** — the 4% are temp/compiled artifacts (`.tmp-*`), not invented files.

## 8. Conclusion

The requirements AI **accurately maps the admin-metadata → Keystone lifecycle and the background data population**: 96% real source grounding, 95% real metadata, zero hallucinations across all sampled claims. The describe-endpoint propagation (fields/layout/form/buttons/record-types/list-view-features) and the write-time engines (validation/trigger/computed/auto-name/audit/email) are correctly traced.

This establishes the **direct-DB grounding baseline**. The next document compares the same 20 prompts grounded via srinivas's API-based MCP, to decide own-MCP vs srinivas's-MCP on quality + security (no data leakage) + meta-object coverage.

## Appendix — artifacts
| Artifact | Location |
|---|---|
| Per-prompt results (CSV) | `scripts/result-objmeta.csv` |
| Full draft JSONs | `scripts/objmeta-json/*.json` |
| Sweep script | `scripts/sweep-objmeta.ps1` |
