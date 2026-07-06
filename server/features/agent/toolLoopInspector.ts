/**
 * Tool-loop inspector (Option A): the model drives the live-page inspection itself via
 * observe_page / act_on_page in the native agent loop, instead of the fixed
 * navigate→login→planner pipeline. Self-correcting (a failed click returns the fresh
 * observation and the model retries differently), every LLM step is cost-tracked through
 * the orchestrator, and every action captures screenshot evidence.
 *
 * Enabled via INSPECTOR_TOOL_LOOP=true (or db.settings.inspectorToolLoop). Returns the
 * SAME result shape as inspectApplicationFlow so assessInspection and every downstream
 * consumer work unchanged; on any failure the caller falls back to the classic path.
 */

import { getToolCapableOrchestrator } from '../../ai/orchestrator';
import { pageTools } from '../../ai/tools/pageTools';
import type { ToolContext } from '../../ai/tools/types';
import { openPageSession, closePageSession, sessionArtifacts } from './pageSession';

const INSPECTOR_SYSTEM = `You inspect a live web application through two tools: observe_page (read the current page) and act_on_page (click / type / select by element id).

Goal: reach and fully OBSERVE the feature named in the task, so test cases can be grounded in what is really on the page.

Method:
1. Study the CURRENT observation first — elements, headings, tables, forms.
2. Navigate step by step toward the feature (menus, tabs, list rows). One action per step, always chosen from the LATEST observation's element ids.
3. When the feature is visible, drill INTO it: open its menus/panels/settings so hidden controls are revealed and observed. If the feature has a create/add or edit action, open that form ONCE and observe it so the input fields are captured. This is a TEST ENVIRONMENT — you MAY fill the form with the provided test data and submit it to observe the real result/validation, then continue. Still never delete existing records or perform other destructive actions unless the task explicitly asks.
4. Re-observe after anything unexpected. If an action fails, choose a different element — do not repeat the exact same failing action.
5. Never touch destructive controls (delete, remove, reset...) unless the task explicitly requires it.

Stop when the feature and its controls have been observed (or you are genuinely blocked), then answer with a short plain-text summary: what was reached, what is visible (key controls, tables, forms), and anything that blocked you. Do not fabricate anything you did not observe.`;

export async function inspectApplicationFlowViaTools(options: {
  targetUrl: string;
  prompt: string;
  credentials: any;
  runId: string;
  knowledge?: string;
  testData?: string;
  workspaceId?: string;
}) {
  const { sessionId } = await openPageSession({
    targetUrl: options.targetUrl,
    credentials: options.credentials,
    runId: options.runId,
  });

  try {
    const orch = await getToolCapableOrchestrator('appInspector', { workspaceId: options.workspaceId });
    const toolContext: ToolContext = {
      workspaceId: options.workspaceId,
      runId: options.runId,
      scratch: { pageSessionId: sessionId, inspectionIntent: options.prompt },
    };
    const loop = await orch.runToolLoop({
      task: `Inspect this application for the following testing goal, then summarize what you observed:\n${options.prompt}${options.knowledge ? `\n\nKnown app context:\n${options.knowledge.slice(0, 4000)}` : ''}${options.testData ? `\n\nTEST DATA (use these exact field api_names and valid values when filling a form):\n${options.testData.slice(0, 3000)}` : ''}`,
      system: INSPECTOR_SYSTEM,
      tools: pageTools,
      toolContext,
      maxSteps: 24,
      temperature: 0.2,
    });

    // GUARANTEE: if the model never actually invoked the page tools (e.g. the resolved provider
    // didn't deliver tool specs, so the loop dead-ended on step 1 claiming "tools not available"),
    // this path is worse than the classic inspector. Throw so inspectApplicationFlow falls back.
    const toolCalls = loop.steps.reduce((n, s) => n + (s.toolCalls?.length || 0), 0);
    if (toolCalls === 0) {
      throw new Error('tool-loop inspector made no tool calls (provider did not deliver page tools) — falling back to classic inspector.');
    }

    const art = sessionArtifacts(sessionId);
    const last = art?.lastRaw || {};

    // Union every interactive control seen across ALL observations (deepest last→first), the
    // same contract the classic inspector provides to the coder/verifier.
    const seen = new Set<string>();
    const unionActions: any[] = [];
    const pushUnion = (a: any) => {
      if (!a) return;
      const d = a.dom || a;
      const key = d?.testId || d?.id || d?.ariaLabel || d?.placeholder || `${a.role || ''}:${a.text || ''}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      unionActions.push(a);
    };
    for (const a of last.actions || []) pushUnion(a);
    for (let i = (art?.observedPages.length || 0) - 1; i >= 0; i -= 1) {
      for (const a of art?.observedPages[i]?.actions || []) pushUnion(a);
    }

    const assertionTargets = [
      ...(last.headings || []).map((text: string) => ({ type: 'heading', text })),
      ...(last.tables || []).map((t: any) => ({ type: 'table', label: t.label, headers: t.headers, rowCount: t.rowCount })),
      ...(last.listLikeRegions || []).map((r: any) => ({ type: 'list-region', label: r.label, text: r.text })),
    ].slice(0, 20);

    const blocked = /\bblocked\b|\bcould not\b|\bunable to\b/i.test(loop.finalText || '') && unionActions.length === 0;

    return {
      inspectionEngine: 'tool-loop',
      goalStatus: blocked ? 'blocked' : (loop.stoppedReason === 'max_steps' ? 'partial' : 'satisfied'),
      currentUrl: art?.currentUrl || '',
      pageSummary: String(last.bodyText || '').slice(0, 1200),
      agentSummary: (loop.finalText || '').slice(0, 2000),
      visibleNavigation: unionActions.slice(0, 150),
      visibleTables: last.tables || [],
      visibleForms: last.forms || [],
      assertionTargets,
      actionsTaken: art?.actionsTaken || [],
      observedPages: (art?.observedPages || []).map((p: any) => ({ stage: p.stage, url: p.url, headings: p.headings, actions: p.actions, forms: p.forms, tables: p.tables })),
      screenshots: art?.screenshots || [],
      warnings: [],
      toolLoop: { steps: loop.steps.length, stoppedReason: loop.stoppedReason, costUsd: loop.totalUsage.costUsd },
    };
  } finally {
    await closePageSession(sessionId);
  }
}
