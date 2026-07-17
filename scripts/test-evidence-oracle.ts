/**
 * Evidence-grounded bug finding — Phase 1: observed DOM state carry-through. Offline, deterministic.
 *   npx tsx scripts/test-evidence-oracle.ts   (npm run test:evidence-oracle)
 *
 * Proves observed element state (disabled/readonly/value) flows to the registry + evidence-graph node
 * when EVIDENCE_ORACLE_V1 is on, and is ABSENT when off (byte-for-byte legacy). The flag is read at
 * call time, so we toggle process.env between runs in the same process.
 */
import { runGroundingNode } from '../server/features/agent/workflow/nodes/grounding';
import type { VerifiedElement } from '../server/features/agent/domExplorer';

let passed = 0, failed = 0;
const ok = (c: boolean, n: string) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ ${n}`); } };

function el(overrides: Partial<VerifiedElement> = {}): VerifiedElement {
  return {
    id: 'el-1', tag: 'input', role: 'textbox', name: 'Version', text: null, aria_label: null,
    placeholder: '1.0.0', input_name: 'create-app-version', data_field: null, element_id: 'create-app-version',
    type: 'text', autocomplete: null, maxLength: null, minLength: null, pattern: null, min: null, max: null, inputMode: null,
    value: '1.0.0', options: [], href: null, tooltip: null, interactive: true,
    resolved_selector: '#create-app-version', selector_strategy: 'css' as any, fallback_selector: null,
    unique: true, visible: true, status: 'verified',
    state: { disabled: false, readonly: false, required: true },
    ...overrides,
  };
}

function main() {
  console.log('flag ON — observed state carried to registry + node');
  process.env.EVIDENCE_ORACLE_V1 = '1';
  const on = runGroundingNode({ elements: [el()], rediscoveryAttempts: 0 });
  const vsOn = on.verifiedSelectors[0];
  ok(vsOn?.fieldMeta?.observed != null, 'observed block present when flag on');
  ok(vsOn?.fieldMeta?.observed?.value === '1.0.0', 'observed.value carries the real default ("1.0.0")');
  ok(vsOn?.fieldMeta?.observed?.disabled === false, 'observed.disabled carries real state (enabled)');
  ok(vsOn?.fieldMeta?.required === true, 'required still carried alongside observed');
  const nodeOn = on.evidenceGraph.nodes[0];
  ok(!!nodeOn && nodeOn.fieldMeta?.observed?.value === '1.0.0', 'observed flows onto the evidence-graph node');

  console.log('flag OFF — byte-for-byte legacy (no observed block)');
  delete process.env.EVIDENCE_ORACLE_V1;
  const off = runGroundingNode({ elements: [el()], rediscoveryAttempts: 0 });
  const vsOff = off.verifiedSelectors[0];
  ok(vsOff?.fieldMeta?.observed == null, 'observed absent when flag off');
  ok(vsOff?.fieldMeta?.required === true, 'required still carried when flag off (unchanged)');

  console.log('disabled control is observed as disabled=true (future oracle input)');
  process.env.EVIDENCE_ORACLE_V1 = '1';
  const disabled = runGroundingNode({ elements: [el({ id: 'btn', tag: 'button', role: 'button', name: 'Create', state: { disabled: true, readonly: false, required: false } })], rediscoveryAttempts: 0 });
  ok(disabled.verifiedSelectors[0]?.fieldMeta?.observed?.disabled === true, 'observed.disabled=true for a disabled button');
  delete process.env.EVIDENCE_ORACLE_V1;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
