# Fixture and report shapes

## Fixture

Keep fixtures declarative and independent of live state.

```jsonc
{
  "id": "routing-question-not-action-01",
  "stage": "routing",            // routing | grounding | authoring | compile | execute | investigate
  "input": {
    "message": "what about pagination?",
    "history": ["...prior turn establishing the ListView subject..."]
  },
  "expect": {
    "kind": "assert",            // "assert" = property checks, "golden" = exact match
    "checks": [
      { "path": "kind", "equals": "answer" },
      { "path": "isImperative", "equals": false }
    ]
  },
  "origin": "run 23d5f929 — misrouted as generate_cases",
  "defectClass": "intent-misroute"
}
```

**Rules**
- `origin` cites the real run or bug the fixture was mined from — it justifies the fixture's existence and survives author turnover.
- `defectClass` groups fixtures so a report can say "assertion-correctness regressed", not just "fixture 14 failed".
- Prefer `assert` over `golden`. Golden strings are correct only for genuinely deterministic output (routing enums, compiled selectors); prose and authored cases need property checks.

## Property checks over exact strings

For anything with legitimate variation, assert the property the behavior requires:

| Bad (brittle) | Good (property) |
|---|---|
| expected title equals `"Actions menu shows core options"` | title is non-empty, ≤ 80 chars, contains no file path or camelCase identifier |
| expected api name equals `"my_app"` | value is lowercase, spaces replaced with `_`, non-empty |
| expected 13 plan steps | every case step maps to ≥1 plan step; no plan step lacks a `sourceStep` |

A suite full of golden strings fails on correct output and trains you to ignore it.

## Report shape

```
SUITE  <n> fixtures · stages: routing(8) grounding(10) authoring(14) compile(9) execute(7)
MODEL  <provider>/<model>   RUN  baseline | after:<change>

metric                     baseline    after     delta
routing accuracy             0.88       0.94      +0.06
grounding coverage           0.61       0.79      +0.18
reachability                 0.40       0.85      +0.45
cases → scripts              0.50       0.86      +0.36
assertion correctness        0.21       0.71      +0.50
false-PASS rate              0.18       0.04      -0.14   (lower is better)
false-BUG rate              0.33       0.07      -0.26   (lower is better)

REGRESSED (2)
  authoring/transform-normalize-03  pass → fail   expected lowercase output, got raw input
  compile/partial-severity-01       pass → fail   whole batch dropped on one unresolved target

NOISE   two unchanged runs differed by ≤0.02 on all metrics
```

**Always include:** fixture count per stage, the model/provider, the noise floor, and every regressed fixture by name with its diff.

## Trend

Append each run to a history file so quality is a line, not an anecdote. Record: date, commit/build, model, per-metric scores, fixture count. Without the fixture count and model, later comparisons are meaningless.
