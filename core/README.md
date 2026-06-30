# Core

Cross-cutting primitives for the Vite + Express platform.

Planned homes:

- `core/shared`: domain types and pure helpers.
- `core/persistence`: database schema, repositories, and persistence contracts.
- `core/llm`: provider/model routing contracts.

Existing implementations remain in `server/shared`, `server/db`, and `server/ai` until
they are moved behind stable imports.
