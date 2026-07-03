/**
 * Agent workflow tools — wraps existing services as native function-calling tools
 * so the agent loop can run tests, generate scripts, fetch evidence, and read
 * package metadata without leaving the tool-calling protocol.
 *
 * Tools added here complement the existing DATA tools (corePlatformData) and
 * META tools (corePlatformMeta) and DOM tools (domTools).
 */
import type { AgentTool, ToolContext } from './types';
import { executePlaywrightScripts, type ScriptInput } from '../../features/playwright/executionService';
import { synthesizeScriptFromElements, type BlackboardElement } from '../../features/agent/synthesizeScript';
import { capturePlaywrightEvidence } from '../../features/evidence/evidenceService';
import { Runs } from '../../db/repository';
import { listBlackboard } from '../../features/agent/blackboard';
import { readCodeFileInScope } from '../../features/projects/codeSearch';

const str = { type: 'string' };

export const apiReadTool: AgentTool = {
  spec: {
    name: 'api_read',
    description: 'Authenticated GET request to the target API. Use to read live data, metadata, config, or records from the app service. Returns JSON response body. Credentials are resolved automatically from the configured site.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...str, description: 'API path (e.g. /api/apps, /api/settings). Relative to the base URL.' },
      },
      required: ['path'],
    },
  },
  async execute(args: Record<string, unknown>) {
    const path = String(args.path || '');
    if (!path) return { error: 'path is required' };
    try {
      const base = String(process.env.TARGET_BASE_URL || '').replace(/\/+$/, '');
      if (!base) return { error: 'TARGET_BASE_URL is not configured.' };
      const token = String(process.env.TARGET_TOKEN || '').trim()
        || await loginForToken(base).catch(() => null);
      const res = await fetch(`${base}${path}`, {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      const raw = await res.text();
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = raw.slice(0, 8000); }
      return { url: `${base}${path}`, status: res.status, ok: res.ok, data: body };
    } catch (e: any) {
      return { path, error: e?.message || String(e) };
    }
  },
};

export const runHeadlessTool: AgentTool = {
  spec: {
    name: 'run_headless',
    description: 'Run approved Playwright spec(s) headless against the target URL. Pass the script code directly or a blackboard_id to synthesize from verified selectors. Returns pass/fail per test with errors and screenshot paths.',
    parameters: {
      type: 'object',
      properties: {
        script: { ...str, description: 'Playwright test code to run (alternative to blackboard_id).' },
        title: { ...str, description: 'Test title (used as filename).' },
        baseUrl: { ...str, description: 'Target base URL. Defaults to configured TARGET_BASE_URL.' },
        blackboard_id: { ...str, description: 'Blackboard entry ID to synthesize a script from (alternative to script).' },
        timeoutMs: { type: 'integer', description: 'Per-test timeout in ms (default 120000).' },
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const base = String(args.baseUrl || process.env.TARGET_BASE_URL || '');
    if (!base) return { error: 'No target URL configured. Set TARGET_BASE_URL or pass baseUrl.' };

    let scripts: ScriptInput[] = [];

    if (args.script) {
      scripts = [{ code: String(args.script), title: String(args.title || 'Generated test') }];
    } else if (args.blackboard_id) {
      const entry = listBlackboard().find((e: any) => e.id === args.blackboard_id);
      if (!entry) return { error: `Blackboard entry "${args.blackboard_id}" not found. Run explore_page first.` };
      const code = synthesizeScriptFromElements({
        title: String(args.title || 'Synthesized test'),
        baseUrl: entry.baseUrl || base,
        elements: (entry.elements || []) as BlackboardElement[],
      });
      scripts = [{ code, title: String(args.title || 'Synthesized test') }];
    } else {
      return { error: 'Provide either script code or blackboard_id.' };
    }

    try {
      const result = await executePlaywrightScripts({
        scripts,
        baseUrl: base,
        runId: ctx.runId || `tool-run-${Date.now()}`,
        timeoutMs: Math.min(300000, Math.max(10000, Number(args.timeoutMs) || 120000)),
        screenshotMode: 'only-on-failure',
      });
      return {
        ok: result.ok,
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        tests: result.tests.map((t) => ({
          title: t.title,
          status: t.status,
          error: t.error,
          durationMs: t.durationMs,
          screenshotPath: t.screenshotPath,
        })),
        durationMs: result.durationMs,
      };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  },
};

export const generateScriptTool: AgentTool = {
  spec: {
    name: 'generate_script',
    description: 'Persist a Playwright spec from verified selectors (blackboard) or explicit script code. When blackboard_id is provided, synthesizes a complete test from the explored elements — no LLM guessing. Optionally persists to the scripts repository.',
    parameters: {
      type: 'object',
      properties: {
        title: { ...str, description: 'Test case title.' },
        blackboard_id: { ...str, description: 'Blackboard entry ID from explore_page. Synthesizes script from verified selectors.' },
        script: { ...str, description: 'Explicit Playwright code (alternative to blackboard_id).' },
        baseUrl: { ...str, description: 'Target base URL.' },
        persist: { type: 'boolean', description: 'Save to the scripts repository (default false).' },
      },
      required: ['title'],
    },
  },
  async execute(args: Record<string, unknown>) {
    const title = String(args.title || '');
    if (!title) return { error: 'title is required' };
    const base = String(args.baseUrl || process.env.TARGET_BASE_URL || '');

    let code = '';
    let source = '';

    if (args.script) {
      code = String(args.script);
      source = 'provided';
    } else if (args.blackboard_id) {
      const entry = listBlackboard().find((e: any) => e.id === args.blackboard_id);
      if (!entry) return { error: `Blackboard entry "${args.blackboard_id}" not found.` };
      code = synthesizeScriptFromElements({
        title,
        baseUrl: entry.baseUrl || base,
        elements: (entry.elements || []) as BlackboardElement[],
      });
      source = `blackboard:${args.blackboard_id}`;
    } else {
      return { error: 'Provide either script code or blackboard_id.' };
    }

    const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.spec.ts';

    if (args.persist) {
      try {
        const { Scripts } = require('../../db/repository');
        await Scripts.upsert({
          title,
          filename,
          code,
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (e: any) {
        return { error: `Generated script but persistence failed: ${e?.message}`, title, filename, code, source };
      }
    }

    return { ok: true, title, filename, code, source };
  },
};

export const getRunTool: AgentTool = {
  spec: {
    name: 'get_run',
    description: 'Get a test run summary with per-case results. Returns status, pass/fail counts, errors, and timestamps.',
    parameters: {
      type: 'object',
      properties: {
        runId: { ...str, description: 'Run ID to retrieve.' },
      },
      required: ['runId'],
    },
  },
  async execute(args: Record<string, unknown>) {
    const runId = String(args.runId || '');
    if (!runId) return { error: 'runId is required' };
    try {
      const run = await Runs.get(runId);
      if (!run) return { error: `Run "${runId}" not found.` };
      return {
        id: run.id,
        status: run.status,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
        error: run.error,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        tests: (run.tests || []).map((t: any) => ({
          title: t.title,
          status: t.status,
          error: t.error,
          durationMs: t.durationMs,
        })),
      };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  },
};

export const getEvidenceTool: AgentTool = {
  spec: {
    name: 'get_evidence',
    description: 'Capture screenshots for the target URL or test cases. Opens a headless browser, logs in with configured credentials, and takes full-page screenshots. Returns screenshot URLs.',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: { ...str, description: 'Target URL to screenshot.' },
        runId: { ...str, description: 'Run ID (used for filename prefix).' },
        titles: {
          type: 'array',
          items: str,
          description: 'Test case titles to include in evidence metadata.',
        },
      },
    },
  },
  async execute(args: Record<string, unknown>) {
    const targetUrl = String(args.baseUrl || process.env.TARGET_BASE_URL || '');
    if (!targetUrl) return { error: 'No target URL. Set TARGET_BASE_URL or pass baseUrl.' };
    const runId = String(args.runId || `evidence-${Date.now()}`);
    const titles = Array.isArray(args.titles) ? args.titles.map(String) : [];
    try {
      const credentials = {
        username: process.env.TARGET_USERNAME || '',
        password: process.env.TARGET_PASSWORD || '',
      };
      const evidence = await capturePlaywrightEvidence(
        targetUrl,
        runId,
        titles.map((t) => ({ title: t, captureEvidence: true })),
        credentials,
      );
      return {
        runId,
        evidence: evidence.map((e: any) => ({
          title: e.title,
          url: e.url,
          screenshotUrl: e.screenshotUrl,
        })),
      };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  },
};

export const readPackageTool: AgentTool = {
  spec: {
    name: 'read_package',
    description: 'Read the connected repository\'s package.json. Returns name, scripts, dependencies, and devDependencies. Use to understand the app build tooling and framework before generating tests.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext) {
    try {
      const content = await readCodeFileInScope('package.json', { projectId: ctx.projectId }).catch(() => null);
      if (!content) return { error: 'package.json not found in the connected repository.' };
      const pkg = typeof content === 'string' ? JSON.parse(content) : content;
      return {
        name: pkg.name || '',
        version: pkg.version || '',
        scripts: pkg.scripts ? Object.keys(pkg.scripts).slice(0, 40) : [],
        dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).slice(0, 40) : [],
        devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies).slice(0, 20) : [],
        framework: detectFramework(pkg),
      };
    } catch (e: any) {
      return { error: `Failed to read package.json: ${e?.message || String(e)}` };
    }
  },
};

function detectFramework(pkg: any): string[] {
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frameworks: string[] = [];
  if (allDeps.next) frameworks.push('next');
  if (allDeps.react || allDeps['react-dom']) frameworks.push('react');
  if (allDeps.vue || allDeps['vue-router']) frameworks.push('vue');
  if (allDeps.angular || allDeps['@angular/core']) frameworks.push('angular');
  if (allDeps.svelte || allDeps['@sveltejs/kit']) frameworks.push('svelte');
  if (allDeps.express) frameworks.push('express');
  return frameworks;
}

async function loginForToken(url: string): Promise<string | null> {
  const username = String(process.env.TARGET_USERNAME || '').trim();
  const password = String(process.env.TARGET_PASSWORD || '').trim();
  if (!username || !password) return null;
  try {
    const res = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
    return json?.access_token || null;
  } catch { return null; }
}

export function agentWorkflowTools(): AgentTool[] {
  return [
    apiReadTool,
    runHeadlessTool,
    generateScriptTool,
    getRunTool,
    getEvidenceTool,
    readPackageTool,
  ];
}
