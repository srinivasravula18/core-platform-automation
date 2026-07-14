import type { Express } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { executePlaywrightScripts } from './executionService';
import { findSettingsCredentials } from '../../shared/url';
import { resolveCredentials } from '../credentials/credentialsService';
import { createAuthStorageState } from '../evidence/evidenceService';

const codegenRuns = new Map<string, { child: ChildProcess; outputPath: string; url: string; startedAt: string }>();

function safeId(value: string) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || randomUUID();
}

function isLocalHost(host = '') {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host);
}

function stopProcessTree(child: ChildProcess) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    killer.once('exit', () => resolve());
    killer.once('error', () => resolve());
  });
}

function applySettingsCredentials(code: string, baseUrl: string) {
  const creds = findSettingsCredentials(baseUrl);
  if (!creds.username || !creds.password) return code;
  let next = code;
  next = next.replace(/const\s+USERNAME\s*=\s*(['"]).*?\1\s*;?/m, `const USERNAME = ${JSON.stringify(creds.username)};`);
  next = next.replace(/const\s+PASSWORD\s*=\s*(['"]).*?\1\s*;?/m, `const PASSWORD = ${JSON.stringify(creds.password)};`);
  next = next.replace(/(getBy(?:Label|Placeholder)\([^)]*(?:email|user(?:name)?|login)[^)]*\)[\s\S]{0,80}\.fill\()\s*(['"]).*?\2(\s*[,)]?)/gi, `$1${JSON.stringify(creds.username)}$3`);
  next = next.replace(/(getBy(?:Label|Placeholder)\([^)]*password[^)]*\)[\s\S]{0,80}\.fill\()\s*(['"]).*?\2(\s*[,)]?)/gi, `$1${JSON.stringify(creds.password)}$3`);
  return next;
}

export function registerPlaywrightRoutes(app: Express) {
  app.post('/api/playwright/run', async (req, res) => {
    try {
      const { scripts, baseUrl, runId, singleSession, screenshotMode } = req.body || {};
      if (!Array.isArray(scripts) || scripts.length === 0) {
        return res.status(400).json({ error: 'scripts[] is required' });
      }
      const runnableScripts = scripts.map((script: any) => ({ ...script, code: applySettingsCredentials(String(script?.code || ''), String(baseUrl || '')) }));
      // Compiler-emitted specs import './mission-runner'; without emitting it they collect 0 tests on re-run.
      const needsMissionRunner = runnableScripts.some((s: any) => /from\s+['"]\.\/mission-runner['"]/.test(String(s?.code || '')));
      // Compiled specs never log in themselves (MissionRunner expects an injected authenticated session),
      // so re-runs must prepare one — same proven login the pipeline uses. Legacy scripts keep their own login.
      let storageStatePath: string | undefined;
      let sessionStorageState: { origin: string; items: Record<string, string> } | undefined;
      if (needsMissionRunner && baseUrl) {
        const stored = resolveCredentials({ targetUrl: String(baseUrl) });
        const settings = findSettingsCredentials(String(baseUrl));
        const creds = stored?.username && stored?.password
          ? { username: stored.username, password: stored.password }
          : settings.username && settings.password ? { username: settings.username, password: settings.password } : null;
        if (creds) {
          const authPath = path.join(process.cwd(), '.testflow-pw', `rerun-${safeId(String(runId || Date.now()))}-auth.json`);
          await fs.mkdir(path.dirname(authPath), { recursive: true });
          const auth = await createAuthStorageState(String(baseUrl), creds, authPath).catch(() => null);
          if (auth?.ok || auth?.sessionStorage) {
            storageStatePath = authPath;
            sessionStorageState = auth?.sessionStorage;
          }
        }
      }
      const result = await executePlaywrightScripts({ scripts: runnableScripts, baseUrl, runId, singleSession: !!singleSession, screenshotMode: screenshotMode === 'on' ? 'on' : undefined, emitMissionRunner: needsMissionRunner, storageStatePath, sessionStorageState });
      const evidenceDir = path.resolve(process.cwd(), 'evidence');
      await fs.mkdir(evidenceDir, { recursive: true });
      const screenshotUrls: string[] = [];
      for (const t of result.tests || []) {
        for (const fp of [...(t.stepScreenshotPaths || []), t.screenshotPath].filter(Boolean)) {
          const dest = `${result.runId}-shot-${screenshotUrls.length + 1}.png`;
          const ok = await fs.copyFile(fp, path.join(evidenceDir, dest)).then(() => true).catch(() => false);
          if (ok) screenshotUrls.push(`/evidence/${dest}`);
        }
      }
      res.json({ ...result, screenshotUrls });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to run Playwright scripts.' });
    }
  });

  app.post('/api/playwright/codegen/start', async (req, res) => {
    try {
      const deploymentMode = String(process.env.DEPLOYMENT_MODE || process.env.NODE_ENV || '').toLowerCase();
      const allowRemote = String(process.env.ALLOW_REMOTE_CODEGEN || '').toLowerCase() === 'true';
      if (!allowRemote && (deploymentMode === 'production' || !isLocalHost(req.headers.host || ''))) {
        return res.status(400).json({ error: 'Playwright Codegen requires a local desktop session. It cannot open a headed browser from the deployed server.' });
      }
      const url = String(req.body?.url || '').trim();
      if (!url) return res.status(400).json({ error: 'url is required' });
      const id = safeId(req.body?.id || `codegen-${randomUUID().slice(0, 8)}`);
      const dir = path.join(process.cwd(), '.testflow-pw', 'codegen');
      await fs.mkdir(dir, { recursive: true });
      const outputPath = path.join(dir, `${id}.spec.ts`);
      const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
      const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npx.cmd', 'playwright', 'codegen', url, '--output', outputPath]
        : ['playwright', 'codegen', url, '--output', outputPath];
      const child = spawn(command, args, {
        cwd: process.cwd(),
        shell: false,
        stdio: 'ignore',
        detached: false,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      codegenRuns.set(id, { child, outputPath, url, startedAt: new Date().toISOString() });
      child.once('exit', () => {
        const current = codegenRuns.get(id);
        if (current?.child === child) codegenRuns.delete(id);
      });
      res.json({ id, url, outputPath, started: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to start Playwright codegen.' });
    }
  });

  app.get('/api/playwright/codegen/:id', async (req, res) => {
    try {
      const id = safeId(req.params.id);
      const active = codegenRuns.get(id);
      const outputPath = active?.outputPath || path.join(process.cwd(), '.testflow-pw', 'codegen', `${id}.spec.ts`);
      const code = await fs.readFile(outputPath, 'utf8').catch(() => '');
      res.json({ id, running: !!active, outputPath, code });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to read generated code.' });
    }
  });

  app.post('/api/playwright/codegen/:id/stop', async (req, res) => {
    const id = safeId(req.params.id);
    const active = codegenRuns.get(id);
    if (active) {
      await stopProcessTree(active.child);
      codegenRuns.delete(id);
    }
    res.json({ id, stopped: true });
  });
}
