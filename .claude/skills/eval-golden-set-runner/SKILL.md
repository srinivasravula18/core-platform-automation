---
name: eval-golden-set-runner
description: Use before and after changing any prompt, agent logic, grounding rule, compiler rule, or pipeline stage — to verify the change did not regress output quality. Runs the golden-set fixtures, compares against expected outputs, and reports per-metric deltas. Also use when asked "did this make it better", "is this measured", or to bootstrap the eval suite if fixtures do not exist yet.
---

# Golden-set eval runner

Turns "it looks better" into a number. **No prompt or pipeline change ships without a before/after delta.**

## First: does the suite exist?

Check `package.json` scripts and confirm each referenced file actually resolves — several eval entry points in this repo have historically pointed at **missing files**, so a passing-looking script list is not evidence a suite exists.

- **Fixtures present** → run baseline, apply change, re-run, report deltas.
- **Fixtures missing** → say so plainly, then bootstrap (below). Never report a quality claim from a suite that did not run.

## Running a comparison

1. **Capture baseline first, before touching anything.** A delta needs both sides; recording the "after" only is worthless.
2. Run the suite on a **fixed** input set — same fixtures, same seed/ordering.
3. Report **per-metric**, not one aggregate. An aggregate hides a regression in one dimension behind a gain in another.
4. Run twice on unchanged code to establish noise. A "gain" inside noise is not a gain.
5. State sample size next to every number. `+8%` on 12 fixtures is not a finding.

## Metrics to report

| Metric | What it catches |
|---|---|
| Routing accuracy | intent misclassification (question treated as an action) |
| Grounding coverage | % of authored claims traceable to captured evidence |
| Reachability | did discovery reach the goal object, or ground on the wrong screen |
| Cases → scripts conversion | silent attrition between authoring and compiled output |
| Assertion correctness | transform / preserve / normalize contradictions; impossible asserts |
| False-PASS rate | tests that pass without proving the behavior (tautological asserts) |
| False-BUG rate | defects reported for test-logic failures, not product failures |
| Schema-conformance | outputs rejected by validation, per provider |

## The regression gate

- Any metric dropping beyond noise → **fail the change**, report which fixtures flipped.
- Report flipped fixtures **by name with the diff**, never as a count. "3 regressions" is not actionable; naming them is.
- A fixture that flips from fail→pass still gets inspected: confirm it passes for the right reason, not because an assertion got weaker.

## Bootstrapping (when fixtures do not exist)

Build the smallest suite that can detect the failures you already know about:

1. **Mine real runs for fixtures.** Persisted runs with known-wrong output are the highest-value seeds — they are already-proven failure modes.
2. **One fixture per known defect class**, not per bug. Cover at minimum: intent routing, evidence reachability, assertion correctness, and false-PASS.
3. **Expected outputs are properties, not golden strings**, wherever the correct answer has legitimate variation — assert "the API-name field is lowercase with spaces replaced" rather than one exact string, or the suite fails on correct output.
4. **Freeze the inputs.** Fixtures must not depend on live app state, current dates, or network availability; stub what the pipeline would fetch.
5. **Add an adversarial subset**: injection strings embedded in repo files / artifact text / DOM, scope-violation requests, contradiction traps, loop bait.
6. Record the baseline into the repo so the trend line starts immediately.

## Honesty rules

- Never estimate a score. If the suite did not run, there is no number.
- A metric that cannot be computed from the fixtures is reported as **not measured**, not as passing.
- If the system under test is unreachable and the suite needs it, say the run is blocked — do not simulate results.
- Report the window: how many fixtures, over which stages, on which model/provider. A score without those is not comparable to the next one.

See `references/fixture-format.md` for the fixture and report shapes.
