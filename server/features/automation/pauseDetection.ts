import { normalizePauseRequest, type PauseRequest } from '../../../core/shared/pause';
import type { RecordingStep } from './types';

export interface PauseProposal extends PauseRequest {
  reason: 'one-time-code' | 'cross-origin' | 'idle-gap';
}

type StepDraft = Omit<RecordingStep, 'id' | 'recordingId' | 'currentOverride' | 'createdAt' | 'updatedAt'>;
type Observation = { autocomplete?: string; idleMs?: number };

const ONE_TIME_CODE_RE = /\b(?:otp|totp|mfa|2fa|two[ -]?factor|multi[ -]?factor|authenticator|passcode|one[ -]?time(?:[ -]?(?:code|pin|password|passcode))?|(?:verification|security|confirmation|sms|email|access|login|challenge|verify)[ -]?(?:code|pin)|sign[ -]?in[ -]?code|auth(?:entication)?[ -]?(?:code|pin))\b/i;
// Decoys that legitimately contain "code" and must never gate a run.
const NOT_A_CHALLENGE_RE = /\b(?:post(?:al)?|zip|country|area|dial|promo|coupon|discount|referral|currency|language|state|region|product|sort|swift|iban|bic|error|status|http|colou?r)[ -]?code\b/gi;
const ACTION_LINE_RE = /(?:getBy\w+\([^\n]*\)\.(?:fill|type|press|selectOption|setInputFiles)|runner\.(?:fill|press|select))\(/;
const IDLE_PROPOSAL_MS = 15_000;

/** True when the text names an OTP / MFA / verification-code field. Decoy "…code" phrases are stripped first. */
export function isAuthChallengeText(text: string): boolean {
  const value = String(text || '').replace(NOT_A_CHALLENGE_RE, ' ');
  return ONE_TIME_CODE_RE.test(value);
}

function challengePause(id: string, label: string): PauseRequest {
  return {
    id,
    kind: 'manual_action',
    prompt: `Waiting for the verification step (${label}) to be completed in the browser.`,
    hint: 'The run resumes by itself once the code is accepted. Use Resume only if it did not.',
    masked: false,
    requiresHeaded: true,
    onTimeout: 'fail',
  };
}

function firstQuoted(line: string): string {
  // Prefer the accessible name over a role token like `getByRole('textbox', { name: 'OTP' })`.
  const named = line.match(/name:\s*['"`]([^'"`]{1,60})['"`]/) || line.match(/['"`]([^'"`]{1,60})['"`]/);
  return named ? named[1] : 'the verification field';
}

/** The locator chain a recorded action was performed on, e.g. `page.getByRole('textbox', {…})`. */
function locatorOf(line: string): string {
  const match = line.match(/^await\s+(.*)\.(?:fill|type|press|selectOption|setInputFiles)\(/);
  return match ? match[1] : '';
}

/**
 * Execution-time gate injection. A recorded fill/press on an OTP/MFA field is REPLACED by a wait for
 * the user to satisfy the challenge in the browser, so the stale recorded code is never typed and the
 * real code is never captured. The run continues on its own the moment the field clears — no return
 * trip to TestFlow. `tf.pause` remains only as the fallback if that never happens (and its presence is
 * what gives the run an unlimited test timeout). Operates on the dispatched copy only.
 */
export function injectAuthChallengePauses(script: string): string {
  const lines = String(script || '').split('\n');
  const output: string[] = [];
  let gated = false;
  let injected = 0;

  for (const raw of lines) {
    const line = raw.trim();
    // The gate clears only once the challenge was submitted by hand, so the recorded submit that
    // follows it is already done. Keep it, but tolerate the control being gone.
    const submit = gated && line.match(/^await\s+(.*)\.click\(\s*\)\s*;?$/);
    if (submit) {
      gated = false;
      const indent = raw.slice(0, raw.length - raw.trimStart().length);
      output.push(`${indent}await ${submit[1]}.click({ timeout: 5000 }).catch(() => {});`);
      continue;
    }
    if (!ACTION_LINE_RE.test(line) || /\btf\.pause\s*\(/.test(line)) { output.push(raw); continue; }
    if (!isAuthChallengeText(line)) { gated = false; output.push(raw); continue; }
    // Segmented code inputs are one field per digit; collapse the whole run into a single gate.
    if (gated) continue;
    gated = true;
    injected += 1;
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    const pause = normalizePauseRequest(challengePause(`pause-auth-${injected}`, firstQuoted(line)));
    const locator = locatorOf(line);
    if (!locator) { output.push(`${indent}await tf.pause(${JSON.stringify(pause)});`); continue; }
    output.push(`${indent}// TestFlow: complete this verification in the browser — the run continues by itself.`);
    output.push(`${indent}await ${locator}.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});`);
    output.push(`${indent}await ${locator}.waitFor({ state: 'hidden', timeout: ${pause.timeoutMs} })`);
    output.push(`${indent}  .catch(async () => { await tf.pause(${JSON.stringify(pause)}); });`);
  }
  return output.join('\n');
}

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
    if (observation.autocomplete === 'one-time-code' || isAuthChallengeText(label) || isAuthChallengeText(line)) {
      // Review-only: the real gate is injected at dispatch, where it can auto-resume off the page.
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'manual_action', prompt: `Complete the verification for ${label} in the browser`, requiresHeaded: true, reason: 'one-time-code' };
    } else if (appOrigin && currentOrigin && currentOrigin !== appOrigin) {
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'manual_action', prompt: `Complete the external sign-in step for ${label}`, requiresHeaded: true, reason: 'cross-origin' };
    } else if (Number(observation.idleMs || step.metadata?.idleMs || 0) >= IDLE_PROPOSAL_MS) {
      proposal = { id: `pause-step-${step.ordinal + 1}`, kind: 'manual_action', prompt: `Complete the manual action before ${label}`, requiresHeaded: true, reason: 'idle-gap' };
    }
    if (proposal) step.metadata = { ...step.metadata, pauseProposal: proposal };
  }
  return steps;
}
