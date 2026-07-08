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

