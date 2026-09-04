# Business-Logic & Race Conditions
> Abusing the intended workflow — skipping steps, replaying, or racing operations — to reach a state the app should forbid.

## When it applies
Multi-step flows (checkout, approval, onboarding), quotas/limits, discount/credit logic, state machines, and anything where two requests can interleave.

## How to test
- Map the intended sequence, then break it: skip a step, repeat a one-time action, submit steps out of order, tamper with hidden state (price, quantity, status, role) between steps.
- Limits: apply a coupon twice, withdraw more than the balance, exceed a per-user quota.
- Race / TOCTOU: fire many concurrent identical requests (single-packet or parallel) against check-then-act operations — balance deductions, unique-constraint gaps, invite/redeem, "claim once".
- Authorization state: does a status change (`draft`→`approved`) skip the approver check when set directly?

## How to validate
Show a forbidden end state actually achieved — negative balance, double-redeemed credit, an approval without an approver, a quota exceeded. Reproduce it at least twice.

## Remediation
Server-side state machine and invariants; atomic/locked check-then-act (DB constraints, `SELECT … FOR UPDATE`, idempotency keys); never trust client-supplied state.
