# Services

Agentic test-platform services adapted from `agentic-test-platform`.

Planned homes:

- `services/orchestration`: multi-agent run orchestration.
- `services/agents`: agent role handlers and prompt/tool contracts.
- `services/grounding`: inspection, selector grounding, source verification.
- `services/generators`: requirements, cases, plans, and script generation.
- `services/execution`: Playwright execution and evidence capture.
- `services/artifacts`: artifact serialization and storage.
- `services/memory`: run memory, chat memory, and learned stability facts.
- `services/tools`: metadata/data/repo tool adapters.
- `services/evaluation`: accuracy, coverage, and quality scoring.

Current implementations are exposed through service facades and still delegate to
`server/features/*`, `server/agent-runtime/*`, and `server/ai/*`. Moving code behind
those facades should not require changing `apps/api`.

Active imported modules:

- `services/event-bus/src`: in-process agent-to-agent bus.
- `services/observability/src`: lightweight tracing primitives.
- `services/workspace/src`: git-backed artifact workspace.
- `core/shared/src`: metadata, locator, model, secret, and testing domain types.

Full original target source is also available in `architecture-import/agentic-test-platform`
for modules that require adaptation before activation.
