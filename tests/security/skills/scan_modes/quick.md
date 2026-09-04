# Scan mode: quick
> Fast, shallow pass — highest-signal checks only. For CI gates and smoke tests.

- Time-box hard. Recon is a single quick surface map, not exhaustive enumeration.
- Test only the highest-impact classes on the most obvious inputs: access control, injection on primary search/id params, auth on the login/session flow.
- Skip deep fuzzing, exhaustive parameter mining, and multi-step business-logic chains.
- One proof-of-concept per finding is enough; do not iterate for extra severity.
- Prefer breadth of coverage over depth: touch each surface once, report the clear wins.
