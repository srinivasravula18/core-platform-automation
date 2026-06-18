/**
 * Edge Finder — the "Exploration & Discovery" pattern (book Chapter 21) for QA.
 *
 * The goal is to surface the UNTESTED edge cases: error states, boundary inputs,
 * permission/role gaps, concurrency, empty states, and negative/failure paths that a
 * feature's EXISTING test cases do not yet cover. We find them the way a senior engineer
 * explores an unfamiliar system — by deeply researching the app's REAL codebase — and then
 * diff that grounded understanding against the test cases that already exist, proposing only
 * the gaps (the "unknown-unknowns").
 *
 * This REUSES existing infrastructure rather than reinventing it:
 *  - deepParallelResearch (server/ai/research/deepResearch.ts) does the Claude-Code-style
 *    fan-out investigation over the codebase. The research `io` is wired EXACTLY like
 *    supervisor.answerAppQuestionFromCode: search via searchCodeInScope + relevantSourcePaths,
 *    read via readCodeFileInScope, scope = { projectId, appId }.
 *  - getOrchestrator (server/ai/orchestrator.ts) makes the single grounded generateObject
 *    call that turns research notes (minus what is already tested) into proposals.
 */
import { z } from 'zod';
import { getOrchestrator } from '../orchestrator';
import { deepParallelResearch, relevantSourcePaths } from '../research/deepResearch';
import { searchCodeInScope, readCodeFileInScope } from '../../features/projects/codeSearch';

export interface EdgeProposal {
  title: string;
  rationale: string;
  subFeature?: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
}

export interface FindUntestedEdgesResult {
  proposals: EdgeProposal[];
  researchNotes: string;
}

const proposalsSchema = z.object({
  proposals: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    subFeature: z.string().default(''),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']).default('Medium'),
  })).default([]),
});

/** Normalize a title for loose comparison: lowercase, collapse to alphanumerics + single spaces. */
function normalizeTitle(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find untested edge cases for a feature: research the real codebase, then propose only the
 * edge/negative/validation scenarios that are grounded in the research AND not already covered
 * by an existing test case title.
 */
export async function findUntestedEdges(opts: {
  feature: string;
  existingCaseTitles?: string[];
  workspaceId?: string;
  userId?: string;
  projectId?: string;
  appId?: string | null;
  maxProposals?: number;
  onProgress?: (label: string) => void;
  signal?: AbortSignal;
}): Promise<FindUntestedEdgesResult> {
  const scopeArg = { projectId: opts.projectId, appId: opts.appId };
  const maxProposals = opts.maxProposals ?? 12;
  const existingTitles = (opts.existingCaseTitles || []).map((t) => String(t || '')).filter(Boolean);

  // 1) Deep parallel research over the REAL codebase, wired exactly like
  //    supervisor.answerAppQuestionFromCode (search → relevantSourcePaths, read → in-scope).
  let researchNotes = '';
  try {
    researchNotes = await deepParallelResearch({
      question: `Edge cases, error states, input validations, permission/role differences, empty states, and negative/failure paths for: ${opts.feature}`,
      io: {
        search: async (terms, limit) =>
          relevantSourcePaths(
            ((await searchCodeInScope(terms, scopeArg, limit)).matches as Array<{ path: string }>).map((m) => m.path),
            terms,
          ),
        read: (p, b) => readCodeFileInScope(p, scopeArg, b),
      },
      orchestratorAgent: 'featureAnalyst',
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      onProgress: opts.onProgress,
    });
  } catch {
    // Research is best-effort; proceed with empty notes so the caller still gets a result.
    researchNotes = '';
  }

  // 2) ONE grounded generateObject call: diff the research notes against what is already
  //    tested and propose only the untested edge/negative/validation gaps.
  opts.onProgress?.('Diffing the research against existing test coverage…');
  const existingBlock = existingTitles.length
    ? existingTitles.map((t) => `- ${t}`).join('\n')
    : '(none provided)';
  const prompt = `You are a QA edge-case explorer for THIS application. Using ONLY the grounded research notes below (compiled by reading the app's real codebase), propose test scenarios that target UNTESTED edges of the feature: "${opts.feature}".

Propose ONLY edge/negative/validation scenarios that are BOTH:
  (a) grounded in the research notes below (do not invent behaviour not in the notes), AND
  (b) NOT already covered by one of the existing test case titles listed below.

Focus on unknown-unknowns: error states, boundary inputs, permission/role gaps, concurrency, empty states, and negative/failure paths. Do not invent behaviour not in the notes. For each proposal give a concise title, a one-line rationale (why this edge matters, grounded in the notes), the relevant subFeature if any, and a priority of Low, Medium, High, or Critical.

GROUNDED RESEARCH NOTES:
${researchNotes || '(no research notes were produced)'}

EXISTING TEST CASE TITLES (already covered — do NOT propose these):
${existingBlock}

Return strict JSON matching the schema: {"proposals":[{"title":"...","rationale":"...","subFeature":"...","priority":"Medium"}]}.`;

  const orch = await getOrchestrator('featureAnalyst', { workspaceId: opts.workspaceId, userId: opts.userId });
  const res = await orch.generateObject({ prompt, schema: proposalsSchema, userMessage: opts.feature });

  // Guardrail short-circuit → no proposals (but still return the research notes we gathered).
  if ((res as any).shortCircuit) {
    return { proposals: [], researchNotes };
  }

  const raw = ((res as any).object?.proposals || []) as Array<{
    title?: unknown; rationale?: unknown; subFeature?: unknown; priority?: unknown;
  }>;

  // 3) Dedupe against existing titles (normalized substring match), cap, and tidy.
  const existingNorm = existingTitles.map(normalizeTitle).filter(Boolean);
  const seen = new Set<string>();
  const proposals: EdgeProposal[] = [];
  for (const item of raw) {
    const title = String(item?.title || '').trim();
    if (!title) continue;
    const norm = normalizeTitle(title);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    // Skip if this proposal closely matches an existing case title (either direction).
    const alreadyCovered = existingNorm.some((ex) => ex.includes(norm) || norm.includes(ex));
    if (alreadyCovered) continue;
    seen.add(norm);
    const subFeatureRaw = String(item?.subFeature || '').trim();
    const priority = item?.priority as EdgeProposal['priority'];
    proposals.push({
      title,
      rationale: String(item?.rationale || '').trim(),
      subFeature: subFeatureRaw ? subFeatureRaw : undefined,
      priority: (['Low', 'Medium', 'High', 'Critical'] as const).includes(priority) ? priority : 'Medium',
    });
    if (proposals.length >= maxProposals) break;
  }

  return { proposals, researchNotes };
}
