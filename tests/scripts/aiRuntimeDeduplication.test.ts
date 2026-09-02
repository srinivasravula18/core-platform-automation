import assert from 'node:assert/strict';
import test from 'node:test';
import { codexMcpServers } from '../../server/ai/codex/mcpConfig';

test('Codex transports receive one identical scoped MCP table', () => {
  assert.deepEqual(codexMcpServers({
    core: {
      url: 'http://127.0.0.1:4312/mcp',
      bearerTokenEnvVar: 'CORE_MCP_TOKEN',
      allowedTools: ['read_app', 'list_objects'],
    },
  }), {
    core: {
      url: 'http://127.0.0.1:4312/mcp',
      bearer_token_env_var: 'CORE_MCP_TOKEN',
      enabled_tools: ['read_app', 'list_objects'],
      startup_timeout_sec: 30,
      tool_timeout_sec: 300,
    },
  });
  assert.deepEqual(codexMcpServers(), {});
});

test('empty optional MCP fields are omitted without changing timeout defaults', () => {
  assert.deepEqual(codexMcpServers({ app: { url: 'https://example.test/mcp', allowedTools: [] } }), {
    app: {
      url: 'https://example.test/mcp',
      startup_timeout_sec: 30,
      tool_timeout_sec: 300,
    },
  });
});
