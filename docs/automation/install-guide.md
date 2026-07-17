# TestFlow Desktop Agent — Installation Guide

The TestFlow Desktop Agent runs Playwright recording and test execution **on your own machine** and
connects securely (outbound only) to TestFlow AI. The browser never runs in the cloud, and the agent
can reach applications inside your corporate network that the cloud never could.

## Requirements

- Windows 10/11 (macOS/Linux support is on the roadmap; the agent code is cross-platform).
- [Node.js 18 or newer](https://nodejs.org) on your PATH.
- Outbound HTTPS access to your TestFlow AI URL.

## 1. Download

In TestFlow AI, go to **Automation → Local Agent** and click **Download Agent**. This gives you a
`TestFlow-Agent.zip` containing the agent and a `config.json` with a **one-time pairing token** (valid
for 10 minutes). Download it fresh each time you set up a new machine.

## 2. Install — nothing to install

The bundle is **self-contained**: production `node_modules` and the compiled `dist/` ship inside it —
there is no install step at all.

1. Unzip `TestFlow-Agent.zip` to a folder you control, e.g. `C:\TestFlow-Agent`.
2. Double-click **start.bat**. That's it.

Requires Node.js 18+ on the machine (or a bundled portable Node in `agent/node/`).

## 3. Start

Double-click **start.bat**. On first launch the agent:

- exchanges the pairing token for a durable, machine-bound agent token (stored in `config.json`),
- opens a WebSocket to the cloud and begins sending heartbeats,
- starts a local API on `http://localhost:2424` for diagnostics.

Back in **Automation → Local Agent**, the status badge turns green (**Connected**) within a few seconds.

## 4. Use it

- **Record Test** — pick your agent, enter the app URL, and click **Start Recording**. A Playwright
  codegen window opens on your desktop; interact with your app and the script streams back to the cloud.
- **Schedules / Executions** — schedule runs (daily/weekly/monthly/cron/webhook). When a schedule fires,
  the cloud dispatches the job to your agent, which runs it locally and uploads the report, video, and
  trace.

## Stopping / restarting

- **stop.bat** stops the agent (it terminates whatever is listening on port 2424).
- Closing the start.bat console window also stops it.
- To restart, run **start.bat** again — it reuses the stored token (no re-pairing needed).

## Updating

When a newer agent is published, **Automation → Local Agent** shows an **Update Agent** action, and the
agent logs a notice on startup. Download the new ZIP and unzip it over the same folder, then run
start.bat (your `config.json` and token are preserved).

## Security notes

- The agent connects **outbound only** — it opens no inbound ports to the internet. The local API is
  bound to `127.0.0.1` and requires the `X-Agent-Local-Key` from your `config.json`.
- Tokens are stored under your user profile and are never logged. Revoke an agent any time from
  **Automation → Local Agent** (its tokens stop working immediately).
- Each agent is bound to its machine's fingerprint and to the user who paired it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Node.js is required but was not found" | Install Node 18+ (or use a bundle with a portable Node in `agent/node/`), then run start.bat |
| Badge stays grey / "not running" | Run start.bat; check the console window for errors |
| "Invalid or expired pairing token" | Pairing tokens last 10 minutes — download a fresh ZIP |
| Recording window doesn't open | The browser (Chromium) must be present in `agent/browsers/` — use a bundle that includes it |
| Logs | See `logs/agent-YYYY-MM-DD.log` in the agent folder, or `GET http://localhost:2424/logs` |
