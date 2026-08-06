# Agent Runtime v2 Production-Readiness Report

Date: 2026-07-30

## Status

Implementation is complete. Production rollout is **conditional** because the existing
`test:agent-workflow-resume` suite reports two restart-idempotency failures in untouched
workflow code. All runtime-v2 focused checks, TypeScript compilation, and production builds pass.

## Implemented phases

1. **Authenticated capability policy**
   - Tools are filtered from server-resolved user grants.
   - Read, write, and destructive effects are explicit.
   - Destructive tools are never exposed, including to unrestricted users.

2. **Progress-based tool-loop stopping**
   - The loop stops after three identical calls or five consecutive failures.
   - The configured and hard maximum is 64 tool iterations.
   - Stops produce an honest partial-result summary.

3. **Credential-bound target API tools**
   - Target access uses the selected server-side Website Credential.
   - OpenAPI operations are discovered from the live selected target.
   - Only exact GET/POST/PUT/PATCH contract operations are callable.
   - Authentication, credential, agent, and destructive operations are blocked.

4. **Playwright MCP YAML snapshot tool**
   - Microsoft MCP tools are discovered dynamically from the installed server.
   - Optional testing, network, PDF, DevTools, and vision capability groups are enabled by goal.
   - The agent can navigate, fill, select, create, update, save, submit, and advance as an end user.
   - Destructive controls, arbitrary code execution, secret-bearing storage tools, unsafe
     coordinate actions, and unrestricted server-file access are blocked.
   - The final accessibility-tree YAML snapshot is returned as grounded evidence.

5. **Verification, memory, tracing, and telemetry**
   - Supported writes are re-read and marked verified, failed, or unsupported.
   - Verified mutation memory stores compact completion facts and entity IDs.
   - Tool errors are structured for safe model recovery.
   - Trace payloads are secret-redacted and bounded; prompts are represented by metadata only.
   - Each supervisor turn writes bounded audit telemetry with stop reason, tools, timings,
     verification states, and token usage.

## Modified runtime files

| Area | Files | Risk |
| --- | --- | --- |
| Configuration and checks | `.env.example`, `package.json`, `scripts/test-agent-*.ts`, `scripts/test-platform-api-tools.ts`, `scripts/test-playwright-snapshot-tool.ts` | Low |
| Policy and loop | `server/ai/policy.ts`, `server/ai/toolProgress.ts`, `server/ai/orchestrator.ts`, `server/ai/supervisor.ts`, `server/ai/tools/types.ts` | Medium |
| Target tools and verification | `server/ai/tools/apiContract.ts`, `server/ai/tools/corePlatformMeta.ts`, `server/ai/tools/platformApi.ts`, `server/ai/tools/playwrightSnapshot.ts`, `server/ai/verification.ts` | Medium |
| Evidence and observability | `server/ai/memory/artifactMemory.ts`, `server/ai/tracer.ts`, `server/features/controller/routes.ts` | Medium |
| Browser inspection | `server/features/agent/mcpInspector.ts` | Medium |

No database schema or public API migration is required. Existing tool APIs remain compatible;
new capability and verification properties are optional.

## Validation

Passed:

- `npm run lint`
- `npm run build`
- `test:agent-policy`
- `test:agent-tool-loop`
- `test:platform-api-tools`
- `test:playwright-snapshot-tool`
- live Microsoft MCP discovery with `testing,network` capabilities (32 tools)
- `test:agent-verification`
- `test:rbac`
- `test:capability-routing`
- `test:session-context`
- `test:conversation-persistence`
- `test:evidence`
- `test:api`
- `test:openai-responses`
- `test:agent-workflow-state`
- `test:agent-discovery-graph`
- `test:agent-authoring-graph`
- `test:grounding`

Outstanding:

- `test:agent-workflow-resume`: 110 checks pass and 2 restart-idempotency checks fail because
  discovery and case authoring each replay once across a simulated restart. None of the files
  involved in that workflow were changed by this implementation.

## Rollout and rollback

Roll out first in a non-production workspace with least-privilege test users and test Website
Credentials. Confirm create/update/save/submit flows and audit entries against the real target.
Do not enable production rollout until the two workflow-resume failures are dispositioned.

Rollback is code-only: revert the runtime-v2 files above and remove
`AGENT_MAX_TOOL_ITERATIONS`. No data rollback is required.
