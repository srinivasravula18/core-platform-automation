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

const CRITIC = 'CriticAgent';
const AUTHOR = 'TestGenerationAgent';

/** The subset of an authored case the critic inspects (structurally compatible with AuthoredTestCase). */
export interface CritiqueCase {
  title?: string;
  description?: string;
  preconditions?: string;
  tags?: string[];
  steps?: Array<{ action?: string; expected?: string }>;
}

export interface CaseVerdict {
  index: number;
  title: string;
  accepted: boolean;
  issues: string[];
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
  causationId?: string | null;
}): Promise<CritiqueResult> {
  const labels = input.catalogLabels ?? (isAgentNativeEnabled() ? await readSharedCatalog(input.runId) : []);
  const vocab = catalogVocabulary(labels);
  const seenTitles = new Map<string, number>();
  const verdicts: CaseVerdict[] = [];

  input.cases.forEach((c, index) => {
    const title = String(c.title || `Case ${index + 1}`);
    const issues: string[] = [];
    const key = norm(title);

    if (seenTitles.has(key)) issues.push(`Duplicate of case #${seenTitles.get(key)! + 1} ("${title}") — author a distinct behavior or drop it.`);
    else seenTitles.set(key, index);

    const steps = Array.isArray(c.steps) ? c.steps : [];
    if (!steps.length) issues.push('No steps — a case with no actions cannot be compiled or executed.');
    if (!norm(c.preconditions)) issues.push('Empty precondition — state the exact signed-in role/app/data that must exist before the steps run.');
    if ((c.tags ?? []).some((t) => /^@?blocked$/i.test(String(t))) || /^blocked\b/i.test(title)) issues.push('Marked @blocked — the verified catalog lacks the controls this behavior needs; it must not proceed to compile.');
    if (isUngrounded(c, vocab)) issues.push('Ungrounded — none of the steps reference any control present in the verified evidence catalog (likely hallucinated labels).');

    verdicts.push({ index, title, accepted: issues.length === 0, issues });
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
        await bus.publish({ runId: input.runId, from: CRITIC, to: AUTHOR, type: 'CRITIQUE', payload: { summary: `Refuted "${v.title}".`, title: v.title, issues: v.issues }, causationId: input.causationId ?? null });
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
