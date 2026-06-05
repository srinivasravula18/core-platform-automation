import type { Express } from 'express';
import { getGitRepoStatus, syncGitAgentMain, scanGitAgentChanges, generateGitAgentCases } from './gitAgentService';
import { analyzeCodeChanges, applyCodeChangeTests } from './analysisService';

export function registerGitAgentRoutes(app: Express) {
  app.post('/api/git-agent/analyze', async (req, res) => {
    try {
      const baseRef = String(req.body?.baseRef || 'auto').trim() || 'auto';
      res.json(await analyzeCodeChanges(baseRef, { workspaceId: req.body?.workspaceId || 'default' }));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to analyze code changes.' });
    }
  });

  app.post('/api/git-agent/apply', async (req, res) => {
    try {
      res.json(await applyCodeChangeTests(req.body || {}, { workspaceId: req.body?.workspaceId || 'default' }));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to create tests from code changes.' });
    }
  });

  app.get('/api/git-agent/status', (req, res) => {
    try {
      res.json(getGitRepoStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to read git agent status.' });
    }
  });

  app.post('/api/git-agent/sync', (req, res) => {
    try {
      res.json(syncGitAgentMain());
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to sync main branch.' });
    }
  });

  app.post('/api/git-agent/scan', (req, res) => {
    try {
      const baseRef = String(req.body?.baseRef || 'auto').trim() || 'auto';
      res.json(scanGitAgentChanges(baseRef));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to scan changed files.' });
    }
  });

  app.post('/api/git-agent/generate', async (req, res) => {
    try {
      const baseRef = String(req.body?.baseRef || 'auto').trim() || 'auto';
      res.json(await generateGitAgentCases(baseRef));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to generate git change test cases.' });
    }
  });
}
