# Architecture

This file records the current code homes used by anti-drift checks. Update it
when an approved architecture change moves a responsibility.

## Code homes

| Concern | Home |
| --- | --- |
| React application and client API adapters | `src/` |
| Backend composition and HTTP entry points | `server.ts`, `apps/api/src/` |
| Backend feature modules | `server/features/` |
| Agent orchestration and provider integration | `server/agent-core/`, `server/agent-runtime/`, `server/ai/` |
| Shared backend infrastructure | `server/shared/` |
| Database schema and persistence | `server/db/` |
| Desktop Record & Play agent | `agent/src/` |
| Core-platform database MCP server | `mcp-servers/core-platform-db/` |
| Operational and maintenance commands | `scripts/` |
| Reference architecture import (not runtime code) | `architecture-import/` |

## Current boundaries

- Browser code under `src/` communicates with backend code through HTTP APIs.
- Backend feature routes register endpoints; reusable behavior belongs in feature services or shared modules.
- `server/db/schema.sql` is the authoritative database schema.
- `architecture-import/` is reference material and is excluded from runtime governance scans.
- Circular imports are prohibited across governed source roots.
