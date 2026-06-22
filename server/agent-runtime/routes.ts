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
import { routeGoal } from './goals/router';
import type { RoutingContext, RouteTarget } from './goals/types';
import type { ChatTurn, SelectedApp } from '../ai/controller';
import { buildPlan } from '../ai/controller';
import { quickWorkspaceAnswer } from '../ai/tools/registry';
import { reqScope } from '../shared/scope';

interface GoalRequestBody {
  message?: string;
  history?: ChatTurn[];
  apps?: SelectedApp[];
  pageContext?: { path?: string };
  workspaceId?: string;
}

export function registerAgentRuntimeRoutes(app: Express) {
  app.post('/api/agent/goal', async (req, res, next) => {
    try {
      const body: GoalRequestBody = req.body || {};
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const scope = reqScope(req);
      const workspaceId = body.workspaceId || 'default';
      const history = Array.isArray(body.history) ? body.history : undefined;
      const apps = Array.isArray(body.apps) ? body.apps : undefined;

      // The deterministic router resolves a target from the selected apps; map the
      // client's {name, baseUrl} shape onto the router's RouteTarget {name, url}.
      const selectedApps: RouteTarget[] = (apps || [])
        .filter((a) => a && (a.baseUrl || a.name))
        .map((a) => ({ name: a.name || undefined, url: a.baseUrl || undefined }));
      const ctx: RoutingContext = { selectedApps, conversationTarget: null };

      const { route } = await routeGoal(
        { message, history, apps, workspaceId, userId: scope.userId },
        ctx,
      );

      switch (route.kind) {
        case 'answer': {
          // FAST PATH: questions about the user's OWN QA artifacts (counts/lists of test cases,
          // suites, plans, runs, …) answer instantly from workspace data.
          const quick = await quickWorkspaceAnswer(message, {
            userId: scope.userId,
            projectId: scope.projectId,
            appId: scope.appId,
          });
          if (quick) {
            return res.json({ kind: 'answer', reply: quick, route, source: 'workspace' });
          }
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
  });
}
