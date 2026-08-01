---
name: agent-pipeline-forensics
description: Use when debugging a multi-agent pipeline run, tracing execution across agent/stage handoffs, investigating a mismatch between expected and actual agent behavior, or explaining an unexplained count (steps vs evidence frames, cases vs scripts). Produces a code-cited forensic report from one real persisted run.
---

# Agent pipeline forensics

Trace what **actually happened** in one real run, boundary by boundary, with literal payloads.

## The non-negotiable rule

**"A mechanism exists" is not a finding. "The mechanism fired on this run" is.**

Every claim must be one of:
- a literal payload copied from the datastore/artifact (not paraphrased, not reconstructed), or
- a `file:line` citation to the code that produced it.

If you cannot produce either, write **`DEFECT: unanswerable — <why>`** and move on. Never fill a gap with a plausible description of how the code is *supposed* to work.

## Method

1. **Pick one real run, name it, justify it.** Prefer a run that exhibits the exact reported phenomenon. State the run id, prompt, target, engine, status, and why this specimen and not another. If the obvious candidate has no usable data (no artifacts, still awaiting review), say so and pick the next one — explicitly.

2. **List the stage events in order** from the run store, plus whatever roster/chips the UI showed. Divergence between the two is itself a finding.

3. **Trace every boundary with literal payloads.** For each handoff, show the input artifact and the output artifact verbatim. Build the arithmetic chain explicitly, e.g.:
   `3 case steps → 13 plan steps → 14 runner calls → 12 executed + 1 harness frame = 13 evidence entries`
   Then name the **single** boundary where the multiplication/loss occurred, with the line that caused it.

4. **Classify each boundary relation**: `1:1`, `1:N` (bounded or unbounded), `N:1`, or *decoupled*. An unbounded LLM-decided `1:N` is where counts explode; a positional zip across a `1:N` boundary is a guaranteed mis-attribution bug.

5. **Check identity survival.** Does a traceable id (source step, case id, request id) survive each hop? Where it dies, say which line destroys it and what the downstream cost is.

6. **Distinguish deliberate short-circuits from failures.** A stage reporting "skipped" may be (a) a deliberate no-op, (b) a genuine failure mislabelled. Find the condition that produced the label and check whether the code can even tell those apart.

7. **Verify the negative.** When something expected is absent from the output, prove *where* it was lost — was it never captured, captured then filtered, or captured then truncated by a cap? Cite the filter/cap.

8. **Rank defects** at the end: severity, one-line description, `file:line`. No remediation unless asked.

## Traps this skill exists to prevent

- Describing intended behavior instead of observed behavior.
- Accepting a count without deriving it.
- Reporting "X is skipped" without finding the condition that set it.
- Assuming a downstream stage consumes an upstream artifact — **check that it actually reads it** (a stage can be passed data it never uses).
- Treating stale code comments as behavior. Read the code, not the comment above it.
- Trusting a self-reported status field over the execution record.

## Empirical confirmation

If a live re-run is possible, run it and compare. If the system under test is unreachable, **say so plainly**, state what a re-run would prove, and mark the empirical section blocked — do not simulate it.

See `references/boundary-checklist.md` for the per-boundary question set.
