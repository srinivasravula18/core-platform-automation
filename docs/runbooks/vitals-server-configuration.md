# Runbook — configure Vitals on the server

**For:** an agent or operator with shell access to the server running Test Flow AI.
**Goal:** Vitals reads the monitored product's observability data. That needs exactly one setting —
the database connection — written into Test Flow AI's environment.

**Do not** modify the monitored product (core-platform). Nothing in this runbook changes it.
**Do not** print, echo or paste passwords into logs, chat, or a transcript. Mask them (`sed` recipes
below do this). **Do not** commit any `.env` file.

---

## Background you need

- Vitals is a page group inside **Test Flow AI**. It reads the `obs` schema that the monitored
  product's App Service writes to its own Postgres database.
- Vitals is *not* the product's observability console. It does not talk to that console for reading,
  and it keeps working after that console is removed.
- Therefore Vitals needs one thing: **the connection string of the database that holds the `obs`
  tables.** That is the same database the product's own console reads.

---

## Step 1 — Locate Test Flow AI's environment file

```bash
ls -d /home/*/core-platform-automation /opt/core-platform-automation /srv/core-platform-automation 2>/dev/null
# fallback
sudo find / -maxdepth 5 -type d -name core-platform-automation 2>/dev/null | head
```

The env file is `.env.local` in that directory (fall back to `.env` if the deployment uses that).
Call it `$TFA_ENV` from here on.

## Step 2 — Discover where the monitored product stores its data

The **running process** is the authority — a `.env` file on disk may not be what pm2 started with.

```bash
pm2 env core-platform-observability 2>/dev/null \
  | grep -E '^(OBSERVABILITY_DB_URL|DATABASE_URL|DB_HOST|DB_PORT|DB_USER|DB_USERNAME|DB_NAME)=' \
  | sed -E 's#(//[^:]+:)[^@]*@#\1***@#'
```

If that process is not running, read the product's env file instead:

```bash
sudo find / -maxdepth 5 -name .env -path '*core-platform*' 2>/dev/null | head
grep -E '^(OBSERVABILITY_DB_URL|DATABASE_URL|DB_HOST|DB_PORT|DB_USER|DB_USERNAME|DB_NAME)=' <that file> \
  | sed -E 's#(//[^:]+:)[^@]*@#\1***@#'
```

**Resolution order the product uses** (`apps/observability/src/server/db.ts`) — apply the same logic:

1. `OBSERVABILITY_DB_URL` — if set, this is the answer; ignore the rest.
2. `DATABASE_URL` — if set, this is the answer.
3. Otherwise assemble from the parts:
   `DB_HOST` (default `127.0.0.1`), `DB_PORT` (default `5432`),
   `DB_USER` or `DB_USERNAME` (default `postgres`), `DB_PASSWORD`,
   `DB_NAME` (default `core-platform`).

> Do not assume `DB_NAME=core-platform`. Sandboxes are provisioned as `<base>_sb_<name>`, so a
> deployment may store its telemetry in a differently-named database.

## Step 3 — Confirm which database actually holds the `obs` tables

Verify before writing anything. This finds the store regardless of naming:

```bash
psql -U <db_user> -h <db_host> -p <db_port> -Atc \
  "select datname from pg_database where datistemplate = false" \
| while read db; do
    n=$(psql -U <db_user> -h <db_host> -p <db_port> -d "$db" -Atc \
      "select count(*) from information_schema.tables where table_schema='obs'")
    echo "$db -> $n obs tables"
  done
```

Interpret:

| Result | Meaning | Action |
|---|---|---|
| One database with **8+** obs tables | That is the store | Use it in Step 4 |
| **Several** with 8+ | Each sandbox carries its own store | Use the one matching the product instance being monitored; report the full list back |
| **All zero** | The product has not migrated its observability schema | **Stop.** Vitals cannot be configured. Report that the monitored product needs its migrations run and `OBS_ENABLED` left enabled |

## Step 4 — Write the setting into Test Flow AI's environment

Idempotent — replaces an existing line rather than appending a duplicate:

```bash
NEW='VITALS_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>'
if grep -q '^VITALS_DATABASE_URL=' "$TFA_ENV"; then
  sudo sed -i "s#^VITALS_DATABASE_URL=.*#${NEW}#" "$TFA_ENV"
else
  printf '\n# Vitals reads the monitored product'"'"'s obs schema directly.\n%s\n' "$NEW" | sudo tee -a "$TFA_ENV" >/dev/null
fi
grep -c '^VITALS_DATABASE_URL=' "$TFA_ENV"   # must print exactly 1
```

If the password contains `@ : / # ?`, either URL-encode it or use the parts form instead, which needs
no encoding — **all five** are required together:

```bash
VITALS_DB_HOST=...
VITALS_DB_PORT=5432
VITALS_DB_USER=...
VITALS_DB_PASSWORD=...
VITALS_DB_NAME=...
```

Optional, and only if the product's console is still running and runs should be startable from Load
Lab. Reading works without these; skip them if that console is being retired:

```bash
VITALS_CONTROL_URL=http://127.0.0.1:5006
VITALS_CONTROL_USERNAME=<operator>
VITALS_CONTROL_PASSWORD=<password>
```

Also confirm `CRED_ENC_KEY` is set in `$TFA_ENV`. Without it, anything saved through the UI is
encrypted with a well-known development key.

## Step 5 — Restart the backend

The backend has **no hot reload**; an env change does nothing until the process restarts.

```bash
pm2 restart <test-flow-ai-backend-process>   # or the deployment's own restart command
pm2 list                                      # confirm it came back online
```

## Step 6 — Verify

```bash
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:3001/api/vitals/status
```

Expected:

```json
{"configured":true,"reachable":true,"message":"Connected.","database":"<name>",
 "schemaPresent":true,"oldestSampleAt":"...","newestSampleAt":"..."}
```

`newestSampleAt` should be recent (minutes, if the product is serving traffic). Then open Vitals →
Overview and confirm the tiles and charts render.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `configured:false` | No setting was read | Wrong env file, or the backend was not restarted. Re-check Steps 4-5 |
| `"holds no observability tables"` | Connected to a real database that is not the store | Wrong `DB_NAME`. Redo Step 3 and use the database reporting 8+ tables |
| `"obs schema is incomplete (N of 8)"` | Partially migrated database | Run the monitored product's migrations against it |
| `reachable:false` + `password authentication failed` | Wrong credentials | Re-read Step 2 from the running process, not a stale file |
| `reachable:false` + `no pg_hba.conf entry` | Postgres refuses this client | Database is on another host; allow the app server in `pg_hba.conf` or use the host the product itself uses |
| `reachable:false` + `ECONNREFUSED` | Wrong host or port | Compare against Step 2 output |
| Status is `Connected.` but pages are empty | Store is reachable but has no data in the window | Widen the time range. If `newestSampleAt` is old, the product is not currently writing — check `OBS_ENABLED` is not `0` on its side |
| Permission errors on write actions | Read-only role | Expected. Reads work; resolving issues, alert rules, dashboards and engagements need `insert`/`update` on `obs` |

## Minimum privileges

Reading needs `CONNECT` on the database, `USAGE` on schema `obs`, and `SELECT` on its tables. Grant
`INSERT`/`UPDATE` only if the write actions above are wanted. A read-only role is a sound default.

## When finished, report

1. The database name chosen, and how it was confirmed (table count).
2. The full output of `/api/vitals/status` (no credentials).
3. Whether the control-plane variables were set, and why.
4. Anything from the troubleshooting table that was hit, and what resolved it.
