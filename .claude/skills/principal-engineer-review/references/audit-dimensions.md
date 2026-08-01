# Per-dimension question sets

Ask these; cite `file:line`; mark absent artifacts as `DEFECT: absent`.

## 1. Safety / injection
- Does every model-facing prompt route through the shared policy stack, or do any bypass it by passing a raw system string?
- Can a stored prompt override **replace** (rather than layer onto) the safety blocks?
- Is untrusted content — repo files, DB text authored by users, scraped DOM, tool output — delimited and marked non-instructional, or concatenated as trusted?
- Is prompt-level confirmation required before destructive/live actions, independent of code gating?

## 2. Data isolation
- What is the scope key on each store? Is it enforced in the `WHERE` clause or filtered in application code after a broad fetch?
- Any `OR <col> IS NULL` disjunction in a scope filter? (Null-owner rows then match every user.)
- Any unscoped `SELECT *` reachable from a live code path (traces, exports, debug endpoints)?
- Process-global caches/singletons keyed without the owner?
- Is there a personal-vs-shared tier, or is sharing an accident of a null/wildcard fallback?

## 3. Canonical state
- For each fact: one authoritative store, or several that can drift?
- Two writers on one key: overwrite, version, or reject? Show the write path.
- Insert-only stores accumulating contradictions with no invalidation?
- Does a read prefer the wrong store under any condition (e.g. "whichever is longer")?

## 4. Execution topology
- Sync call stack or async dispatch? Show the line that kicks work off after the response.
- Is there a concurrency cap, semaphore, or queue — or is it unbounded?
- What is lost on crash mid-flight? Does a checkpoint hold payloads or only references?
- Multi-instance: what breaks first? Look for per-process registries, boot-time reconcilers with no ownership check, schedulers with no leader election.

## 5. Tool calling
- Is `effect` (read/write/destructive) declared per tool or inferred from the name?
- Is capability re-checked at dispatch, or only at visibility/listing time?
- Is there argument-schema validation before execute?
- Are writes verified by deterministic re-read — and does a failed verification force rejection, or merely inform the model?
- Is the full tool catalog sent every call, or filtered per request?

## 6. Agent dynamics
- Every loop that can iterate: max count, the line enforcing it, and the fallback at the cap (hard fail / accept-with-warning / human escalation / silent stop).
- Can a downstream agent veto or push back upstream, or is the pipeline one-directional?
- Is a revision after a critique **re-verified**, or accepted on non-emptiness?
- Any self-reported status (`accepted`, `verified`, `complete`) that unblocks the pipeline without being checked against what executed?
- Is the ground-truth checker's own output verified, or trusted blindly?

## 7. Observability
- Can the full chain (tool calls, evidence, decisions) be reconstructed from persisted data after the fact?
- Is the trace keyed by the run id, or by a per-call id that cannot be joined?
- Is the assembled prompt persisted, or only metadata about it?
- Does every stored fact carry producer + timestamp + causation? Go table by table.

## 8. Evaluation
- Does a golden set exist and run on change? Do the eval entry points resolve to real files?
- What is the measured success rate, and how was it produced?
- Is there an adversarial/red-team subset?
- Is quality tracked as a trend, or inspected reactively?

## 9. Cost & reliability
- Is cost attributable per run, or only per call/day? Is there a join key to the run?
- Is there a mid-flight ceiling per run/user/day — and is the guard actually reachable (check that callers populate its inputs)?
- Any provider that reports zero usage and thus spends invisibly?
- Rate limiting or abuse detection on expensive actions?
- Provider outage: fallback model, queue, circuit breaker — or hard fail?
- What computation is reused across runs, and does it survive a restart?

## 10. Governance
- Is there a single deletion path per user/workspace? Do owner columns have enforced foreign keys?
- What does the audit log actually cover — mutations only, which routes, any read/access logging?
- What user data egresses to third parties, and is it classified or redacted on the way out?
- Can you reconstruct which prompt version + served model + code build produced a given historical run?
