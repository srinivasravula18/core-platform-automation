import type { Express } from 'express';
import { Requirements, RequirementLinks, Cases, isPgEnabled } from '../../db/repository';
import { addActivity, persistDataInBackground } from '../../shared/storage';
import { getAIErrorMessage } from '../../shared/ai';
import { confirmRequirementDraft, discoverRequirement, draftRequirement, getRequirementWithCases } from './requirementService';
import { reqScope, scopeFilter } from '../../shared/scope';
import { getApp, getProjectRepoPath } from '../projects/projectService';
import { resolveCredentials } from '../credentials/credentialsService';
import { buildCorePlatformApplicationContext } from '../agent/applicationContext';
import { assembleConversationContext } from '../../ai/memory/contextAssembler';
import { resolveModelForAgent, resolveProviderForAgent } from '../../ai/orchestrator';
import { normalizeTestCaseTypes } from '../../../core/shared/testCaseTypes';

// Server-side conversation reconstruction for requirement drafting, so follow-ups
// ("also add requirements for X") enrich the running scope instead of starting cold.
// Best-effort: an assembly failure never blocks the draft.
async function conversationContextForDraft(conversationId: unknown, history: unknown, query: string): Promise<string> {
  if (typeof conversationId !== 'string' && !Array.isArray(history)) return '';
  try {
    const assembled = await assembleConversationContext({
      conversationId: typeof conversationId === 'string' && conversationId ? conversationId : undefined,
      fallbackHistory: history,
      currentMessage: query,
      model: resolveModelForAgent('featureAnalyst', resolveProviderForAgent('featureAnalyst')),
      path: 'requirements.draft',
    });
    return assembled.promptBlock.trim();
  } catch (err: any) {
    console.warn('[requirements] conversation context assembly failed:', err?.message || err);
    return '';
  }
}

function repoPathForScope(scope: ReturnType<typeof reqScope>): string {
  return scope.projectId ? getProjectRepoPath(scope.projectId) : '';
}

async function applicationContextPromptForScope(scope: ReturnType<typeof reqScope>, query: string): Promise<string> {
  const app = scope.appId ? getApp(scope.appId) : undefined;
  const targetUrl = app?.baseUrl || '';
  const credentials = targetUrl
    ? resolveCredentials({ targetUrl, ownerId: scope.userId || undefined }) || undefined
    : undefined;
  const built = await buildCorePlatformApplicationContext({
    projectId: scope.projectId,
    appId: scope.appId || '',
    targetUrl,
    prompt: query,
    ownerId: scope.userId,
    credentials,
    maxChars: 22000,
  });
  return built.promptText;
}

// Anti-buffering pad: defeats proxies that ignore X-Accel-Buffering by filling their
// ~4-8KB upstream buffer on every event (SSE comment lines are ignored by the client).
// See the same constant in controller/routes.ts for the full rationale.
const STREAM_PROXY_PAD = `: ${' '.repeat(4096)}\n\n`;

function prepareStreamingResponse(res: any) {
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
  try { res.flush?.(); } catch { /* best effort */ }
}

export function registerRequirementRoutes(app: Express) {
  app.post('/api/requirements/draft/stream', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Tell me which feature or section to test.' });

    prepareStreamingResponse(res);
    const send = (obj: any) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n${STREAM_PROXY_PAD}`); } catch { /* client gone */ }
    };
    const heartbeat = setInterval(() => {
      send({ type: 'heartbeat', at: Date.now() });
      flushStream(res);
    }, 10000);

    try {
      const scope = reqScope(req);
      let index = 0;
      const onProgress = (text: string) => {
        send({ type: 'step', index: index++, text });
        flushStream(res);
      };
      onProgress('Starting requirement drafting agent...');
      const [applicationContextPrompt, conversationContextPrompt] = await Promise.all([
        applicationContextPromptForScope(scope, query).catch(() => ''),
        conversationContextForDraft(req.body?.conversationId, req.body?.history, query),
      ]);
      const result = await draftRequirement(query, {
        workspaceId: req.body?.workspaceId || 'default',
        userId: scope.userId,
        role: scope.role,
        repoPath: repoPathForScope(scope),
        projectId: scope.projectId,
        appId: scope.appId || '',
        applicationContextPrompt,
        conversationContextPrompt,
        requirementsOnly: true,
        onProgress,
      });
      send({ type: 'final', result });
      flushStream(res);
    } catch (error: any) {
      send({ type: 'error', error: getAIErrorMessage(error) || error?.message || 'Failed to draft requirement.' });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  app.post('/api/requirements/draft', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) return res.status(400).json({ error: 'Tell me which feature or section to test.' });
      const scope = reqScope(req);
      const [applicationContextPrompt, conversationContextPrompt] = await Promise.all([
        applicationContextPromptForScope(scope, query).catch(() => ''),
        conversationContextForDraft(req.body?.conversationId, req.body?.history, query),
      ]);
      const result = await draftRequirement(query, { workspaceId: req.body?.workspaceId || 'default', userId: scope.userId, role: scope.role, repoPath: repoPathForScope(scope), projectId: scope.projectId, appId: scope.appId || '', applicationContextPrompt, conversationContextPrompt, requirementsOnly: true });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: getAIErrorMessage(error) || error?.message || 'Failed to draft requirement.' });
    }
  });

  app.post('/api/requirements/confirm', async (req, res) => {
    try {
      const scope = reqScope(req);
      const result = await confirmRequirementDraft(req.body?.draft || {}, { workspaceId: req.body?.workspaceId || 'default', userId: scope.userId, role: scope.role, projectId: scope.projectId, appId: scope.appId || '' });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: getAIErrorMessage(error) || error?.message || 'Failed to create requirement.' });
    }
  });

  /* ---------- discover: search the target app source, reconcile, propose gaps ---------- */
  app.post('/api/requirements/discover', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) return res.status(400).json({ error: 'Tell me which feature or section to test.' });
      const scope = reqScope(req);
      const requirementsOnly = req.body?.requirementsOnly === true || req.body?.mode === 'requirements_only';
      const applicationContextPrompt = await applicationContextPromptForScope(scope, query).catch(() => '');
      const result = await discoverRequirement(query, { workspaceId: req.body?.workspaceId || 'default', userId: scope.userId, role: scope.role, repoPath: repoPathForScope(scope), projectId: scope.projectId, appId: scope.appId || '', applicationContextPrompt, requirementsOnly });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: getAIErrorMessage(error) || error?.message || 'Failed to discover requirement.' });
    }
  });

  /* ---------- list with coverage rollup ---------- */
  app.get('/api/requirements', async (req, res) => {
    try {
      const requirements = scopeFilter(await Requirements.list(), reqScope(req));
      const links = await RequirementLinks.list();
      const cases = scopeFilter(await Cases.list(), reqScope(req));
      const casesById = new Map(cases.map((testCase: any) => [testCase.id, testCase]));
      const byReq = new Map<string, { existing: number; generated: number }>();
      const typesByReq = new Map<string, Set<string>>();
      for (const l of links) {
        const entry = byReq.get(l.requirementId) || { existing: 0, generated: 0 };
        if (l.linkType === 'generated') entry.generated += 1;
        else entry.existing += 1;
        byReq.set(l.requirementId, entry);
        const typeSet = typesByReq.get(l.requirementId) || new Set<string>();
        const linkedCase = casesById.get(l.caseId);
        if (linkedCase) normalizeTestCaseTypes(linkedCase).forEach((type) => typeSet.add(type));
        typesByReq.set(l.requirementId, typeSet);
      }
      res.json(requirements.map((r: any) => {
        const counts = byReq.get(r.id) || { existing: 0, generated: 0 };
        return { ...r, testCaseTypes: [...(typesByReq.get(r.id) || [])], existingCaseCount: counts.existing, generatedCaseCount: counts.generated, linkedCaseCount: counts.existing + counts.generated };
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to list requirements.' });
    }
  });

  /* ---------- single requirement with resolved linked cases ---------- */
  app.get('/api/requirements/:id', async (req, res) => {
    try {
      const requirement = await getRequirementWithCases(req.params.id);
      if (!requirement) return res.status(404).json({ error: 'Requirement not found.' });
      const scope = reqScope(req);
      if (scope.userId && ((requirement as any).ownerId || '') !== scope.userId) {
        return res.status(404).json({ error: 'Requirement not found.' });
      }
      res.json(requirement);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load requirement.' });
    }
  });

  /* ---------- edit / delete the requirement itself ---------- */
  app.put('/api/requirements/:id', async (req, res) => {
    const existing = await Requirements.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Requirement not found.' });
    const updated = { ...existing, ...req.body, updatedAt: new Date() };
    await Requirements.upsert(updated);
    if (!isPgEnabled()) persistDataInBackground('requirement update');
    addActivity(`Updated requirement: ${updated.title}`, { ownerId: reqScope(req).userId || '' });
    res.json({ success: true });
  });

  app.delete('/api/requirements/:id', async (req, res) => {
    const existing = await Requirements.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Requirement not found.' });
    await Requirements.remove(req.params.id);
    if (!isPgEnabled()) persistDataInBackground('requirement delete');
    addActivity(`Deleted requirement: ${existing.title}`, { ownerId: reqScope(req).userId || '' });
    res.json({ success: true });
  });

  app.post('/api/requirements/bulk-delete', async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
    let deleted = 0;
    for (const id of ids) {
      const existing = await Requirements.get(id);
      if (!existing) continue;
      await Requirements.remove(id);
      deleted += 1;
    }
    if (!isPgEnabled()) persistDataInBackground('requirement bulk delete');
    addActivity(`Deleted ${deleted} requirements`, { ownerId: reqScope(req).userId || '' });
    res.json({ success: true, deleted });
  });

  /* ---------- manage coverage links ---------- */
  app.post('/api/requirements/:id/links', async (req, res) => {
    const requirement = await Requirements.get(req.params.id);
    if (!requirement) return res.status(404).json({ error: 'Requirement not found.' });
    const caseId = String(req.body?.caseId || '').trim();
    if (!caseId) return res.status(400).json({ error: 'caseId is required.' });
    const testCase = await Cases.get(caseId);
    if (!testCase) return res.status(404).json({ error: 'Test case not found.' });
    const link = await RequirementLinks.upsert({
      requirementId: req.params.id,
      caseId,
      linkType: req.body?.linkType === 'generated' ? 'generated' : 'existing',
      note: req.body?.note || '',
    });
    if (!isPgEnabled()) persistDataInBackground('requirement link');
    addActivity(`Linked case ${caseId} to requirement ${requirement.title}`, { ownerId: reqScope(req).userId || '' });
    res.json({ success: true, link });
  });

  app.delete('/api/requirements/:id/links/:caseId', async (req, res) => {
    const requirement = await Requirements.get(req.params.id);
    if (!requirement) return res.status(404).json({ error: 'Requirement not found.' });
    await RequirementLinks.remove(req.params.id, req.params.caseId);
    if (!isPgEnabled()) persistDataInBackground('requirement unlink');
    res.json({ success: true });
  });
}
