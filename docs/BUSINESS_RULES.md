# Business Rules Registry

Definitions in this file are human-authored sources of truth. Add a section for
each governed concept after its owner and approval reference are known.

## Example entry template (not a governed concept)

- Id: `<bounded-context>.<concept>`
- Bounded context: `<context>`
- Version: `1.0.0`
- Owner: `<human or role>`
- Approval ref: `<decision, issue, or pull request>`
- Definition: `<one unambiguous authoritative paragraph>`
- Risk tier: `blocking | reversible | incidental`
- Contract tests: `<path and conformance profile>`
- Canonical implementation: `<path>`
- Consumers: `<discovery method, confidence, and blind spots>`
- Decisions/notes: `<assumptions, migration expiries, and waiver references>`
- Last audit sync: `<date>`
