import type { Express } from 'express';
import { buildPlan, cancelPlan, classifyIntent, executePlan, explainIntent, streamExplain, getPlan, listPlans } from '../../ai/controller';
import { runSupervisor, answerAppQuestionFromCode, answerViaConversationalRuntime } from '../../ai/supervisor';
import { isWorkspaceDataQuestion, quickWorkspaceAnswer } from '../../ai/tools/registry';
import { reqScope } from '../../shared/scope';
import { ChatConversations } from '../../db/repository';
import { assembleConversationContext } from '../../ai/memory/contextAssembler';
import { getProviderCredentials, resolveModelForAgent, resolveProviderForAgent } from '../../ai/orchestrator';

// An action request mutates/creates/runs something → needs the full tool loop. A plain
// question can be answered with the FAST single-call git-grounded path.
const ACTION_RE = /\b(generate|create|write|build|make|run|execute|file\s+(a|the)|add|move|organi[sz]e|re-?run|delete|remove|update|edit|set\s|navigate|open|go\s+to|triage|expand|rework|schedule)\b/i;

async function assembleFastContext(message: string, conversationId: unknown, history: unknown) {
  const provider = resolveProviderForAgent('chatAssistant');
  return assembleConversationContext({
    conversationId: typeof conversationId === 'string' ? conversationId : undefined,
    fallbackHistory: history,
    currentMessage: message,
    model: resolveModelForAgent('chatAssistant', provider),
    path: 'controller.fast-question',
  });
}

function nativeReplayOptions(assembled: Awaited<ReturnType<typeof assembleFastContext>>) {
  const provider = resolveProviderForAgent('chatAssistant');
  const accountMode = getProviderCredentials(provider)?.authMode === 'account';
  return accountMode
    ? { questionPrefix: assembled.promptBlock, seedMessages: undefined, memoryBlock: undefined }
    : { questionPrefix: '', seedMessages: assembled.history, memoryBlock: assembled.memoryBlock };
}

async function persistExchange(conversationId: unknown, workspaceId: unknown, userMessage: string, reply: string) {
  if (typeof conversationId !== 'string' || !conversationId) return;
  await ChatConversations.appendMessages({
    id: conversationId,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : 'default',
    title: userMessage.slice(0, 120),
    messages: [{ role: 'user', text: userMessage }, { role: 'assistant', kind: 'text', text: reply }],
  });
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
      const { userMessage, workspaceId, userId, conversationId, history, pageContext, apps } = req.body || {};
      const scope = reqScope(req);
      const effectiveUserId = scope.userId || userId;
      if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ error: 'userMessage is required' });
      }
      // FAST PATH 1: simple count/list questions answered straight from the DB (no LLM).
      const quick = await quickWorkspaceAnswer(userMessage, scope);
      if (quick) {
        await persistExchange(conversationId, workspaceId, userMessage, quick);
        return res.json({ reply: quick, accepted: true, fast: true, actions: [], trace: [] });
      }
      // FAST PATH 2: app-knowledge QUESTIONS get a single git-grounded LLM call (retrieval
      // done deterministically), instead of the slow multi-step tool loop. Include the recent
      // conversation so FOLLOW-UPS resolve against context — "rewrite that case", "explain it",
      // or a pasted case that follows a prior instruction — instead of being answered blind.
      if (!ACTION_RE.test(userMessage) && !isWorkspaceDataQuestion(userMessage, Array.isArray(history) ? history : [])) {
        // Phase 6 cutover: diagnostic/recall questions answer from REAL run evidence via the
        // Conversational Runtime (it persists its own canonical exchange); null → legacy path.
        const runtimeReply = await answerViaConversationalRuntime(userMessage, {
          conversationId, workspaceId, userId: effectiveUserId, projectId: scope.projectId, appId: scope.appId,
        });
        if (runtimeReply) {
          return res.json({ reply: runtimeReply, accepted: true, fast: true, actions: [], trace: [] });
        }
        const assembled = await assembleFastContext(userMessage, conversationId, history);
        const replay = nativeReplayOptions(assembled);
        const reply = await answerAppQuestionFromCode(`${replay.questionPrefix}\n\n${userMessage}`.trim(), {
          workspaceId,
          userId: effectiveUserId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
          contextManifestId: assembled.manifest.id,
          conversationId,
          seedMessages: replay.seedMessages,
          memoryBlock: replay.memoryBlock,
        });
        await persistExchange(conversationId, workspaceId, userMessage, reply);
        return res.json({ reply, accepted: true, fast: true, actions: [{ tool: 'search_codebase', arguments: {} }], trace: [] });
      }
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
      });
      await persistExchange(conversationId, workspaceId, userMessage, result.finalText);
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
    const { userMessage, workspaceId, userId, conversationId, history, pageContext, apps } = req.body || {};
    const scope = reqScope(req);
    const effectiveUserId = scope.userId || userId;
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'userMessage is required' });
    }
    prepareStreamingResponse(res);
    const send = (obj: any) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n${STREAM_PROXY_PAD}`); } catch { /* client gone */ } };
    const heartbeat = startStreamHeartbeat(res, send);
    try {
      send({ type: 'step', index: 0, text: 'Starting...', toolCalls: [] });
      flushStream(res);
      // Instant path: simple count/list answered from the DB, no steps.
      const quick = await quickWorkspaceAnswer(userMessage, effectiveUserId);
      if (quick) { await persistExchange(conversationId, workspaceId, userMessage, quick); await sendFinalReply(res, send, quick, { fast: true }); return res.end(); }
      // Fast git-grounded path for app-knowledge QUESTIONS: ONE LLM call after deterministic
      // retrieval. Emits the search/read progress so the UI still animates the live steps.
      if (!ACTION_RE.test(userMessage) && !isWorkspaceDataQuestion(userMessage, Array.isArray(history) ? history : [])) {
        let i = 0;
        // Phase 6 cutover (streaming): evidence-first runtime answers diagnostic/recall
        // questions; progress lines keep the UI animating. null → legacy code-grounded path.
        const runtimeReply = await answerViaConversationalRuntime(userMessage, {
          conversationId, workspaceId, userId: effectiveUserId, projectId: scope.projectId, appId: scope.appId,
          onProgress: (label) => {
            send({ type: 'step', index: i++, toolCalls: [{ name: 'get_run', arguments: {} }], text: label });
            flushStream(res);
          },
        });
        if (runtimeReply) {
          await sendFinalReply(res, send, runtimeReply, { fast: true });
          return res.end();
        }
        const assembled = await assembleFastContext(userMessage, conversationId, history);
        const replay = nativeReplayOptions(assembled);
        const reply = await answerAppQuestionFromCode(`${replay.questionPrefix}\n\n${userMessage}`.trim(), {
          workspaceId,
          userId: effectiveUserId,
          projectId: scope.projectId,
          appId: scope.appId,
          apps,
          contextManifestId: assembled.manifest.id,
          conversationId,
          seedMessages: replay.seedMessages,
          memoryBlock: replay.memoryBlock,
          onProgress: (label) => {
            send({ type: 'step', index: i++, toolCalls: [{ name: /reading/i.test(label) ? 'read_code_file' : 'search_codebase', arguments: {} }], text: label });
            flushStream(res);
          },
        });
        await persistExchange(conversationId, workspaceId, userMessage, reply);
        await sendFinalReply(res, send, reply, { fast: true });
        return res.end();
      }
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
        onStep: (s) => {
          send({
            type: 'step',
            index: s.index,
            text: s.text,
            toolCalls: s.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, error: c.error })),
          });
          flushStream(res);
        },
      });
      await persistExchange(conversationId, workspaceId, userMessage, result.finalText);
      await sendFinalReply(res, send, result.finalText, { accepted: result.accepted });
    } catch (err: any) {
      send({ type: 'error', error: err?.message || 'supervisor failed' });
    } finally {
      clearInterval(heartbeat);
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
