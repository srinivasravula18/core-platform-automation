import type { Express } from 'express';
import { buildPlan, cancelPlan, classifyIntent, executePlan, explainIntent, getPlan, listPlans, getControllerMemory, clearControllerMemory } from '../../ai/controller';
import { INTENT_LABELS, type IntentKind, type Plan, type PlanStep } from '../../ai/intents';

export function registerControllerRoutes(app: Express) {
  app.get('/api/controller/intents', (req, res) => {
    res.json({
      labels: INTENT_LABELS,
      kinds: Object.keys(INTENT_LABELS),
    });
  });

  app.post('/api/controller/classify', async (req, res, next) => {
    try {
      const { userMessage, pageContext, workspaceId, userId } = req.body || {};
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const result = await classifyIntent({ userMessage, pageContext, workspaceId, userId });
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
      const { userMessage, pageContext, workspaceId, userId } = req.body || {};
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const plan = await buildPlan({ userMessage, pageContext, workspaceId, userId });
      res.json(plan);
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
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

  app.post('/api/controller/explain', async (req, res, next) => {
    try {
      const { topic, workspaceId, userId } = req.body || {};
      if (!topic || typeof topic !== 'string') {
        return res.status(400).json({ error: 'topic is required' });
      }
      const text = await explainIntent(topic, { workspaceId, userId });
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
