# Mutation verification patterns

A write tool's success claim is only trustworthy if the system was **re-read** afterwards. Pattern per mutation type:

## Repository create/update
Re-fetch the entity by the id the tool claims to have created/updated. Assert it exists **and** that the fields the tool claimed to set actually hold those values. Existence alone is not verification.

## API-backed record creation
Re-query through the same read path a user would use (list/filter), not the create response echo. A create endpoint echoing your payload proves nothing about persistence.

## Generic API mutation
Pair the mutation with a GET of the same resource. If no GET exists, the mutation is **unverifiable** — say so explicitly rather than defaulting to success.

## Deletion
Re-read and assert absence. Assert also that *only* the intended target is gone (a scope bug deletes more than asked).

## Verification verdict semantics

Return a typed verdict, not a boolean:

| verdict | meaning | consequence |
|---|---|---|
| `verified` | re-read confirms the claimed state | proceed |
| `failed` | re-read contradicts the claim | **force rejection** — do not report success |
| `unsupported` | no read path exists for this mutation | report honestly as unverified; never launder into success |

## Anti-patterns

- **Verification as advice.** Computing a verdict and passing it to the model to interpret. The model is the party whose claim is under test — it cannot be the judge of it.
- **Schema-valid = true.** Validating that the response parses is not verifying that the world changed.
- **Verifying the wrong thing.** Re-reading a cache the write also populated.
- **Effect-gated verification.** If verification only runs for tools whose effect is `write`, and effect is name-inferred, mis-named mutating tools are never verified. Declared effects fix both problems at once.
- **All-or-nothing.** A verification failure on one item silently discarding a batch of otherwise-good results; prefer per-item verdicts with severity.

## Self-reported status fields

Any field an agent sets that unblocks downstream work (`accepted`, `verified`, `complete`, `intentSatisfied`) must be traceable to an execution record. For each one, ask:
- What would this field say if the work had *not* happened?
- If the answer is "the same thing", the field is decorative and must not gate anything.
