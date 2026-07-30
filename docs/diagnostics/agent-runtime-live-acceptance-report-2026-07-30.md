# Agent Runtime Live Acceptance Report — 2026-07-30

## Scope

Ten prompts were submitted as ten independent requests with unique conversation IDs:
`acceptance-20260730-1` through `acceptance-20260730-10`.

- Prompt 1 started first.
- Prompts 2–10 were then started in parallel as requested.
- Each request selected the appropriate saved Website Credential:
  Keystone for prompts 1–5 and Core Platform Admin for prompts 6–10.
- The harness used `/api/controller/supervise/stream` with a 20-minute limit.

## Result Summary

| Prompt | Conversation ID | Result | Evidence |
|---|---|---|---|
| 1 | `acceptance-20260730-1` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 2 | `acceptance-20260730-2` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 3 | `acceptance-20260730-3` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 4 | `acceptance-20260730-4` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 5 | `acceptance-20260730-5` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 6 | `acceptance-20260730-6` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 7 | `acceptance-20260730-7` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 8 | `acceptance-20260730-8` | Authoring passed; execution not proven | Created and verified 12 cases, `CORE-PLATFORM-ADMIN-TC-000001` through `CORE-PLATFORM-ADMIN-TC-000012`. No `create_run` or execution tool was called. |
| 9 | `acceptance-20260730-9` | Failed — timeout | No persisted turns and no agent-turn audit after 20 minutes. |
| 10 | `acceptance-20260730-10` | Failed — false acceptance | Runtime returned raw `search_codebase` tool-call JSON as the final answer while the audit incorrectly recorded `accepted: true`. No test was created or run. |

Overall:

- Fully proven end-to-end passes: **0/10**
- Verified test-case authoring only: **1/10**
- Invalid false acceptance: **1/10**
- Timed out with no persisted result: **8/10**, including the separately started prompt 1

## Per-Prompt Findings

### 1. Keystone — Account create and run

The request did not complete in 20 minutes. No assistant turn or audit entry was
persisted, so there is no evidence that the Account was created, the test was
generated, or a run completed.

### 2. Keystone — Opportunity create cases

The request did not complete in 20 minutes. No cases or execution result can be
attributed to this conversation.

### 3. Keystone — Case priority update

The request did not complete in 20 minutes. The prior grounding problem could not
be re-evaluated because the new run produced no persisted result.

### 4. Keystone — Account Number negative validation

The request did not complete in 20 minutes. No validation or non-creation evidence
was produced.

### 5. Keystone — Account search and Industry filter

The request did not complete in 20 minutes. No list-view filtering evidence was
produced.

### 6. Admin — Role create and edit

The request did not complete in 20 minutes. No Role modal, list, or edit evidence
was produced.

### 7. Admin — Group create

The request did not complete in 20 minutes. No Group creation or list evidence was
produced.

### 8. Admin — Account Sharing Rule

The runtime successfully called:

1. `search_codebase` twice
2. `read_code_file` twice
3. `create_cases`

`create_cases` completed in 681,944 ms and mutation verification recorded
`verification: "verified"`. Twelve test cases were created. The final response
claimed coverage for owner- and criteria-based rules, Read/Write access,
principal/source selection, required validation, dependent-field clearing, save,
panel visibility, and reopen persistence.

This is an authoring pass only. No `create_run`, Playwright execution, or runtime
verdict was observed, so the Sharing Rule behavior itself is not proven.

### 9. Admin — Account Picklist custom field

The request did not complete in 20 minutes. No custom-field case or execution
evidence was produced.

### 10. Admin — Tab create

The runtime called `search_codebase` and `read_code_file`, then persisted this raw
tool request as its assistant answer:

```json
{"action":"search_codebase","name":"search_codebase","arguments":{"terms":["AdminCreateTabModal","onCreateTab","createTabForm","New Tab","Tabs"],"limit":20}}
```

The audit incorrectly recorded `stopReason: "final_text"` and `accepted: true`.
This is a false-positive completion: no test artifact or run was created.

## API and Tool Verification

Before the prompt batch:

- API suites passed: 34/34.
- Policy, verification, RBAC, evidence, capability-routing, and focused runtime
  suites passed.
- Microsoft Playwright MCP discovery returned 32 tools.
- Live Website Credential login and OpenAPI discovery succeeded after normalizing
  the saved UI URL to its origin and discovering `/auth/login`.
- Live read-only platform tools succeeded for object search, fields, access,
  sample records, record counts, operation search, and a safe GET call.
- Destructive operations remained unavailable.

These checks prove the adapters work individually. They do not prove the
orchestrator remains healthy under ten concurrent long-running requests.

## Scalability Finding

The runtime is **not production-scalable for ten parallel agent requests in its
current form**.

Observed under load:

- Ordinary authenticated status reads timed out while the parallel runs were active.
- Eight requests reached the 20-minute limit without a terminal event.
- Aborted clients did not cancel backend work.
- 24 orphan provider subprocesses remained after the clients timed out.
- Killing those subprocesses caused remaining abandoned work to spawn more children.
- A clean backend process-tree restart was required.

The 64-iteration tool cap does not provide a wall-clock or concurrency bound.

## Required Fixes Before Retest

1. Add a bounded supervisor queue or semaphore with a configurable concurrency limit.
2. Propagate client disconnect and deadline cancellation through the supervisor,
   provider CLI, Playwright, and child processes.
3. Apply a server-side per-turn wall-clock deadline independent of tool iterations.
4. Reject raw tool-call JSON as final text; continue the loop or fail explicitly.
5. Require execution evidence before accepting prompts that explicitly say “run”.
6. Persist terminal timeout/cancelled audit records and partial tool progress.
7. Retest first sequentially for functional correctness, then at controlled
   concurrency levels (2, 4, 8, and 10).

## Final State

The abandoned process tree was terminated. The backend was restarted successfully
and is listening on port 3001 with PID 19984. No orphan provider subprocesses
remained after restart.
