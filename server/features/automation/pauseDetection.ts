import type { PauseRequest } from '../../../core/shared/pause';
import type { RecordingStep } from './types';

export interface PauseProposal extends PauseRequest {
  reason: 'one-time-code' | 'cross-origin' | 'idle-gap';
}

type StepDraft = Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>;
type Observation = { autocomplete?: string; idleMs?: number };

const ONE_TIME_CODE_RE = /\b(?:one[ -]?time|verification|security|auth(?:entication)?)[ -]?(?:code|pin)|\botp\b|\bmfa\b/i;
const IDLE_PROPOSAL_MS = 15_000;

function origin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

/** Add review-only pause proposals. No proposal changes the executable script until accepted. */
export function proposeRecordingPauses(script: string, steps: StepDraft[], appUrl: string, observations: Record<number, Observation> = {}): StepDraft[] {
  const appOrigin = origin(appUrl);
  let currentOrigin = appOrigin;
  let ordinal = 0;

  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    const navigation = line.match(/\.(?:goto|waitForURL)\(\s*['"`]([^'"`]+)['"`]/);
    if (navigation) currentOrigin = origin(navigation[1]) || currentOrigin;
    if (!/(?:getBy\w+\([^\n]+\)\.(?:fill|type|press|selectOption|setInputFiles|check|uncheck)|runner\.(?:fill|press|select|check|uncheck))\(/.test(line)) continue;

    const step = steps[ordinal];
    const observation = observations[ordinal] || {};
    ordinal += 1;
    if (!step) continue;
    const label = String(step.metadata?.label || step.locator || 'this step');
    let proposal: PauseProposal | undefined;
    if (observation.autocomplete === 'one-time-code' || ONE_TIME_CODE_RE.test(label)) {
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'input', prompt: `Enter the ${label}`, masked: true, reason: 'one-time-code' };
    } else if (appOrigin && currentOrigin && currentOrigin !== appOrigin) {
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'manual_action', prompt: `Complete the external sign-in step for ${label}`, requiresHeaded: true, reason: 'cross-origin' };
    } else if (Number(observation.idleMs || step.metadata?.idleMs || 0) >= IDLE_PROPOSAL_MS) {
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'manual_action', prompt: `Complete the manual action before ${label}`, requiresHeaded: true, reason: 'idle-gap' };
    }
    if (proposal) step.metadata = { ...step.metadata, pauseProposal: proposal };
  }
  return steps;
}
