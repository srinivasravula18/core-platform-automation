/**
 * Case Critic (Phase 4) — verification as a PEER, not a postscript.
 *
 * The CriticAgent adversarially reviews the author's drafted cases BEFORE they are committed to compile,
 * publishing a CRITIQUE per refuted case on the bus and a `critique.cases` blackboard fact. This is the
 * first real decision-bearing A2A negotiation: the author drafts, the critic refutes with a concrete reason,
 * and the author revises addressing the critique. It is the anti-hallucination lever — the same reason a
 * strong agent runs a verifier/self-critique loop before acting.
 *
 * The checks are DETERMINISTIC and HIGH-PRECISION on purpose: a false refutation would harm a real run, so
 * the critic only refutes what it can prove — exact duplicate titles, empty preconditions, step-less cases,
 * @blocked leakage, and cases wholly disconnected from the verified evidence catalog (a strong hallucination
 * signal). It never invents; it grounds every objection in the draft + the catalog. Flag-gated by
 * AGENT_NATIVE_V1 via its callers — this module is pure and always safe to import.
 */
import { isAgentNativeEnabled } from '../agentNativeFlag';
import { getMessageBus } from '../bus/messageBus';
import { getBlackboard } from '../bus/blackboard';
import { readSharedCatalog } from '../grounding/groundingFacts';
import { behaviorCritique, type BehaviorObservation } from '../../features/agent/behaviorOracle';

const CRITIC = 'CriticAgent';
const AUTHOR = 'TestGenerationAgent';

/** The subset of an authored case the critic inspects (structurally compatible with AuthoredTestCase). */
export interface CritiqueCase {
  title?: string;
  description?: string;
  preconditions?: string;
  tags?: string[];
  steps?: Array<{ action?: string; expected?: string }>;
  /** Optional structured assert/input literals (e.g. from a post-plan critic pass). When absent, literals
   * are extracted from steps[].expected / steps[].action — the NL asserts present at author-cases time. */
  assertValues?: string[];
  inputValues?: string[];
}

export interface CaseVerdict {
  index: number;
  title: string;
  accepted: boolean;
  issues: string[];
  /** Stable category codes per issue (e.g. 'duplicate','ungrounded','assert-transform','assert-template',
   * 'assert-preserve') — lets the CRITIQUE payload route the author's revision without parsing prose. */
  codes: string[];
}

export interface CritiqueResult {
  verdicts: CaseVerdict[];
  /** True when at least one case was refuted (the author should revise). */
  hasIssues: boolean;
  /** A bounded feedback block the author folds into a revision prompt (empty when nothing was refuted). */
  feedback: string;
  summary: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const tokens = (s: unknown) => new Set(norm(s).match(/[a-z][a-z0-9-]{2,}/g) ?? []);

/** Build the allowed-vocabulary token set from the verified evidence catalog (labels + semantic names). */
export function catalogVocabulary(labels: Array<string | null | undefined>): Set<string> {
  const vocab = new Set<string>();
  for (const label of labels) for (const t of tokens(label)) vocab.add(t);
  return vocab;
}

// ---------------------------------------------------------------------------------------------
// Assertion-vs-behavior checks — the class that broke 11/14 production scripts: the author asserts the
// RAW typed input for a case whose whole purpose is that the app TRANSFORMS it (lowercase/trim/derive), or
// leaks an unresolved {{token}} into an assertion. All checks read only title/description/steps and fire
// ONLY on a provable literal contradiction (quoted literals), never on prose → ~zero false refutations.
// ---------------------------------------------------------------------------------------------

const QUOTED = /"([^"]{1,80})"|'([^']{1,80})'|`([^`]{1,80})`/g;

/** Deliberate literals only: quoted strings + explicit structured values. Prose is ignored (no false refute). */
function literals(strs: Array<string | undefined>, extra?: string[]): string[] {
  const out: string[] = [...(extra ?? [])];
  for (const s of strs) {
    if (!s) continue;
    let m: RegExpExecArray | null;
    QUOTED.lastIndex = 0;
    while ((m = QUOTED.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter((v) => v.trim().length > 0);
}
const assertLiterals = (c: CritiqueCase) => literals((c.steps ?? []).map((s) => s.expected), c.assertValues);
const inputLiterals = (c: CritiqueCase) => literals((c.steps ?? []).map((s) => s.action), c.inputValues);

type Xf = 'lowercase' | 'uppercase' | 'trim' | 'strip';
const applyXf = (v: string, x: Xf) => x === 'lowercase' ? v.toLowerCase() : x === 'uppercase' ? v.toUpperCase() : x === 'trim' ? v.trim() : v.replace(/\s+/g, '');

/** The value transform(s) a case's title/description CLAIMS the app performs. */
function statedTransforms(c: CritiqueCase): Xf[] {
  const t = `${c.title ?? ''}. ${c.description ?? ''}`.toLowerCase();
  const xs = new Set<Xf>();
  if (/lower[\s-]?case|lowercased|to lower|normaliz|slugif|sanitiz/.test(t)) xs.add('lowercase');
  if (/upper[\s-]?case|uppercased|to upper/.test(t)) xs.add('uppercase');
  if (/\btrim|trimmed|leading|trailing|surrounding whitespace|normaliz|sanitiz/.test(t)) xs.add('trim');
  if (/\bstrip|stripped|spaces? removed|no spaces|without spaces/.test(t)) xs.add('strip');
  return [...xs];
}
const claimsPreserved = (c: CritiqueCase) =>
  /preserv|manual value|as entered|unchanged|not modified|kept as[- ]?is|exactly as typed/i.test(`${c.title ?? ''}. ${c.description ?? ''}`);

const TEMPLATE_TOKEN = /\{\{\s*[\w.]+\s*\}\}/;

/** Check B: any unresolved {{token}} reaching an assertion (or an input value) — a generated value must be
 * resolved to its concrete form before it is asserted; a raw token can never match the app's output. */
function unresolvedTemplate(c: CritiqueCase): string | null {
  for (const s of c.steps ?? []) {
    const hit = [s.expected, s.action].find((v) => v && TEMPLATE_TOKEN.test(v));
    if (hit) return `Unresolved template token in an assertion — a step expects "${hit}", which still contains a {{token}}. A generated value must be resolved to its concrete value before it is asserted; a raw token can never match the app's rendered output.`;
  }
  for (const v of [...assertLiterals(c), ...inputLiterals(c)]) if (TEMPLATE_TOKEN.test(v)) {
    return `Unresolved template token in an assertion literal ("${v}"). Reference the generated value's resolved form, not the raw {{token}}.`;
  }
  return null;
}

/** Check A: the case claims a transform but a step asserts a literal that violates it (either the raw input
 * verbatim, or a quoted value that is itself not transformed). Acronym-guarded to avoid false positives. */
function transformContradiction(c: CritiqueCase): string | null {
  const xs = statedTransforms(c);
  if (!xs.length) return null;
  const asserts = assertLiterals(c);
  const inputs = inputLiterals(c);
  for (const x of xs) {
    for (const a of asserts) {
      // Tier 1 (strongest): the assert is the raw input verbatim, though the app would transform it.
      const raw = inputs.find((i) => norm(i) === norm(a) && applyXf(i, x) !== i && a === i);
      if (raw) return `Assertion contradicts stated behavior — the title/description says the value is ${x}d, but a step asserts "${a}" (the raw input), which is not ${x}d (the app would produce "${applyXf(a, x)}"). A test asserting the pre-transform value will fail on the real app.`;
      // Tier 2: a quoted assert literal itself violates the transform (guard acronyms: need a lowercase letter or digit/underscore).
      const meaningful = /[a-z]/.test(a) || /[0-9_]/.test(a);
      if (meaningful && applyXf(a, x) !== a) return `Assertion contradicts stated behavior — the title/description says the value is ${x}d, but a step asserts "${a}", which is not ${x}d (the app would produce "${applyXf(a, x)}"). Assert the value AFTER the app's transform.`;
    }
  }
  return null;
}

// Submit / create triggers and validation-error indicators — generic verb conventions, no product names.
const SUBMIT_VERB = /\b(creat|sav(e|ing)|submit|add\b|confirm|apply|register|sign[\s-]?up|update|delete|remov)/i;
const VALIDATION_INTENT = /\b(required|mandatory|validation|invalid|rejected|cannot|not\s+allowed|blank|empty|error)\b/i;
/** An EXPECTED result that asserts a validation/error indicator (not a bare "required" — that also appears in
 * positive "all required fields" prose, which is not an error assertion). */
const assertsValidation = (expected: string) =>
  /\b(error|warning|alert|invalid|rejected|not\s+allowed|cannot|must\s+(be\s+)?(provided|entered|filled|selected)|is\s+required|required\s+(field\s+)?(error|message|indicator)|validation)\b/i.test(expected);

/** Is this a validation/negative case (a requirement is being ENFORCED)? Excludes positive "with required fields". */
function isValidationCase(c: CritiqueCase): boolean {
  const t = `${c.title ?? ''}. ${c.description ?? ''}`;
  if (/\bwith\s+(all\s+)?required\b/i.test(t)) return false;
  return VALIDATION_INTENT.test(t);
}

/** Check D (authoring-side): a validation/required case must assert the error AFTER a submit/create attempt —
 * a required-field error does not exist until you try to save with the field empty. Refutes when the validation
 * is asserted BEFORE the submit step, or when there is no submit step at all. Deterministic from the NL steps. */
function validationSequencing(c: CritiqueCase): string | null {
  if (!isValidationCase(c)) return null;
  const steps = Array.isArray(c.steps) ? c.steps : [];
  const firstVal = steps.findIndex((s) => assertsValidation(String(s.expected ?? '')));
  if (firstVal < 0) return null; // no validation assertion → nothing to sequence
  const submitIdx = steps.findIndex((s) => SUBMIT_VERB.test(String(s.action ?? '')));
  if (submitIdx < 0) {
    return `Validation is asserted but no submit/create/save step triggers it — a required-field/validation error only appears AFTER you attempt to save with the field empty. Add the submit step that triggers the validation, or drop the validation assertion.`;
  }
  if (firstVal < submitIdx) {
    return `The validation error is asserted at step ${firstVal + 1}, BEFORE the submit at step ${submitIdx + 1} that would trigger it — the error does not exist until the create/save is attempted. Move the validation check to AFTER the submit step (leave the field empty, submit, THEN assert the error).`;
  }
  return null;
}

/** Check C: the case claims the value is PRESERVED as entered, but asserts a case/whitespace variant of the
 * input — internally inconsistent regardless of app behavior. Provable from the draft alone. */
function preservationContradiction(c: CritiqueCase): string | null {
  if (!claimsPreserved(c)) return null;
  const asserts = assertLiterals(c);
  const inputs = inputLiterals(c);
  for (const a of asserts) for (const i of inputs) {
    if (a !== i && norm(a) === norm(i)) {
      return `Preservation claim contradicts its own assertion — the case says the value is preserved as entered ("${i}"), but asserts "${a}", which differs only by case/whitespace. Assert "${i}" verbatim, or restate the behavior as normalization and assert the normalized form.`;
    }
  }
  return null;
}

/** Is this case entirely disconnected from the verified evidence? (No step token overlaps the catalog.) A
 * strong hallucination signal — but only meaningful when there IS a catalog to compare against. */
function isUngrounded(c: CritiqueCase, vocab: Set<string>): boolean {
  if (vocab.size === 0) return false; // no catalog → can't judge grounding, so never refute on this basis
  const steps = Array.isArray(c.steps) ? c.steps : [];
  if (!steps.length) return false; // handled by the no-steps check
  for (const step of steps) {
    for (const t of tokens(step.action)) if (vocab.has(t)) return false; // shares vocabulary → grounded enough
  }
  return true;
}

/**
 * Adversarially review the drafted cases. Pure computation of verdicts; when AGENT_NATIVE_V1 is on it also
 * publishes the CRITIQUE traffic + blackboard fact for the run (best-effort, never throws).
 */
export async function critiqueCases(input: {
  runId: string;
  goal: string;
  cases: CritiqueCase[];
  /** Verified evidence labels/semantic names — the grounding authority for the ungrounded check. When
   * omitted, the critic reads the SHARED `evidence.catalog` fact from the blackboard (P5), so any agent
   * holding only a runId grounds against the same evidence the inspector published — not a re-derivation. */
  catalogLabels?: Array<string | null | undefined>;
  /** Observe-then-assert: measured form behaviour. Present → refute validation asserts that contradict it. */
  behavior?: BehaviorObservation;
  causationId?: string | null;
}): Promise<CritiqueResult> {
  const labels = input.catalogLabels ?? (isAgentNativeEnabled() ? await readSharedCatalog(input.runId) : []);
  const vocab = catalogVocabulary(labels);
  const seenTitles = new Map<string, number>();
  const verdicts: CaseVerdict[] = [];

  input.cases.forEach((c, index) => {
    const title = String(c.title || `Case ${index + 1}`);
    const issues: string[] = [];
    const codes: string[] = [];
    const flag = (code: string, issue: string) => { issues.push(issue); codes.push(code); };
    const key = norm(title);

    if (seenTitles.has(key)) flag('duplicate', `Duplicate of case #${seenTitles.get(key)! + 1} ("${title}") — author a distinct behavior or drop it.`);
    else seenTitles.set(key, index);

    const steps = Array.isArray(c.steps) ? c.steps : [];
    if (!steps.length) flag('no-steps', 'No steps — a case with no actions cannot be compiled or executed.');
    if (!norm(c.preconditions)) flag('empty-precondition', 'Empty precondition — state the exact signed-in role/app/data that must exist before the steps run.');
    if ((c.tags ?? []).some((t) => /^@?blocked$/i.test(String(t))) || /^blocked\b/i.test(title)) flag('blocked', 'Marked @blocked — the verified catalog lacks the controls this behavior needs; it must not proceed to compile.');
    if (isUngrounded(c, vocab)) flag('ungrounded', 'Ungrounded — none of the steps reference any control present in the verified evidence catalog (likely hallucinated labels).');

    // Assertion-vs-behavior contradictions — the class that broke the production run.
    const tc = transformContradiction(c); if (tc) flag('assert-transform', tc);
    const tt = unresolvedTemplate(c); if (tt) flag('assert-template', tt);
    const pc = preservationContradiction(c); if (pc) flag('assert-preserve', pc);
    const vs = validationSequencing(c); if (vs) flag('assert-sequencing', vs);

    // Observe-then-assert: refute validation asserts that contradict the measured form behaviour.
    for (const b of behaviorCritique(c, input.behavior)) flag(b.code, b.issue);

    verdicts.push({ index, title, accepted: issues.length === 0, issues, codes });
  });

  const refuted = verdicts.filter((v) => !v.accepted);
  const hasIssues = refuted.length > 0;
  const feedback = refuted.length
    ? `The critic refuted ${refuted.length} of ${verdicts.length} drafted case(s). Revise ONLY these, addressing every objection; keep the accepted cases unchanged:\n`
      + refuted.map((v) => `- "${v.title}": ${v.issues.join(' ')}`).join('\n')
    : '';
  const summary = hasIssues
    ? `Refuted ${refuted.length}/${verdicts.length} case(s): ${refuted.map((v) => v.title).slice(0, 6).join('; ')}.`
    : `Accepted all ${verdicts.length} case(s) — grounded, de-duplicated, executable.`;

  // Publish the negotiation as real A2A traffic (flag-gated; best-effort).
  if (isAgentNativeEnabled()) {
    try {
      const bus = getMessageBus();
      for (const v of refuted) {
        await bus.publish({ runId: input.runId, from: CRITIC, to: AUTHOR, type: 'CRITIQUE', payload: { summary: `Refuted "${v.title}".`, title: v.title, issues: v.issues, codes: v.codes }, causationId: input.causationId ?? null });
      }
      // A RESULT summarizing the verdict (even an all-accept is worth recording — the critic ran).
      await bus.publish({ runId: input.runId, from: CRITIC, to: AUTHOR, type: 'RESULT', payload: { summary, accepted: verdicts.length - refuted.length, refuted: refuted.length }, causationId: input.causationId ?? null });
      await getBlackboard().put(input.runId, 'critique.cases', { verdicts, refuted: refuted.length, accepted: verdicts.length - refuted.length }, CRITIC);
    } catch (err) {
      console.warn(`[critic] failed to publish critique for run ${input.runId} (non-fatal):`, (err as Error)?.message);
    }
  }

  return { verdicts, hasIssues, feedback, summary };
}
