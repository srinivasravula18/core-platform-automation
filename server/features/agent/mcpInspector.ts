/**
 * MCP inspector — drives the live app through the REAL @playwright/mcp server (headless),
 * the same Model-Context-Protocol browser surface Claude/Cursor use. The model calls
 * browser_navigate / browser_snapshot / browser_click / browser_type to reach and observe
 * the target feature; we then take a final accessibility snapshot and map it to the SAME
 * result shape as inspectApplicationFlow, so every downstream consumer works unchanged.
 *
 * Enabled via INSPECTOR_MCP=true (or db.settings.inspectorMcp). Runs headless and server-safe
 * (--headless --no-sandbox, honouring PLAYWRIGHT_CHROMIUM_PATH). On ANY failure it throws so
 * the caller falls back to the tool-loop / classic inspector — it never degrades a run.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getToolCapableOrchestrator } from '../../ai/orchestrator';
import { startMcpSession, closeMcpSession, type McpSession } from '../../ai/tools/mcpClient';
import { createAuthStorageState } from '../evidence/evidenceService';
import { normalizeTargetUrl } from '../../shared/url';
import type { AgentTool, ToolContext } from '../../ai/tools/types';

// The inspector only needs to read and interact — never close the browser, upload files,
// manage tabs, run arbitrary unsafe code, or handle dialogs. Whitelisting keeps the loop
// focused and safe.
const ALLOWED_MCP_TOOLS = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_wait_for',
]);

function buildSystemPrompt(targetUrl: string, credentials: any): string {
  const hasCreds = !!(credentials?.username && credentials?.password);
  return `You inspect a LIVE web application through the Playwright MCP browser tools. The browser is already open at the target app (headless).

Your tools include: browser_snapshot (read the current page as an accessibility tree with [ref] markers), browser_navigate, browser_click, browser_type, browser_fill_form, browser_select_option, browser_press_key, browser_hover, browser_wait_for.

Goal: reach and FULLY OBSERVE the feature named in the task, so test cases can be grounded in what is really on the page.

Method:
1. Call browser_snapshot FIRST to see the current page. Always work from the latest snapshot's real elements and [ref] values — never guess a ref.
${hasCreds ? `2. If a sign-in form is shown (username/email + password fields), log in ONCE using these credentials: username "${credentials.username}", password "${credentials.password}". Type them into the matching fields and submit, then browser_snapshot again to confirm the app loaded.` : '2. If a sign-in form is shown and you have no credentials, stop and report that login is required.'}
3. Navigate step by step toward the feature (menus, tabs, list rows) — ONE action per step, each grounded in the latest snapshot. browser_snapshot again after every navigation.
4. When the feature is visible, drill INTO it: open its menus/panels/settings so hidden controls are revealed, and snapshot them. If it has a create/add or edit action, open that form ONCE and snapshot it so the fields are captured. This is a TEST ENVIRONMENT — you MAY fill and submit a form with provided test data to observe the real result/validation, then continue.
5. NEVER use destructive controls (delete, remove, reset, deactivate...) unless the task explicitly requires it.
6. If an action fails, take a fresh snapshot and choose a different element — do not repeat the exact failing action.

Stop when the feature and its controls have been observed (or you are genuinely blocked), then answer with a short plain-text summary: what was reached, what is visible (key controls, tables, forms), and anything that blocked you. Never fabricate anything you did not observe.`;
}

/**
 * Headless login for the MCP browser, reusing the PROVEN raw-Playwright login: createAuthStorageState
 * logs in headless (token endpoint or form, whichever the app needs) and captures both the
 * storageState (cookies + localStorage, written to a temp file we pass to the MCP server via
 * --storage-state) AND the sessionStorage token (which storageState omits — this app keeps its auth
 * there). We then inject that captured sessionStorage into the MCP browser via browser_evaluate and
 * reload, so the MCP-driven browser starts fully authenticated without depending on MCP's own
 * form-event dispatch (which some React SPAs don't accept). Returns the storageState path (for the
 * caller to pass at MCP launch) or null. App-agnostic; works local and in production.
 */
async function prepareAuthForMcp(uiUrl: string, credentials: any): Promise<{ storageStatePath: string | null; sessionItems: Record<string, string> | null }> {
  const username = String(credentials?.username || '').trim();
  const password = String(credentials?.password || '').trim();
  if (!username || !password) return { storageStatePath: null, sessionItems: null };
  const storageStatePath = join(tmpdir(), `mcp-auth-${randomUUID()}.json`);
  try {
    const res = await createAuthStorageState(uiUrl, { username, password }, storageStatePath);
    if (!res.ok) return { storageStatePath: null, sessionItems: null };
    return { storageStatePath, sessionItems: res.sessionStorage?.items || null };
  } catch {
    return { storageStatePath: null, sessionItems: null };
  }
}

/** Inject captured sessionStorage token values into the MCP browser and reload. */
async function injectSessionIntoMcp(session: McpSession, uiUrl: string, items: Record<string, string> | null): Promise<void> {
  if (!items || !Object.keys(items).length) return;
  const injectFn = `() => { const items = ${JSON.stringify(items)}; for (const k in items) { try { sessionStorage.setItem(k, items[k]); } catch (e) {} } return true; }`;
  try {
    await session.client.callTool({ name: 'browser_navigate', arguments: { url: uiUrl } });
    await session.client.callTool({ name: 'browser_evaluate', arguments: { function: injectFn } });
    await session.client.callTool({ name: 'browser_navigate', arguments: { url: uiUrl } });
  } catch { /* best effort */ }
}

/** Extract structured page facts from the app via a single browser_evaluate through MCP. */
async function snapshotStructured(session: McpSession): Promise<any> {
  const evalTool = session.tools.find((t) => t.spec.name === 'browser_evaluate')
    // browser_evaluate was filtered out of the loop tools; call it directly on the client instead.
    || null;
  const tryParseEmbeddedJson = (raw: string) => {
    const text = String(raw || '').trim();
    if (!text) return null;
    const starts: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{' || ch === '[') starts.push(i);
    }
    for (const start of starts) {
      const open = text[start];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === open) depth += 1;
        else if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            const candidate = text.slice(start, i + 1);
            try { return JSON.parse(candidate); } catch { break; }
          }
        }
      }
    }
    return null;
  };
  const fn = `() => {
    const q = (sel) => Array.from(document.querySelectorAll(sel));
    const text = (e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
    const headings = q('h1,h2,h3,[role=heading]').map(text).filter(Boolean).slice(0, 40);
    const tables = q('table,[role=grid],[role=table]').slice(0, 12).map((t) => ({
      label: (t.getAttribute('aria-label') || '').slice(0, 80),
      headers: Array.from(t.querySelectorAll('th,[role=columnheader]')).map(text).filter(Boolean).slice(0, 30),
      rowCount: t.querySelectorAll('tr,[role=row]').length,
    }));
    const forms = q('form,[role=form]').slice(0, 12).map((f) => ({
      text: text(f).slice(0, 120),
      fieldCount: f.querySelectorAll('input,select,textarea').length,
    }));
    return { url: location.href, title: document.title, headings, tables, forms, bodyText: text(document.body).slice(0, 1500) };
  }`;
  try {
    const res: any = await session.client.callTool({ name: 'browser_evaluate', arguments: { function: fn } });
    const parts = Array.isArray(res?.content) ? res.content : [];
    const raw = parts.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n');
    const parsed = tryParseEmbeddedJson(raw);
    return parsed || { url: '', title: '', headings: [], tables: [], forms: [], bodyText: raw.slice(0, 1500) };
  } catch {
    return { url: '', title: '', headings: [], tables: [], forms: [], bodyText: '' };
  }
}

export async function inspectApplicationFlowViaMcp(options: {
  targetUrl: string;
  prompt: string;
  credentials: any;
  runId: string;
  knowledge?: string;
  testData?: string;
  workspaceId?: string;
}) {
  const url = normalizeTargetUrl(options.targetUrl);
  if (!url) throw new Error('No target URL was resolved for the MCP inspector.');

  let session: McpSession | null = null;
  try {
    // Log in FIRST with the proven raw-Playwright path, capturing storageState (cookies +
    // localStorage) and the sessionStorage token. Start the MCP browser from that storageState.
    const auth = await prepareAuthForMcp(url, options.credentials);

    // Launch the real Playwright MCP server (headless, server-safe). Expose browser_evaluate
    // to the SESSION (for our structured extraction) but keep it OUT of the model's tool set.
    session = await startMcpSession({
      toolFilter: (name) => ALLOWED_MCP_TOOLS.has(name) || name === 'browser_evaluate',
      extraArgs: auth.storageStatePath ? ['--storage-state', auth.storageStatePath] : [],
    });
    const loopTools: AgentTool[] = session.tools.filter((t) => ALLOWED_MCP_TOOLS.has(t.spec.name));

    // Inject the captured sessionStorage token (storageState omits it) and land on the app.
    await injectSessionIntoMcp(session, url, auth.sessionItems);
    if (!auth.storageStatePath && !auth.sessionItems) {
      await session.client.callTool({ name: 'browser_navigate', arguments: { url } });
    }

    const orch = await getToolCapableOrchestrator('appInspector', { workspaceId: options.workspaceId });
    const toolContext: ToolContext = { workspaceId: options.workspaceId, runId: options.runId, scratch: {} };
    const loop = await orch.runToolLoop({
      task: `Inspect this application for the following testing goal, then summarize what you observed:\n${options.prompt}${options.knowledge ? `\n\nKnown app context:\n${options.knowledge.slice(0, 4000)}` : ''}${options.testData ? `\n\nTEST DATA (use these exact field api_names and valid values when filling a form):\n${options.testData.slice(0, 3000)}` : ''}`,
      system: buildSystemPrompt(url, options.credentials),
      tools: loopTools,
      toolContext,
      maxSteps: 28,
      temperature: 0.2,
    });

    const toolCalls = loop.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0);
    if (toolCalls === 0) {
      throw new Error('MCP inspector made no tool calls (provider did not deliver MCP tools) — falling back.');
    }

    // Final structured snapshot of wherever the model landed — this is the grounded page the
    // coder/verifier consume, in the SAME shape inspectApplicationFlow returns.
    const structured = await snapshotStructured(session);
    const blocked = /\bblocked\b|\bcould not\b|\bunable to\b|login is required/i.test(loop.finalText || '')
      && (structured.headings || []).length === 0;

    const assertionTargets = [
      ...(structured.headings || []).map((text: string) => ({ type: 'heading', text })),
      ...(structured.tables || []).map((t: any) => ({ type: 'table', label: t.label, headers: t.headers, rowCount: t.rowCount })),
    ].slice(0, 20);

    return {
      inspectionEngine: 'mcp',
      goalStatus: blocked ? 'blocked' : (loop.stoppedReason === 'max_steps' ? 'partial' : 'satisfied'),
      currentUrl: structured.url || url,
      pageSummary: String(structured.bodyText || '').slice(0, 1200),
      agentSummary: (loop.finalText || '').slice(0, 2000),
      visibleNavigation: [],
      visibleTables: structured.tables || [],
      visibleForms: structured.forms || [],
      assertionTargets,
      actionsTaken: [],
      observedPages: [],
      screenshots: [],
      warnings: [],
      toolLoop: { steps: loop.steps.length, stoppedReason: loop.stoppedReason, costUsd: loop.totalUsage.costUsd },
    };
  } finally {
    await closeMcpSession(session);
  }
}
