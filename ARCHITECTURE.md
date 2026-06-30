# Test Flow AI Architecture

This repository uses the `agentic-test-platform` architecture style while keeping the
runtime stack as Vite + Express.

## Runtime

- Web app: Vite + React, currently rooted at `src/`.
- API app: Express, booted by `server.ts` through `apps/api/src/server.ts`.
- Shared backend modules: existing `server/` modules remain the implementation source
  until each service is migrated behind a stable boundary.

## Target Boundaries

- `apps/api`: Express app composition, middleware, route registration, API startup.
- `apps/web`: Vite web application boundary. The active UI still lives in `src/` while
  this boundary is introduced incrementally.
- `core`: cross-cutting primitives such as shared domain types, persistence contracts,
  model routing, secrets, and environment helpers.
- `services`: agentic platform capabilities such as orchestration, grounding, execution,
  artifacts, memory, tools, and evaluation.
- `configs`: deploy/runtime configuration for agents, providers, guardrails, and model routing.
- `prompts`: durable system prompts and prompt contracts.
- `storage`: local development artifacts that should not be treated as source code.

## Migration Rule

Do not replace Vite or Express. New architecture work should introduce a boundary first,
then move implementation behind it without changing public route/UI behavior.

Current compatibility layer:

- `server.ts` is only a launcher.
- `apps/api/src/server.ts` owns Express app assembly.
- Existing `server/features/*` modules are the first set of service implementations to
  migrate into `services/*` when their contracts are stable.

## Imported Reference Architecture

The source implementation from `E:\agentic-test-platform` is present under
`architecture-import/agentic-test-platform`. It is excluded from the active build because it
contains the original pnpm/turbo package graph and non-active framework choices. The active
application remains Vite + Express.

Migration rule for imported modules:

1. Move or adapt the needed source from `architecture-import/agentic-test-platform`.
2. Place it under the matching active `core/*` or `services/*` boundary.
3. Replace facade delegation only after the adapted module passes `npm.cmd run lint` and
   `npm.cmd run build`.
