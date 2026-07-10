/**
 * Live runtime lineage validation for the Selector Registry fix. Throwaway; no production code
 * modified. Runs the REAL subsystem against the authenticated app and prints the lineage counts:
 *   Playwright DOM → Evidence Registry → Selector Registry → verified_selectors → Prompt selectors.
 *   PROBE_USER=<user> PROBE_PASS=<password> npx tsx scripts/validate-selector-lineage.ts
 */
import { exploreAndVerifyPage } from '../server/features/agent/domExplorer';
import { runSelectorRegistryPhase, renderSelectorRegistryForPrompt } from '../server/features/agent/pipelineDelta';
import { getRunRegistry } from '../server/features/agent/evidence/registry';
import { recordEvidence } from '../server/features/agent/evidence/registry';
import { PROVENANCE } from '../server/features/agent/evidence/provenance';

// All deployment-specific config comes from the environment — nothing hardcoded.
const TARGET_URL = process.env.TARGET_URL || '';
const USER = process.env.PROBE_USER || '';
const PASS = process.env.PROBE_PASS || '';
if (!TARGET_URL || !USER || !PASS) {
  console.error('Set TARGET_URL, PROBE_USER, PROBE_PASS in the environment before running.');
  process.exit(1);
}

async function main() {
  console.log(`TARGET_URL = ${TARGET_URL}  user=${USER}\n`);
  const vp = await exploreAndVerifyPage({ targetUrl: TARGET_URL, credentials: { username: USER, password: PASS } });
  const domCount = vp.coverage.total_extracted;
  const domVerified = vp.coverage.verified;
  console.log(`[1] Playwright DOM (captureSemanticSnapshot) : ${domCount} elements (${domVerified} verified-unique)`);

  // Assemble a run exactly as the pipeline would (dom_exploration + Evidence Registry record).
  const run: any = { id: 'lineage-run', dom_exploration: vp, inspection_contexts: [] };
  recordEvidence(run, {
    id: 'dom', type: 'dom', status: domCount === 0 ? 'failed' : 'present',
    source: PROVENANCE.LIVE_DOM, confidence: domVerified > 0 ? 'verified-live' : 'inferred',
    producer: 'DOMExplorer', payload: vp.elements, artifactCount: domCount, payloadRef: 'dom_exploration',
  });
  console.log(`[2] Evidence Registry (dom artifacts)         : ${getRunRegistry(run).get('dom')?.artifactCount ?? 0}`);

  const registry = runSelectorRegistryPhase({ run, onPhase: () => {} });
  console.log(`[3] Selector Registry (total / verified)      : ${registry.coverage.total_elements} / ${registry.coverage.verified}  (promoted_from_dom=${registry.coverage.promoted_from_dom})`);
  console.log(`[4] Evidence Registry (selector artifacts)    : ${getRunRegistry(run).get('selector_registry')?.artifactCount ?? 0}`);

  const structuredVerified = registry.verified_selectors.filter((s: any) => s.verified).length;
  console.log(`[5] WorkerContext selector count (verified)   : ${structuredVerified}`);

  const block = renderSelectorRegistryForPrompt(run.selector_registry);
  const promptSelectorCount = (block.match(/\n {2}Selector: /g) || []).length;
  console.log(`[6] Prompt Verified-Selector count           : ${promptSelectorCount}`);
  console.log(`[7] selectorRegistryBlock empty?             : ${block.length === 0}`);

  console.log('\n--- prompt block (first 900 chars) ---');
  console.log(block.slice(0, 900));

  const passLine = domCount > 0 && registry.coverage.total_elements > 0 && structuredVerified > 0 && promptSelectorCount > 0;
  console.log(`\nLINEAGE INTEGRITY: ${passLine ? 'PASS — selectors survive DOM→Registry→WorkerContext→Prompt' : 'FAIL'}`);
  process.exit(passLine ? 0 : 1);
}
main().catch((e) => { console.error('LINEAGE ERROR:', e?.message || e); process.exit(1); });
