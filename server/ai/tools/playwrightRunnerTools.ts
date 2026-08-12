// Playwright runner tools: list/run a real test file in the connected repo and report real results —
// the VALIDATE phase never lets the agent claim "passed" without an actual browser execution.
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import type { AgentTool, ToolContext } from './types';

function repoPathFrom(ctx: ToolContext): string {
  const p = String((ctx.scratch as any)?.repoPath || '');
  if (!p) throw new Error('No connected repository is attached to this run.');
  return p;
}

function resolveTestPath(repoPath: string, relPath: string): string {
  const abs = path.resolve(repoPath, relPath);
  const normalizedRoot = path.resolve(repoPath) + path.sep;
  if (!abs.startsWith(normalizedRoot)) throw new Error(`Path "${relPath}" escapes the repository root.`);
  return abs;
}

function runPlaywrightCli(repoPath: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxCmd, ['playwright', ...args], { cwd: repoPath, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }); });
    child.once('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err?.message || err) }); });
  });
}

export const listTestsTool: AgentTool = {
  spec: {
    name: 'list_tests',
    description: 'List Playwright tests discovered under a path in the connected repository (playwright test --list). Use to confirm a written test file is syntactically valid and discoverable BEFORE running it.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Test file or glob relative to the repo root.' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const repoPath = repoPathFrom(ctx);
    const rel = String(args.path || '');
    resolveTestPath(repoPath, rel);
    const result = await runPlaywrightCli(repoPath, ['test', '--list', rel], 30_000);
    return { discovered: result.code === 0, output: result.stdout + (result.stderr ? `\n${result.stderr}` : '') };
  },
};

export const runTestTool: AgentTool = {
  capability: { effect: 'write', permissions: ['agent:execute'] },
  spec: {
    name: 'run_test',
    description: 'Actually execute a Playwright test file in the connected repository and report the real result — pass/fail, the error message, and evidence paths on failure. This is the ONLY way to know if a test truly works; never claim it passed without calling this.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Test file relative to the repo root.' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const repoPath = repoPathFrom(ctx);
    const rel = String(args.path || '');
    resolveTestPath(repoPath, rel);
    const result = await runPlaywrightCli(repoPath, ['test', rel, '--reporter=line'], 120_000);
    const passed = result.code === 0;
    const evidenceDir = path.join(repoPath, 'test-results');
    let evidence: string[] = [];
    try {
      evidence = fs.readdirSync(evidenceDir).slice(0, 10);
    } catch { /* no artifacts */ }
    return {
      passed,
      exitCode: result.code,
      output: (result.stdout + '\n' + result.stderr).slice(-4000),
      evidenceDir: evidence.length ? path.relative(repoPath, evidenceDir) : null,
      evidenceFiles: evidence,
    };
  },
};

export const playwrightRunnerTools: AgentTool[] = [listTestsTool, runTestTool];
