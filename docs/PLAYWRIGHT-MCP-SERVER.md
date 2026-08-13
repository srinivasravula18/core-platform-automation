# Playwright MCP Server

This project uses the official Microsoft Playwright MCP server:

- package: `@playwright/mcp`
- installed version: `0.0.77`
- MCP name: `io.github.microsoft/playwright-mcp`
- repo: `https://github.com/microsoft/playwright-mcp`

Use the pinned version for reproducible local automation.

## Claude Code

```bash
claude mcp add playwright npx @playwright/mcp@0.0.77
```

## Claude Desktop

Add this to the Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@0.0.77"]
    }
  }
}
```

## Codex

```bash
codex mcp add playwright npx "@playwright/mcp@0.0.77"
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@0.0.77"]
```

## Server Options Used By This App

The in-app DOM facts collector starts the same server from the installed package:

```bash
node node_modules/@playwright/mcp/cli.js --headless --isolated --no-sandbox --shared-browser-context
```

For local interactive clients, headed mode is fine. For CI/server use, keep `--headless --isolated --no-sandbox`.


## Relationship to the Codex runtime's MCP bridge

Two different MCP servers are in play; they do not overlap.

- **This one (`playwright`)** is an EXTERNAL server the app starts itself to collect DOM facts. It is
  configured in the developer's own Codex/Claude config, not by the app at turn time.
- **The internal bridge (`testflow`)** is what exposes the application's own agent tools to Codex.
  It is created per turn by `server/ai/codex/mcpBridge.ts`, bound to loopback, scoped to one
  user/project/app with an explicit tool allowlist, and torn down when the turn ends.

Only `testflow` tool calls are auto-approved by the app server client; any other MCP server's tool
calls are declined during an agent turn. See `docs/CODEX-RUNTIME.md`.
