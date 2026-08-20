import type { Express } from 'express';
import { buildPlan, cancelPlan, classifyIntent, executePlan, explainIntent, streamExplain, getPlan, listPlans } from '../../ai/controller';
import { runSupervisor } from '../../ai/supervisor';
import { reqScope } from '../../shared/scope';
import { normalizeInput, preLLMPolicyCheck } from '../../ai/guardrails';
import { ChatConversations } from '../../db/repository';
import { quickWorkspaceAnswer } from '../../ai/tools/registry';
import { quickUrlHealthAnswer, urlHealthTool } from '../../agent-core/registry/urlHealthTool';
import { shouldPrepareTestScope, shouldUseConversationalFastPath } from '../../agent-runtime/goals/router';

async function persistExchange(conversationId: unknown, workspaceId: unknown, userMessage: string, reply: string, scope?: { userId?: string; projectId?: string; appId?: string | null }) {
  if (typeof conversationId !== 'string' || !conversationId) return;
  // Store the conversation under the SAME workspace key the console's history list queries —
  // `${projectId||'none'}::${appId||'all'}` (see scopeWorkspaceId in the Agent Console). The body
  // `workspaceId` is a hardcoded 'default' used only for agent memory, so relying on it stored chats
  // under 'default' where the project-scoped history never found them. Derive from scope instead.
  const convWorkspace = scope
    ? `${scope.projectId || 'none'}::${scope.appId || 'all'}`
    : (typeof workspaceId === 'string' ? workspaceId : 'default');
  await ChatConversations.appendMessages({
    id: conversationId,
    workspaceId: convWorkspace,
    title: userMessage.slice(0, 120),
    messages: [{ role: 'user', text: userMessage }, { role: 'assistant', kind: 'text', text: reply }],
    // Stamp ownership so the conversation belongs to the sender — otherwise it is created unowned
    // and, under strict per-user history isolation, a tester never sees their own chats.
    ownerId: scope?.userId,
    projectId: scope?.projectId,
    appId: scope?.appId || undefined,
  });
}

// Deterministic small-talk shortcut: greetings ("hi", "hloo"), thanks, farewells, and identity
// questions get an instant canned reply with NO LLM call. The console's chat path did not run the
// guardrail, so these went to the model — which then rambled about its own greeting-classification
// rules ("hloo is not recognized as an instant greeting… counts against the usage budget") instead
// of just answering. Returns the canned reply, or null to proceed to the normal flow.
function smallTalkReply(userMessage: string, history: unknown, conversationId: unknown): string | null {
  const normalized = normalizeInput(userMessage).value;
  const verdict = preLLMPolicyCheck(
    {
      agent: 'chatAssistant' as any,
      userMessage,
      requestId: typeof conversationId === 'string' ? conversationId : 'controller',
      hasHistory: Array.isArray(history) && history.length > 0,
    },
    normalized,
  );
  return verdict.kind === 'respond' ? verdict.reply : null;
}

async function deterministicReply(
  userMessage: string,
  history: unknown,
  conversationId: unknown,
  scope: { userId?: string; projectId?: string; appId?: string | null },
  apps?: Array<{ name?: string; baseUrl?: string }>,
): Promise<{ reply: string; source: string; actions?: Array<{ tool: string; arguments: Record<string, unknown>; result: unknown }> } | null> {
  const smallTalk = smallTalkReply(userMessage, history, conversationId);
  if (smallTalk) return { reply: smallTalk, source: 'small-talk' };
  const workspace = await quickWorkspaceAnswer(userMessage, scope);
  if (workspace) return { reply: workspace, source: 'workspace' };
  const health = await quickUrlHealthAnswer(userMessage, { ...scope, userMessage });
  if (health) return { reply: health, source: 'url-health' };
  const targetUrl = String(apps?.find((app) => app?.baseUrl)?.baseUrl || '').trim();
  if (targetUrl && shouldPrepareTestScope(userMessage)) {
    const checked: any = await urlHealthTool.execute({ url: targetUrl }, { ...scope, userMessage });
    const checkedAction = { tool: 'check_url', arguments: { url: targetUrl }, result: checked };
    if (!checked?.ok) return { reply: `Cannot test ${targetUrl}: ${checked?.meaning || checked?.error || 'the target is unavailable'}.`, source: 'url-health', actions: [checkedAction] };
    const prepared = { scope: userMessage, targetUrl };
    return {
      reply: `The target is reachable. Preparing the reviewed test scope for ${targetUrl}.`,
      source: 'test-scope',
      actions: [checkedAction, { tool: 'prepare_test_scope', arguments: prepared, result: prepared }],
    };
  }
  return null;
}

import { INTENT_LABELS, type IntentKind, type Plan, type PlanStep } from '../../ai/intents';

/**
 * Anti-buffering pad. A reverse proxy that ignores X-Accel-Buffering (forced
 * proxy_buffering, proxy_ignore_headers, some LBs) holds small writes until its
 * ~4-8KB upstream buffer fills — live progress then arrives all at once at the
 * end, which is exactly the "streaming works locally but not deployed" failure.
 * Padding each event with an SSE comment line (clients ignore ':' lines; ours
 * JSON.parse-and-skip them) fills that buffer immediately so every event is
 * flushed through even a misconfigured proxy. ~4KB per event is negligible here.
 */
const STREAM_PROXY_PAD = `: ${' '.repeat(4096)}\n\n`;

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
  // Prime the proxy buffer so the FIRST real event isn't held back either.
  try { res.write(STREAM_PROXY_PAD); } catch { /* client gone */ }
}

function flushStream(res: any) {
  try { res.flush?.(); } catch { /* compression flush is best-effort */ }
}

function startStreamHeartbeat(res: any, send: (obj: any) => void) {
  return setInterval(() => {
    send({ type: 'heartbeat', at: Date.now() });
    flushStream(res);
  }, 10000);
}

async function sendFinalReply(
  res: any,
  send: (obj: any) => void,
  reply: string,
  extra: Record<string, unknown> = {},
) {
  const full = String(reply || '');
  const tokens = full.match(/\S+\s*/g) || (full ? [full] : []);
  let buf = '';
  for (let i = 0; i < tokens.length; i += 1) {
    buf += tokens[i];
    if ((i + 1) % 5 === 0) {
      send({ type: 'answer_delta', delta: buf });
      flushStream(res);
      buf = '';
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  }
  if (buf) {
    send({ type: 'answer_delta', delta: buf });
    flushStream(res);
  }
  send({ type: 'final', reply: full, ...extra });
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
      const scope = reqScope(req);
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const result = await classifyIntent({
        userMessage,
        pageContext,
        workspaceId,
        userId: scope.userId || userId,
        projectId: scope.projectId,
        appId: scope.appId,
        history,
        apps,
      });
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
      const scope = reqScope(req);
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      const plan = await buildPlan({
        userMessage,
        pageContext,
        workspaceId,
        userId: scope.userId || userId,
        projectId: scope.projectId,
        appId: scope.appId,
        history,
        apps,
      });
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
      const { userMessage, workspaceId, userId, conversationId, history, pageContext, apps, model, effort } = req.body || {};
      const scope = reqScope(req);
      const effectiveUserId = scope.userId || userId;
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      // Instant small-talk shortcut (greeting/thanks/farewell/identity) — no LLM call.
      const quick = await deterministicReply(userMessage, history, conversationId, scope, apps);
      if (quick) {
        await persistExchange(conversationId, workspaceId, userMessage, quick.reply, scope);
        return res.json({ reply: quick.reply, accepted: true, fast: true, source: quick.source, actions: quick.actions || [], trace: [] });
      }
      const priorTurns = Array.isArray(history) && history.some((turn: any) => turn?.role === 'assistant');
      const useFastPath = shouldUseConversationalFastPath(userMessage, { hasPriorTurns: priorTurns });
      console.log(`[routing] ${conversationId || '(no conversation)'} -> ${useFastPath ? 'fast (no tools)' : 'grounded'} (priorTurns=${priorTurns})`);
      if (useFastPath) {
        const reply = await explainIntent(userMessage, {
          workspaceId, userId: effectiveUserId, projectId: scope.projectId, appId: scope.appId,
          conversationId, history, apps, model, effort,
        });
        await persistExchange(conversationId, workspaceId, userMessage, reply, scope);
        return res.json({ reply, accepted: true, fast: true, source: 'codex-sdk', actions: [], trace: [] });
      }
      // Requests that need product evidence or actions retain the scoped Supervisor tool loop.
      const result = await runSupervisor({
        userMessage,
        workspaceId,
        userId: effectiveUserId,
        projectId: scope.projectId,
        appId: scope.appId,
        conversationId,
        history,
        pageContext,
        apps,
        model,
        effort,
      });
      await persistExchange(conversationId, workspaceId, userMessage, result.finalText, scope);
      res.json({
        reply: result.finalText,
        accepted: result.accepted,
        usage: result.usage,
        actions: result.toolResults.map((t) => ({ tool: t.name, arguments: t.arguments, result: t.result })),
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
    const { userMessage, workspaceId, userId, conversationId, history, pageContext, apps, model, effort } = req.body || {};
    const scope = reqScope(req);
    const effectiveUserId = scope.userId || userId;
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'userMessage is required' });
    }
    prepareStreamingResponse(res);
    const abort = new AbortController();
    const abortOnClose = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', abortOnClose);
    const send = (obj: any) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n${STREAM_PROXY_PAD}`); } catch { /* client gone */ } };
    const heartbeat = startStreamHeartbeat(res, send);
    try {
      send({ type: 'step', index: 0, text: 'Starting...', toolCalls: [] });
      flushStream(res);
      // Instant small-talk shortcut (greeting/thanks/farewell/identity) — no LLM call.
      const quick = await deterministicReply(userMessage, history, conversationId, scope, apps);
      if (quick) {
        await persistExchange(conversationId, workspaceId, userMessage, quick.reply, scope);
        await sendFinalReply(res, send, quick.reply, { accepted: true, fast: true, source: quick.source, actions: quick.actions || [] });
        return res.end();
      }
      // A follow-up must not silently lose the tools the first turn had — see the two-turn forensic.
      const hasPriorTurns = Array.isArray(history) && history.some((turn: any) => turn?.role === 'assistant');
      const fastPath = shouldUseConversationalFastPath(userMessage, { hasPriorTurns });
      console.log(`[routing] ${conversationId || '(no conversation)'} -> ${fastPath ? 'fast (no tools)' : 'grounded'} (priorTurns=${hasPriorTurns})`);
      if (fastPath) {
        let reply = '';
        for await (const delta of streamExplain(userMessage, {
          workspaceId, userId: effectiveUserId, projectId: scope.projectId, appId: scope.appId,
          conversationId, history, apps, model, effort, signal: abort.signal,
        })) {
          reply += delta;
          send({ type: 'answer_delta', delta });
          flushStream(res);
        }
        reply = reply.trim() || 'No answer available.';
        await persistExchange(conversationId, workspaceId, userMessage, reply, scope);
        send({ type: 'final', reply, accepted: true, fast: true, source: 'codex-sdk' });
        return res.end();
      }
      // Grounded/action path: emit tool progress and native answer deltas as they arrive.
      let streamedReply = '';
      const result = await runSupervisor({
        userMessage,
        workspaceId,
        userId: effectiveUserId,
        projectId: scope.projectId,
        appId: scope.appId,
        conversationId,
        history,
        pageContext,
        apps,
        model,
        effort,
        onStep: (s) => {
          send({
            type: 'step',
            index: s.index,
            text: s.text,
            toolCalls: s.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, error: c.error })),
          });
          flushStream(res);
        },
        onTextDelta: (delta) => {
          streamedReply += delta;
          send({ type: 'answer_delta', delta });
          flushStream(res);
        },
        signal: abort.signal,
      });
      await persistExchange(conversationId, workspaceId, userMessage, result.finalText, scope);
      const final = {
        accepted: result.accepted,
        usage: result.usage,
        actions: result.toolResults.map((tool) => ({ tool: tool.name, arguments: tool.arguments, result: tool.result })),
      };
      if (streamedReply) send({ type: 'final', reply: result.finalText, ...final });
      else await sendFinalReply(res, send, result.finalText, final);
    } catch (err: any) {
      if (!abort.signal.aborted) send({ type: 'error', error: err?.message || 'supervisor failed' });
    } finally {
      clearInterval(heartbeat);
      res.off('close', abortOnClose);
      res.end();
    }
  });

  app.get('/api/controller/plans', async (req, res, next) => {
    try {
    const workspaceId = String((req.query.workspaceId as string) || 'default');
    res.json({ plans: await listPlans(workspaceId) });
    } catch (error) { next(error); }
  });

  app.get('/api/controller/plans/:id', async (req, res, next) => {
    try {
    const plan = await getPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
    } catch (error) { next(error); }
  });

  app.post('/api/controller/plans/:id/execute', async (req, res, next) => {
    try {
      const { approveAll, stepId } = req.body || {};
      const plan = await getPlan(req.params.id);
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

  app.post('/api/controller/plans/:id/cancel', async (req, res, next) => {
    try {
    const plan = await cancelPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
    } catch (error) { next(error); }
  });

  app.post('/api/controller/explain/stream', async (req, res) => {
    const { topic, workspaceId, userId, conversationId, history, apps } = req.body || {};
    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'topic is required' });
    }
    prepareStreamingResponse(res);
    try {
      const scope = reqScope(req);
      res.write('\n');
      for await (const delta of streamExplain(topic, { workspaceId, userId: scope.userId || userId, projectId: scope.projectId, appId: scope.appId, conversationId: typeof conversationId === 'string' ? conversationId : undefined, history, apps })) {
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
      const { topic, workspaceId, userId, conversationId, history, apps } = req.body || {};
      if (!topic || typeof topic !== 'string') {
        return res.status(400).json({ error: 'topic is required' });
      }
      const scope = reqScope(req);
      const text = await explainIntent(topic, { workspaceId, userId: scope.userId || userId, projectId: scope.projectId, appId: scope.appId, conversationId: typeof conversationId === 'string' ? conversationId : undefined, history, apps });
      res.json({ topic, answer: text });
    } catch (err: any) {
      if (err?.status) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

}
