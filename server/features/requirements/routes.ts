import type { Express } from 'express';
import { Requirements, RequirementLinks, Cases, isPgEnabled } from '../../db/repository';
import { addActivity, persistDataInBackground } from '../../shared/storage';
import { getAIErrorMessage } from '../../shared/ai';
import { discoverRequirement, getRequirementWithCases } from './requirementService';
import { reqScope, scopeFilter } from '../../shared/scope';

export function registerRequirementRoutes(app: Express) {
  /* ---------- discover: search the target app source, reconcile, propose gaps ---------- */
  app.post('/api/requirements/discover', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) return res.status(400).json({ error: 'Tell me which feature or section to test.' });
      const scope = reqScope(req);
      const result = await discoverRequirement(query, { workspaceId: req.body?.workspaceId || 'default', userId: scope.userId, role: scope.role });
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
      const byReq = new Map<string, { existing: number; generated: number }>();
      for (const l of links) {
        const entry = byReq.get(l.requirementId) || { existing: 0, generated: 0 };
        if (l.linkType === 'generated') entry.generated += 1;
        else entry.existing += 1;
        byReq.set(l.requirementId, entry);
      }
      res.json(requirements.map((r: any) => {
        const counts = byReq.get(r.id) || { existing: 0, generated: 0 };
        return { ...r, existingCaseCount: counts.existing, generatedCaseCount: counts.generated, linkedCaseCount: counts.existing + counts.generated };
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
    addActivity(`Updated requirement: ${updated.title}`);
    res.json({ success: true });
  });

  app.delete('/api/requirements/:id', async (req, res) => {
    const existing = await Requirements.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Requirement not found.' });
    await Requirements.remove(req.params.id);
    if (!isPgEnabled()) persistDataInBackground('requirement delete');
    addActivity(`Deleted requirement: ${existing.title}`);
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
    addActivity(`Deleted ${deleted} requirements`);
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
    addActivity(`Linked case ${caseId} to requirement ${requirement.title}`);
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
