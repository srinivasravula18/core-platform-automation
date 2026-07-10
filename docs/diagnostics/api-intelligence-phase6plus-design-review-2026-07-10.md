# Principal-Engineer Design Review — API Intelligence Phase 6+

**Status: REVIEW ONLY. No code written. The implementation plan is NOT modified by this document.** This is an adversarial, production-readiness review of `api-intelligence-phase6plus-qa-intelligence-plan-2026-07-10.md` (and, where relevant, the underlying Phase 1–5 plan). I wrote the plan under review; I am reviewing it as if a peer wrote it, and I disagree with several of its decisions.

**Severity legend:** 🔴 Blocker (fix before build) · 🟠 Major (fix in design) · 🟡 Minor · ⚪ Nit.

---

## TL;DR — the five things that matter

1. 🔴 **The generic `graph_edges` polymorphic table contradicts this codebase's proven pattern (typed link tables like `requirement_case_links`) and sacrifices foreign-key integrity.** It will accumulate orphans, resist indexing, and be hard to query. Replace most of it with typed link tables.
2. 🔴 **Secrets/PII at rest.** `api_executions` and `APIEvidence` persist full request/response JSONB — including `Authorization` tokens, passwords, and user PII (business-rule tests literally create users). There is no redaction layer. This is a security defect, not a nice-to-have.
3. 🔴 **Phase 6+ builds on scaffolding that does not exist yet.** Phases 1–5 are unbuilt, and F9/F10 depend on the WorkerContext + Prompt-Budget from the *evidence* plan's Phase C, which is also unbuilt and explicitly deferred. The plan quietly assumes all of it.
4. 🟠 **Cross-layer DOM verification per endpoint is not viable at scale** — DOM inspection took 3+ minutes per page in the traced UI runs; running it per endpoint on a large API surface is infeasible. It must be bounded by design, not a footnote.
5. 🟠 **Too many features, too shallow.** 11 features across 6 phases is a breadth trap. Several tables/agents are premature (`graph_nodes`, `qa_memory_index`, `api_coverage_snapshots`, a second validator agent). Deliver a thin vertical slice first.

If only two changes are made: **(a) typed link tables instead of `graph_edges`, and (b) a redaction layer before anything is persisted.**

---

## 1. Architectural consistency — 🟠 Major

- **Dual source of truth.** Phases 1–5 store API runs as JSON blobs (`db.apiRuns`, mirrored on `agent_runs.raw` in PG). Phase 6 introduces normalized relational rows (`api_endpoints`, `graph_edges`, ...) for the *same* endpoints. So an endpoint exists both as a JSON field inside a run blob and as a relational row — two representations that can drift. **Decide the source of truth up front:** either endpoints are relational from Phase 1 (and runs reference them by id), or the graph is a projection rebuilt from run blobs. The plan straddles both and creates a sync seam.
- **Pattern break.** The existing schema is "lightly-normalized entities + JSONB blobs + typed FK link tables." Phase 6 introduces a *polymorphic* edge table, a new idiom the codebase doesn't use. Two mental models for relationships is a consistency cost every future contributor pays.

**Recommendation:** endpoints/DTOs relational from Phase 1; relationships as **typed link tables** matching `requirement_case_links`. Reserve a single generic edge table (if any) only for genuinely open-ended, low-volume links — not the hot paths.

## 2. Scalability — 🟠 Major

- **`graph_edges` polymorphic joins.** Evidence-chain traversal (F11) over `(src_type,src_id,edge_type,dst_type,dst_id)` requires recursive CTEs with type-dispatch — hard to index, hard to bound, slow as the graph grows. Typed link tables give you narrow, individually-indexed joins.
- **`api_executions` is unbounded append-only** and is the input to flaky detection (F8) and coverage trends (F7). Without partitioning/retention/rollup from day one, it becomes a storage and query problem within a year on any active project. The plan mentions a "sample window" but no retention or aggregation strategy.
- **Coverage dashboard** recomputing aggregates over graph + executions on every load won't scale; needs cached rollups (or the `api_coverage_snapshots` table used as a rollup, not a trend-only extra).

**Recommendation:** retention + daily rollup table for executions; typed indexed link tables; precomputed coverage rollups.

## 3. Long-term maintainability — 🟠 Major

- **Polymorphic edges have no referential integrity.** You cannot FK a polymorphic `src_id`/`dst_id`, so deleting a case/requirement/run leaves orphaned edges forever. The existing schema gets this right with `ON DELETE CASCADE/SET NULL`. In two years, `graph_edges` is a swamp of dangling rows and magic-string `edge_type`s nobody dares prune. **Typed link tables self-clean via CASCADE.**
- **Feature sprawl.** Each of the 6 phases adds agents + tables + endpoints + UI. Left unchecked, API Intelligence becomes as large as the existing agent subsystem, with its own drifting conventions. Fewer, deeper features age better than eleven shallow ones.

## 4. Runtime performance — 🟠 Major

- 🔴-adjacent: **Cross-layer DOM check per endpoint is a non-starter.** `domExplorer`/inspection was minutes per page in real runs. Iterating it per endpoint across a real API is infeasible. This must be a hard design rule: DOM cross-check is **opt-in, sampled, and reserved for a handful of Critical, UI-observable mutations** — never the default per-endpoint path. The DB cross-check (a record query) is cheap and can stay broader.
- **GraphUpsert write amplification.** Every run writing many edges → batch in one transaction; rely on `UNIQUE` upserts for idempotency.

## 5. Database design — 🔴 Blocker (the edge model) + 🟡

- 🔴 Replace generic `graph_edges` with typed link tables (see §1–§3). Keep the graph *concept*; drop the polymorphic *table*.
- 🟡 **`graph_nodes` registry is redundant** — the plan itself says "most node types are existing tables." A node registry duplicates identity that already lives in `requirements`/`cases`/`api_endpoints`. Cut it; use the existing tables as nodes.
- 🟡 **`api_missions` PK is ambiguous** ("= run_id or mission_id"). Pick one. For v1, mission is a small run-scoped object — a single JSONB column on the run (or one `api_missions` row keyed by run_id) beats two tables (`api_missions` + `api_mission_tasks`); split later only if tasks need independent querying.
- 🟡 **`qa_memory_index` (with optional embedding) is premature.** The plan admits it's optional. Recall can query the normalized tables directly. Adding an index (and a vector column) before a proven recall-perf problem is speculative. Cut from the core.
- 🟡 **Multi-tenant leak risk:** a polymorphic edge table makes it easy to forget project/owner scoping on a traversal and leak cross-tenant links. Typed tables with `project_id` + FKs make isolation the default.

## 6. Agent responsibilities — 🟠 Major

- **Two validator agents is unnecessary.** `apiBusinessRuleValidator` (F4) and the Phase-3 `apiValidator` are the same job with different inputs — business rules are just another validation dimension. Collapse to **one** validator agent that takes an optional rules set. Two agents = two prompts to keep in sync = drift. The plan even hedges ("could extend apiValidator") — do that.
- Keeping dependency inference, risk scoring, flaky detection, and contract diffing as **deterministic code (not agents)** is correct — hold that line.
- `apiFlowPlanner` as a distinct agent is justified (flow synthesis ≠ per-endpoint case planning). Keep it, but consider whether it's a *mode* of `apiTestPlanner` to avoid a fourth API agent.

## 7. WorkerContext usage — 🔴 Blocker (dependency) 

- **F9 (Mission State) and F10 (QA Memory) "populate WorkerContext slots" — but WorkerContext and the Prompt-Budget manager do not exist.** They're the evidence-driven plan's Phase C, explicitly deferred and unapproved for build. So Phase 10 has a hard dependency on unbuilt, unapproved infrastructure. Options: (a) build a minimal typed WorkerContext first, (b) deliver Mission State as a standalone typed object consumed directly by the API agents (no dependency on the general WorkerContext), or (c) gate Phase 10 behind Phase-C approval. **The plan must name this dependency instead of assuming it.** My recommendation: (b) — a self-contained `ApiMissionContext` the API planner/validator read directly, decoupled from the general WorkerContext, so Phase 10 isn't blocked on Phase C.

## 8. Evidence Registry integration — 🟠 Major

- **payloadRef model mismatch.** The Evidence Registry stores *metadata only* and points `payloadRef` at a `run.*` field. But API intelligence stores payloads in **PG tables**, not on the run object. So APIEvidence either (a) keeps payloads on the run JSON (contradicting the normalized-PG direction) or (b) needs `payloadRef` to address a table row (a registry change — which we're told not to make). This seam is unaddressed. **Decide:** APIEvidence payloads live on the run blob (registry unchanged, PG holds only derived intelligence), which is the least-disruptive answer and keeps the registry contract intact.
- 🟡 **`'risk'` should not be an evidence type.** Evidence = observed proof; risk is a *derived score*. Overloading `EvidenceType` with a computed metric muddies the vocabulary. Drop `'risk'`; keep `'api'`, `'api_flow'`, `'business_rule'`, `'regression'`. (Flaky/coverage are correctly *not* evidence types.)

## 9. Failure recovery — 🟠 Major

- **Flow mutation leaks.** Flows like register→create→share→delete create real state. If a flow fails midway there is no cross-HTTP transaction to roll back. The plan says "cleanup" but doesn't specify **compensating teardown steps + idempotency keys**. Without them, failed flows leave orphaned records and poison reruns. This must be designed, not assumed.
- **PG-down mid-run is undefined.** The platform supports a JSON fallback, but Phase 6 is "PG-first." What happens to an in-flight run if PG is unavailable at GraphUpsert? Define: run completes (evidence on the blob), graph write is deferred/retried; never fail the whole run because analytics couldn't persist.
- Graph upserts must be idempotent (the `UNIQUE` constraints enable this) and retried; partial graphs are acceptable and self-heal on the next run.

## 10. Backward compatibility — 🟢 Good, with one watch

- Additive tables/endpoints/UI and an additive `EvidenceType` extension (consumers have `default` handling) are genuinely backward-compatible. ✅
- 🟡 **Watch:** Mission State replacing conversation history *for API agents only* is safe **iff** no shared code path is mutated. Verify the API agents use a separate context assembler; do not touch the UI agents' history handling.

## 11. Security — 🔴 Blocker

- **Unredacted secrets/PII at rest.** `api_executions.request/response` and APIEvidence persist full headers/bodies — `Authorization: Bearer ...`, `Set-Cookie`, passwords, emails, tokens, and any PII the API returns. Stored in PG, queryable, and surfaced in the Evidence Explorer UI. **Required:** a redaction layer that masks known-sensitive headers/fields (auth, cookie, password, token, secret, and configurable PII paths) *before* persistence and *before* UI display. Non-negotiable for enterprise.
- **Mutating flows against production.** The Risk engine lists "production usage" as a factor, implying prod runs. Mutating flows (create/delete users) against prod is dangerous. **Hard-block mutating flows when the resolved environment is production**; require an explicit non-prod target.
- **Cross-tenant isolation** — reinforced by §5: typed, project-scoped, FK'd tables make isolation the default; polymorphic edges make a leak one forgotten `WHERE` away.
- Tokens in flow chaining must live only in memory during the run, never logged, never persisted (see redaction).

## 12. API design — 🟡 Minor

- Namespacing under `/api/api-intelligence/*` and body/`x-project-id` scoping are consistent with the app. ✅
- 🟡 **Graph/chain endpoints can return unbounded payloads.** `/graph/chain/:id` could serialize an entire evidence web. Enforce **depth limits + pagination + an ego-graph default** (N-hop neighborhood), not the whole graph.
- 🟡 `/flows/:id/run` is a mutating trigger — must sit behind the write-safety gate and an explicit confirmation, not a bare POST.

## 13. UI scalability — 🟠 Major

- **Hand-rolled SVG graph vs "no external graph lib" is a contradiction at scale.** Readable layout of hundreds of nodes/edges is genuinely hard (force-directed, collision, zoom/pan) — reimplementing it well is a project of its own. Two honest options: (a) allow one small, vetted, self-contained graph-view lib (the "no external *graph database*" rule was about persistence, not visualization — clarify the constraint), or (b) **never render the whole graph** — show a bounded ego-graph around the selected node with click-to-expand. I recommend (b) regardless; whole-graph views are unusable past ~100 nodes anyway.
- Evidence Explorer must **lazy-load** the chain (one hop at a time), not load-everything.
- Coverage dashboard on Recharts with precomputed rollups is fine.

## 14. Risk of technical debt — 🟠 Major

Ranked debt sources: (1) polymorphic `graph_edges` (no FKs, magic strings, orphans); (2) dual JSON-vs-PG source of truth; (3) building on unbuilt Phases 1–5 + unbuilt WorkerContext/budget — assumptions rot if those change; (4) speculative `qa_memory_index` embedding; (5) eleven features half-built. Each is avoidable now, expensive later.

## 15. Unnecessary complexity — 🟠 Major (cut list)

Concrete cuts, in priority order:
1. `graph_edges` (generic) → typed link tables. **Biggest simplification.**
2. `graph_nodes` registry → use existing tables as nodes. **Cut.**
3. Second validator agent → one validator. **Merge.**
4. `qa_memory_index` (+ embedding) → query normalized tables. **Defer.**
5. `api_coverage_snapshots` → only if trends are proven-needed; otherwise compute-on-read with a cache. **Defer.**
6. `api_missions` + `api_mission_tasks` (two tables) → one run-scoped mission object for v1. **Collapse.**
7. `'risk'` evidence type → not evidence. **Drop.**

---

## Phase reordering & sequencing recommendations

1. 🔴 **Build a thin end-to-end vertical slice before the intelligence layer.** The safest first deliverable is *Phase 1–3 of the core plan* (discover → plan → execute → validate → one regression baseline → evidence → report) against a real API. Prove the core loop earns trust before investing in graph/risk/flow/coverage. Phase 6 has nothing to attach to until this exists.
2. **Bring Dependency (F2) and Risk (F5) adjacent to Planning.** They exist to inform the planner (core Phase 2). Landing them in Phases 6/8 means the planner ships "dumb," then gets retrofitted twice. Consider: minimal dependency + risk *inputs* alongside the planner, richer graph later.
3. **Gate F9/F10 (Mission State, QA Memory) on a decision about WorkerContext** (see §7). Prefer a self-contained `ApiMissionContext` so they're not blocked on the deferred evidence-plan Phase C.
4. **Keep Flaky (F8) and Evidence Explorer (F11) last** — flaky needs execution history (inherently late-value); the explorer needs the (now typed) link tables. Correct as sequenced.
5. **Flow Testing (F9 in core numbering / Phase 9 here) is the highest-risk phase** (mutations, teardown, prod-blocking, redaction). It should not ship until redaction + compensating-teardown + prod-block are in place — i.e. after the security layer.

## Recommended revised shape (if adopted)

- **Persistence:** typed link tables (reuse `requirement_case_links` pattern), relational endpoints/DTOs from Phase 1, run blobs remain the payload store; graph is a projection over typed tables. Executions get retention + rollup. A redaction layer wraps all persistence.
- **Agents:** `apiDiscovery`, `apiTestPlanner` (risk/dep-aware, with a flow mode or a sibling `apiFlowPlanner`), **one** `apiValidator` (rules-capable), `apiFailureAnalyst`, `apiReporter`. No second validator.
- **Context:** self-contained `ApiMissionContext` (decoupled from the general WorkerContext) so Mission State/QA Memory aren't blocked.
- **UI:** ego-graph views + lazy-loaded chains, not whole-graph rendering; clarify the "no graph lib" constraint.
- **Scope discipline:** ship the vertical slice, then F1/F2 (typed graph + deps), then F3/F4 (versioning + rules in the one validator), then F5/F8 (risk + flaky), then F6 (flows, gated on security), then F7/F11 (dashboard + explorer). Fewer tables, one validator, redaction throughout.

---

## Bottom line

The plan is directionally sound and genuinely additive, but three items are production blockers as written: the **polymorphic edge table** (replace with typed link tables), the **absence of a redaction layer** (secrets/PII at rest), and the **unstated dependency on unbuilt Phases 1–5 and WorkerContext**. Two are scale traps: **per-endpoint DOM cross-check** and **whole-graph UI rendering**. And the feature set is broader than it needs to be — cut the seven items in §15 and ship a trustworthy vertical slice first.

**This is a review only. The implementation plan is unchanged. No code was written. Recommend reconciling these findings into a revised plan (separate turn) before any Phase 6 build begins.**
