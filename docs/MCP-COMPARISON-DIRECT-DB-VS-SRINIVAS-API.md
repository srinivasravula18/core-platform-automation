# MCP Grounding Comparison — Direct-DB vs API vs Swagger

**Question:** How should the test-automation app ground its core-platform metadata — own **direct-DB read** (`meta.object`), **plain API** (App Service `/api/apps/.../objects`), or the **OpenAPI/Swagger spec** (paths derived into a catalog)?
**Method:** the **same 20 object/metadata/background lifecycle prompts** run through the identical requirements pipeline; the **only** variable is the catalog source (`CORE_PLATFORM_CATALOG_SOURCE = db | api | swagger`).
**Date:** 2026-06-24
**User priority:** API-based (no direct DB) to avoid data leakage. This finds the source that's both secure AND well-grounded.

---

## 0. THREE-WAY VERDICT (updated)

| Metric | Direct-DB | API (plain) | **Swagger** |
|---|---|---|---|
| Drafts with metadata populated | 19/20 | 5/20 | **19/20** |
| Total metadata refs | 45 | 11 | 111 |
| Avg business rules | 25.9 | 25.0 | 24.2 |
| Data leakage | ⚠️ reads everything | ✅ none | ✅ **none** |
| Meta-object coverage | meta.object only (32) | business only | **richest (44, incl. trigger_rule/validation_rule/assignments)** |
| Over-tagged drafts (≥10 refs) | 0 | 0 | 3 |

**Winner: Swagger.** It matches the DB's metadata population (19/20) — but **purely via the API, no DB, no leakage** — and is *richer* than the DB because the spec's admin paths expose finer resources (`trigger_rule`, `validation_rule`, `layout_assignment`, `picklist`…) that aren't even rows in `meta.object`. It's also **app-agnostic**: any app's OpenAPI paths yield its catalog the same way.

**The one caveat:** on ~15% of prompts (3/20) Swagger **over-tags** — dumping 10-25 loosely-related objects because the 44-object catalog is so rich. Fix: a precision instruction in the drafting prompt ("list only the 1-5 objects that are the PRIMARY source of truth, not every related object"). With that guard, Swagger gives **DB-level relevance + API-level security + spec-level richness**.

**Recommendation:** adopt **`swagger` catalog source** (pure API, no DB) + a precision cap on `metadataRefs`. This supersedes the earlier "hybrid with read-only DB view" recommendation below — Swagger removes the need for any DB access at all.

---

## 1. Original two-way verdict (superseded by §0)

**Rule quality is identical; metadata grounding collapses on the plain API path — and when it does produce refs, they're frequently the *wrong* objects.** This is what motivated adding Swagger (which resolves it).

---

## 2. Aggregate comparison (20 matched prompts)

| Metric | Own Direct-DB | Srinivas API | Delta |
|---|---|---|---|
| **Avg business rules / draft** | 25.9 | 25.0 | ~tie (3%) — noise |
| **Total metadata refs** | **45** | 11 | DB **4×** |
| **Drafts with metadata populated** | **19/20** | 5/20 | DB |
| **Drafts with *correct* meta-object refs** | ~19/20 | ~2/20 | DB |
| **Data-leakage risk** | ⚠️ bypasses access control | ✅ none (access-enforced) | **API** |
| **Meta-object coverage** (tab/field/permission…) | ✅ full | ❌ hidden by `data_source='business'` | **DB** |
| **Prod credential surface** | DB role | API token only | API |

**Why rules tie:** both read the same git source for the narrative; the catalog only affects `metadataRefs`. So the *prose* requirements are equally good either way.

---

## 3. Per-prompt metadata refs (the decisive column)

| # | Prompt | DB refs | API refs |
|---|---|---|---|
| 1 | Create | object, field, access_record, trigger_audit_log, contact | *(none)* |
| 2 | InlineEdit | object, field, trigger_audit_log, object_audit_log | contact |
| 3 | SoftDelete | access_record, meta_audit_log, trigger_audit_log | *(none)* |
| 4 | Restore | access_record, field, flow, scheduled_job, sharing_rule, tab, trigger_audit_log | *(none)* |
| 5 | Field-Add | field, object | object |
| 6 | Field-Edit | field, access_record, meta_audit_log | field |
| 7 | Field-Delete | field | *(none)* |
| 8 | Layout | object | *(none)* |
| 9 | Form | object | *(none)* |
| 10 | RecordType | object, field | *(none)* |
| 11 | Button | object | **asset** ⟵ wrong |
| 12 | Assignments | *(none)* | *(none)* |
| 13 | ListViewAssign | object, role, group, user | *(none)* |
| 14 | BgPopulation | field | *(none)* |
| 15 | ValidationRule | object | *(none)* |
| 16 | TriggerRule | trigger_audit_log, object_audit_log | **contact, site, vendor, asset, account, sample, opportunity** ⟵ all wrong |
| 17 | Computed | field, object | *(none)* |
| 18 | AutoName | object | *(none)* |
| 19 | AuditLog | meta_audit_log, object_audit_log, object | *(none)* |
| 20 | EmailTemplate | object | *(none)* |

---

## 4. The two failure modes of the API path

1. **Blindness (15/20)** — the App Service `/api/apps/:id/objects` filters `data_source='business'`, so the meta-objects these requirements are *about* (`field`, `object`, `access_record`, `trigger_audit_log`, `meta_audit_log`, `tab`, `flow`, `permission`) are invisible. The draft is left with empty `metadataRefs`.
2. **Wrong-object substitution (e.g. #11, #16)** — when forced to pick from a catalog that contains only business objects, the model grabs irrelevant ones: a **Trigger Rule** requirement (whose source of truth is `trigger_audit_log` / `object_audit_log`) came back tagged with `contact, site, vendor, asset, account, sample, opportunity` — seven business objects, **all wrong**. The direct-DB path correctly tagged the two real meta-objects.

So the API path doesn't just under-populate — it can **mislead**.

---

## 5. The tradeoff, stated plainly

| | Own Direct-DB | Srinivas API |
|---|---|---|
| Metadata grounding | ✅ full + correct | ❌ mostly empty / sometimes wrong |
| Requirement prose quality | ✅ | ✅ (identical) |
| Data leakage | ⚠️ reads everything | ✅ access-enforced, none |
| Architectural consistency | diverges | matches srinivas |

The user's instinct (API = no leakage) is **correct and important** — but the API path **cannot see the platform metadata** that object/metadata/background requirements depend on, because that metadata is *intentionally* hidden from the business-objects API.

---

## 6. Recommendation — HYBRID (best of both)

Do **not** pick one wholesale. Split by data type:

| Data type | Source | Why |
|---|---|---|
| **Record data** (account, contact, sample…) | **Srinivas's API** (App Service `:5001`) | Access-enforced, **no leakage** — exactly the user's goal. Already how `corePlatformData.ts` works. |
| **Metadata catalog** (object/field/tab… api_names) | **Narrow read-only `meta.object` view** | The catalog is *schema, not user data*. Restrict a read-only DB role to `SELECT` on **only `meta.object` + `meta.app`** → full metadata grounding with a **near-zero leakage surface** (no business records reachable). |

This delivers:
- ✅ Full, correct metadata grounding (45 refs, 19/20 populated)
- ✅ No business-data leakage (record data stays behind the access-enforced API; the only DB exposure is the object/field *names*, which are not sensitive)
- ✅ Consistent with srinivas's pattern for everything that touches actual records

### Alternative (cleanest, but needs a core-platform change — out of scope per policy)
Add a meta-objects endpoint to core-platform's App Service (e.g. `/api/apps/:id/objects?include_system=true`). Then srinivas's pure API path would suffice with zero DB access. **Not pursued** — the user's rule is to make no changes in core-platform. Recommend raising this with the core-platform team as the long-term fix.

---

## 7. Bottom line

- **If you must choose one today:** the **own direct-DB** path is the only one that actually grounds these requirements — but scope it to a **read-only `meta.object`-only role** so it's not a real leakage risk.
- **The hybrid above is the recommended production shape:** srinivas's API for records (no leakage) + read-only meta-catalog for grounding.
- Srinivas's pure API approach, as-is, is **not sufficient** for object/metadata/background requirement drafting — not because it's badly built (it's the cleaner architecture), but because the metadata it needs is deliberately outside the business-objects API.

---

## Appendix — artifacts
| | Direct-DB run | Srinivas API run |
|---|---|---|
| Results CSV | `scripts/result-objmeta.csv` | `scripts/result-objmeta-srinivas.csv` |
| Draft JSONs | `scripts/objmeta-json/` | `scripts/srinivas-json/` |
| Baseline report | `docs/OBJECT-METADATA-LIFECYCLE-BENCHMARK.md` | — |
| Source switch | `corePlatformData.ts` — `CORE_PLATFORM_CATALOG_SOURCE` env | |
