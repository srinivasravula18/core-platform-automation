---
name: principal-engineer-review
description: Use when asked for a full architecture, security, memory, production-readiness, or due-diligence review of this system — or any request phrased as "audit my architecture / agents / memory / prompts", "is this production ready", "what would a principal engineer flag". Runs the audit dimensions in root-cause order and produces a code-cited findings report, then a phased roadmap only if asked.
---

# Principal engineer review

An umbrella review. Runs the audit dimensions in **root-cause order**, produces findings first, remediation only on request.

## Operating rules

1. **Analysis only by default.** Do not modify files, refactor, or implement during a review. This repo's architect process (see `CLAUDE.md`) requires a written plan approved on a **later turn** before any code changes.
2. **Every claim carries `file:line`.** Inspect the actual current code — never answer from memory, prior sessions, or documentation. Docs describe intent; code is behavior.
3. **Unanswerable is a finding.** If a question cannot be answered from the code (no SLA exists, no eval exists, no owner is defined), write `DEFECT: absent — <what is missing>`. The absence of an artifact is the diligence result, not a gap in the review.
4. **Take a position.** Every finding gets a verdict and a one-line reason. Never park a judgment call as "up to you" with no recommendation.
5. **Separate built-from-live.** A subsystem that exists but is flag-gated OFF, has zero callers, or runs shadow-only is **not** the live behavior. State which path actually executes. This is the single most common source of false comfort.

## Dimension order (root-cause first)

Run in this order — each earlier dimension can invalidate findings in later ones.

| # | Dimension | Core question |
|---|---|---|
| 1 | **Safety / injection** | Does untrusted content reach the model as trusted? Can an override strip the safety stack? |
| 2 | **Data isolation** | Can one user's data reach another's session? Check *every* read path, not the obvious one. |
| 3 | **Canonical state** | Is there one source of truth per fact, or shadow copies that can disagree? Insert-only or versioned? |
| 4 | **Execution topology** | Sync or async dispatch? Concurrency bound? What survives a crash? What breaks on a second instance? |
| 5 | **Tool calling** | Is capability declared or name-inferred? Is it enforced at dispatch? Are writes verified by re-read, and does that verification gate acceptance? |
| 6 | **Agent dynamics** | Conflict resolution, veto paths, loop caps and their fallbacks, self-reported status vs actual work. |
| 7 | **Observability** | Can a wrong output be reconstructed after the fact? Does every stored fact record producer + timestamp + causation? |
| 8 | **Evaluation** | Is quality measured or spot-checked? Does a regression gate exist? |
| 9 | **Cost & reliability** | Per-run cost attribution, ceilings, rate limits, provider fallback. |
| 10 | **Governance** | Deletion path, audit coverage, third-party egress classification, reproducibility. |

For a pipeline-behavior question ("why did this run do X"), delegate to the `agent-pipeline-forensics` skill instead — it traces one real run rather than surveying the codebase.

## Method

- **Fan out, then synthesize.** Dispatch parallel read-only investigations per dimension; each returns `file:line`-cited findings. Never let one agent's summary stand in for reading the code when the claim is load-bearing.
- **Verify the structural claims yourself.** Feature flags, default values, and "is this actually wired" questions are cheap to check directly and too important to delegate blindly.
- **Cross-check agent reports.** Subagents can be confidently wrong. If two reports disagree, read the code.

## Report format

1. **Plain-language verdict, 2–3 sentences.** What is actually true, what it costs, what is at risk.
2. **Findings by dimension** — each with `file:line`, a verdict, and one line of reasoning. Include what is genuinely **good and worth preserving**; a review that only lists faults is not calibrated.
3. **Cross-cutting themes** — the 2–4 root causes that explain most individual findings. Individual defects are symptoms; name the disease.
4. **Ranked defects** by the axes the request implies (silent wrong output / cost runaway / data loss / security / revenue risk).

## Remediation (only when asked)

Produce a phased plan with checkboxes: phase goal, risk level, scope cap (≤10–15 files or one subsystem), acceptance criteria, and rollback. Order phases by **impact per unit of risk**, not architectural elegance. Live harm and measurement come before refactors.

Be honest about ceilings: for LLM systems, the target is measured accuracy with residual failures **surfaced**, not eliminated. Never promise 100%.

See `references/audit-dimensions.md` for the per-dimension question sets.
