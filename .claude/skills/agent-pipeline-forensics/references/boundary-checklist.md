# Per-boundary checklist

Apply to every handoff in the pipeline. Record the answer or `DEFECT: unanswerable`.

## For each boundary A → B

1. **Artifact identity** — what exactly is passed? Name the artifact key, its size, and its item count.
2. **Relation** — `1:1`, `1:N`, `N:1`, or decoupled? If `1:N`, is N bounded? By what? Cite the line.
3. **Who decides N** — deterministic code, or an LLM following a prompt rule? Cite the prompt line if the latter.
4. **Filters** — what is admitted vs dropped between A and B? Cite the predicate. Count the drops.
5. **Caps** — is there a max that silently truncates? Cite it, and state whether the truncation is disclosed anywhere.
6. **Identity survival** — does a per-item id survive? If not, which line destroys it?
7. **Does B actually read it** — grep B for the field. A stage can receive data it never consumes (check the options object it builds).
8. **Failure semantics** — if A fails, does B see an error, an empty value, or a silently-defaulted value? Empty-string defaults are silent degradation.

## Count reconciliation template

```
<source unit>       N₀   (artifact, file:line)
  → <transform>            (rule/line that sets the ratio)
<intermediate>      N₁
  → <transform>
<runner/exec unit>  N₂
  → <capture rule>
<evidence unit>     N₃
```
State which single arrow is not `1:1`. That arrow is the answer.

## UI attribution check

If the product renders per-source-unit evidence:
- Is the mapping by explicit id, or **positional index**?
- Positional zip across a non-`1:1` boundary ⇒ every item after the first is mis-attributed, and the overflow is unreachable. Quantify both: how many shown wrong, how many orphaned.

## "Skipped" disambiguation

For any stage reporting skipped/no-op:
- What single expression produces the label?
- How many distinct code paths can produce that same state?
- Can the label distinguish a deliberate short-circuit from a genuine failure? If not, that is a defect — check whether a sibling stage already does it correctly and cite the asymmetry.

## Post-action truth

For pipelines that verify then act:
- Was the property (uniqueness, visibility, enablement) verified **before** the action that could invalidate it?
- Is it re-verified after state changes? If not, any assertion following a state change is unsound.
