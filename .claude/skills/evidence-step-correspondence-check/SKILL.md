---
name: evidence-step-correspondence-check
description: Use when a pipeline's evidence, screenshots, logs, or artifacts don't map cleanly back to the logical steps that produced them — "why are there 13 screenshots for a 3-step test", "the screenshot next to this step is wrong", or any unexplained artifact count. Traces the count chain and finds the multiplier.
---

# Evidence ↔ step correspondence check

An unexplained artifact count is never mysterious — it is a `1:N` boundary somewhere in the chain. Find it.

## Step 1 — build the count chain

Write it out explicitly with real numbers from one real run:

```
source unit   (case steps)        3
   │ 1:N  ← who decides N? code or LLM? cite the rule
intermediate  (plan steps)       13
   │ 1:1  (+ compiler-injected extras)
runner calls                     14
   │ 1:1  on success AND on throw
executed                         12   (aborted at 12)
   │ + harness end-of-test capture
evidence artifacts               13
```

State which single arrow is not `1:1`. **That arrow is the entire answer.** Everything downstream is a symptom.

## Step 2 — classify each boundary

| relation | implication |
|---|---|
| `1:1` | safe to zip by index |
| `1:N` bounded | needs an explicit id to attribute |
| `1:N` unbounded (LLM-decided) | index-zipping is guaranteed wrong |
| decoupled | artifact count has no relation to source count at all |

Capture is usually per **low-level runner action**, not per human-legible step. Say that plainly — it explains why "one prose step" can become nine frames.

## Step 3 — check the UI attribution

- [ ] Does the product map artifacts to steps by **explicit id** or by **positional index**?
- [ ] If positional across a non-`1:1` boundary: every item after the first is mis-attributed **and** the overflow is unreachable. Quantify both — "3 shown against the wrong frame, 10 orphaned" is the finding; "mapping is off" is not.
- [ ] Is the expansion visible anywhere in the UI, or does it surface only as an unexplained count?

## Step 4 — check for an identity field

- [ ] Does the intermediate schema have a `sourceStep`-style field? If not, identity was destroyed at the first handoff and cannot be reconstructed downstream.
- [ ] Adding it is a **real fix, not a workaround** — and it usually resolves the mis-attribution as a side effect. Trace the full threading path before proposing it: schema → prompt requirement → compiler emit → runner log → artifact record → UI grouping. Name every file in that chain.

## Step 5 — rule out the false explanations

Before blaming the multiplier, disprove these:
- [ ] **Retries** — does a retry produce extra artifacts, or does the parser read only the last result?
- [ ] **Polling** — does an assertion's internal polling emit one artifact or many?
- [ ] **Before/after pairs** — check the code, not the comment. Stale comments claiming before/after capture are common; count the actual capture calls per action.
- [ ] **Harness extras** — end-of-test or fixture-level captures that are not runner frames at all. These often explain exactly the "+1" that makes the arithmetic look wrong.

## Step 6 — semantic duplication

Even with correct counts, ask: how many artifacts show the **same page state**? N consecutive read-only assertions against a static screen produce N near-identical images. That is duplication in substance, and worth reporting even when the mechanism is correct.
