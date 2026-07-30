/**
 * The single backend dispatcher for the unified agent router ("Strike 1").
 *
 * POST /api/agent/goal runs the ONE typed routing decision (routeGoal) and maps
 * the resulting Route.kind to a typed JSON response. This endpoint is ADDITIVE:
 * it does NOT execute deep runs (the existing /api/agent/start does) or perform
 * heavy code analysis (the existing git-agent route / client does). For action
 * routes it returns the DECISION so the client can call the existing endpoint.
 *
 * Answer / clarify / workspace_action are resolved here by delegating to the
 * existing handlers, since they are cheap and already grounded.
 */

import type { Express } from 'express';
import { randomUUID } from 'crypto';
import { routeGoal } from './goals/router';
import type { CapabilityShadowRecord, RouteKind, RoutingContext, RouteTarget } from './goals/types';
import { routeTurn, capabilityToLegacyRouteKind } from '../../services/runtime/src/application/routeTurn';
import type { ChatTurn, SelectedApp } from '../ai/controller';
import { buildPlan } from '../ai/controller';
import { quickWorkspaceAnswer } from '../ai/tools/registry';
import { agentSetupReadiness } from '../features/agent/setupReadiness';
import { reqScope } from '../shared/scope';
import { listApps } from '../features/projects/projectService';

interface GoalRequestBody {
  message?: string;
  history?: ChatTurn[];
  apps?: SelectedApp[];
  pageContext?: { path?: string };
  workspaceId?: string;
  /** Authoritative conversation link (Phase 3) — enables session-aware routing/shadow. */
  conversationId?: string;
}

/** CONVERSATIONAL_ROUTER_SHADOW (default on): record capability decisions beside legacy routing. */
function shadowRouterEnabled(): boolean {
  return String(process.env.CONVERSATIONAL_ROUTER_SHADOW ?? 'true').toLowerCase() !== 'false';
}

/** Ring buffer of recent shadow comparisons (diagnostics; no extra LLM call, plan §22.3). */
export const capabilityShadowLog: CapabilityShadowRecord[] = [];

function recordCapabilityShadow(input: {
  conversationId: string; message: string; legacyKind: RouteKind;
  scope: { workspaceId: string; ownerId: string; projectId?: string | null; appId?: string | null };
}): void {
  if (!shadowRouterEnabled()) return;
  void routeTurn({
    conversationId: input.conversationId,
    message: input.message,
    scope: { workspaceId: input.scope.workspaceId, ownerId: input.scope.ownerId, projectId: input.scope.projectId, appId: input.scope.appId },
    mode: 'shadow',
  }).then(({ decision }) => {
    const mapped = capabilityToLegacyRouteKind(decision);
    const rec: CapabilityShadowRecord = {
      conversationId: input.conversationId,
      message: input.message.slice(0, 200),
      legacyKind: input.legacyKind,
      capability: decision.capability,
      interaction: decision.interaction,
      mappedLegacyKind: mapped,
      agreed: mapped === input.legacyKind,
      resolvedEntityIds: decision.resolvedEntities.map((e) => e.id).slice(0, 10),
      missing: decision.missing.map((m) => m.reason),
      at: new Date().toISOString(),
    };
    capabilityShadowLog.push(rec);
    if (capabilityShadowLog.length > 200) capabilityShadowLog.splice(0, capabilityShadowLog.length - 200);
    console.log(`[capability-shadow] legacy=${rec.legacyKind} capability=${rec.capability}/${rec.interaction} agreed=${rec.agreed}${rec.missing.length ? ` missing=${rec.missing.join('; ')}` : ''}`);
  }).catch((err) => console.warn('[capability-shadow] failed:', err?.message || err));
}

/** A response destination the router logic writes to — real Express res in the sync path, a collector in the
 * durable-job path. Lets the SAME branch logic serve both without duplication. */
interface GoalSink {
  status(code: number): GoalSink;
  json(payload: unknown): unknown;
}

export function registerAgentRuntimeRoutes(app: Express) {
  // Durable router jobs (mirrors the understanding-job pattern): the router's typed decision runs a model
  // call that can be slow, and a single long HTTP request dies when the tab is backgrounded / a proxy times
  // out — so "Routing request to the right agent…" silently stopped. Run it as a background job the client
  // polls with SHORT requests, keyed by conversation so a returning client re-attaches instead of losing it.
  const routerJobs = new Map<string, { status: 'running' | 'done'; result?: { status: number; payload: any }; createdAt: number; conversationId?: string; ownerId?: string }>();
  const ROUTER_JOB_TTL_MS = 30 * 60 * 1000;
  const pruneRouterJobs = () => {
    const cutoff = Date.now() - ROUTER_JOB_TTL_MS;
    for (const [id, job] of routerJobs) if (job.createdAt < cutoff) routerJobs.delete(id);
  };

  // The router decision logic, unchanged — writes its single JSON response to the provided sink.
  async function goalCore(body: GoalRequestBody, scope: ReturnType<typeof reqScope>, res: GoalSink, next: (err?: any) => void): Promise<unknown> {
    try {
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      // Fail fast when the workspace isn't set up (no LLM / no target URL+credentials / no project):
      // return one friendly answer turn with the exact setup steps instead of starting work that
      // spins then fails, or silently degrades to a heuristic/canned response. Every Agent Console
      // action routes through here first, so this single gate covers chat, deep runs, and drafts.
      const readiness = agentSetupReadiness(scope);
      if (!readiness.ready) {
        return res.json({ kind: 'answer', reply: readiness.message, route: { kind: 'answer', reason: `setup incomplete: ${readiness.missing.join(', ')}` }, source: 'setup' });
      }
      const workspaceId = body.workspaceId || 'default';
      const history = Array.isArray(body.history) ? body.history : undefined;
      const apps = Array.isArray(body.apps) ? body.apps : undefined;

      // The deterministic router resolves a target from the selected apps; map the
      // client's {name, baseUrl} shape onto the router's RouteTarget {name, url}.
      const selectedApps: RouteTarget[] = (apps || [])
        .filter((a) => a && (a.baseUrl || a.name))
        .map((a) => ({ name: a.name || undefined, url: a.baseUrl || undefined }));
      const availableApps: RouteTarget[] = (scope.projectId ? listApps(scope.projectId) : [])
        .filter((a) => a && (a.baseUrl || a.name))
        .map((a) => ({ name: a.name || undefined, url: a.baseUrl || undefined }));
      const ctx: RoutingContext = { selectedApps, availableApps, conversationTarget: null };

      const { route } = await routeGoal(
        { message, history, apps, workspaceId, userId: scope.userId },
        ctx,
      );

      // Read-only workspace count/list requests win over a model action label.
      // The helper returns null before touching storage for non-workspace messages.
      const quickWorkspace = await quickWorkspaceAnswer(message, {
        userId: scope.userId,
        projectId: scope.projectId,
        appId: scope.appId,
      });
      if (quickWorkspace) {
        return res.json({
          kind: 'answer',
          reply: quickWorkspace,
          route: { ...route, kind: 'answer', reason: 'read-only workspace query' },
          source: 'workspace',
        });
      }


      // Option A: an explicit request to GENERATE/CREATE/WRITE test cases for a feature is an
      // ACTION — it must run the deep pipeline (which previews the coverage areas, then generates
      // cases for review with an optional continue-to-execution), NOT be answered as a chat question
      // with a terse "Created N cases" summary. This holds even when politely phrased "can you …?".
      // Info questions ABOUT existing cases ("how many cases do I have", "list my cases") are excluded.
      // A leading imperative "test/cover/automate <feature>" ("test the list view end to end") is a
      // case-generation request even without the words "test cases" — it must reach the generate flow (with
      // its review gate), not dead-end as an informational answer. Result/status talk ("test failed", "why…")
      // is excluded so it stays a question.
      const imperativeTestFeature =
        /^(?:\s*(?:please|can you|could you|pls|hey)[\s,]+)?(test|cover|automate)\b/i.test(message.trim())
        && /\b(view|views|page|pages|screen|screens|flow|flows|feature|features|module|modules|list|form|forms|workflow|tab|grid|dashboard|end[\s-]to[\s-]end|e2e|creation|functionality|button|field)\b/i.test(message)
        && !/\b(failed|passed|error|errors|why|how|status|result|results|did it|is it)\b/i.test(message);
      const wantsCaseGen =
        (/\b(generate|create|write|draft|author|add|build|make)\b[\s\S]{0,40}\b(test\s*cases?|cases?|coverage|scenarios?)\b/i.test(message)
          || imperativeTestFeature)
        // Exclude info questions ABOUT existing artifacts. "list" must be followed by an artifact
        // word ("list my cases") so it does NOT swallow "list view" in a real generation request.
        && !(/\b(how many|how much|do (?:we|i) have|which cases|what cases|count)\b/i.test(message)
          || /\b(?:list|show(?:\s+me)?)\s+(?:(?:my|the|all|our)\s+)?(?:test\s+)?(?:cases?|suites?|plans?|runs?|scripts?)\b/i.test(message));
      // Intercept answer/workspace_action AND requirement_draft: the LLM router sometimes classifies
      // a clear "write test cases for X" as requirement_draft (the words "write"/"feature" tip it that
      // way), which then silently drafts a codebase requirement on the wrong feature. wantsCaseGen only
      // matches messages that explicitly ask for test cases/coverage/scenarios, so a genuine
      // "create a requirement for X" (no "cases") is never caught here.
      if (wantsCaseGen && (route.kind === 'answer' || route.kind === 'workspace_action' || route.kind === 'requirement_draft')) {
        const hasTarget = !!(route.target?.url || route.target?.name || selectedApps.some((a) => a.url || a.name));
        if (hasTarget) {
          route.kind = 'generate_cases';
        } else if (availableApps.length) {
          // No app resolved but the project HAS apps — ASK which one (deterministic), instead of
          // silently drafting a codebase-only requirement that can drift to the wrong feature. This
          // makes "write test cases for X" behave the same regardless of the LLM's answer/action call.
          const names = [...new Set(availableApps.map((a) => a.name).filter(Boolean))];
          route.kind = 'clarify';
          (route as any).clarifyingQuestion = names.length
            ? `Which app should I generate these test cases for? ${names.join(' · ')}`
            : 'Which app should I generate these test cases for? Pick one in the top-bar app switcher (or the "Apps to test" picker).';
        } else {
          // No app resolvable at all — a clear "write test cases" request must NEVER silently become a
          // codebase requirement draft (which drifts to the wrong feature). Ask for the app/URL instead.
          route.kind = 'clarify';
          (route as any).clarifyingQuestion = 'Which app should I generate these test cases for? Select one in the top-bar app switcher or the "Apps to test" picker, or paste the app URL.';
        }
      }

      // Phase 3 shadow: compare the deterministic capability decision against the FINAL
      // legacy route (fire-and-forget — never blocks or changes this response).
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
      if (conversationId) {
        recordCapabilityShadow({
          conversationId, message, legacyKind: route.kind,
          scope: { workspaceId, ownerId: scope.userId || '', projectId: scope.projectId, appId: scope.appId },
        });
      }

      switch (route.kind) {
        case 'answer': {
          // Do NOT block this routing call on the deep code answer: the adaptive exploration can
          // run for minutes (especially for broad questions) and would time the request out — the
          // bug behind "Sorry, I could not process that request". Return the 'answer' decision with
          // NO reply so the client STREAMS the answer via the supervisor (live progress, no timeout).
          return res.json({ kind: 'answer', route });
        }

        case 'clarify': {
          return res.json({ kind: 'clarify', reply: route.clarifyingQuestion, route });
        }

        case 'workspace_action': {
          const plan = await buildPlan({
            userMessage: message,
            workspaceId,
            userId: scope.userId,
            history,
            apps,
            pageContext: body.pageContext as any,
          });
          return res.json({ kind: 'workspace_action', plan, route });
        }

        case 'code_analysis': {
          // Decision only — the existing git-agent route / client runs the analysis.
          return res.json({ kind: 'code_analysis', route, scope: route.scope });
        }

        case 'generate_cases':
        case 'deep_test_run': {
          // Decision only — the existing /api/agent/start endpoint performs execution.
          return res.json({
            kind: route.kind,
            target: route.target,
            scope: route.scope,
            execute: route.kind === 'deep_test_run',
            route,
          });
        }

        case 'requirement_draft': {
          // Decision only — the frontend calls /api/requirements/draft/stream.
          return res.json({ kind: 'requirement_draft', scope: route.scope, route });
        }

        default: {
          // Exhaustive guard: any unexpected kind is surfaced rather than swallowed.
          return res.json({ kind: route.kind, route });
        }
      }
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }

  /** Run goalCore against an in-memory collector so its single JSON response is captured as {status,payload}. */
  async function runGoalToResult(body: GoalRequestBody, scope: ReturnType<typeof reqScope>): Promise<{ status: number; payload: any }> {
    return await new Promise((resolve) => {
      let settled = false;
      let statusCode = 200;
      const done = (r: { status: number; payload: any }) => { if (!settled) { settled = true; resolve(r); } };
      const sink: GoalSink = {
        status(code: number) { statusCode = code; return sink; },
        json(payload: unknown) { done({ status: statusCode, payload }); return payload; },
      };
      goalCore(body, scope, sink, (err?: any) => done({ status: err?.status || 500, payload: { error: err?.message || 'Routing failed.' } }))
        .catch((err: any) => done({ status: err?.status || 500, payload: { error: err?.message || 'Routing failed.' } }));
    });
  }

  // Durable router: start a background job and return its id immediately. The job runs to completion regardless
  // of the client's tab focus, so backgrounding the tab (or a proxy idle-timeout) can no longer kill routing.
  app.post('/api/agent/goal', async (req, res, next) => {
    try {
      const body: GoalRequestBody = req.body || {};
      if (!(typeof body.message === 'string' && body.message.trim())) {
        return res.status(400).json({ error: 'message is required' });
      }
      const scope = reqScope(req);
      pruneRouterJobs();
      const jobId = randomUUID();
      routerJobs.set(jobId, {
        status: 'running', createdAt: Date.now(),
        conversationId: String(body.conversationId || '').trim() || undefined,
        ownerId: scope.userId || undefined,
      });
      runGoalToResult(body, scope).then((result) => {
        const job = routerJobs.get(jobId);
        if (job) { job.status = 'done'; job.result = result; }
      });
      res.json({ job_id: jobId });
    } catch (err) {
      next(err);
    }
  });

  // Poll a router job. Short request → immune to tab-backgrounding/proxy idle-timeouts.
  app.get('/api/agent/goal/:jobId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = routerJobs.get(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Unknown or expired routing job.' });
    if (job.status !== 'done' || !job.result) return res.json({ status: 'running' });
    res.json({ status: 'done', http: job.result.status, result: job.result.payload });
  });

  // Re-attach after a navigate-away: the latest router job for this conversation (owned by the caller).
  app.get('/api/agent/goal/for-conversation/:conversationId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    pruneRouterJobs();
    const conversationId = String(req.params.conversationId || '').trim();
    const ownerId = reqScope(req).userId || '';
    if (!conversationId) return res.json({ job: null });
    let latest: { jobId: string; job: any } | null = null;
    for (const [jobId, job] of routerJobs) {
      if (job.conversationId !== conversationId) continue;
      if (ownerId && job.ownerId && job.ownerId !== ownerId) continue;
      if (!latest || job.createdAt > latest.job.createdAt) latest = { jobId, job };
    }
    if (!latest) return res.json({ job: null });
    res.json({ job: { jobId: latest.jobId, status: latest.job.status, http: latest.job.result?.status ?? null, result: latest.job.result?.payload ?? null } });
  });
}
