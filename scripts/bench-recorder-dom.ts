/**
 * Phase 0 benchmark for the codegen hover freeze (docs/plans/recorder-large-dom-freeze-architecture-plan.md).
 *
 * Measures main-thread blocking caused by Playwright's injected recorder while the pointer sweeps a
 * page, across TWO axes — node count and locator ambiguity. Ambiguity is the axis upstream reporters
 * showed matters most (a ~1k-element page froze worse than a 15k one, playwright#22041), so a
 * node-count-only benchmark would measure the wrong thing.
 *
 * Run: npx tsx scripts/bench-recorder-dom.ts [--headed] [--nodes 1000,5000,15000,40000]
 */
import fs from 'fs';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const OUT_DIR = path.join(process.cwd(), '.testflow-pw', 'scratch', 'bench');
const SWEEP_POINTS = 120;

type Ambiguity = 'unique' | 'repeated';
interface Fixture { name: string; nodes: number; ambiguity: Ambiguity; depth: number; file: string }
interface Sample { totalBlockingMs: number; maxLongTaskMs: number; longTasks: number; sweepWallMs: number }

/** A grid whose cells are either all-distinct or all-identical — the ambiguity axis. */
function fixtureHtml(nodes: number, ambiguity: Ambiguity, depth: number): string {
  const perCell = depth + 2; // wrappers + cell + text node
  const cells = Math.max(20, Math.floor(nodes / perCell));
  const cols = 8;
  const open = Array.from({ length: depth }, (_, i) => `<div class="w${i}">`).join('');
  const close = '</div>'.repeat(depth);
  const body: string[] = [];
  for (let i = 0; i < cells; i++) {
    const label = ambiguity === 'unique' ? `Account ${i} value ${i}` : 'Inactive';
    body.push(`${open}<div role="cell" class="cell" tabindex="0">${label}</div>${close}`);
  }
  return `<!doctype html><meta charset="utf-8"><title>bench ${nodes} ${ambiguity} d${depth}</title>
<style>body{margin:0;font:12px sans-serif}#grid{display:grid;grid-template-columns:repeat(${cols},1fr)}
.cell{padding:6px;border:1px solid #ddd;height:18px;overflow:hidden}</style>
<div id="grid">${body.join('')}</div>`;
}

function writeFixtures(nodeCounts: number[]): Fixture[] {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fixtures: Fixture[] = [];
  for (const nodes of nodeCounts) {
    for (const ambiguity of ['unique', 'repeated'] as Ambiguity[]) {
      for (const depth of [1, 6]) {
        const name = `${nodes}-${ambiguity}-d${depth}`;
        const file = path.join(OUT_DIR, `${name}.html`);
        fs.writeFileSync(file, fixtureHtml(nodes, ambiguity, depth));
        fixtures.push({ name, nodes, ambiguity, depth, file });
      }
    }
  }
  return fixtures;
}

/** Long tasks are the honest proxy for "the page is frozen under the pointer". */
async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__tfLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) (window as any).__tfLongTasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
}

async function sweep(page: Page): Promise<Sample> {
  const box = await page.locator('#grid').boundingBox();
  if (!box) throw new Error('grid not found');
  await page.evaluate(() => { (window as any).__tfLongTasks = []; });
  const started = Date.now();
  // Walk cell to cell: each crossing is what triggers the recorder's hover work.
  for (let i = 0; i < SWEEP_POINTS; i++) {
    const x = box.x + 10 + ((i * 53) % Math.max(1, box.width - 20));
    const y = box.y + 10 + ((i * 31) % Math.max(1, Math.min(box.height, 600) - 20));
    await page.mouse.move(x, y);
  }
  const sweepWallMs = Date.now() - started;
  const durations: number[] = await page.evaluate(() => (window as any).__tfLongTasks || []);
  return {
    sweepWallMs,
    longTasks: durations.length,
    totalBlockingMs: Math.round(durations.reduce((sum, d) => sum + Math.max(0, d - 50), 0)),
    maxLongTaskMs: Math.round(durations.reduce((max, d) => Math.max(max, d), 0)),
  };
}

async function measure(fixture: Fixture, recorder: boolean, headed: boolean): Promise<Sample> {
  const context: BrowserContext = await chromium.launchPersistentContext('', { headless: !headed });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`file://${fixture.file.replace(/\\/g, '/')}`);
    // Enable after navigation: the mode is pushed by the Inspector, and PW_CODEGEN_NO_INSPECTOR would
    // suppress that push entirely, leaving the recorder in NoneTool and measuring nothing.
    if (recorder) await (context as any)._enableRecorder({ language: 'playwright-test', mode: 'recording' });
    await page.waitForTimeout(800);
    if (recorder && !(await page.evaluate(() => !!document.body.getAttribute('data-pw-cursor')))) {
      throw new Error('recorder did not install — benchmark would report false zeros');
    }
    await installLongTaskObserver(page);
    return await sweep(page);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const headed = process.argv.includes('--headed');
  const nodesArg = process.argv[process.argv.indexOf('--nodes') + 1];
  const nodeCounts = process.argv.includes('--nodes') && nodesArg
    ? nodesArg.split(',').map(Number).filter(Number.isFinite)
    : [1000, 5000, 15000, 40000];

  const fixtures = writeFixtures(nodeCounts);
  console.log(`fixtures: ${fixtures.length} in ${OUT_DIR}\n`);
  console.log('fixture'.padEnd(24), 'engine'.padEnd(10), 'blocking'.padStart(9), 'maxTask'.padStart(9), 'tasks'.padStart(7), 'sweep'.padStart(8));

  const rows: any[] = [];
  for (const fixture of fixtures) {
    for (const recorder of [false, true]) {
      const sample = await measure(fixture, recorder, headed);
      const engine = recorder ? 'recorder' : 'baseline';
      rows.push({ ...fixture, engine, ...sample });
      console.log(
        fixture.name.padEnd(24), engine.padEnd(10),
        `${sample.totalBlockingMs}ms`.padStart(9),
        `${sample.maxLongTaskMs}ms`.padStart(9),
        String(sample.longTasks).padStart(7),
        `${sample.sweepWallMs}ms`.padStart(8),
      );
    }
  }

  const report = path.join(OUT_DIR, 'results.json');
  fs.writeFileSync(report, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${report}`);

  // The claim under test: recorder cost must grow with node count AND with ambiguity.
  for (const nodes of nodeCounts) {
    const pick = (a: Ambiguity) => rows.find((r) => r.nodes === nodes && r.ambiguity === a && r.depth === 6 && r.engine === 'recorder');
    const unique = pick('unique'); const repeated = pick('repeated');
    if (unique && repeated) console.log(`${nodes} nodes @ depth 6 — unique ${unique.totalBlockingMs}ms vs repeated ${repeated.totalBlockingMs}ms blocking`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
