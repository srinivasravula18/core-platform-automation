/**
 * Outcome Validator (observe-then-assert, Phase B) — Skyvern's Validator idea, deterministic and oracle-grounded.
 *
 * After execution, a failure is one of three things and they must never be confused: an assertion-defect (the
 * test claimed something the app does not do — fix the test), an app-defect (the app genuinely misbehaved — a
 * real bug), or infra/flake (timeout, navigation, browser). We classify each failure against the measured
 * behaviour oracle, so "the app did not show the error I expected" resolves to app-defect ONLY when the oracle
 * proves that field is required — otherwise it is the test's own mistake. Pure + import-safe: no Playwright.
 */
import type { BehaviorObservation } from './behaviorOracle';
import { isRequiredField } from './behaviorOracle';

export type OutcomeVerdict = 'assertion-defect' | 'app-defect' | 'infra' | 'unknown';

export interface FailureInput {
  title?: string;
  error?: string;
  status?: string;
}

export interface FailureClassification {
  verdict: OutcomeVerdict;
  reason: string;
  /** The field the failure is about, when identified from the title against the oracle. */
  field?: string;
}

const INFRA = /(timeout|timed out|net::err|econnrefused|econnreset|enotfound|target closed|browser(type)?\.launch|navigation failed|page\.goto|websocket|crashed|out of memory)/i;
const VALIDATION_ASSERT_FAIL = /expectValidation|expectErrorState|required-field|validation error|\[role="alert"\]|aria-invalid|toBeVisible/i;
const VALUE_ASSERT_FAIL = /toHaveValue|expectValue|expected value|to have value/i;
const VALIDATION_INTENT = /\b(required|mandatory|validation|invalid|rejected|cannot|blank|empty)\b/i;

const norm = (s: unknown) => String(s ?? '').toLowerCase();

/** The oracle field whose label appears in the case title (e.g. "Prefix is required" → the Prefix field). */
function fieldFromTitle(title: string, obs: BehaviorObservation | null): BehaviorObservation['fields'][number] | null {
  if (!obs?.probed) return null;
  const t = norm(title);
  return obs.fields.find((f) => f.label && f.label.length >= 3 && t.includes(f.label.toLowerCase())) ?? null;
}

/**
 * Classify one failed test against the observed form behaviour. High-precision: only calls app-defect when the
 * oracle PROVES the app should have behaved differently; otherwise the safer assertion-defect / unknown.
 */
export function classifyFailure(failure: FailureInput, obs: BehaviorObservation | null): FailureClassification {
  const err = String(failure.error ?? '');
  const title = String(failure.title ?? '');

  if (INFRA.test(err)) return { verdict: 'infra', reason: 'Environmental failure (timeout/navigation/browser), not a product or test-logic defect.' };

  const isValidationCase = VALIDATION_INTENT.test(norm(title)) && !/\bwith\s+(all\s+)?required\b/i.test(title);
  const field = fieldFromTitle(title, obs) ?? undefined;

  // A validation assertion that failed because no error appeared.
  if (VALIDATION_ASSERT_FAIL.test(err) && isValidationCase) {
    if (field && obs?.probed) {
      if (!isRequiredField(field, obs)) {
        return { verdict: 'assertion-defect', field: field.label, reason: `The test expected a validation error on "${field.label}", but the form did not reject that field when empty and it is not marked required — the assertion is wrong, not the app.` };
      }
      if (field.autoDerivedFrom) {
        return { verdict: 'assertion-defect', field: field.label, reason: `"${field.label}" auto-derives from "${field.autoDerivedFrom}", so it is not empty unless explicitly cleared — the "required" assertion is mis-premised.` };
      }
      // Field IS required and no error appeared → the app should have shown one (or the field was wrongly filled).
      return { verdict: 'app-defect', field: field.label, reason: `The oracle observed "${field.label}" is required (rejected when empty), but this run showed NO validation error on submit — a genuine product regression if the field was left empty.` };
    }
    return { verdict: 'unknown', reason: 'A validation assertion failed but no oracle field could be matched to judge whether the app or the test is at fault.' };
  }

  // A value assertion mismatch (toHaveValue/expectValue) — usually a transform the test did not account for.
  if (VALUE_ASSERT_FAIL.test(err)) {
    if (field?.transform && field.transform !== 'verbatim') {
      return { verdict: 'assertion-defect', field: field.label, reason: `"${field.label}" is transformed on entry (${field.transform}); the test asserted the raw typed value instead of the app's ${field.transform} output.` };
    }
    return { verdict: 'unknown', reason: 'A value assertion failed; without a matching oracle transform the cause (test vs app) is undetermined.' };
  }

  return { verdict: 'unknown', reason: 'Failure did not match a classifiable pattern against the behaviour oracle.' };
}

export interface OutcomeSummary {
  classifications: Array<FailureClassification & { title: string }>;
  assertionDefects: number;
  appDefects: number;
  infra: number;
  unknown: number;
}

/** Classify a batch of failed tests; the graph uses assertionDefects>0 to route a bounded re-author and
 * surfaces appDefects to the bug framework. */
export function classifyOutcomes(failures: FailureInput[], obs: BehaviorObservation | null): OutcomeSummary {
  const classifications = failures.map((f) => ({ title: String(f.title ?? ''), ...classifyFailure(f, obs) }));
  return {
    classifications,
    assertionDefects: classifications.filter((c) => c.verdict === 'assertion-defect').length,
    appDefects: classifications.filter((c) => c.verdict === 'app-defect').length,
    infra: classifications.filter((c) => c.verdict === 'infra').length,
    unknown: classifications.filter((c) => c.verdict === 'unknown').length,
  };
}
