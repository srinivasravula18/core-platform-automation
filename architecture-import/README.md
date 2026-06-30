# Imported Agentic Test Platform Architecture

This folder is an exact source/reference import from `E:\agentic-test-platform`, excluding
generated outputs and dependency directories such as `.git`, `node_modules`, `.next`, and `dist`.

It is intentionally excluded from the active root TypeScript build. The imported source depends
on the original pnpm/turbo workspace package graph and includes non-active runtime choices such
as Next.js/Fastify. The current product must remain Vite + Express.

Use this folder as the migration source when moving implementation behind the active boundaries:

- `core/*`
- `services/*`
- `apps/api`
- `apps/web`

Do not import from `architecture-import/*` in production code. Move/adapt the needed module into
the active Vite/Express architecture first, then wire it through a service or core facade.
