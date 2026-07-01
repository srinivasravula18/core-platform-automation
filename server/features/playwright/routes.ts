import type { Express } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { executePlaywrightScripts } from './executionService';

const codegenRuns = new Map<string, { child: ChildProcess; outputPath: string; url: string; startedAt: string }>();

function safeId(value: string) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || randomUUID();
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

export function registerPlaywrightRoutes(app: Express) {
  app.post('/api/playwright/run', async (req, res) => {
    try {
      const { scripts, baseUrl, runId, singleSession } = req.body || {};
      if (!Array.isArray(scripts) || scripts.length === 0) {
        return res.status(400).json({ error: 'scripts[] is required' });
      }
      const result = await executePlaywrightScripts({ scripts, baseUrl, runId, singleSession: !!singleSession });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to run Playwright scripts.' });
    }
  });

  app.post('/api/playwright/codegen/start', async (req, res) => {
    try {
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
