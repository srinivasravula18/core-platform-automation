/**
 * Investigation node (bug-investigation framework, Phase 3; flag `AGENT_INVESTIGATE`) — runs between
 * execute_tests and finalize:
 *   1. Deterministic pre-analysis per failure CLUSTER (signature, error kind, console/network correlation)
 *      → a grounded classification guess with per-observation confidence, no LLM required.
 *   2. Optional LLM classification (strict failureClassificationSchema via the sanctioned one-repair loop),
 *      bounded to a per-run budget; the deterministic guess survives any LLM failure.
 *   3. Intent-outcome judge on PASSING mutation cases (the App1 false-PASS class): did the app actually
 *      accomplish the case's intent? Verdict → suspiciousPasses, later filed as an intent defect.
 *   4. Phase 5/6 seams (injectable, inert by default): record read-back for business-rule validation and a
 *      single re-run probe that demotes deterministic bugs to flaky.
 * Contract: NEVER throws; flag off → null (exact current behavior); output goes to the run stash only.
 */
import { readFile } from 'fs/promises';
import {
  failureClassificationSchema,
  intentOutcomeSchema,
  type FailureClassification,
  type IntentOutcome,
  type Observation,
} from '../../../../shared/schemas';
import { systemPromptFor } from '../../../../ai/systemPrompts';
import { failureSignature, classifyErrorKind, type StepLogEntry, type TestResultLike } from '../defectReporter';
import { validateBusinessRules, resolveSchema, type BusinessRuleViolation } from '../../validation/businessRules';
import type { ObjectSchema } from '../../testdata/types';
import { generateStrictObject } from './authoring';

/** Flag reader (lazy, per the dotenv load-order convention) — exported so callers never re-check ad hoc. */
export function isInvestigationEnabled(): boolean {
  return ['1', 'true'].includes(String(process.env.AGENT_INVESTIGATE || '').toLowerCase());
}

export interface InvestigationCaseRef {
  id?: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps?: Array<{ action?: string; expected?: string }>;
}

export interface InvestigationFinding {
  signature: string;
  errorKind: string;
  failingTarget: string | null;
  affectedTests: string[];
  classification: string;
  rootCauseArea: string;
  confidence: number;
  observations: Observation[];
  suggestedAreas: string[];
  severity?: string;
  /** Phase 6: a single re-run of the cluster lead passed → not a deterministic product bug. */
  flaky?: boolean;
  /** Phase 5: schema-driven read-back violations (populated when the readback seam is wired). */
  businessRuleViolations?: string[];
  source: 'deterministic' | 'llm' | 'llm+deterministic';
}

export interface SuspiciousPass {
  title: string;
  reason: string;
  confidence: number;
  observations: Observation[];
}

export interface RecoveryAttempt {
  kind: string;
  target: string;
  outcome: string;
}

export interface InvestigationSummary {
  findings: InvestigationFinding[];
  suspiciousPasses: SuspiciousPass[];
  recoveryAttempts: RecoveryAttempt[];
  llmCalls: number;
}

export interface ClassifyContext {
  caseRef: InvestigationCaseRef | null;
  tests: TestResultLike[];
  errorKind: string;
  failingTarget: string | null;
  error: string;
  stepLog: StepLogEntry[];
  consoleErrors: Array<{ type?: string; text?: string }>;
  networkFailures: Array<Record<string, unknown>>;
  deterministicGuess: { classification: string; confidence: number };
}

export interface JudgeContext {
  caseRef: InvestigationCaseRef | null;
  title: string;
  stepLog: StepLogEntry[];
  consoleErrors: Array<{ type?: string; text?: string }>;
  networkFailures: Array<Record<string, unknown>>;
  /** Phase 5 seam output: the record read back from the platform API after the mutation (null = not found). */
  readback: Record<string, unknown> | null | undefined;
}

export interface InvestigationDeps {
  /** LLM classification — injectable for tests; default uses the strict one-repair loop. */
  classify?: (ctx: ClassifyContext) => Promise<FailureClassification | null>;
  /** LLM intent-outcome judge — injectable for tests. */
  judgeIntent?: (ctx: JudgeContext) => Promise<IntentOutcome | null>;
  /** Phase 5 seam: fetch the record a mutation case created/updated (platform API). Inert when absent. */
  readbackRecord?: (caseTitle: string) => Promise<Record<string, unknown> | null>;
  /** Phase 5 seam: the backend object schema(s) — the authority for business-rule validation. */
  objectSchema?: ObjectSchema[];
  /** Phase 5 seam: sibling records for duplicate detection on unique fields. Inert when absent. */
  listRecords?: (caseTitle: string) => Promise<Array<Record<string, unknown>> | null>;
  /** Phase 6 seam: re-run ONE failing spec; 'passed' demotes the cluster to flaky. Inert when absent. */
  rerunFailing?: (caseTitle: string) => Promise<'passed' | 'failed' | null>;
}

export interface InvestigationNodeInput {
  runId: string;
  tests: TestResultLike[];
  cases: InvestigationCaseRef[];
  /** Compiled spec source per case id — carries the compiler-derived "mutationIntent" marker. */
  compiledSources: Record<string, string>;
  /** case id → title (from workflow state) so compiled sources map back to test titles. */
  caseTitleById: Record<string, string>;
  deps?: InvestigationDeps;
}

const MAX_CLASSIFY_CALLS = 5;
const MAX_JUDGE_CALLS = 5;
const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

async function readJsonSafe<T>(path: string | undefined): Promise<T | null> {
  if (!path) return null;
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** Deterministic classification guess from the error kind alone — honest, bounded confidence. */
export function deterministicClassification(errorKind: string): { classification: string; confidence: number } {
  switch (errorKind) {
    case 'scope-violation': return { classification: 'automation_issue', confidence: 0.9 };
    case 'context-mismatch': return { classification: 'environment', confidence: 0.7 };
    case 'ambiguous-locator': return { classification: 'automation_issue', confidence: 0.6 };
    case 'locator-not-found': return { classification: 'ui', confidence: 0.5 };
    case 'timeout': return { classification: 'performance', confidence: 0.4 };
    case 'assertion': return { classification: 'functional', confidence: 0.5 };
    case 'navigation': return { classification: 'environment', confidence: 0.5 };
    default: return { classification: 'unknown', confidence: 0.2 };
  }
}

const INVESTIGATOR_ADDENDUM = `
--- FAILURE INVESTIGATION METHODOLOGY ---
You are investigating an automated test failure. You receive the authored case, the failure error, the
per-step execution log, console errors and failed network calls captured DURING the run.
Method: reproduce the failure mentally from the step log → cross-check every hypothesis against the
captured evidence → classify. Rules:
- Every observation MUST cite the evidence that supports it in verifiedBy (e.g. "error-text", "step-log",
  "console-log", "network-log", "case-steps"). Never state anything the evidence does not show.
- confidence is YOUR honest probability the statement is true; use low values when evidence is thin.
- classification 'automation_issue' means the TEST/tooling is wrong, not the product.
- Return ONLY the JSON object required by the schema.`;

const JUDGE_ADDENDUM = `
--- INTENT-OUTCOME JUDGMENT ---
A data-mutating test case PASSED its assertions. Your job: decide whether the app actually accomplished
the case's INTENT — assertions can pass while the outcome is wrong (record created in the wrong place,
wrong status, not persisted). You receive the case, the per-step log (what was filled/clicked), console
errors, failed network calls, and — when available — the record read back from the backend API.
Rules:
- intentSatisfied=false ONLY with concrete supporting evidence; cite it in observations[].verifiedBy.
- If the read-back record is null after a create flow, that is strong evidence the intent failed.
- If evidence is insufficient to doubt the pass, return intentSatisfied=true with your honest confidence.
- Return ONLY the JSON object required by the schema.`;

function zodValidate<T>(schema: { safeParse: (v: unknown) => any }) {
  return (wire: unknown): { value: T | null; issues: string[] } => {
    const r = schema.safeParse(wire);
    return r.success
      ? { value: r.data as T, issues: [] }
      : { value: null, issues: r.error.issues.map((i: any) => `${i.path.join('.') || 'value'}: ${i.message}`) };
  };
}

function defaultClassify(ctx: ClassifyContext): Promise<FailureClassification | null> {
  const prompt = [
    `CASE: ${ctx.caseRef?.title ?? ctx.tests[0]?.title ?? 'unknown'}`,
    ctx.caseRef?.steps?.length ? `AUTHORED STEPS:\n${ctx.caseRef.steps.map((s, i) => `${i + 1}. ${s.action || ''}${s.expected ? ` → expect: ${s.expected}` : ''}`).join('\n')}` : '',
    `AFFECTED TESTS (${ctx.tests.length}): ${ctx.tests.map((t) => t.title).join('; ')}`,
    `ERROR (${ctx.errorKind}${ctx.failingTarget ? ` on "${ctx.failingTarget}"` : ''}): ${ctx.error.slice(0, 500)}`,
    ctx.stepLog.length ? `STEP LOG:\n${ctx.stepLog.map((s) => `${s.n ?? '?'}. ${s.kind}${s.label ? ` "${s.label}"` : ''}${s.value ? ` = "${s.value}"` : ''} → ${s.ok === false ? `FAILED (${s.error || ''})` : 'ok'}`).join('\n').slice(0, 2000)}` : '',
    ctx.consoleErrors.length ? `CONSOLE ERRORS:\n${ctx.consoleErrors.map((c) => `[${c.type}] ${c.text}`).join('\n').slice(0, 1200)}` : '',
    ctx.networkFailures.length ? `FAILED NETWORK CALLS:\n${JSON.stringify(ctx.networkFailures.slice(0, 10)).slice(0, 1200)}` : '',
    `DETERMINISTIC GUESS: ${ctx.deterministicGuess.classification} (confidence ${ctx.deterministicGuess.confidence}) — confirm or correct it against the evidence.`,
  ].filter(Boolean).join('\n\n');

  return generateStrictObject<FailureClassification, FailureClassification>({
    node: 'investigate_failures',
    agent: 'defectTriage',
    schema: failureClassificationSchema,
    schemaName: 'failure_classification',
    system: `${systemPromptFor('defectTriage')}\n${INVESTIGATOR_ADDENDUM}`,
    prompt,
    validate: zodValidate<FailureClassification>(failureClassificationSchema),
  }).then((r) => r.value);
}

function defaultJudgeIntent(ctx: JudgeContext): Promise<IntentOutcome | null> {
  const prompt = [
    `CASE: ${ctx.title}`,
    ctx.caseRef?.description ? `INTENT: ${ctx.caseRef.description}` : '',
    ctx.caseRef?.steps?.length ? `AUTHORED STEPS:\n${ctx.caseRef.steps.map((s, i) => `${i + 1}. ${s.action || ''}${s.expected ? ` → expect: ${s.expected}` : ''}`).join('\n')}` : '',
    ctx.stepLog.length ? `EXECUTED STEP LOG:\n${ctx.stepLog.map((s) => `${s.n ?? '?'}. ${s.kind}${s.label ? ` "${s.label}"` : ''}${s.value ? ` = "${s.value}"` : ''} → ${s.ok === false ? 'FAILED' : 'ok'}`).join('\n').slice(0, 2000)}` : '',
    ctx.consoleErrors.length ? `CONSOLE ERRORS DURING RUN:\n${ctx.consoleErrors.map((c) => `[${c.type}] ${c.text}`).join('\n').slice(0, 1000)}` : '',
    ctx.networkFailures.length ? `FAILED NETWORK CALLS DURING RUN:\n${JSON.stringify(ctx.networkFailures.slice(0, 10)).slice(0, 1000)}` : '',
    ctx.readback === undefined
      ? 'BACKEND READ-BACK: not available for this run.'
      : ctx.readback === null
        ? 'BACKEND READ-BACK: the record this flow should have created/updated was NOT FOUND via the API.'
        : `BACKEND READ-BACK RECORD:\n${JSON.stringify(ctx.readback).slice(0, 1500)}`,
  ].filter(Boolean).join('\n\n');

  return generateStrictObject<IntentOutcome, IntentOutcome>({
    node: 'investigate_failures',
    agent: 'defectTriage',
    schema: intentOutcomeSchema,
    schemaName: 'intent_outcome',
    system: `${systemPromptFor('defectTriage')}\n${JUDGE_ADDENDUM}`,
    prompt,
    validate: zodValidate<IntentOutcome>(intentOutcomeSchema),
  }).then((r) => r.value);
}

/** Case ids whose compiled spec commits data (the compiler embeds its plan-derived marker in MISSION). */
export function mutationCaseTitles(compiledSources: Record<string, string>, caseTitleById: Record<string, string>): Set<string> {
  const titles = new Set<string>();
  for (const [caseId, code] of Object.entries(compiledSources)) {
    if (code.includes('"mutationIntent":true')) {
      const title = caseTitleById[caseId];
      if (title) titles.add(title);
    }
  }
  return titles;
}

/**
 * The investigation itself — pure orchestration over injected/default deps. NEVER throws: every stage is
 * individually guarded, and an LLM failure leaves the deterministic finding standing.
 */
export async function runInvestigationNode(input: InvestigationNodeInput): Promise<InvestigationSummary> {
  const summary: InvestigationSummary = { findings: [], suspiciousPasses: [], recoveryAttempts: [], llmCalls: 0 };
  try {
    const deps = input.deps ?? {};
    const casesByTitle = new Map(input.cases.map((c) => [c.title, c]));
    const failedTests = input.tests.filter((t) => FAILED_STATUSES.has(String(t.status)));

    // Pre-load per-test evidence artifacts once.
    const stepLogsByTitle = new Map<string, StepLogEntry[]>();
    const consoleByTitle = new Map<string, Array<{ type?: string; text?: string }>>();
    const networkByTitle = new Map<string, Array<Record<string, unknown>>>();
    for (const t of input.tests) {
      const steps = await readJsonSafe<StepLogEntry[]>(t.stepLogPath);
      if (steps?.length) stepLogsByTitle.set(t.title, steps);
      const consoleLog = await readJsonSafe<Array<{ type?: string; text?: string }>>(t.consoleLogPath);
      if (consoleLog?.length) consoleByTitle.set(t.title, consoleLog.slice(0, 10));
      const network = await readJsonSafe<Array<Record<string, unknown>>>(t.networkLogPath);
      if (network?.length) networkByTitle.set(t.title, network.slice(0, 15));
    }

    const mutationTitlesSet = mutationCaseTitles(input.compiledSources ?? {}, input.caseTitleById ?? {});

    // ---- 1+2. Failure clusters: deterministic pre-analysis, then bounded LLM refinement ----
    const clusters = new Map<string, { sig: ReturnType<typeof failureSignature>; tests: TestResultLike[] }>();
    for (const t of failedTests) {
      const sig = failureSignature(t, stepLogsByTitle.get(t.title));
      const c = clusters.get(sig.hash);
      if (c) c.tests.push(t);
      else clusters.set(sig.hash, { sig, tests: [t] });
    }

    for (const { sig, tests } of clusters.values()) {
      const lead = tests[0];
      const stepLog = stepLogsByTitle.get(lead.title) ?? [];
      const consoleErrors = consoleByTitle.get(lead.title) ?? [];
      const networkFailures = networkByTitle.get(lead.title) ?? [];
      const guess = deterministicClassification(sig.errorKind);

      const observations: Observation[] = [
        { statement: `Failure kind "${sig.errorKind}"${sig.target ? ` anchored on "${sig.target}"` : ''}: ${String(lead.error || '').slice(0, 160)}`, confidence: 0.95, verifiedBy: ['error-text'] },
      ];
      const failedStep = [...stepLog].reverse().find((s) => s.ok === false);
      if (failedStep) {
        observations.push({ statement: `Execution reached step ${failedStep.n ?? '?'} (${failedStep.kind}${failedStep.label ? ` "${failedStep.label}"` : ''}) before failing; all prior steps succeeded.`, confidence: 0.95, verifiedBy: ['step-log'] });
      }
      if (consoleErrors.length) {
        observations.push({ statement: `${consoleErrors.length} console error(s) captured during the test, e.g. "${String(consoleErrors[0]?.text || '').slice(0, 120)}".`, confidence: 0.9, verifiedBy: ['console-log'] });
      }
      if (networkFailures.length) {
        observations.push({ statement: `${networkFailures.length} failed/erroring network call(s) captured during the test.`, confidence: 0.9, verifiedBy: ['network-log'] });
      }

      const finding: InvestigationFinding = {
        signature: sig.hash,
        errorKind: sig.errorKind,
        failingTarget: sig.target,
        affectedTests: tests.map((t) => t.title),
        classification: guess.classification,
        rootCauseArea: sig.target ?? '',
        confidence: guess.confidence,
        observations,
        suggestedAreas: [],
        source: 'deterministic',
      };

      // Phase 5: a FAILED mutation case with a read-back seam — business-rule violations on whatever the
      // API stored reclassify the finding to a DATA/product bug (the failure isn't just a UI symptom).
      if (deps.readbackRecord && deps.objectSchema?.length && mutationTitlesSet.has(lead.title)) {
        try {
          const readback = await deps.readbackRecord(lead.title);
          if (readback !== undefined) {
            const submitted = stepLog
              .filter((s) => (s.kind === 'fill' || s.kind === 'select') && s.label && s.value)
              .map((s) => ({ field: String(s.label), value: String(s.value) }));
            const schema = resolveSchema(submitted, readback ?? null, deps.objectSchema);
            const violations = validateBusinessRules({ record: readback, submitted, schema, allRecords: null });
            if (violations.length) {
              finding.businessRuleViolations = violations.map((v) => `${v.rule}${v.field ? ` (${v.field})` : ''}: ${v.message}`);
              finding.classification = 'data';
              finding.confidence = Math.max(finding.confidence, ...violations.map((v) => v.confidence));
              finding.observations.push(...violations.map((v) => ({ statement: v.message, confidence: v.confidence, verifiedBy: v.verifiedBy })));
            }
          }
        } catch { /* read-back is best-effort */ }
      }

      // Phase 6 seam: one re-run probe of the cluster lead; a pass demotes the finding to flaky.
      if (deps.rerunFailing) {
        try {
          const verdict = await deps.rerunFailing(lead.title);
          if (verdict) {
            summary.recoveryAttempts.push({ kind: 'rerun', target: lead.title, outcome: verdict });
            if (verdict === 'passed') {
              finding.flaky = true;
              finding.classification = 'synchronization';
              finding.observations.push({ statement: `A single re-run of "${lead.title}" PASSED — the failure is not deterministic (flaky/timing).`, confidence: 0.85, verifiedBy: ['rerun-probe'] });
            } else {
              finding.observations.push({ statement: `A single re-run of "${lead.title}" failed again — the failure reproduces deterministically.`, confidence: 0.9, verifiedBy: ['rerun-probe'] });
            }
          }
        } catch { /* probe is best-effort */ }
      }

      // Bounded LLM refinement; the deterministic finding survives any LLM failure.
      const classify = deps.classify ?? (isInvestigationEnabled() ? defaultClassify : null);
      if (classify && summary.llmCalls < MAX_CLASSIFY_CALLS) {
        try {
          summary.llmCalls += 1;
          const llm = await classify({
            caseRef: casesByTitle.get(lead.title) ?? null,
            tests,
            errorKind: sig.errorKind,
            failingTarget: sig.target,
            error: String(lead.error || ''),
            stepLog,
            consoleErrors,
            networkFailures,
            deterministicGuess: guess,
          });
          if (llm) {
            // Flaky demotion and business-rule DATA reclassification are deterministic — the LLM never overrides them.
            finding.classification = (finding.flaky || finding.businessRuleViolations?.length) ? finding.classification : llm.classification;
            finding.rootCauseArea = llm.rootCauseArea || finding.rootCauseArea;
            finding.confidence = llm.confidence;
            finding.observations = [...observations, ...llm.observations];
            finding.suggestedAreas = llm.suggestedAreas;
            finding.severity = llm.severity;
            finding.source = 'llm+deterministic';
          }
        } catch { /* LLM refinement is best-effort */ }
      }
      summary.findings.push(finding);
    }

    // ---- 3. Intent-outcome judge on PASSING mutation cases (the false-PASS class) ----
    const mutationTitles = mutationCaseTitles(input.compiledSources, input.caseTitleById);
    const passedMutations = input.tests.filter((t) => t.status === 'passed' && mutationTitles.has(t.title));
    for (const t of passedMutations) {
      if (summary.llmCalls >= MAX_CLASSIFY_CALLS + MAX_JUDGE_CALLS && !deps.judgeIntent) break;
      try {
        // Phase 5 seam: read the record back first — a missing record is deterministic evidence.
        let readback: Record<string, unknown> | null | undefined = undefined;
        if (deps.readbackRecord) {
          try { readback = await deps.readbackRecord(t.title); } catch { readback = undefined; }
        }
        if (readback === null) {
          summary.suspiciousPasses.push({
            title: t.title,
            reason: 'Assertions passed, but the record this flow should have created/updated was NOT found via the backend API.',
            confidence: 0.9,
            observations: [{ statement: 'Backend read-back returned no matching record after the mutation flow.', confidence: 0.9, verifiedBy: ['api-readback'] }],
          });
          continue; // deterministic verdict — no LLM needed
        }

        // Phase 5: schema-driven business-rule validation of the read-back record. Any violation is a
        // deterministic suspicious pass — the API accepted something the app's own schema forbids.
        if (readback && deps.objectSchema?.length) {
          const submitted = (stepLogsByTitle.get(t.title) ?? [])
            .filter((s) => (s.kind === 'fill' || s.kind === 'select') && s.label && s.value)
            .map((s) => ({ field: String(s.label), value: String(s.value) }));
          const schema = resolveSchema(submitted, readback, deps.objectSchema ?? []);
          let allRecords: Array<Record<string, unknown>> | null = null;
          if (deps.listRecords) { try { allRecords = await deps.listRecords(t.title); } catch { allRecords = null; } }
          const violations: BusinessRuleViolation[] = validateBusinessRules({ record: readback, submitted, schema, allRecords });
          if (violations.length) {
            summary.suspiciousPasses.push({
              title: t.title,
              reason: `Assertions passed, but ${violations.length} business-rule violation(s) were found on the stored record: ${violations.map((v) => v.rule).join(', ')}.`,
              confidence: Math.max(...violations.map((v) => v.confidence)),
              observations: violations.map((v) => ({ statement: v.message, confidence: v.confidence, verifiedBy: v.verifiedBy })),
            });
            continue; // deterministic verdict — stronger than the LLM judge
          }
        }

        const judge = deps.judgeIntent ?? (isInvestigationEnabled() ? defaultJudgeIntent : null);
        if (!judge) continue;
        summary.llmCalls += 1;
        const verdict = await judge({
          caseRef: casesByTitle.get(t.title) ?? null,
          title: t.title,
          stepLog: stepLogsByTitle.get(t.title) ?? [],
          consoleErrors: consoleByTitle.get(t.title) ?? [],
          networkFailures: networkByTitle.get(t.title) ?? [],
          readback,
        });
        if (verdict && !verdict.intentSatisfied) {
          summary.suspiciousPasses.push({
            title: t.title,
            reason: verdict.reason || 'The case passed its assertions but the judge found the intent unsatisfied.',
            confidence: verdict.confidence,
            observations: verdict.observations,
          });
        }
      } catch { /* judging one case must never sink the others */ }
    }
  } catch {
    // Node contract: investigation is report-only enrichment — never fail the run.
  }
  return summary;
}
