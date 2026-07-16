/**
 * Phase 7 — Visual-regression baseline tests. Proves (offline, scratch dirs): baseline seeding from passing
 * tests only, deterministic dimension diff via PNG header parse, generous byte-fallback content diff,
 * report-only shape, and baseline lifecycle (seed → identical clean → changed flagged).
 *   npx tsx scripts/test-visual-baseline.ts   (npm run test:visual-baseline)
 */
import path from 'path';
import fs from 'fs/promises';
import {
  caseSignature,
  readPngSize,
  diffImages,
  diffRunSteps,
  isVisualRegressionEnabled,
} from '../server/features/agent/validation/visualBaseline';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };
const eq = (a: unknown, b: unknown, n: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} (got ${JSON.stringify(a)})`);

const SCRATCH = path.resolve(process.cwd(), '.testflow-pw', 'scratch', `visual-${process.pid}`);
const BASELINES = path.join(SCRATCH, 'baselines');

/** Minimal PNG: real signature + IHDR width/height + deterministic body bytes. */
function fakePng(width: number, height: number, filler = 7, size = 4000): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([head, ihdr, Buffer.alloc(size, filler)]);
}

async function main() {
  await fs.mkdir(SCRATCH, { recursive: true });

  console.log('flag + primitives');
  delete process.env.VISUAL_REGRESSION;
  ok(!isVisualRegressionEnabled(), 'flag absent → disabled');
  process.env.VISUAL_REGRESSION = '1';
  ok(isVisualRegressionEnabled(), 'flag=1 → enabled');
  ok(caseSignature('Create account') === caseSignature('Create account'), 'case signature is stable');
  ok(caseSignature('Create account') !== caseSignature('Delete account'), 'distinct cases → distinct signatures');
  eq(readPngSize(fakePng(1280, 720)), { width: 1280, height: 720 }, 'PNG header parse');
  ok(readPngSize(Buffer.from('not a png at all, just text')) === null, 'non-PNG → null');

  console.log('diffImages');
  ok(diffImages(fakePng(1280, 720), fakePng(1280, 720)) === null, 'identical → no diff');
  const dim = diffImages(fakePng(1280, 720), fakePng(1280, 500));
  eq(dim?.kind, 'dimension-change', 'height change → dimension-change');
  ok(!!dim && dim.message.includes('1280x720') && dim.message.includes('1280x500'), 'message names both sizes');
  const content = diffImages(fakePng(1280, 720, 7), fakePng(1280, 720, 200));
  eq(content?.kind, 'content-change', 'massive byte divergence → content-change');
  const minor = diffImages(fakePng(1280, 720, 7, 4000), fakePng(1280, 720, 7, 4010));
  ok(minor === null, 'tiny size wobble stays under the report-only threshold');

  console.log('diffRunSteps lifecycle: seed (pass only) → identical clean → change flagged');
  const shots = async (name: string, bufs: Buffer[]) => {
    const dir = path.join(SCRATCH, name);
    await fs.mkdir(dir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < bufs.length; i += 1) {
      const p = path.join(dir, `s${i + 1}.png`);
      await fs.writeFile(p, bufs[i]);
      paths.push(p);
    }
    return paths;
  };

  const run1 = await diffRunSteps({
    tests: [
      { title: 'Create account', status: 'passed', stepScreenshotPaths: await shots('r1-pass', [fakePng(1280, 720), fakePng(1280, 720, 9)]) },
      { title: 'Broken case', status: 'failed', stepScreenshotPaths: await shots('r1-fail', [fakePng(1280, 720)]) },
    ],
    baselineRoot: BASELINES,
  });
  eq(run1.findings.length, 0, 'first run never produces findings');
  eq(run1.seeded, 2, 'passing test seeds its step baselines');
  eq(run1.compared, 0, 'nothing compared on first sighting');
  const failDir = path.join(BASELINES, caseSignature('Broken case'));
  ok(await fs.access(failDir).then(() => false).catch(() => true), 'FAILING test does NOT seed a baseline');

  const run2 = await diffRunSteps({
    tests: [{ title: 'Create account', status: 'passed', stepScreenshotPaths: await shots('r2', [fakePng(1280, 720), fakePng(1280, 720, 9)]) }],
    baselineRoot: BASELINES,
  });
  eq(run2.findings.length, 0, 'identical rerun → clean');
  eq(run2.compared, 2, 'both steps compared');
  eq(run2.seeded, 0, 'nothing reseeded');

  const run3 = await diffRunSteps({
    tests: [{ title: 'Create account', status: 'passed', stepScreenshotPaths: await shots('r3', [fakePng(1280, 400), fakePng(1280, 720, 9)]) }],
    baselineRoot: BASELINES,
  });
  eq(run3.findings.length, 1, 'changed step flagged, unchanged step clean');
  eq(run3.findings[0].kind, 'dimension-change', 'dimension change detected');
  eq(run3.findings[0].step, 1, 'finding names the step');
  eq(run3.findings[0].caseTitle, 'Create account', 'finding names the case');
  ok(!!run3.findings[0].baselinePath && !!run3.findings[0].currentPath, 'finding carries both image paths');
  ok(run3.findings[0].confidence > 0 && run3.findings[0].confidence <= 1, 'confidence bounded');

  console.log('robustness');
  const run4 = await diffRunSteps({
    tests: [{ title: 'Ghost', status: 'passed', stepScreenshotPaths: [path.join(SCRATCH, 'does-not-exist.png')] }],
    baselineRoot: BASELINES,
  });
  eq(run4.findings.length + run4.seeded + run4.compared, 0, 'unreadable frames are skipped silently');
  const run5 = await diffRunSteps({ tests: [], baselineRoot: BASELINES });
  eq(run5.findings.length, 0, 'empty test list → empty result');

  await fs.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
