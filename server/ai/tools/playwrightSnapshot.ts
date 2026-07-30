import { resolveCredentials } from '../../features/credentials/credentialsService';
import { inspectApplicationFlowViaMcp } from '../../features/agent/mcpInspector';
import type { AgentTool } from './types';

export const playwrightYamlSnapshotTool: AgentTool = {
  spec: {
    name: 'playwright_yaml_snapshot',
    description: 'Use Playwright MCP as a non-destructive end user: navigate, fill, select, save, submit, and advance through the selected target as required by the goal, then return the final YAML accessibility snapshot and observed page facts.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What page, feature, form, table, or control must be reached and observed.' },
      },
      required: ['goal'],
    },
  },
  capability: { effect: 'write', permissions: ['agent:execute'] },
  async execute(args, ctx) {
    const goal = String(args.goal || ctx.userMessage || '').trim();
    if (!goal) throw new Error('A snapshot goal is required.');
    const credential = resolveCredentials({
      websiteId: String(ctx.appId || ''),
      targetUrl: typeof ctx.targetUrl === 'string' ? ctx.targetUrl : undefined,
      ownerId: ctx.userId ? String(ctx.userId) : undefined,
      role: typeof ctx.credentialRole === 'string' ? ctx.credentialRole : undefined,
    });
    const targetUrl = credential?.baseUrl || (typeof ctx.targetUrl === 'string' ? ctx.targetUrl : '');
    if (!targetUrl) throw new Error('Select a target application with Website Credentials before taking a Playwright MCP snapshot.');

    const inspection = await inspectApplicationFlowViaMcp({
      targetUrl,
      prompt: goal,
      credentials: credential ? { username: credential.username, password: credential.password } : {},
      runId: String(ctx.runId || ctx.conversationId || `snapshot-${Date.now()}`),
      workspaceId: ctx.workspaceId ? String(ctx.workspaceId) : undefined,
      userId: ctx.userId ? String(ctx.userId) : undefined,
      readOnly: false,
      blockDestructive: true,
    });
    return {
      source: 'playwright-mcp',
      goal,
      status: inspection.goalStatus,
      url: inspection.currentUrl,
      summary: inspection.agentSummary,
      yaml: inspection.accessibilitySnapshot,
      visibleTables: inspection.visibleTables,
      visibleForms: inspection.visibleForms,
      assertionTargets: inspection.assertionTargets,
      warnings: inspection.warnings,
    };
  },
};
