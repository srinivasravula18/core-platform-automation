# TestFlow Desktop Agent shows "Offline" — diagnosis & fix (2026-07-20)

## Summary

The local desktop agent (`D:\TestFlow-Agent`) registers with the cloud successfully but the app always shows it **Offline**. Root cause: the nginx reverse proxy on `ops.acchindra.com` does not forward WebSocket upgrade requests, so the agent's live socket can never be established. A secondary agent-side bug made the failure silent: after one rejected upgrade the agent stopped retrying entirely. The agent bug is fixed (commit `d7f2791`); the nginx change on the server is **still pending** and is the only remaining step.

## Symptoms

Agent log (`start.bat` console / `logs/agent-YYYY-MM-DD.log`):

```
{"msg":"registered with cloud","agentId":"AGENT-…"}
{"msg":"connecting to cloud","url":"wss://ops.acchindra.com/automation-dev/api/automation/agent-ws"}
{"msg":"token refresh failed","err":"Token refresh failed (401)."}   ← first run, stale tokens
… after re-pairing …
{"msg":"access token refreshed"}                                     ← then silence, no reconnect
```

In the app's **Local Agent** card: machine details and a "last heartbeat" timestamp appear (these come from HTTP registration, which works), but status stays **Offline** because the WebSocket never connects. The agent never "connected then dropped" — the socket never established at all.

## Investigation

1. **First 401s (token refresh failed)** — the install's `config.json` held tokens from an earlier pairing that the cloud no longer recognized (agent record gone/revoked server-side). Re-pairing with a fresh pairing token fixed registration. Pairing tokens are single-use: consumed at first registration and deleted from `config.json`, so a stale install cannot self-recover.
2. **WS still rejected after clean re-pair.** A raw handshake probe against
   `wss://ops.acchindra.com/automation-dev/api/automation/agent-ws` with a **valid, freshly-issued agent token** returned:

   ```
   HTTP/1.1 401
   server: nginx/1.24.0 (Ubuntu)
   x-powered-by: Express
   content-type: application/json

   {"error":"Authentication required."}
   ```

   That response is decisive:
   - The app's real WS gateway (`server/features/automation/agentGateway.ts`) replies to a bad token with a **bare** `HTTP/1.1 401 Unauthorized` — no body, no Express headers.
   - `{"error":"Authentication required."}` comes from the app's regular HTTP auth middleware (`server/features/auth/routes.ts`).

   So the upgrade request reached Express as a **plain GET**: nginx stripped/never forwarded the `Upgrade: websocket` / `Connection: upgrade` headers, Node never emitted the `upgrade` event, and the ordinary HTTP auth layer answered instead. Plain HTTPS calls (register, token refresh, artifact upload) pass through the same proxy fine, which is why only the socket fails.

## Root causes

| # | Layer | Cause |
|---|-------|-------|
| 1 | nginx on `ops.acchindra.com` | The `/automation-dev` (and `/automation-test`) locations lack WebSocket forwarding (`proxy_http_version 1.1` + `Upgrade`/`Connection` headers), so the agent-ws handshake is proxied as a normal GET and 401s in Express middleware. **Pending — the only remaining fix.** |
| 2 | Agent (`agent/src/connection.ts`) | The `ws` library suppresses `error`/`close` when an `unexpected-response` listener is registered. The old handler refreshed the token on 401 and then relied on `close` → reconnect, which never fires — the agent hung forever after the first rejected upgrade, logging nothing. **Fixed.** |
| 3 | Stale credentials (first run only) | `config.json` carried tokens for an agent record the cloud no longer had; refresh legitimately 401'd until re-pairing. **Resolved by re-pairing.** |

## Fixes

### Agent-side (done — commit `d7f2791`)

`agent/src/connection.ts` `unexpected-response` handler now:
- captures and logs the rejection status **and response body** (`ws upgrade rejected` — this would have identified the nginx issue immediately),
- still refreshes the access token on 401,
- always schedules a reconnect with exponential backoff (1s → 60s max), guarded against double-scheduling.

Rebuilt `dist/connection.js` (+ sourcemap) committed and also copied into the live install at `D:\TestFlow-Agent`. Verified live: the agent now loops `ws upgrade rejected` → `access token refreshed` → `reconnecting after backoff` indefinitely, so it will connect on its own the moment the proxy is fixed.

### Server-side (PENDING — run on the ops.acchindra.com Ubuntu box)

1. Locate the site config:

   ```bash
   grep -rn "automation-dev" /etc/nginx/
   ```

2. Add a WebSocket-aware location for the agent-ws path (duplicate for `/automation-test`); `<port>` = the same upstream port the existing `/automation-dev` `proxy_pass` uses:

   ```nginx
   location /automation-dev/api/automation/agent-ws {
       proxy_pass http://127.0.0.1:<port>/api/automation/agent-ws;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_read_timeout 3600s;   # heartbeats are 15s; keep long-lived sockets open
       proxy_send_timeout 3600s;
   }
   ```

3. Validate and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

No agent restart or re-pairing is needed afterwards; within one backoff cycle (≤60 s) the log should show `connected to cloud` and the Local Agent card should flip to **Online** with live heartbeats.

## Verification checklist (after the nginx change)

- [ ] Agent log shows `connected to cloud` and no further `ws upgrade rejected` lines.
- [ ] Local Agent card shows **Online**; "last heartbeat" updates every ~15 s.
- [ ] Re-running the handshake probe returns `101 Switching Protocols` (or a **bare** 401 for a bad token, proving the gateway — not Express — now answers).

## Reference

- Agent connect/reconnect: `agent/src/connection.ts`
- Cloud HTTP client (register/refresh/upload): `agent/src/cloud.ts`
- WS gateway + upgrade auth: `server/features/automation/agentGateway.ts`
- Token issue/refresh service: `server/features/automation/agentService.ts`
- 401 source (plain-HTTP path): `server/features/auth/routes.ts`
