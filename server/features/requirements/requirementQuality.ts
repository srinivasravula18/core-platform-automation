/**
 * Post-generation quality gate for generated requirements.
 *
 * Two deterministic, LLM-free passes the requirement pipeline runs AFTER the analyst returns:
 *   - lintRequirementQuality: flags weak/ambiguous wording, non-atomic ("compound") statements,
 *     missing acceptance criteria / MoSCoW priority / code citations, vague acceptance criteria,
 *     and non-functional requirements with no measurable threshold. Non-blocking — findings are
 *     surfaced to the reviewer, not used to reject the draft (coercion stays permissive).
 *   - findDuplicateRequirement: before minting a new REQ id, detects a near-duplicate already in
 *     the requirements collection for the SAME owner + project + app/surface, so re-running the
 *     same query updates the existing requirement in place instead of creating a duplicate.
 *
 * Both are pure functions (existing requirements are passed in) so there is no import cycle with
 * requirementService and they can be unit-tested directly.
 */

export interface QualityFinding {
  requirement: string;
  module: string;
  issue: string;
  severity: 'warn' | 'info';
}

export interface DuplicateMatch {
  id: string;
  title: string;
  reason: string;
}

// Ambiguous / unverifiable words that make a "shall" statement untestable. Deliberately curated to
// avoid noise: legitimate enumerating words ("support", "handle") are excluded; only genuinely vague
// terms are flagged.
const WEAK_WORD_RE = /\b(appropriate(?:ly)?|as needed|as required|etc\.?|and\/or|user-friendly|intuitive|seamless|robust|flexible|efficient(?:ly)?|fast|quick(?:ly)?|reasonabl[ey]|sufficient(?:ly)?|adequate(?:ly)?|approximately|roughly|if possible|where applicable|best effort|tbd|todo|some|several|various|may|might)\b/i;

// Acceptance criteria that assert nothing observable.
const VAGUE_AC_RE = /\b(works?|correct(?:ly)?|as expected|properly|successfully|fine|ok)\b/i;

const MOSCOW = new Set(['must', 'should', 'could', "won't", 'wont', 'will not']);

// NFR categories that imply a numeric budget/threshold should be stated.
const MEASURABLE_NFR_RE = /(perf|latency|through|response|time|scal|throughput|memory|load|rate|concurren)/i;

function norm(s: unknown): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokenSet(s: unknown): Set<string> {
  return new Set(norm(s).split(' ').filter((w) => w.length > 2));
}

function jaccard(a: unknown, b: unknown): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  return inter / (A.size + B.size - inter);
}

/** Lint the generated understanding for common requirement-quality defects. Never throws. */
export function lintRequirementQuality(understanding: any): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const modules = Array.isArray(understanding?.srsModules) ? understanding.srsModules : [];
  for (const mod of modules) {
    const moduleTitle = String(mod?.title || 'Requirements');
    const isNfrModule = /non-functional/i.test(moduleTitle);
    for (const req of Array.isArray(mod?.requirements) ? mod.requirements : []) {
      const title = String(req?.title || 'Requirement');
      const statement = String(req?.statement || '');
      const push = (issue: string, severity: QualityFinding['severity'] = 'warn') =>
        findings.push({ requirement: title, module: moduleTitle, issue, severity });

      if (statement.trim().length < 12) {
        push('Missing or too-short "shall" statement.');
      } else {
        const shalls = (statement.match(/\bshall\b/gi) || []).length;
        if (shalls >= 2) push('Compound statement (multiple "shall") — split into atomic requirements.');
        const weak = statement.match(WEAK_WORD_RE);
        if (weak) push(`Ambiguous wording ("${weak[0]}") — make it specific and testable.`);
      }

      const priority = norm(req?.priority);
      if (!MOSCOW.has(priority)) push('Missing or non-MoSCoW priority (expected Must/Should/Could/Won\'t).');

      const acs = Array.isArray(req?.acceptanceCriteria) ? req.acceptanceCriteria : [];
      const nonEmptyAcs = acs.filter((a: any) => String(a?.given || a?.when || a?.then || '').trim());
      if (nonEmptyAcs.length === 0) {
        push('No acceptance criteria (add Given/When/Then).');
      } else if (nonEmptyAcs.some((a: any) => VAGUE_AC_RE.test(String(a?.then || '')) && String(a?.then || '').trim().split(/\s+/).length <= 4)) {
        push('Vague acceptance criteria ("works"/"as expected") — assert an observable result.', 'info');
      }

      const sources = Array.isArray(req?.sources) ? req.sources.filter((s: any) => String(s || '').trim()) : [];
      if (sources.length === 0) push('No code citation (add the source file that proves this rule).', 'info');

      const category = String(req?.category || '');
      if ((isNfrModule || category) && MEASURABLE_NFR_RE.test(category || moduleTitle)) {
        const hasNumber = /\d/.test(statement) || (Array.isArray(req?.details) && req.details.some((d: any) => /\d/.test(String(d))));
        if (!hasNumber) push('Non-functional requirement has no measurable threshold (state a number/limit).');
      }
    }
  }
  return findings.slice(0, 80);
}

/**
 * Find an existing requirement that is a near-duplicate of this one within the same owner + project
 * + app/surface scope. Deterministic: exact normalized feature-query match, or a high title-token
 * overlap. Returns null when nothing matches (a genuinely new requirement).
 */
export function findDuplicateRequirement(
  understanding: any,
  featureQuery: string,
  existing: any[],
  scope: { ownerId?: string; projectId?: string; appId?: string },
): DuplicateMatch | null {
  const title = String(understanding?.title || '');
  const fq = String(featureQuery || '');
  const scoped = (existing || []).filter((r) =>
    (scope.ownerId ? String(r?.ownerId || '') === scope.ownerId : true) &&
    String(r?.projectId || '') === String(scope.projectId || '') &&
    String(r?.appId || '') === String(scope.appId || ''),
  );
  for (const r of scoped) {
    if (fq && r?.featureQuery && norm(fq) === norm(r.featureQuery)) {
      return { id: r.id, title: String(r.title || ''), reason: 'Same feature query on the same app/surface.' };
    }
    const sim = jaccard(title, r?.title);
    if (sim >= 0.8) {
      return { id: r.id, title: String(r.title || ''), reason: `Title ~${Math.round(sim * 100)}% match on the same app/surface.` };
    }
  }
  return null;
}
