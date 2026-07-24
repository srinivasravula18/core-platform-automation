/**
 * AI code-change analysis.
 *
 * Reads the real diff between the previous and current code, classifies each
 * change (UI / functional / business-logic / config), then reconciles the
 * changes against the EXISTING test cases and scripts before proposing anything.
 * The console uses this to ask the human "your existing tests already cover this"
 * vs "here are the new cases/scripts I'll create for the gaps".
 */

import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { Cases, Scripts } from '../../db/repository';
import { db } from '../../shared/storage';
import { pushInboxItem } from '../inbox/routes';
import { scanGitAgentChanges, getGitAgentDiff } from './gitAgentService';
import { nextArtifactId } from '../../shared/artifactIds';

const analysisSchema = z.object({
  summary: z.string(),
  changes: z.array(z.object({
    file: z.string(),
    changeType: z.enum(['ui', 'functional', 'business-logic', 'api', 'db-schema', 'config', 'other']),
    // For API changes: 'new' (endpoint added) | 'modified' (contract changed) | 'removed' | 'none'.
    apiChange: z.enum(['new', 'modified', 'removed', 'none']).default('none'),
    // True when the change adds/alters a DB table, column, migration, or model.
    dbChange: z.boolean().default(false),
    whatChanged: z.string(),
    testFocus: z.string(),
  })).default([]),
  coverage: z.object({
    sufficient: z.boolean().default(false),
    coveredBy: z.array(z.object({
      kind: z.enum(['case', 'script']).default('case'),
      id: z.string(),
      title: z.string().default(''),
      reason: z.string().default(''),
    })).default([]),
    gaps: z.array(z.string()).default([]),
    reasoning: z.string().default(''),
  }).default({ sufficient: false, coveredBy: [], gaps: [], reasoning: '' }),
  proposedCases: z.array(z.object({
    title: z.string(),
    type: z.string(),
    priority: z.string(),
    tags: z.array(z.string()).default([]),
    rationale: z.string(),
    steps: z.array(z.object({ action: z.string(), expected: z.string() })).default([]),
  })).default([]),
  proposedScripts: z.array(z.object({
    filename: z.string(),
    title: z.string(),
    forCase: z.string().optional(),
  })).default([]),
});

export type CodeChangeAnalysis = z.infer<typeof analysisSchema> & {
  baseRef: string;
  headCommit: string;
  branch: string;
  changedFiles: any[];
};

export async function analyzeCodeChanges(
  baseRef = 'auto',
  opts: { workspaceId?: string; userId?: string } = {},
): Promise<CodeChangeAnalysis> {
  const scan = scanGitAgentChanges(baseRef);
  const diff = getGitAgentDiff(baseRef);

  const existingCases = (db.cases || []).slice(0, 80).map((c: any) => ({
    id: c.id,
    title: c.title,
    tags: c.tags || [],
    type: c.type,
    sourcePath: c.sourcePath || '',
    stepCount: (c.steps || []).length,
  }));
  const existingScripts = (db.scripts || []).slice(0, 80).map((s: any) => ({
    id: s.id,
    filename: s.filename,
    title: s.title,
    sourcePath: s.sourcePath || s.gitSourcePath || '',
  }));

  const orch = await getOrchestrator('caseWriter', opts);
  const result = await orch.generateObject<z.infer<typeof analysisSchema>>({
    prompt: `You are a senior QA engineer reviewing recent code changes in a repository. Test ONLY what actually changed.

Changed files (path + heuristic area/risk):
${JSON.stringify(scan.changedFiles, null, 2)}

Actual code diff (previous vs current; may be truncated):
${diff || '(no diff content available — reason from the file list and paths)'}

EXISTING test cases already in the QA repository:
${JSON.stringify(existingCases)}

EXISTING Playwright scripts already in the repository:
${JSON.stringify(existingScripts)}

Do the following and return strict JSON matching the schema:
1) Classify each meaningful change as "ui", "functional", "business-logic", "api", "db-schema", "config", or "other":
   - "ui": layout/interaction/visual — focus tests on rendering, interaction, and visual correctness.
   - "functional"/"business-logic": go deeper into the diff — behavior differences vs the previous code, edge cases, validation, and data correctness.
   - "api": a route/endpoint/controller/handler changed. Set apiChange to "new" when an endpoint is added, "modified" when an existing endpoint's path/method/request/response/validation/auth changed, "removed" when deleted. Focus tests on status codes, request/response contract, validation, auth, and backward compatibility.
   - "db-schema": a table, column, index, migration, schema file (e.g. schema.sql), or data model changed. Set dbChange = true. Focus tests on migrations applying cleanly, data integrity, nullability/defaults, and reads/writes against the new shape.
   Set apiChange and dbChange on every change (default "none"/false when not applicable).
2) Reconcile against the EXISTING cases and scripts listed above. Decide whether they ALREADY adequately cover the changes. In coverage.coveredBy, list the specific existing case/script ids that cover each change and why. Set coverage.sufficient = true ONLY if existing coverage genuinely tests these changes.
3) If coverage is NOT sufficient, in proposedCases propose the MINIMUM set of new test cases (with concrete, executable steps) and in proposedScripts the Playwright script filenames needed to close the gaps. Do NOT duplicate existing coverage. If coverage IS sufficient, leave proposedCases and proposedScripts empty.
If there are no code changes, return an empty changes array and coverage.sufficient = true.`,
    schema: analysisSchema,
    userMessage: 'analyze code changes and reconcile against existing coverage',
  });

  const object = (result as any).object || {
    summary: 'No analysis produced.',
    changes: [],
    // sufficient:false on empty output — never tell the user "already covered" when the
    // analysis actually failed/produced nothing (that suppresses needed gap cases).
    coverage: { sufficient: false, coveredBy: [], gaps: [], reasoning: 'Analysis produced no result; coverage is unknown.' },
    proposedCases: [],
    proposedScripts: [],
  };

  return {
    baseRef: scan.baseRef,
    headCommit: scan.headCommit,
    branch: scan.branch,
    changedFiles: scan.changedFiles,
    ...object,
  };
}

export async function applyCodeChangeTests(
  input: { proposedCases?: any[]; proposedScripts?: any[]; baseRef?: string },
  opts: { workspaceId?: string } = {},
): Promise<{ createdCases: any[]; createdScripts: any[]; inboxItemId?: string }> {
  const workspaceId = opts.workspaceId || 'default';
  const createdCases: any[] = [];
  for (const c of input.proposedCases || []) {
    const id = await nextArtifactId('TC', { sourceText: `${c.title || ''} ${c.rationale || ''}` });
    const rec = await Cases.upsert({
      id,
      title: c.title,
      description: c.rationale || '',
      steps: Array.isArray(c.steps) ? c.steps : [],
      status: 'Draft',
      tags: Array.isArray(c.tags) && c.tags.length ? c.tags : ['@git-change'],
      type: c.type || 'Manual',
      priority: c.priority || 'Medium',
      createdBy: 'Git Agent',
      proposedBy: 'Git Agent',
      approvalState: 'pending_review',
    });
    createdCases.push({ id: rec.id, title: rec.title });
  }

  const createdScripts: any[] = [];
  for (const s of input.proposedScripts || []) {
    const rec = await Scripts.upsert({
      name: s.title || s.filename,
      filename: s.filename,
      title: s.title || s.filename,
      code: '// Draft generated from code-change analysis. Implement against the approved test case.\n',
      language: 'typescript',
      framework: 'playwright',
      status: 'Draft',
      createdBy: 'Git Agent',
    });
    createdScripts.push({ id: rec.id, filename: rec.filename });
  }

  let inboxItemId: string | undefined;
  if (createdCases.length || createdScripts.length) {
    const inbox = await pushInboxItem({
      workspaceId,
      source: 'case',
      sourceId: createdCases[0]?.id || 'git-batch',
      title: `Approve ${createdCases.length} case(s) + ${createdScripts.length} script(s) from code changes`,
      summary: 'Generated from the git diff to cover code changes not already tested by existing coverage.',
      confidence: 80,
      proposedBy: 'Git Agent',
      payload: { caseIds: createdCases.map((c) => c.id), scriptIds: createdScripts.map((s) => s.id) },
      links: [{ label: 'Open Test Cases', href: '/cases' }],
    });
    inboxItemId = inbox.id;
  }

  return { createdCases, createdScripts, inboxItemId };
}
