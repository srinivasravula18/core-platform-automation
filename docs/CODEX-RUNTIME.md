# Codex Runtime — operations guide

Every agent turn in Test Flow AI runs on one runtime: **Codex**. Ordinary text, structured,
streaming, cancellation, and resumable turns use the official TypeScript Codex SDK. Turns that
need application tools use `codex app-server`, because it can answer MCP approval requests.

## Why two internal paths

The SDK passed live checks for text, schemas, event streaming, abort, thread resume, and resuming
an App Server-created thread. It does not expose the server-side approval exchange required by the
scoped MCP bridge. `CodexRuntime` therefore uses the SDK data plane for ordinary turns and retains
the small App Server path for authentication, model discovery, device login, and MCP tool turns.

## Layout

| File | Role |
|---|---|
| `server/ai/codex/sdkClient.ts` | official SDK adapter and account-safe process environment |
| `server/ai/codex/appServerClient.ts` | control/MCP transport; answers server-initiated approval requests |
| `server/ai/codex/runtime.ts` | `CodexRuntime` — threads, turns, streaming, structured output, cancellation, health |
| `server/ai/codex/mcpBridge.ts` | loopback-only MCP server exposing scoped application tools |
| `server/ai/providers/codex.ts` | the runtime behind the existing `AIProvider` contract |
| `server/ai/orchestrator.ts` | guardrails, prompt assembly, usage, tracing, the tool loop |

## Setup

1. Install the CLI: `npm i -g @openai/codex` (the app expects `codex` on PATH; override with `CODEX_CLI_PATH`).
2. Authenticate: `codex login`. This uses the machine's ChatGPT subscription and is **not billed per token**.
3. Optional: set `OPENAI_API_KEY` (or save a key in Settings → AI Runtime) to run in API-key mode instead.
   Only then does the cost tracker record spend, priced from `PRICING_PER_1M_TOKENS`.

Verify SDK compatibility with `npm run test:codex-sdk-compat`, then run
`npm run test:codex-runtime` and `npm run test:codex-tool-loop`.

## Connecting a deployed environment (no browser, no shell, no API key)

`codex login` needs a browser on the machine, which a test/staging server does not have. Use the
**device-code** flow instead: Settings → AI Runtime → **Sign in with ChatGPT**. The server asks the
runtime to start a login, shows a short code and a URL, and the admin completes it in a browser on
their own laptop. Codex stores a refresh token, so this is one-time per environment.

```
POST /api/ai/runtime/login              → { loginId, verificationUrl, userCode, state }
GET  /api/ai/runtime/login/:loginId     → { state: pending | success | error | cancelled }
POST /api/ai/runtime/login/:loginId/cancel
POST /api/ai/runtime/logout
```

All four are **admin-only** (`requireAdmin`). The shared app-server process is held open while a
login is pending so the idle timer cannot kill the flow mid-way, and an unused code is reaped after
`CODEX_LOGIN_TTL_MS` (default 15 min).

Equivalent from a shell, if the admin has one: `codex login --device-auth`.

### Persisting credentials across redeploys

Tokens live in `$CODEX_HOME/auth.json` (default `~/.codex`). The backend passes its environment
through to the runtime, so setting `CODEX_HOME` is enough — no code change. In a container, point it
at a mounted volume or every redeploy loses the session:

```
CODEX_HOME=/data/codex        # mount /data/codex
```

### Licensing note

A ChatGPT Plus/Pro subscription is an individual seat. Pointing a shared environment at one person's
login means every tester's runs consume that account's rate limits, and it is outside what an
individual plan licenses. For a genuinely shared deployment use a ChatGPT Business/Enterprise seat
provisioned for the service, or API-key mode. The device login is appropriate for a small team's
test environment.

## Authentication modes

| Mode | When | Billing |
|---|---|---|
| `account` (default) | no API key configured | ChatGPT subscription; usage recorded at zero cost |
| `api_key` | a key is saved in Settings or `OPENAI_API_KEY` is set | per token, tracked under Settings → Cost |

Settings → AI Runtime reports which mode is live, and **Test connection** resolves the real blocker
(not authenticated / CLI missing / usage limit) rather than a generic failure.

## Tools and the MCP bridge

Application tools are not sent to the model as prose. `AgentOrchestrator.runToolLoop` opens a scoped
bridge session and hands Codex an MCP endpoint; the runtime then calls the tools natively and
iterates on its own. The tools still execute **in the backend process**, so their existing database
access and scope enforcement are unchanged.

Security layers, all enforced in `mcpBridge.ts` and `appServerClient.ts`:

- the listener binds `127.0.0.1` on an ephemeral port — unreachable off-box;
- every request must carry the process bridge token, given only to our Codex process via env;
- the session's URL path is a 32-byte random secret, revoked the moment the turn ends;
- a session pins user/project/app/conversation plus an explicit tool allowlist;
- `maxSteps` becomes a hard tool-call ceiling — past it, calls are refused with an instruction to answer;
- **only** tool calls from the `testflow` bridge are approved. Sandbox escapes, shell-command
  escalation, and file writes are always denied; agents run read-only.

Tool errors are returned to Codex as visible tool errors, never swallowed, so the agent can
self-correct instead of stalling.

## Threads

A conversation's model-side history lives in a Codex thread, mapped in the `codex_threads` table by
`{conversation_id, agent}`. A restarted (or second) worker resumes the same thread instead of
restarting the agent's memory. If the runtime has forgotten a mapped thread, the loop drops the
mapping and starts a fresh one rather than failing the turn.

## Configuration

| Variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | switches to API-key mode; empty means the ChatGPT login |
| `CODEX_CLI_PATH` | path to the codex binary when it is not on PATH |
| `CODEX_TRANSPORT` | `auto` (default), strict `sdk`, or rollback value `app-server` |
| `CODEX_APP_SERVER_TIMEOUT_MS` | per-request timeout (default 30s) |
| `CODEX_TURN_TIMEOUT_MS` | per-turn timeout (default 15m) |
| `CODEX_APP_SERVER_IDLE_MS` | idle shutdown for the shared process (default 5m) |
| `CODEX_MCP_PORT` | bridge port; 0/unset means ephemeral |
| `CODEX_MCP_SESSION_TTL_MS` | bridge session lifetime (default 30m) |
| `CODEX_MCP_MAX_RESULT_CHARS` | per-tool-result bound before it enters model context (default 24k) |

## Checks

| Command | Covers |
|---|---|
| `npm run test:codex-sdk-compat` | SDK text, schema, events, abort, cross-transport resume, MCP capability gate |
| `npm run test:codex-runtime` | health/auth, text, structured output, streaming, cancellation, thread resume |
| `npm run test:codex-mcp-bridge` | loopback binding, auth rejection, allowlist, scope, budget, revocation |
| `npm run test:codex-tool-loop` | end-to-end: Codex calls a real tool and answers from its result |

The runtime checks skip loudly (exit 0) when Codex is not authenticated, so CI without a login stays green.

## Operational notes

- SDK turns are short-lived CLI processes; App Server is one shared, lazily started control/MCP process.
- Phase 4 App Server deletion is intentionally skipped while SDK MCP approval remains unavailable.
- Codex thread storage is local to the runtime host. Multi-instance deployment therefore needs
  worker affinity or shared Codex storage before horizontal scaling.
- Stop in the Agent Console maps to `turn/interrupt` and returns immediately; the interrupted turn
  is never transferred into another thread.
