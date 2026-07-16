/**
 * Defect Reporter (bug-investigation framework, Phase 2) — deterministic, pure module that turns a run's
 * per-test failures into PROFESSIONAL clustered defect reports:
 *   - failure-signature clustering: N tests sharing one root symptom → ONE defect (frequency: N), never N duplicates
 *   - cross-run dedup: an existing open auto-defect with the same @sig tag gets an occurrence update, not a copy
 *   - regression detection: a case that passed in a prior run and fails now is flagged @regression
 *   - deterministic risk block: frequency + regression + mutation criticality → 0-100 score
 *   - full report fields: repro steps (from the authored case), expected/actual, environment, test data used,
 *     evidence gallery refs, console-error excerpt — everything a human needs to reproduce and triage.
 * No I/O and no LLM here: callers (runtime terminal hook, tests) supply inputs and persist outputs.
 */
import { createHash } from 'crypto';

/** Loose per-test record: the graph path passes full TestResult; the legacy path passes execution_result.tests. */
export interface TestResultLike {
  title: string;
  status: string;
  durationMs?: number;
  error?: string;
  screenshotPath?: string;
  stepScreenshotPaths?: string[];
  tracePath?: string;
  consoleLogPath?: string;
  networkLogPath?: string;
  stepLogPath?: string;
}

export interface DefectCaseRef {
  id?: string;
  title: string;
  preconditions?: string;
  priority?: string;
  steps?: Array<{ action?: string; expected?: string }>;
}

/** One prior run's per-case verdicts (caseTitle → 'passed'|'failed'|…), newest first in the input array. */
export interface PriorRunSummary {
  runId: string;
  at?: string;
  verdicts: Record<string, string>;
}

export interface ExistingDefectRef {
  id: string;
  status?: string;
  tags?: string[];
  metadata?: any;
}

/** MissionRunner step-log entry (parsed from TestResult.stepLogPath by the caller). */
export interface StepLogEntry {
  n?: number;
  kind?: string;
  label?: string | null;
  value?: string | null;
  ok?: boolean;
  ms?: number;
  error?: string;
}

export interface DefectReporterInput {
  runId: string;
  /** runs-table row id when known — becomes linkedRunId (FK-safe: pass null if uncertain). */
  runRecordId?: string | null;
  baseUrl?: string;
  missionScope?: string;
  appLabel?: string;
  mutationIntent?: boolean;
  environment?: Record<string, string | undefined>;
  cases?: DefectCaseRef[];
  tests: TestResultLike[];
  evidenceShots?: Array<{ title: string; url?: string; screenshotUrl: string; status?: string }>;
  /** Parsed step logs keyed by test title (caller reads TestResult.stepLogPath). */
  stepLogsByTitle?: Record<string, StepLogEntry[]>;
  /** Console error/pageerror excerpts keyed by test title (caller reads TestResult.consoleLogPath). */
  consoleByTitle?: Record<string, Array<{ type?: string; text?: string }>>;
  priorRuns?: PriorRunSummary[];
  existingDefects?: ExistingDefectRef[];
  scope?: { projectId?: string | null; appId?: string | null; ownerId?: string | null };
}

export interface DefectDraft {
  id: string;
  title: string;
  description: string;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  status: string;
  linkedRunId?: string | null;
  evidence: Array<{ title: string; url?: string; screenshotUrl: string; status?: string }>;
  tags: string[];
  approvalState: string;
  proposedBy: string;
  sourceRunId: string;
  projectId?: string | null;
  appId?: string | null;
  ownerId?: string | null;
  metadata: DefectMetadata;
}

export interface DefectMetadata {
  signature: string;
  errorKind: string;
  failingTarget: string | null;
  normalizedMessage: string;
  frequency: number;
  affectedTests: string[];
  regression: boolean;
  lastPassedRunId?: string | null;
  lastPassedAt?: string | null;
  risk: { score: number; level: 'low' | 'medium' | 'high'; factors: string[] };
  environment: Record<string, string>;
  testDataUsed: Array<{ field: string; value: string }>;
  consoleErrors: Array<{ type?: string; text?: string }>;
  occurrences: number;
  firstSeenRunId: string;
  lastSeenRunId: string;
  investigation?: unknown;
  recoveryAttempts?: unknown[];
  suspiciousPass?: boolean;
}

/** Merge instructions for an existing same-signature defect: occurrence bump, never a duplicate row. */
export interface DefectOccurrenceUpdate {
  id: string;
  tags: string[];
  metadata: Partial<DefectMetadata> & { occurrences: number; lastSeenRunId: string };
}

export interface DefectReport {
  drafts: DefectDraft[];
  updates: DefectOccurrenceUpdate[];
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Strip run-specific noise (ANSI, quoted values, durations, big numbers) so one bug = one message shape. */
export function normalizeFailureMessage(error?: string): string {
  return String(error || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/["'`][^"'`\n]{0,160}["'`]/g, '"…"')
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/gi, 'N$2')
    .replace(/\b\d{3,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 220);
}

/** Deterministic error-kind classification from the raw failure text (no LLM). */
export function classifyErrorKind(error?: string): string {
  const e = String(error || '');
  if (!e) return 'unknown';
  if (/MISSION SCOPE VIOLATION/i.test(e)) return 'scope-violation';
  if (/MISSION CONTEXT MISMATCH/i.test(e)) return 'context-mismatch';
  if (/Timed?\s?out|timeout/i.test(e)) return 'timeout';
  if (/toBeVisible|toBeHidden|toContainText|toHaveValue|toBeEnabled|toBeDisabled|toBeGreaterThan|expect\(/i.test(e)) return 'assertion';
  if (/strict mode violation|resolved to \d+ elements/i.test(e)) return 'ambiguous-locator';
  if (/no verified selector|not found|unable to find|waiting for locator/i.test(e)) return 'locator-not-found';
  if (/net::|ERR_|ECONNREFUSED|navigation/i.test(e)) return 'navigation';
  return 'unknown';
}

/** The step target the failure anchors to: last failing step-log label, else a locator quoted in the error. */
export function failingTargetOf(test: TestResultLike, stepLog?: StepLogEntry[]): string | null {
  const failedStep = [...(stepLog ?? [])].reverse().find((s) => s.ok === false);
  if (failedStep?.label) return String(failedStep.label).slice(0, 120);
  const m = /getBy\w+\(([^)]{0,100})\)|locator\('([^']{0,100})'\)/.exec(String(test.error || ''));
  if (m) return (m[1] || m[2] || '').slice(0, 120) || null;
  return null;
}

export interface FailureSignature {
  hash: string;
  errorKind: string;
  target: string | null;
  normalizedMessage: string;
}

/** signature = normalized(error kind + failing step target + bounded message) — the clustering key. */
export function failureSignature(test: TestResultLike, stepLog?: StepLogEntry[]): FailureSignature {
  const errorKind = classifyErrorKind(test.error);
  const target = failingTargetOf(test, stepLog);
  const normalizedMessage = normalizeFailureMessage(test.error);
  return { hash: sha1(`${errorKind}|${target ?? ''}|${normalizedMessage}`).slice(0, 12), errorKind, target, normalizedMessage };
}

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

function reproStepsFor(caseRef: DefectCaseRef | undefined, stepLog: StepLogEntry[] | undefined): string {
  if (caseRef?.steps?.length) {
    return caseRef.steps
      .map((s, i) => `${i + 1}. ${s.action || '(step)'}${s.expected ? `\n   Expected: ${s.expected}` : ''}`)
      .join('\n');
  }
  if (stepLog?.length) {
    return stepLog
      .map((s, i) => `${i + 1}. ${s.kind || 'step'}${s.label ? ` "${s.label}"` : ''}${s.value ? ` = "${s.value}"` : ''}${s.ok === false ? '  ← FAILED HERE' : ''}`)
      .join('\n');
  }
  return '(no authored steps available — see the attached step evidence)';
}

function testDataFrom(stepLog: StepLogEntry[] | undefined): Array<{ field: string; value: string }> {
  return (stepLog ?? [])
    .filter((s) => (s.kind === 'fill' || s.kind === 'select') && s.label && s.value)
    .map((s) => ({ field: String(s.label), value: String(s.value) }))
    .slice(0, 20);
}

function riskBlock(frequency: number, regression: boolean, mutation: boolean): DefectMetadata['risk'] {
  const factors: string[] = [`${frequency} test(s) affected`];
  let score = 20 + Math.min(40, frequency * 10);
  if (regression) { score += 25; factors.push('regression: previously passing case now fails'); }
  if (mutation) { score += 15; factors.push('data-mutating flow (writes tenant data)'); }
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low', factors };
}

function severityOf(frequency: number, regression: boolean, mutation: boolean): DefectDraft['severity'] {
  if (regression && mutation) return 'Critical';
  if (regression || mutation || frequency >= 3) return 'High';
  return 'Medium';
}

/** Latest prior run in which this case title PASSED (input priorRuns must be newest-first). */
function lastPassOf(title: string, priorRuns: PriorRunSummary[]): PriorRunSummary | null {
  for (const run of priorRuns) {
    if (String(run.verdicts?.[title] || '').toLowerCase() === 'passed') return run;
  }
  return null;
}

/**
 * Build one professional defect draft per failure SIGNATURE (plus occurrence updates for existing
 * same-signature defects). Pure and deterministic: same input → same output, ids idempotent per run+signature.
 */
export function buildDefectDrafts(input: DefectReporterInput): DefectReport {
  const failed = (input.tests ?? []).filter((t) => FAILED_STATUSES.has(String(t.status)));
  if (!failed.length) return { drafts: [], updates: [] };

  const casesByTitle = new Map((input.cases ?? []).map((c) => [c.title, c]));
  const priorRuns = input.priorRuns ?? [];

  // 1. Cluster by failure signature.
  const clusters = new Map<string, { sig: FailureSignature; tests: TestResultLike[] }>();
  for (const t of failed) {
    const sig = failureSignature(t, input.stepLogsByTitle?.[t.title]);
    const existing = clusters.get(sig.hash);
    if (existing) existing.tests.push(t);
    else clusters.set(sig.hash, { sig, tests: [t] });
  }

  // 2. Cross-run dedup index: open auto-defects by @sig tag.
  const openBySig = new Map<string, ExistingDefectRef>();
  for (const d of input.existingDefects ?? []) {
    if (/^(closed|resolved|done|fixed)$/i.test(String(d.status || ''))) continue;
    const sigTag = (d.tags ?? []).find((t) => t.startsWith('@sig:'));
    if (sigTag) openBySig.set(sigTag.slice('@sig:'.length), d);
  }

  const runId8 = input.runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'RUN';
  const drafts: DefectDraft[] = [];
  const updates: DefectOccurrenceUpdate[] = [];

  for (const { sig, tests } of clusters.values()) {
    const lead = tests[0];
    const titles = tests.map((t) => t.title);
    const frequency = tests.length;
    const stepLog = input.stepLogsByTitle?.[lead.title];
    const caseRef = casesByTitle.get(lead.title);

    // Regression: ANY affected case passed in a prior run.
    let lastPassed: PriorRunSummary | null = null;
    for (const title of titles) {
      const hit = lastPassOf(title, priorRuns);
      if (hit) { lastPassed = hit; break; }
    }
    const regression = lastPassed !== null;
    const mutation = input.mutationIntent === true;
    const risk = riskBlock(frequency, regression, mutation);

    const evidence = (input.evidenceShots ?? []).filter((s) => titles.some((t) => String(s.title || '').startsWith(t)));
    const consoleErrors = (input.consoleByTitle?.[lead.title] ?? []).slice(0, 5);

    const existing = openBySig.get(sig.hash);
    if (existing && existing.id !== `DEF-AUTO-${runId8}-${sig.hash.slice(0, 6).toUpperCase()}`) {
      // Same failure already on file from a prior run → occurrence update, never a duplicate defect.
      const prevMeta = (existing.metadata ?? {}) as Partial<DefectMetadata>;
      const mergedTests = Array.from(new Set([...(prevMeta.affectedTests ?? []), ...titles]));
      const tags = Array.from(new Set([...(existing.tags ?? []), ...(regression ? ['@regression'] : [])]));
      updates.push({
        id: existing.id,
        tags,
        metadata: {
          occurrences: Number(prevMeta.occurrences ?? 1) + 1,
          lastSeenRunId: input.runId,
          affectedTests: mergedTests,
          frequency: Math.max(Number(prevMeta.frequency ?? 0), frequency),
          regression: Boolean(prevMeta.regression) || regression,
          ...(regression && lastPassed ? { lastPassedRunId: lastPassed.runId, lastPassedAt: lastPassed.at ?? null } : {}),
          risk,
        },
      });
      continue;
    }

    const environment: Record<string, string> = {
      url: String(input.baseUrl || ''),
      app: String(input.appLabel || ''),
      missionScope: String(input.missionScope || ''),
      runId: input.runId,
      browser: 'chromium (headless)',
      engine: 'langgraph',
      ...(Object.fromEntries(Object.entries(input.environment ?? {}).filter(([, v]) => v != null)) as Record<string, string>),
    };

    const expected = caseRef?.steps?.length
      ? caseRef.steps.map((s) => s.expected).filter(Boolean).slice(-1)[0] || 'All case steps complete without errors.'
      : 'All case steps complete without errors.';
    const failedStep = [...(stepLog ?? [])].reverse().find((s) => s.ok === false);
    const actual = [
      lead.error ? String(lead.error).slice(0, 400) : `Test "${lead.title}" ${lead.status}.`,
      failedStep ? `Failing step: ${failedStep.kind || 'step'}${failedStep.label ? ` "${failedStep.label}"` : ''} (step ${failedStep.n ?? '?'}).` : '',
    ].filter(Boolean).join('\n');

    const description = [
      `${frequency} test(s) failed with the same failure signature (${sig.errorKind}${sig.target ? ` on "${sig.target}"` : ''}).`,
      '',
      `Affected tests:`,
      ...titles.map((t) => `- ${t}`),
      '',
      `Error (${sig.errorKind}): ${String(lead.error || 'no error text').slice(0, 300)}`,
      regression && lastPassed ? `\nREGRESSION: passed in run ${lastPassed.runId}${lastPassed.at ? ` (${lastPassed.at})` : ''}, fails now.` : '',
      `\nRisk ${risk.score}/100 (${risk.level}): ${risk.factors.join('; ')}.`,
    ].filter((line) => line !== '').join('\n');

    drafts.push({
      id: `DEF-AUTO-${runId8}-${sig.hash.slice(0, 6).toUpperCase()}`,
      title: `[Auto] ${sig.errorKind}${sig.target ? ` on "${sig.target}"` : ''} — ${lead.title}`.slice(0, 180),
      description,
      stepsToReproduce: [
        caseRef?.preconditions ? `Preconditions: ${caseRef.preconditions}\n` : '',
        reproStepsFor(caseRef, stepLog),
      ].join(''),
      expected: String(expected),
      actual,
      severity: severityOf(frequency, regression, mutation),
      status: 'Open',
      linkedRunId: input.runRecordId ?? null,
      evidence,
      tags: [
        '@auto',
        `@sig:${sig.hash}`,
        `@kind:${sig.errorKind}`,
        ...(regression ? ['@regression'] : []),
        ...(mutation ? ['@mutation'] : []),
      ],
      approvalState: 'approved',
      proposedBy: 'QA Assistant',
      sourceRunId: input.runId,
      projectId: input.scope?.projectId ?? null,
      appId: input.scope?.appId ?? null,
      ownerId: input.scope?.ownerId ?? null,
      metadata: {
        signature: sig.hash,
        errorKind: sig.errorKind,
        failingTarget: sig.target,
        normalizedMessage: sig.normalizedMessage,
        frequency,
        affectedTests: titles,
        regression,
        lastPassedRunId: lastPassed?.runId ?? null,
        lastPassedAt: lastPassed?.at ?? null,
        risk,
        environment,
        testDataUsed: testDataFrom(stepLog),
        consoleErrors,
        occurrences: 1,
        firstSeenRunId: input.runId,
        lastSeenRunId: input.runId,
      },
    });
  }

  // Stable order: highest risk first, then id — deterministic output for identical input.
  drafts.sort((a, b) => b.metadata.risk.score - a.metadata.risk.score || a.id.localeCompare(b.id));
  return { drafts, updates };
}
