# Agentic Test Automation Platform

Multi-agent automated testing for **metadata-driven (Salesforce-style) apps**. Claude agents connect
to a target platform org (the source of truth), produce industry-standard artifacts (IEEE-829 plan,
requirements + RTM, ISTQB cases, suites, scripts), then execute them headless (Playwright) and via a
metadata-driven API-testing MCP server, capturing full evidence. UI is a Claude-style chat with voice.

Full architecture + research citations: `~/.claude/plans/creata-an-appliation-which-recursive-llama.md`.

## Status (verified, runnable)

| Package | What it does | Self-check |
|---|---|---|
| `@atp/shared` | domain types (metadata/locators/testing) + model router + secret-handle resolver/redactor | `pnpm -F @atp/shared test` |
| `@atp/grounding` | render-profile → locator **synthesizer** + **selector-lint** (anti-hallucination) | `pnpm -F @atp/grounding test` |
| `@atp/generators` | deterministic **payload mutator** (valid/boundary/invalid) + ISTQB case generator | `pnpm -F @atp/generators test` |
| `@atp/agent-bus` | **agent-to-agent** messaging (request/reply, notify, pub/sub) + **agents-as-tools** + transcript + loop guard | `pnpm -F @atp/agent-bus test` |
| `@atp/memory` | **per-agent memory** (facts + notes) + **chat memory** with compaction | `pnpm -F @atp/memory test` |
| `@atp/db` | Drizzle schema on **local Postgres** (28 tables incl. chat/memory/A2A) | `pnpm -F @atp/db test` |
| `@atp/orchestrator` | wires the above into a runnable pipeline (manager → agents-as-tools → A2A → grounded spec) | `pnpm -F @atp/orchestrator demo` |

Run everything: `pnpm install && pnpm -r build && pnpm -r test`

The orchestrator demo runs the full deterministic pipeline on the **real `leave_request`** object and
prints the agent-to-agent transcript + a grounded, lint-passing Playwright spec.

## Local setup

- Node 20+, pnpm 10, **local Postgres** on `localhost:5432` (verified). DB `atp` is created and migrated.
- Copy `.env.example` → `.env` (a working `.env` with the local `DATABASE_URL` is already present).
- Apply schema changes: `pnpm -F @atp/db generate && pnpm -F @atp/db migrate`.

## Built next (scaffolded in the plan, not yet coded)

`mcp-platform-meta` (multi-org metadata MCP) · `mcp-api-test` (MCP wrapper over the payload mutator) ·
`indexer` (render-convention learner) · `worker` (Playwright runner + evidence) · `api` (Fastify control
plane) · `apps/chat` (Claude-style chat + voice) · `workspace` (git-backed artifacts) · `tracing`
(OTel GenAI + Langfuse). The orchestrator's deterministic handlers are the seam where Claude Agent SDK
calls drop in for judgment-heavy phases.
