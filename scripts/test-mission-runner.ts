/**
 * MissionRunner template tests (Phase 4). The runner source is emitted to disk and run by Playwright, so we
 * (1) prove it parses as valid TS (esbuild), and (2) prove it owns navigation/login/verification and builds
 * locators only from verified primitives.
 *   npx tsx scripts/test-mission-runner.ts   (npm run test:mission-runner)
 */
import { transformSync } from 'esbuild';
import { MISSION_RUNNER_SOURCE } from '../server/features/agent/compiler/missionRunner.template';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function main() {
  console.log('valid TypeScript');
  let parsed = true;
  try { transformSync(MISSION_RUNNER_SOURCE, { loader: 'ts' }); } catch (e: any) { parsed = false; console.error('   parse error:', e?.message); }
  ok(parsed, 'MissionRunner source compiles (esbuild ts)');

  console.log('owns navigation / login / verification');
  ok(/async startMission\(/.test(MISSION_RUNNER_SOURCE), 'exposes startMission');
  ok(/async openModule\(/.test(MISSION_RUNNER_SOURCE), 'exposes mission-scoped openModule');
  ok(/page\.goto\(/.test(MISSION_RUNNER_SOURCE), 'MissionRunner (and ONLY it) performs page.goto');
  ok(/MISSION CONTEXT MISMATCH/.test(MISSION_RUNNER_SOURCE), 'verifies mission context, aborts on mismatch');
  ok(/startsWith\(surfacePath/.test(MISSION_RUNNER_SOURCE), 'Admin verified by surface path (self-appId allowed)');

  console.log('recover-once-then-abort with expected-vs-actual diagnostic');
  // verify() re-navigates once when off-context, then throws showing both expected and landed surface.
  ok(/if \(!okc\(this\.ctx\(\)\)\) \{[\s\S]*?page\.goto/.test(MISSION_RUNNER_SOURCE), 'verify re-navigates once before aborting');
  ok(/executed on the wrong/.test(MISSION_RUNNER_SOURCE), 'wrong-surface failure names the wrong facet');
  ok(/Expected path=/.test(MISSION_RUNNER_SOURCE) && /but landed path=/.test(MISSION_RUNNER_SOURCE), 'error shows expected vs actual surface');

  console.log('builds locators only from verified primitives');
  ok(/getByRole\(/.test(MISSION_RUNNER_SOURCE) && /getByTestId\(/.test(MISSION_RUNNER_SOURCE), 'role/testid strategies');
  ok(/no verified selector provided/.test(MISSION_RUNNER_SOURCE), 'throws rather than invent a selector');

  console.log('reveal-then-act (fixes hover-gated controls universally)');
  ok(/private async reveal\(/.test(MISSION_RUNNER_SOURCE), 'has a reveal() step');
  ok(/scrollIntoViewIfNeeded/.test(MISSION_RUNNER_SOURCE) && /\.hover\(\{ timeout/.test(MISSION_RUNNER_SOURCE), 'reveal scrolls into view + hovers to trigger :hover on ancestors');
  ok(/async click\(/.test(MISSION_RUNNER_SOURCE) && /async expectVisible\(/.test(MISSION_RUNNER_SOURCE), 'exposes reveal-aware click + expectVisible');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
