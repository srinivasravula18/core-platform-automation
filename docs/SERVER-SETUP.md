# Server Setup

What must be true on the server for Test Flow AI to run smoothly. Written for whoever provisions or
operates the box, not for feature development.

Ordered by how badly it breaks things: everything in **Required** must be right or the app will not
start or will fail its first agent run.

---

## 1. Required

### Runtime

| Component | Version | Notes |
| --- | --- | --- |
| Node.js | 20+ (24.x in use) | The backend runs `tsx server.ts` — no build step in dev. |
| PostgreSQL | 14+ (17.x in use) | Mandatory. The JSON store is a throwaway sandbox, not a fallback. |
| Codex CLI | current | Every agent turn runs through it. Must be on `PATH` or pointed at by `CODEX_CLI_PATH`. |
| Chromium | Playwright-managed | Installed by `npm run playwright:install`. |

### Environment

Copy `.env.example` to `.env.local` and set at minimum:

```bash
DATABASE_URL=postgres://user:password@host:5432/testflowai
CRED_ENC_KEY=<32 bytes of randomness>
ADMIN_USERNAME=<first admin login>
ADMIN_PASSWORD=<first admin password>
APP_URL=https://your-host            # used to build absolute links
```

**`CRED_ENC_KEY` encrypts website passwords and private-repo tokens at rest.** Rotating it makes every
stored secret undecryptable — they must be re-entered by hand. Generate once, back it up, keep it out of
source control:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Database

The schema is idempotent and applied on boot; it is also applied manually by:

```bash
psql -h HOST -U USER -d testflowai -v ON_ERROR_STOP=1 -f server/db/schema.sql
```

`server/db/schema.sql` is authoritative. Any schema change must stay idempotent for both new and
existing databases, and `scripts/setup-db.bat` must be updated in the same change.

A successful boot logs:

```
[pg] schema applied
[pg] connected, schema applied, seed: ...
[workflow] graph runtime checkpointer initialized
Backend running on http://localhost:3001
```

If `[workflow] graph runtime checkpointer initialized` is missing, agent runs cannot checkpoint and will
not survive a restart.

### Browsers

```bash
npm run playwright:install
```

Required before the first run that executes scripts or inspects a live page. On a headless Linux server
the launcher already passes `--no-sandbox` and friends; no extra flags are needed.

---

## 2. Codex runtime

Every agent turn runs through Codex. Two authentication modes:

| Mode | How | When |
| --- | --- | --- |
| ChatGPT account | leave `OPENAI_API_KEY` empty, run `codex login` on the server | local/dev, no per-token billing |
| API key | set `OPENAI_API_KEY` | production; billed per token and tracked by the cost tracker |

**Account mode is rejected outside local dev** — a production deployment must use an API key.

```bash
CODEX_HOME=/var/lib/testflow/codex     # MUST be a mounted volume in a container
CODEX_CLI_PATH=/usr/local/bin/codex    # only when codex is not on PATH
CODEX_TRANSPORT=auto                   # leave as auto
```

**`CODEX_HOME` on a container is the one that bites.** It defaults to `~/.codex`; if that is not a
mounted volume, the ChatGPT sign-in is lost on every redeploy and agent runs start failing with auth
errors that look like model errors.

### The server's own `~/.codex/config.toml`

The Codex CLI merges the operating user's global config into every turn. The application sends an
explicit (possibly empty) `mcp_servers` table so a developer's global MCP servers cannot leak into agent
runs — a globally-registered Playwright MCP server otherwise drives a **real, visible browser** during
agent turns.

If you see an unexpected browser window opening on the server during a run, check that file first.

---

## 3. Target applications

Agent runs need a target that is actually serving. Configure per app in the UI
(**Settings → Credentials**), not by environment variable — the env target is a local-dev fallback only.

For each target the server needs:

- **network reachability** from the server to the target's base URL (a run pre-flights this and refuses
  to start against a target returning 404/502/503/504 or refusing the connection);
- **credentials** stored in Settings → Credentials, with *Use for Playwright* ticked for anything that
  needs sign-in;
- **a connected repository** on the project, if you want repo-grounded requirements and cases. Without
  it the agents fall back to live inspection only, and the guide's coverage will be thinner.

Repository paths are read from disk by the server process, so the account running the backend needs read
access to them.

---

## 4. Ports and processes

| Port | Process | Notes |
| --- | --- | --- |
| 3000 | frontend (`npm run dev:frontend`) | Vite dev server; served statically in production. |
| 3001 | backend (`npm run dev:backend`) | API, SSE event streams, and the desktop-agent WebSocket. |
| ephemeral | scoped MCP bridge | Loopback-only. Set `CODEX_MCP_PORT` only if you must pin it. |

**The backend has no watch/hot-reload.** After any change under `server/**` it must be restarted or the
running process keeps executing stale code. Restart the whole process tree, not just the listener — a
half-killed tree leaves a zombie holding port 3001, and the next start fails with `EADDRINUSE` that gets
swallowed into a confusing crash later.

Verify a restart actually took:

```bash
curl -s localhost:3001/api/health          # {"ok":true,...}
netstat -ano | grep ":3001 .*LISTENING"    # confirm a listener exists
```

---

## 5. Optional configuration

None of these are needed for a working install.

| Variable | Purpose |
| --- | --- |
| `REMOTE_AGENT_V1` | Enables the Record & Play desktop-agent module (paired agents, recordings, schedules). |
| `SESSION_RUN_PROJECTION_V1` | Session-scoped run projection. |
| `DEPLOYMENT_MODE=production` | Enforces production rules — notably, refuses to start without a durable checkpointer. |
| `SEED_DEMO_DATA=true` | Seeds demo content on an empty database. |
| `CHROMIUM_MAX_CONCURRENT_LAUNCHES` | Serialize Chromium startups on machines where parallel launches crash. |
| `PGPOOL_MAX` | PostgreSQL pool size; raise for many concurrent runs. |
| `AGENT_BUS_MAX_MESSAGES` | Per-run message budget (default 1000) — a runaway-loop guard. |
| `CODEX_TURN_TIMEOUT_MS` | Per-turn ceiling (default 15m). Raise only if long repository analyses are being cut off. |

The application deliberately has **no feature flags** for agent behaviour. Everything the agents do —
grounding, critique, per-case repair, evidence gates — is always on. If a behaviour needs disabling, that
is a code change, not an environment variable.

---

## 6. Operational checks

**After deploying:**

```bash
curl -s localhost:3001/api/health                                    # service is up
curl -s localhost:3001/api/app-config                                # deployment mode, module flags
psql "$DATABASE_URL" -c "select count(*) from agent_tasks;"          # orchestration schema exists
```

**Signs something is wrong:**

| Symptom | Likely cause |
| --- | --- |
| Runs fail immediately with auth errors | Codex sign-in lost — check `CODEX_HOME` is a mounted volume. |
| "Server is not responding" on every target | Server cannot reach the target network; check egress rules. |
| Stored credentials suddenly invalid | `CRED_ENC_KEY` changed or is missing. |
| Runs start but never checkpoint | No `DATABASE_URL`; in-memory checkpointer is non-durable. |
| A browser window opens during runs | A globally-registered MCP browser server in the operating user's `~/.codex/config.toml`. |
| Code changes have no effect | Backend not restarted — it has no hot-reload. |

**Backups.** Back up the PostgreSQL database and `CRED_ENC_KEY` together. The database without the key
leaves every stored credential and repository token unrecoverable.

---

## 7. Resetting data

**Settings → Data → Reset Workspace Data** permanently deletes test artifacts, agent runs, all users'
chat history, and automation data. It keeps users, projects/apps, and settings. It is not a soft delete —
nothing goes to the Recycle Bin.

Stop the backend before any out-of-band database reset: the running process holds in-memory copies and
will write stale rows back over a cleared database.
