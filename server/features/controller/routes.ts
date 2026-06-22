import type { Express } from 'express';
import { buildPlan, cancelPlan, classifyIntent, executePlan, explainIntent, streamExplain, getPlan, listPlans, getControllerMemory, clearControllerMemory } from '../../ai/controller';
import { runSupervisor, answerAppQuestionFromCode } from '../../ai/supervisor';
import { quickWorkspaceAnswer } from '../../ai/tools/registry';
import { reqScope } from '../../shared/scope';

// An action request mutates/creates/runs something → needs the full tool loop. A plain
// question can be answered with the FAST single-call git-grounded path.
const ACTION_RE = /\b(generate|create|write|build|make|run|execute|file\s+(a|the)|add|move|organi[sz]e|re-?run|delete|remove|update|edit|set\s|navigate|open|go\s+to|triage|expand|rework|schedule)\b/i;
import { INTENT_LABELS, type IntentKind, type Plan, type PlanStep } from '../../ai/intents';

function prepareStreamingResponse(res: any) {
  // text/event-stream discourages buffering in production proxies/CDNs even though
  // the client still consumes raw chunks with fetch().getReader().
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
}

export function registerControllerRoutes(app: Express) {
  app.get('/api/controller/intents', (req, res) => {
    res.json({
      labels: INTENT_LABELS,
      kinds: Object.keys(INTENT_LABELS),
    });
  });

  app.post('/api/controller/classify', async (req, res, next) => {
    try {
      const { userMessage, pageContext, workspaceId, userId, history, apps } = req.body || {};
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const result = await classifyIntent({ userMessage, pageContext, workspaceId, userId, history, apps });
      res.json(result);
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  app.post('/api/controller/plan', async (req, res, next) => {
    try {
      const { userMessage, pageContext, workspaceId, userId, history, apps } = req.body || {};
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const plan = await buildPlan({ userMessage, pageContext, workspaceId, userId, history, apps });
      res.json(plan);
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  // SupervisorAgent: dynamic tool-selecting orchestration (retires the static switch).
  // The model chooses + executes capabilities in a loop until the goal is met.
  app.post('/api/controller/supervise', async (req, res, next) => {
    try {
      const { userMessage, workspaceId, userId, history, pageContext, apps } = req.body || {};
      const scope = reqScope(req);
      const effectiveUserId = scope.userId || userId;
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      // FAST PATH 1: simple count/list questions answered straight from the DB (no LLM).
      const quick = await quickWorkspaceAnswer(userMessage, effectiveUserId);
      if (quick) {
        return res.json({ reply: quick, accepted: true, fast: true, actions: [], trace: [] });
      }
      // FAST PATH 2: app-knowledge QUESTIONS get a single git-grounded LLM call (retrieval
      // done deterministically), instead of the slow multi-step tool loop.
      if (!ACTION_RE.test(userMessage)) {
        const reply = await answerAppQuestionFromCode(userMessage, {
          workspaceId,
          userId: effectiveUserId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
        });
        return res.json({ reply, accepted: true, fast: true, actions: [{ tool: 'search_codebase', arguments: {} }], trace: [] });
      }
      const result = await runSupervisor({
        userMessage,
        workspaceId,
        userId: effectiveUserId,
        projectId: scope.projectId,
        appId: scope.appId,
        history,
        pageContext,
        apps,
      });
      res.json({
        reply: result.finalText,
        accepted: result.accepted,
        actions: result.toolResults.map((t) => ({ tool: t.name, arguments: t.arguments })),
        trace: result.steps.map((s) => ({
          index: s.index,
          text: s.text,
          toolCalls: s.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, error: c.error, ms: c.ms })),
        })),
      });
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // Streaming Supervisor: emits one JSON line per agent step (tool calls as they happen)
  // so the chat can show LIVE activity ("Searching the codebase for …", "Reading …"),
  // then a final line with the answer. Mirrors the /explain/stream pattern.
  app.post('/api/controller/supervise/stream', async (req, res) => {
    const { userMessage, workspaceId, userId, history, pageContext, apps } = req.body || {};
    const scope = reqScope(req);
    const effectiveUserId = scope.userId || userId;
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'userMessage is required' });
    }
    prepareStreamingResponse(res);
    const send = (obj: any) => { try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ } };
    try {
      send({ type: 'step', index: 0, text: 'Starting...', toolCalls: [] });
      // Instant path: simple count/list answered from the DB, no steps.
      const quick = await quickWorkspaceAnswer(userMessage, effectiveUserId);
      if (quick) { send({ type: 'final', reply: quick, fast: true }); return res.end(); }
      // Fast git-grounded path for app-knowledge QUESTIONS: ONE LLM call after deterministic
      // retrieval. Emits the search/read progress so the UI still animates the live steps.
      if (!ACTION_RE.test(userMessage)) {
        let i = 0;
        const reply = await answerAppQuestionFromCode(userMessage, {
          workspaceId,
          userId: effectiveUserId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
          onProgress: (label) => send({ type: 'step', index: i++, toolCalls: [{ name: /reading/i.test(label) ? 'read_code_file' : 'search_codebase', arguments: {} }], text: label }),
        });
        send({ type: 'final', reply, fast: true });
        return res.end();
      }
      const result = await runSupervisor({
        userMessage,
        workspaceId,
        userId: effectiveUserId,
        projectId: scope.projectId,
        appId: scope.appId,
        history,
        pageContext,
        apps,
        onStep: (s) => send({
          type: 'step',
          index: s.index,
          text: s.text,
          toolCalls: s.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, error: c.error })),
        }),
      });
      send({ type: 'final', reply: result.finalText, accepted: result.accepted });
    } catch (err: any) {
      send({ type: 'error', error: err?.message || 'supervisor failed' });
    } finally {
      res.end();
    }
  });

  app.get('/api/controller/plans', (req, res) => {
    const workspaceId = String((req.query.workspaceId as string) || 'default');
    res.json({ plans: listPlans(workspaceId) });
  });

  app.get('/api/controller/plans/:id', (req, res) => {
    const plan = getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  });

  app.post('/api/controller/plans/:id/execute', async (req, res, next) => {
    try {
      const { approveAll, stepId } = req.body || {};
      const plan = getPlan(req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (stepId) {
        const step = plan.steps.find((s: PlanStep) => s.id === stepId);
        if (!step) return res.status(404).json({ error: 'Step not found' });
        step.status = 'running';
      }
      const result = await executePlan(req.params.id, { approveAll: !!approveAll });
      res.json(result);
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  app.post('/api/controller/plans/:id/cancel', (req, res) => {
    const plan = cancelPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
  });

  app.post('/api/controller/explain/stream', async (req, res) => {
    const { topic, workspaceId, userId, history, apps } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic is required' });
    }
    prepareStreamingResponse(res);
    try {
      res.write('\n');
      for await (const delta of streamExplain(topic, { workspaceId, userId, history, apps })) {
        res.write(delta);
      }
    } catch (err: any) {
      res.write(`\n[error] ${err?.message || 'stream failed'}`);
    } finally {
      res.end();
    }
  });

  app.post('/api/controller/explain', async (req, res, next) => {
    try {
      const { topic, workspaceId, userId, history, apps } = req.body || {};
      if (!topic || typeof topic !== 'string') {
        return res.status(400).json({ error: 'topic is required' });
      }
      const text = await explainIntent(topic, { workspaceId, userId, history, apps });
      res.json({ topic, answer: text });
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  app.get('/api/controller/memory', (req, res) => {
    res.json({ memory: getControllerMemory() });
  });

  app.delete('/api/controller/memory', (req, res) => {
    clearControllerMemory();
    res.json({ ok: true });
  });
}
