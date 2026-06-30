# Apps

Runtime applications for the Vite + Express platform.

- `apps/api`: Express API composition and bootstrapping.
- `apps/web`: Vite + React web boundary. The active app still compiles from root `src/`
  through root `vite.config.ts` while UI files are migrated incrementally.

This repository intentionally does not use Next.js, Fastify, pnpm workspaces, or turbo.
