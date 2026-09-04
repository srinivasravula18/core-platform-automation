import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vitalsQuery } from '../db';
import { applyDefaults, buildParamSchema, profileById, type TestProfile } from './profiles';
import { isAllowedTarget, resolveTestTargets } from './targetPolicy';
import { summarizeK6 } from './k6-summary';

type ActiveRun = { child: ChildProcess; aborted: boolean; seq: number; summaryPath: string };
const active = new Map<string, ActiveRun>();
let starting = 0;
export const MAX_CONCURRENT_RUNS = 4;
export const activeRunIds = () => [...active.keys()];

const binaryFor = (profile: TestProfile) => profile.runner === 'k6' ? process.env.K6_BIN?.trim() || 'k6' : process.execPath;

export const checkRunnerAvailable = (profile: TestProfile) => new Promise<boolean>((resolve) => {
  if (profile.runner === 'node') return resolve(true);
  if (profile.runner === 'agent') return resolve(fs.existsSync(path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'auth.json')));
  const binary = profile.runner === 'k6' ? binaryFor(profile) : process.env.DOCKER_BIN?.trim() || 'docker';
  const probe = spawn(binary, profile.runner === 'k6' ? ['version'] : ['version', '--format', '{{.Server.Version}}'], { shell: false, windowsHide: true });
  probe.once('error', () => resolve(false));
  probe.once('close', (code) => resolve(code === 0));
});

const log = async (runId: string, run: ActiveRun, stream: 'stdout' | 'stderr' | 'system', line: string) => {
  run.seq += 1;
  await vitalsQuery('insert into obs.test_run_log (run_id, seq, at, stream, line) values ($1, $2, now(), $3, $4) on conflict do nothing', [runId, run.seq, stream, line]).catch(() => undefined);
};

const pipe = (runId: string, run: ActiveRun, stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
  let pending = '';
  stream?.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) void log(runId, run, name, line);
  });
};

export async function startLocalProcess(input: { profileId: string; params: Record<string, unknown>; targetBaseUrl?: string }, triggeredBy: string) {
  if (active.size + starting >= MAX_CONCURRENT_RUNS) throw Object.assign(new Error(`At most ${MAX_CONCURRENT_RUNS} runs can run at once.`), { status: 409 });
  starting += 1;
  try {
  const profile = profileById(input.profileId);
  if (!profile) throw Object.assign(new Error(`Unknown profile: ${input.profileId}`), { status: 400 });
  const params = buildParamSchema(profile).parse(input.params);
  const values = applyDefaults(profile, params);
  const targets = await resolveTestTargets();
  const target = input.targetBaseUrl || targets[0]?.url;
  if (!target || !isAllowedTarget(target, targets.map((entry) => entry.url))) throw Object.assign(new Error('Target is not in the server allowlist.'), { status: 403 });
  const selectedTarget = targets.find((entry) => isAllowedTarget(target, [entry.url]));
  if (profile.category === 'Security' && !selectedTarget?.pentestAllowed) throw Object.assign(new Error('Security testing is not allowed for this sandbox target.'), { status: 403 });
  if (['zap', 'agent', 'nuclei'].includes(profile.runner) && values.authorized !== 'true') throw Object.assign(new Error('Explicit scan authorization is required.'), { status: 400 });
  if (!(await checkRunnerAvailable(profile))) throw Object.assign(new Error(`The ${profile.runner} runner is unavailable.`), { status: 503 });

  const scriptPath = path.resolve(process.cwd(), profile.script);
  if (!scriptPath.startsWith(path.resolve(process.cwd()) + path.sep) || !fs.existsSync(scriptPath)) throw Object.assign(new Error(`Profile script not found: ${profile.script}`), { status: 503 });
  const runId = `run${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const summaryPath = path.join(os.tmpdir(), `${runId}-summary.json`);
  const env = { ...process.env, ...profile.buildEnv(values), API_BASE: target, AUTH_API_BASE: target, K6_NO_USAGE_REPORT: 'true', OBS_TEST_SUMMARY_PATH: summaryPath };
  const args = profile.runner === 'k6' ? ['run', '--summary-export', summaryPath, scriptPath] : [scriptPath];

  await vitalsQuery(`insert into obs.test_run (id, profile_id, profile_label, params, status, target_base_url, started_at, triggered_by)
    values ($1,$2,$3,$4::jsonb,'running',$5,now(),$6)`, [runId, profile.id, profile.label, JSON.stringify(values), target, triggeredBy]);
  const child = spawn(binaryFor(profile), args, { cwd: path.dirname(scriptPath), env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
  const run: ActiveRun = { child, aborted: false, seq: 0, summaryPath };
  active.set(runId, run);
  void log(runId, run, 'system', `Starting ${profile.label} against ${target}`);
  pipe(runId, run, child.stdout, 'stdout');
  pipe(runId, run, child.stderr, 'stderr');
  child.on('error', (error) => void log(runId, run, 'system', `Process error: ${error.message}`));
  child.on('close', async (code) => {
    const exitCode = code ?? -1;
    const summary = summarizeK6(summaryPath);
    const checks = [{ label: 'process exit', expected: '0', actual: String(exitCode), passed: exitCode === 0 }];
    if (profile.thresholds.p95Ms !== undefined && summary.p95Ms !== null) checks.push({ label: 'p95 latency', expected: `< ${profile.thresholds.p95Ms} ms`, actual: `${Math.round(summary.p95Ms)} ms`, passed: summary.p95Ms < profile.thresholds.p95Ms });
    if (profile.thresholds.errorRatePct !== undefined && summary.errorRatePct !== null) checks.push({ label: 'error rate', expected: `< ${profile.thresholds.errorRatePct}%`, actual: `${summary.errorRatePct.toFixed(2)}%`, passed: summary.errorRatePct < profile.thresholds.errorRatePct });
    const passed = !run.aborted && checks.every((check) => check.passed);
    const verdict = { passed, checks };
    await vitalsQuery(`update obs.test_run set status=$2, finished_at=now(), exit_code=$3, summary=$4::jsonb, verdict=$5::jsonb where id=$1`, [runId, run.aborted ? 'aborted' : passed ? 'passed' : 'failed', exitCode, JSON.stringify(summary), JSON.stringify(verdict)]).catch(() => undefined);
    active.delete(runId);
    fs.promises.rm(summaryPath, { force: true }).catch(() => undefined);
  });
  return { id: runId };
  } finally {
    starting -= 1;
  }
}

export const abortLocalProcess = async (runId: string) => {
  const run = active.get(runId);
  if (!run) throw Object.assign(new Error('No active run with that id.'), { status: 404 });
  run.aborted = true;
  if (process.platform === 'win32' && run.child.pid) spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { shell: false, windowsHide: true });
  else if (run.child.pid) { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { run.child.kill('SIGKILL'); } }
  return { ok: true };
};
