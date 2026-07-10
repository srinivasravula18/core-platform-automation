/**
 * API Intelligence HTTP surface (Phase A). Thin: create a run, kick the deterministic pipeline
 * asynchronously, and expose status/details. Scope via body/x-project-id; credentials via the shared
 * credential model. Responses are already redacted (evidence is redacted at assembly).
 */
import type { Express, Request, Response } from 'express';
import { resolveCredentials } from '../credentials/credentialsService';
import { resolveAuthTokenForTarget } from '../agent/domExplorer';
import { createApiRun, getApiRun, listApiRuns } from './store';
import { runApiIntelligence } from './pipeline';
import type { ApiRun } from './types';

function scopeOf(req: Request): { projectId?: string; appId?: string; ownerId?: string } {
  const b = req.body || {};
  return {
    projectId: b.projectId || (req.headers['x-project-id'] as string) || undefined,
    appId: b.appId || (req.headers['x-app-id'] as string) || undefined,
    ownerId: (req as any).authUser?.userId || undefined,
  };
}

/** Best-effort bearer token: explicit token → stored/inline creds → login-derived token. */
async function resolveToken(req: Request, targetUrl: string): Promise<string | undefined> {
  const b = req.body || {};
  if (b.token) return String(b.token);
  const inline = b.inlineCredentials || {};
  if (inline.token) return String(inline.token);
  const creds =
    resolveCredentials({ targetUrl, websiteId: b.websiteId, websiteName: b.websiteName, inline: b.inlineCredentials }) ||
    null;
  const username = inline.username || creds?.username;
  const password = inline.password || (creds as any)?.password;
  if ((creds as any)?.token) return (creds as any).token;
  if (username && password) {
    const tok = await resolveAuthTokenForTarget(targetUrl, username, password).catch(() => null);
    if (tok?.access) return tok.access;
  }
  return undefined;
}

function snapshot(run: ApiRun) {
  return {
    id: run.id,
    status: run.status,
    targetUrl: run.targetUrl,
    environment: run.environment,
    mode: run.mode,
    counts: {
      endpoints: run.endpoints.length,
      scenarios: run.scenarios.length,
      executions: run.executions.length,
      findings: run.findings.length,
      evidence: run.api_evidence.length,
    },
    messages: run.messages.slice(-30),
    report: run.report,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

export function registerApiIntelligenceRoutes(app: Express): void {
  app.post('/api/api-intelligence/start', async (req: Request, res: Response) => {
    const b = req.body || {};
    const targetUrl = String(b.targetUrl || b.app_url || '').trim();
    if (!targetUrl && !b.openapiSpec && !b.postman) {
      return res.status(400).json({ error: 'Provide targetUrl (for live OpenAPI discovery) or an openapiSpec/postman document.' });
    }
    const scope = scopeOf(req);
    const run = createApiRun({
      ...scope,
      targetUrl,
      environment: String(b.environment || 'unknown'),
      mode: b.mode === 'flow' ? 'flow' : 'single',
      writeEnabled: Boolean(b.writeEnabled),
    });
    res.json({ task_id: run.id });

    // Fire-and-forget: the pipeline records progress on the run; clients poll /status.
    const token = await resolveToken(req, targetUrl).catch(() => undefined);
    runApiIntelligence(run, {
      token,
      openapiSpec: b.openapiSpec,
      postman: b.postman,
      fetchLive: b.fetchLive,
      timeoutMs: b.timeoutMs,
    }).catch((e) => console.error('[api-intelligence] pipeline error:', e?.message || e));
  });

  app.get('/api/api-intelligence/runs', (req: Request, res: Response) => {
    res.json(listApiRuns(scopeOf(req)).map(snapshot));
  });

  app.get('/api/api-intelligence/runs/:id/status', (req: Request, res: Response) => {
    const run = getApiRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(snapshot(run));
  });

  app.get('/api/api-intelligence/runs/:id', (req: Request, res: Response) => {
    const run = getApiRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    // Evidence is already redacted; return the full run for the details view.
    res.json(run);
  });
}
