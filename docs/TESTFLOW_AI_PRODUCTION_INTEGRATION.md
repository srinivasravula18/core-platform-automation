# TestFlow AI production integration with Gylin

## 1. Executive summary

TestFlow AI needs one machine-to-machine endpoint:

```text
POST /api/gylin/runs
```

Gylin calls this endpoint after its normal post-deployment test passes. TestFlow must authenticate Gylin with a Bearer token, validate and deduplicate the request, run its existing LangGraph/Playwright pipeline against the exact deployed candidate, wait for a terminal result, and return evidence. TestFlow must not call Azure DevOps directly and must not create a second testing engine.

The existing `/api/agent/start` endpoint cannot be used as-is: it requires a human TestFlow session and returns immediately while the run continues in the background. The new adapter must reuse the same graph runtime and evidence pipeline through an application service, not by making an HTTP request back into TestFlow.

## 2. Existing architecture

### Gylin/AgentLane (already implemented)

- Trigger: project setting `intensiveTesting: true`, or an Azure comment containing `@gylin ... deep testing` / `intensive testing`.
- Invocation point: after the normal post-deployment Playwright gate.
- Client: `runTestFlow()` in `D:\agentlane\server\integrations.mjs`.
- Timeout: 300 seconds.
- Authentication: `Authorization: Bearer <token>`.
- Fail-closed behavior: the delivery does not advance when TestFlow is disconnected, unauthenticated, unavailable, returns a non-passing result, or passes without evidence.
- Evidence: a successful TestFlow response is stored as `TEST_FLOW_RUN` evidence against the exact Gylin candidate commit.

### TestFlow AI (current state)

- Express application entry: `apps/api/src/server.ts`.
- Human auth and RBAC run globally before registered API routes.
- Human run route: `server/features/agent/routes.ts` → `POST /api/agent/start`.
- Durable execution: `server/features/agent/workflow/runtime.ts` → `startGraphRun()`.
- Run persistence: PostgreSQL `agent_runs` plus graph checkpoints and artifacts.
- Evidence generation: the existing execution/evidence code produces screenshots, traces, reports, and `evidence_screenshots`.
- Existing idempotency storage: `agent_operation_receipts` and `server/ai/agent-runtime/operationReceipts.ts`.

## 3. Dependency graph

```text
Azure DevOps comment
  -> Gylin Azure webhook
  -> Gylin governed delivery workflow
  -> deployed candidate URL + exact candidate SHA
  -> POST TestFlow /api/gylin/runs
  -> Gylin service-token authentication
  -> configured TestFlow Project/App target resolution
  -> existing TestFlow LangGraph run
  -> existing Playwright execution
  -> existing screenshot/trace/report evidence
  -> terminal TestFlow response
  -> Gylin TEST_FLOW_RUN evidence and next delivery gate
```

Azure DevOps never calls TestFlow. TestFlow never updates Azure DevOps. Gylin is the only coordinator.

## 4. Runtime flow

1. Gylin completes coding, verification, deployment, health, and post-deployment testing.
2. Gylin decides whether intensive testing is required.
3. Gylin sends the contract in section 9 to TestFlow.
4. TestFlow authenticates the Bearer token before parsing or executing the request.
5. TestFlow validates the body and normalizes `applicationUrl`.
6. TestFlow resolves that URL to exactly one configured TestFlow App and its Project. Unknown or ambiguous targets are rejected; TestFlow must not test an arbitrary caller-supplied URL.
7. TestFlow hashes the full validated request and acquires an idempotency receipt using the caller-supplied key.
8. If the receipt is completed, TestFlow returns the stored response. If it is running, TestFlow attaches to the recorded run. If the same key has a different request hash, TestFlow returns `409`.
9. For a new receipt, TestFlow creates one normal `agent_runs` record and starts the existing graph with:
   - `reviewPolicy: "auto"`
   - `executionPolicy: "auto"`
   - the resolved App/Project/credentials
   - a goal built only from the story ID, candidate SHA, and acceptance criteria
   - the Gylin request metadata stored in the run's safe `raw` metadata
10. The adapter waits for a terminal run for at most 285 seconds. This leaves time for Gylin to receive a response before its 300-second client timeout.
11. On completion, TestFlow verifies that Playwright actually executed and that screenshot/report evidence exists.
12. TestFlow stores the terminal response in the idempotency receipt and returns it to Gylin.
13. If the run is still active at 285 seconds, TestFlow leaves it running and returns `503` with `Retry-After`. A later Gylin retry with the same key attaches to that run; it must never start a duplicate.

## 5. Evidence flow

TestFlow must return evidence produced by the existing execution pipeline, not a fabricated success message.

Minimum passing evidence:

- at least one Playwright execution result;
- at least one screenshot, trace, HTML report, or TestFlow report reference;
- a stable TestFlow `runId`;
- the tested `applicationUrl`;
- the Gylin `candidateCommit` copied into immutable run metadata.

Evidence URLs must use `TESTFLOW_PUBLIC_URL`, never `localhost`. Prefer an authenticated TestFlow report deep-link or a short-lived signed object-storage URL in production. Secrets, cookies, authorization headers, passwords, and session state must be redacted before persistence or response.

## 6. Context flow

The adapter must resolve the target from TestFlow's configured Projects and Apps:

- Compare the normalized request URL with configured App `baseUrl` values or an explicit, narrowly scoped environment mapping.
- Resolve the owning TestFlow Project and App IDs.
- Resolve credentials through the existing credential service using that App/owner context.
- Resolve repository grounding from the configured Project/App; never accept a repository path from the Gylin request.
- Reject an unmapped URL with `422 TARGET_NOT_CONFIGURED`.
- Reject multiple matching Apps with `409 TARGET_AMBIGUOUS`.

Production deployments should use stable environment hostnames such as `https://expense-staging.company.example`, not random localhost ports.

## 7. Prompt flow

Construct one bounded goal inside TestFlow:

```text
Validate deployed story <storyId> at candidate <candidateCommit> against these acceptance criteria:
1. <criterion>
2. <criterion>

Run the complete browser flow, report every failed criterion, and capture screenshot evidence.
```

Do not place tokens, Azure metadata, repository credentials, raw webhook payloads, or unrelated Gylin history in the prompt. Acceptance criteria remain authoritative; TestFlow can add exploratory checks but cannot turn an exploratory result into acceptance evidence unless it maps back to a criterion.

## 8. Current problems to solve

1. `/api/agent/start` accepts a human session, not a service identity.
2. It starts a background job and returns `task_id`; Gylin expects a terminal result.
3. A direct service token would currently fail the global human `apiAuthGate`.
4. The current run-start logic lives inside a large Express route and is not directly reusable by a machine adapter.
5. Gylin's URL is a trust-boundary input and could become an SSRF vector without App mapping.
6. Gylin retries must not start duplicate expensive runs.
7. A TestFlow “completed” status is insufficient unless execution evidence is present.
8. Local `/evidence/...` references are not production-reachable from Gylin.

## 9. Required API contract

### Request

```http
POST /api/gylin/runs HTTP/1.1
Authorization: Bearer <GYLIN_INTEGRATION_TOKEN>
Content-Type: application/json
Accept: application/json
```

```json
{
  "storyId": "US-12365-R2",
  "candidateCommit": "f8cceebdc2a0b2443851bce645702ac6fd038357",
  "applicationUrl": "https://expense-staging.company.example",
  "acceptanceCriteria": [
    { "id": "AC-001", "description": "Approvers can resolve offline sync conflicts without losing either change." }
  ],
  "idempotencyKey": "US-12365-R2:f8cceebdc2a0b2443851bce645702ac6fd038357:intensive-test"
}
```

Validation limits:

- `storyId`: required string, 1–128 characters.
- `candidateCommit`: required 40- or 64-character hexadecimal digest.
- `applicationUrl`: required HTTPS URL in production; credentials and fragments forbidden.
- `acceptanceCriteria`: required array, 1–100 items; IDs 1–128 characters; descriptions 1–4,000 characters; total request body kept below the existing Express JSON limit.
- `idempotencyKey`: required string, 1–256 characters.
- Unknown fields: strip or reject consistently; never persist arbitrary nested data.

### Passing response

Return HTTP `200` only after a terminal, evidence-backed pass:

```json
{
  "status": "passed",
  "runId": "tf-01J...",
  "summary": "12 checks passed across 3 acceptance criteria.",
  "url": "https://testflow.company.example/reports?runId=tf-01J...",
  "evidence": [
    {
      "type": "screenshot",
      "title": "Offline conflict resolution",
      "url": "https://testflow.company.example/evidence/tf-01J-case1-final.png"
    }
  ],
  "candidateCommit": "f8cceebdc2a0b2443851bce645702ac6fd038357"
}
```

Gylin currently requires `status` to equal `passed` and requires either `url` or an `evidence` array.

### Test failure response

A valid test run that found a regression is not an infrastructure error. Return HTTP `200`:

```json
{
  "status": "failed",
  "runId": "tf-01J...",
  "summary": "AC-001 failed: the server version was overwritten.",
  "error": "Acceptance criteria failed",
  "retryable": false,
  "url": "https://testflow.company.example/reports?runId=tf-01J...",
  "evidence": [{ "type": "screenshot", "url": "https://testflow.company.example/evidence/failure.png" }]
}
```

### Infrastructure responses

| HTTP | Meaning | Retry behavior |
|---|---|---|
| `400` | Invalid contract | Do not retry until fixed |
| `401` | Missing/invalid service token | Do not retry until configuration is fixed |
| `409` | Idempotency key reused with different body, or ambiguous App mapping | Do not retry unchanged |
| `422` | Candidate target is not configured or criteria cannot be executed | Requires configuration/human action |
| `429` | TestFlow capacity limit | Retry with backoff and `Retry-After` |
| `503` | Existing run is still active, or temporary dependency failure | Retry the same idempotency key |
| `500` | Unexpected internal failure | Retry the same idempotency key after investigation |

Never return `status: "passed"` for a queued, running, cancelled, review-required, evidence-free, or partially executed run.

## 10. Proposed TestFlow architecture

Add a narrow integration feature, not another agent stack:

```text
server/features/gylin/
  contract.ts       Zod request/response schemas and bounded prompt builder
  auth.ts           Constant-time Bearer-token check for this route only
  service.ts        App mapping, receipt handling, graph start/attach, terminal projection
  routes.ts         POST /api/gylin/runs HTTP adapter
  routes.test.ts    Contract/auth/idempotency/pass/failure checks
```

Reuse:

- `startGraphRun()` and `getGraphRunState()` from the existing workflow runtime;
- `AgentRuns` for durable run state;
- `resolveCredentials()` for target credentials;
- `listApps()`, `getProject()`, and existing Project/App configuration;
- `agent_operation_receipts` for idempotency;
- existing execution evidence and redaction utilities.

Do not add a queue, webhook callback, new database, second Playwright runner, or new authentication library for this first production-compatible version.

## 11. Complete implementation strategy

### A. Extract a reusable run-start application service

Create a small service in the existing agent feature that accepts already-resolved, trusted inputs and performs the shared operations currently embedded in `/api/agent/start`:

- create the legacy run seed;
- persist initial visibility;
- call `startGraphRun()`;
- return the run ID.

The human route keeps all of its existing target/prompt/review logic and calls this service after resolution. The Gylin adapter resolves its own narrow inputs and calls the same service. Do not duplicate the large human route and do not make a loopback HTTP call.

The service input must include Project/App/owner scope, target URL, prompt, mission, resolved credential, requested case count, `reviewPolicy`, `executionPolicy`, and safe metadata. It must never accept plaintext credential values from the API body.

### B. Add route-local machine authentication

Register only `/api/gylin/runs` before `authContextMiddleware` / `apiAuthGate`, and make its own Bearer-token middleware mandatory. This avoids granting the Gylin token access to any human `/api/**` route.

Requirements:

- Read `GYLIN_INTEGRATION_TOKEN` from the environment/secret manager.
- Fail application startup in production if the route is enabled but the token is absent or too short.
- Compare token bytes with `crypto.timingSafeEqual` after checking equal byte lengths.
- Never log the header or token.
- Return the same `401` body for missing and incorrect tokens.
- Audit accepted and rejected requests without sensitive data.

### C. Validate and bind the target

- Parse with Zod (already installed).
- Require HTTPS when `NODE_ENV=production` or `DEPLOYMENT_MODE=production`.
- Normalize URL origin and pathname; reject usernames, passwords, and fragments.
- Resolve exactly one configured TestFlow App. The selected App supplies Project, owner, credentials, metadata, and repository scope.
- Never allow the request to override Project ID, App ID, repository path, credentials, model, provider, or filesystem paths.

### D. Make external idempotency durable

Reuse `agent_operation_receipts`; add the minimum repository functions needed to begin/read/complete/fail a receipt from an explicit external key. Namespace the stored key by hashing `gylin:<idempotencyKey>` and store a SHA-256 request hash.

Rules:

- Same key + same request + completed: return the recorded response.
- Same key + same request + running: attach/wait on the recorded `resourceId` run.
- Same key + different request hash: `409`.
- Failed receipt caused by a transient infrastructure error: attach to the recorded run if it exists; otherwise allow a controlled restart with the same logical key and incremented attempt metadata.
- Receipt retention must be at least as long as Gylin evidence retention for active delivery retries; do not use the current 24-hour default blindly for this integration.

### E. Start the existing graph in non-interactive mode

- `reviewPolicy: "auto"` so the integration can never stop at a human review interrupt.
- `executionPolicy: "auto"` so generated tests execute.
- Use the existing graph and Playwright evidence path.
- Record safe immutable metadata: `source: "gylin"`, `storyId`, `candidateCommit`, `idempotencyKeyHash`, Project ID, App ID, and received timestamp.
- Do not store the raw Bearer token.

### F. Wait and project the terminal result

Poll durable `AgentRuns.get(runId)` (or add an internal completion subscription if one already exists by implementation time) with an abort-aware delay. Stop at 285 seconds.

Terminal mapping:

- `completed` + zero failed tests + evidence → `passed`.
- `completed` + failed tests → `failed`, `retryable: false`.
- `failed` → `failed`; `retryable` is true only for classified infrastructure failures.
- `cancelled`, `review_required`, or `coverage_options` → never pass.
- still running at deadline → HTTP `503`, preserve receipt/run for reattachment.

Validate the execution projection rather than trusting the top-level status alone. Include bounded summaries; never return full traces or raw logs inline.

### G. Publish production-safe evidence references

- Build absolute links from `TESTFLOW_PUBLIC_URL`.
- Link the report page by `runId`.
- Convert existing screenshot/report refs into absolute URLs.
- If evidence is private, return signed URLs or an authenticated report link. Do not make the whole evidence directory public merely for Gylin.
- Ensure evidence remains available for the configured retention period.

## 12. Every TestFlow file that must change

| File | Change | Why | Risk |
|---|---|---|---|
| `apps/api/src/server.ts` | Register the exact Gylin route before human auth middleware | Permit M2M auth without opening other APIs | High |
| `server/features/gylin/contract.ts` (new) | Request/response schemas, URL normalization, prompt builder | Trust-boundary validation | Medium |
| `server/features/gylin/auth.ts` (new) | Route-local constant-time Bearer validation | Service authentication | High |
| `server/features/gylin/service.ts` (new) | Resolve App/Project, acquire receipt, start/attach run, wait, map result/evidence | Integration orchestration | High |
| `server/features/gylin/routes.ts` (new) | Thin Express adapter and safe HTTP errors | Keep transport out of domain logic | Medium |
| `server/features/gylin/routes.test.ts` (new) | Contract, auth, target, idempotency, terminal mapping tests | Prevent security and duplicate-run regressions | High |
| `server/features/agent/startService.ts` (new) | Reusable resolved-run start operation | Avoid duplicating `/api/agent/start` | High |
| `server/features/agent/routes.ts` | Make the human route call the shared start service without behavior changes | One run-start implementation | High |
| `server/ai/agent-runtime/operationReceipts.ts` | Support explicit namespaced external keys, request-hash conflict, longer retention, and resource ID attachment | Durable Gylin retries | High |
| `server/ai/agent-runtime/operationReceipts.test.ts` | Verify external receipt concurrency/conflict/reattachment | Exactly-once expensive execution | High |
| `.env.example` | Document `GYLIN_INTEGRATION_ENABLED`, `GYLIN_INTEGRATION_TOKEN`, `TESTFLOW_PUBLIC_URL`, wait/retention settings | Repeatable deployment | Low |
| `README.md` | Document the production endpoint and network/secrets setup | Operator discoverability | Low |

`server/db/schema.sql` should not change if `agent_operation_receipts` can hold the required resource ID, response, verification, error, and retention. Add a schema change only if implementation proves a concrete missing field; if changed, keep it idempotent and verify `scripts/setup-db.bat` as required by the TestFlow repository rules.

## 13. Why each file changes

- The API entry decides middleware order; route-local M2M auth must run before the human-session gate.
- The Gylin feature owns only the external contract and adaptation.
- The agent start service prevents two implementations of run creation.
- Operation receipts are the existing concurrency-safe place for deduplication.
- Environment and README changes prevent production from depending on developer-machine assumptions.
- Tests focus on the trust boundary and exactly-once behavior, where failures are expensive or unsafe.

## 14. Risk level and required mitigations

### High: authentication bypass

Mitigation: expose only the exact route before global auth; all other API routes retain human auth/RBAC. Add a regression test proving the service token cannot call `/api/agent/start`, settings, projects, credentials, or evidence-administration APIs.

### High: SSRF/arbitrary target execution

Mitigation: the URL must resolve to a configured App; reject arbitrary hosts, URL credentials, fragments, redirects to unmapped origins, and DNS/address changes that violate deployment policy.

### High: duplicate expensive runs

Mitigation: acquire a durable receipt before creating `agent_runs`; test concurrent identical requests. Persist the run ID immediately.

### High: false pass

Mitigation: require terminal completion, zero failed tests, execution records, and evidence. Candidate SHA must match the immutable metadata stored at start.

### Medium: timeout mismatch

Mitigation: TestFlow waits at most 285 seconds and preserves the run for retry attachment. Gylin currently aborts at 300 seconds.

### Medium: evidence exposure

Mitigation: prefer report links/signed URLs; redact secrets and enforce retention. Do not broaden static-file access.

## 15. Backward compatibility

- Existing human login, RBAC, Agent Console, `/api/agent/start`, run status, retry, cancel, and evidence routes must behave exactly as before.
- Existing TestFlow database rows remain readable.
- Existing TestFlow Project/App configuration remains authoritative.
- The feature is disabled unless `GYLIN_INTEGRATION_ENABLED=true`.
- No service token is accepted on any existing endpoint.
- No Azure-specific dependency is added to TestFlow.

## 16. Migration strategy

1. Implement behind `GYLIN_INTEGRATION_ENABLED=false`.
2. Deploy TestFlow code with the feature disabled; run existing build and tests.
3. Create a 32-byte-or-stronger random service token in the production secrets manager.
4. Set the same value as:
   - TestFlow: `GYLIN_INTEGRATION_TOKEN`
   - Gylin: `TEST_FLOW_TOKEN`
5. Set TestFlow `TESTFLOW_PUBLIC_URL=https://testflow.company.example`.
6. Configure the deployed candidate hostname as a TestFlow App under the correct Project, including credentials and repository grounding.
7. Enable `GYLIN_INTEGRATION_ENABLED=true` and restart TestFlow.
8. From the Gylin server network, call the production endpoint with a non-production smoke story.
9. Confirm one TestFlow run, real browser evidence, and one Gylin `TEST_FLOW_RUN` record.
10. In Gylin Integrations, configure:
    - provider: `test-flow`
    - status: `connected`
    - endpoint: `https://testflow.company.example/api/gylin/runs`
    - token environment variable: `TEST_FLOW_TOKEN`
11. Enable `intensiveTesting` for one pilot project before broad rollout.

Generate a token without putting it in shell history where possible. Store it in the platform secret manager, inject it as an environment variable, and rotate it by coordinated TestFlow/Gylin deployment.

## 17. Testing strategy

### Unit/route tests

- missing token → `401`;
- wrong token → `401`;
- correct token → route proceeds;
- service token cannot access existing APIs;
- invalid SHA, URL, criterion, or idempotency key → `400`;
- HTTP URL rejected in production;
- unknown target → `422`;
- ambiguous target → `409`;
- same key/body concurrently starts exactly one run;
- same key/different body → `409`;
- retry attaches to the existing run;
- completed run without evidence never passes;
- completed run with failed Playwright tests returns `status: failed`;
- completed passing run with evidence returns the exact contract;
- 285-second deadline returns `503` without cancelling the run;
- secrets do not appear in response, receipt, audit, or logs.

### Regression checks required by TestFlow

```powershell
npm run lint
npm run build
```

Run the repository's existing relevant test command(s), then verify:

- existing Agent Console start/status/retry/cancel;
- DOM inspection and repository grounding;
- metadata/context/prompt assembly;
- Playwright generation and verified evidence;
- PostgreSQL startup and `scripts/setup-db.bat` if schema changed.

### Production smoke test

From a host on the same network path as Gylin:

```powershell
$headers = @{ Authorization = "Bearer $env:TEST_FLOW_TOKEN"; "Content-Type" = "application/json" }
$body = @{
  storyId = "SMOKE-1"
  candidateCommit = "0123456789abcdef0123456789abcdef01234567"
  applicationUrl = "https://expense-staging.company.example"
  acceptanceCriteria = @(@{ id = "AC-1"; description = "The application loads and exposes its primary workflow." })
  idempotencyKey = "SMOKE-1:0123456789abcdef0123456789abcdef01234567:intensive-test"
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "https://testflow.company.example/api/gylin/runs" -Headers $headers -Body $body
```

Repeat the exact request and verify it returns the same `runId` without creating another run.

## 18. Rollback strategy

1. Set `GYLIN_INTEGRATION_ENABLED=false` and restart TestFlow. The route should return `404` or `503` without affecting human TestFlow use.
2. In Gylin, disable project `intensiveTesting` and remove deep/intensive-test commands while rollback is active.
3. Do not delete completed TestFlow runs, receipts, or evidence; they are audit records.
4. Revert only the integration feature and shared start-service extraction if necessary. Existing human route behavior must remain covered by regression tests.
5. Rotate the integration token if compromise is suspected.

## 19. Estimated implementation effort

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Shared start service + no-behavior-change human route regression | 1–2 days |
| 2 | Gylin contract/auth/target mapping/idempotency/terminal adapter | 2–3 days |
| 3 | Evidence URLs, production configuration, end-to-end tests and rollout | 1–2 days |

Estimate assumes the current TestFlow graph can finish the pilot acceptance suite within the Gylin timeout or can be reattached through the same idempotency key.

## 20. Recommended implementation order

### Phase 1 — reusable run start (high risk)

- [ ] Add `server/features/agent/startService.ts`.
- [ ] Move only resolved run creation/start behavior into it.
- [ ] Update `/api/agent/start` to call it.
- [ ] Prove human behavior did not change.
- [ ] Run lint, build, and focused agent-run tests.

Stop and report Phase 1 before starting Phase 2, following TestFlow's architecture-change rules.

### Phase 2 — secure Gylin adapter (high risk)

- [ ] Add contract, auth, service, route, and focused tests.
- [ ] Extend existing operation receipts for external idempotency and attachment.
- [ ] Register only the exact route before human auth.
- [ ] Verify service token isolation and SSRF controls.
- [ ] Verify pass/failure/timeout mappings.
- [ ] Run lint, build, and focused integration tests.

Stop and report Phase 2 before starting Phase 3.

### Phase 3 — production evidence and rollout (medium risk)

- [ ] Add absolute report/evidence links.
- [ ] Add environment documentation.
- [ ] Deploy disabled, configure secrets and App mapping, then enable.
- [ ] Run duplicate-request and real-browser smoke tests.
- [ ] Enable one pilot Gylin project.
- [ ] Monitor latency, failure classification, duplicate count, and evidence availability.

## Codex execution prompt for the TestFlow repository

Give the following prompt to Codex while its working directory is `D:\core-platform-automation`:

```text
Implement docs/TESTFLOW_AI_PRODUCTION_INTEGRATION.md phase by phase and follow AGENTS.md exactly. First inspect the current code and produce/confirm the Phase 1 file-level plan; do not implement a later phase until I approve it in a separate turn. Reuse the existing LangGraph runtime, AgentRuns, credentials, Project/App mapping, Playwright evidence, redaction, and operation receipts. Do not create a second runner, do not call TestFlow through loopback HTTP, do not let the service token access any existing API, and do not weaken human auth/RBAC. Preserve /api/agent/start behavior. After each phase run the smallest focused tests plus npm run lint and npm run build, report every changed file/risk/result, and do not commit or push.
```

Run that prompt only after this document is available at `D:\core-platform-automation\docs\TESTFLOW_AI_PRODUCTION_INTEGRATION.md`. Keep the Gylin and TestFlow copies synchronized when the contract changes. Do not copy secrets into either repository.

## Production acceptance checklist

- [ ] TestFlow production uses PostgreSQL; no JSON fallback.
- [ ] TLS is valid between Gylin and TestFlow.
- [ ] The service token is stored only in secret managers/environment variables.
- [ ] The token cannot access human TestFlow APIs.
- [ ] The candidate URL maps to exactly one configured TestFlow App.
- [ ] Candidate SHA and story ID appear in immutable run metadata.
- [ ] A duplicate request returns the same run ID.
- [ ] A failed criterion blocks Gylin.
- [ ] A run without real evidence blocks Gylin.
- [ ] Evidence/report links are reachable from authorized production users.
- [ ] No secret appears in logs, prompts, evidence, receipts, or responses.
- [ ] Human Agent Console workflows still pass regression checks.
- [ ] Rollback is tested by disabling the feature flag.
