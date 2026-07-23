import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { executePlaywrightScripts } from '../server/features/playwright/executionService';
import { runPlaywrightRequest } from '../server/features/playwright/routes';

const id = `manual-run-regression-${process.pid}`;
const script = (title: string) => ({
  filename: `${title}.spec.ts`,
  title,
  code: `import { test, expect } from '@playwright/test'; test('${title}', async () => { expect(1).toBe(1); });`,
});

async function main() {
  const progress: number[] = [];
  const result = await runPlaywrightRequest({
    scripts: [script('first'), script('second')],
    executionId: id,
    onProgress: async ({ completed }: any) => { progress.push(completed); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(progress, [1, 2]);

  const sharedId = `${id}-isolation`;
  assert.equal((await executePlaywrightScripts({ scripts: [script('old'), script('kept')], runId: sharedId })).total, 2);
  assert.equal((await executePlaywrightScripts({ scripts: [script('fresh')], runId: sharedId })).total, 1);

  const root = path.resolve(process.cwd(), '.testflow-pw');
  await Promise.all([
    fs.rm(path.join(root, `${id}-case-1`), { recursive: true, force: true }),
    fs.rm(path.join(root, `${id}-case-2`), { recursive: true, force: true }),
    fs.rm(path.join(root, sharedId), { recursive: true, force: true }),
  ]);
  console.log('PASS: manual execution reports per-script progress and isolates every attempt.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
