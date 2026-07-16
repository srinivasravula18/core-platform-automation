/**
 * Phase 1 — Evidence Foundation tests. Proves (offline, no browser):
 *   1. MissionRunner template carries the act()/captureStep() per-step evidence wrappers, the step-log
 *      channel, and the mutation-scope guard.
 *   2. The evidence-capture fixture source installs bounded console/pageerror/network collectors.
 *   3. parsePlaywrightResults materializes step-N screenshots (ordered), console-log/network-log JSON,
 *      and merged step-log attachments into TestResult paths.
 *   npx tsx scripts/test-playwright-execution-evidence.ts   (npm run test:execution-evidence)
 */
import path from 'path';
import fs from 'fs/promises';
import { MISSION_RUNNER_SOURCE } from '../server/features/agent/compiler/missionRunner.template';
import { evidenceCaptureFixtureSource, parsePlaywrightResults } from '../server/features/playwright/executionService';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const SCRATCH = path.resolve(process.cwd(), '.testflow-pw', 'scratch', `evidence-parse-${process.pid}`);

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function reporterJson() {
  // Minimal Playwright JSON-reporter shape: suites → specs → tests → results (+ attachments).
  return {
    stats: { duration: 4321 },
    suites: [
      {
        file: 'a.spec.ts',
        specs: [
          {
            title: 'passing case', ok: true,
            tests: [{
              results: [{
                status: 'passed', duration: 1200,
                attachments: [
                  // Deliberately out of order — the parser must sort by step number.
                  { name: 'step-2', contentType: 'image/png', body: b64('png-two') },
                  { name: 'step-1', contentType: 'image/png', body: b64('png-one') },
                  { name: 'console-log', contentType: 'application/json', body: b64(JSON.stringify([{ type: 'error', text: 'boom' }])) },
                  { name: 'network-log', contentType: 'application/json', body: b64(JSON.stringify([{ kind: 'response', status: 500, url: '/api/x' }])) },
                  { name: 'step-log', contentType: 'application/json', body: b64(JSON.stringify({ n: 1, kind: 'fill', ok: true })) },
                  { name: 'step-log', contentType: 'application/json', body: b64(JSON.stringify({ n: 2, kind: 'click', ok: true })) },
                ],
              }],
            }],
          },
          {
            title: 'failing case', ok: false,
            tests: [{
              results: [{
                status: 'failed', duration: 900,
                error: { message: '[31mTimed out waiting[0m for locator' },
                attachments: [
                  { name: 'trace', contentType: 'application/zip', path: 'D:/fake/trace.zip' },
                  { name: 'step-1', contentType: 'image/png', body: b64('fail-shot') },
                ],
              }],
            }],
          },
        ],
      },
    ],
  };
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });

  console.log('MissionRunner template: per-step evidence + scope guard');
  ok(MISSION_RUNNER_SOURCE.includes('private async captureStep'), 'template has captureStep()');
  ok(MISSION_RUNNER_SOURCE.includes('private async act<T>'), 'template has the act() wrapper');
  ok(MISSION_RUNNER_SOURCE.includes("attach('step-' + this.stepIndex"), 'step screenshots attach as step-N');
  ok(MISSION_RUNNER_SOURCE.includes("attach('step-log'"), 'step log attaches as step-log');
  ok(MISSION_RUNNER_SOURCE.includes('MAX_STEP_SHOTS'), 'step capture is bounded');
  ok(MISSION_RUNNER_SOURCE.includes('MISSION SCOPE VIOLATION'), 'placeholder-app mutation guard present');
  ok(MISSION_RUNNER_SOURCE.includes('mutationIntent'), 'guard keys on compiler-derived mutationIntent');
  ok(/enforceAppId = this\.mission\.platformType === 'RUNTIME' && !!this\.mission\.application && !placeholderApp/.test(MISSION_RUNNER_SOURCE),
    'placeholder app ids are never fake-verified against the URL');
  ok(/async click\(spec: LocatorSpec\): Promise<void> \{ await this\.act\('click'/.test(MISSION_RUNNER_SOURCE), 'interactions run through act()');
  ok(/async expectVisible\(spec: LocatorSpec\): Promise<void> \{ await this\.act\('expectVisible'/.test(MISSION_RUNNER_SOURCE), 'assertions run through act()');

  console.log('evidence-capture fixture source');
  const fx = evidenceCaptureFixtureSource();
  ok(fx.includes("page.on('console'"), 'console collector installed');
  ok(fx.includes("page.on('pageerror'"), 'pageerror collector installed');
  ok(fx.includes("context.on('requestfailed'"), 'requestfailed collector installed');
  ok(fx.includes("context.on('response'"), 'response collector installed');
  ok(fx.includes("attach('console-log'") && fx.includes("attach('network-log'"), 'attaches console-log + network-log');
  ok(fx.includes('status < 400'), 'only failing responses recorded');
  ok(/push\(consoleEntries, 200/.test(fx) && /push\(networkEntries, 150/.test(fx), 'collectors are bounded');

  console.log('parsePlaywrightResults: materialization + counts');
  const parsed = await parsePlaywrightResults(reporterJson(), { runDir: SCRATCH, screenshotMode: 'on' });
  eq([parsed.passed, parsed.failed, parsed.skipped], [1, 1, 0], 'pass/fail/skip counts');
  eq(parsed.durationMs, 4321, 'duration from stats');
  eq(parsed.tests.length, 2, 'two tests parsed');

  const t0 = parsed.tests[0];
  eq(t0.stepScreenshotPaths?.length, 2, 'passing test has both step shots');
  const shot1 = await fs.readFile(t0.stepScreenshotPaths![0], 'utf8');
  const shot2 = await fs.readFile(t0.stepScreenshotPaths![1], 'utf8');
  eq([shot1, shot2], ['png-one', 'png-two'], 'step shots materialized IN ORDER despite shuffled attachments');
  ok(!!t0.consoleLogPath, 'consoleLogPath set');
  ok(!!t0.networkLogPath, 'networkLogPath set');
  ok(!!t0.stepLogPath, 'stepLogPath set');
  const consoleLog = JSON.parse(await fs.readFile(t0.consoleLogPath!, 'utf8'));
  eq(consoleLog[0]?.text, 'boom', 'console log round-trips');
  const netLog = JSON.parse(await fs.readFile(t0.networkLogPath!, 'utf8'));
  eq(netLog[0]?.status, 500, 'network log round-trips');
  const stepLog = JSON.parse(await fs.readFile(t0.stepLogPath!, 'utf8'));
  eq(stepLog.map((e: any) => e.kind), ['fill', 'click'], 'step-log entries merged in order');
  ok(t0.screenshotPath === t0.stepScreenshotPaths![1], 'screenshotPath falls back to the last step shot');

  const t1 = parsed.tests[1];
  eq(t1.status, 'failed', 'failing test status');
  ok(!!t1.error && !t1.error.includes(''), 'ANSI escapes stripped from the error');
  ok(t1.error!.includes('Timed out waiting'), 'error text preserved');
  eq(t1.tracePath, 'D:/fake/trace.zip', 'trace path picked up');
  eq(t1.stepScreenshotPaths?.length, 1, 'failure step shot materialized');

  console.log('only-on-failure mode drops step shots for passing tests');
  const parsed2 = await parsePlaywrightResults(reporterJson(), { runDir: path.join(SCRATCH, 'oof'), screenshotMode: 'only-on-failure' });
  eq(parsed2.tests[0].stepScreenshotPaths?.length, 0, 'passing test has no step shots in only-on-failure');
  eq(parsed2.tests[1].stepScreenshotPaths?.length, 1, 'failing test keeps its step shots');

  await fs.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
