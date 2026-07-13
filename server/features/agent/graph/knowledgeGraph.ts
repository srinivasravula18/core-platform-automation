/**
 * QA Knowledge Graph (Phase 6) — end-to-end traceability:
 *   Requirement → Coverage → Case → Script → Evidence → (Bug) → (Regression)
 * so the system can explain WHY a test exists, WHAT it validates, and WHICH regression it guards. Built
 * deterministically from a run's existing artifacts (prompt, coverage_plan, generated_cases,
 * playwright_scripts, evidence, compiler_diagnostics). Pure/read-only; tolerant of missing pieces.
 */
export type KgKind = 'requirement' | 'coverage' | 'case' | 'script' | 'evidence' | 'bug' | 'regression';
export interface KgNode { id: string; kind: KgKind; label: string; attrs?: Record<string, unknown> }
export type KgEdgeKind = 'refines' | 'covers' | 'implements' | 'proves' | 'reveals' | 'prevents';
export interface KgEdge { from: string; to: string; kind: KgEdgeKind }
export interface KnowledgeGraph { nodes: KgNode[]; edges: KgEdge[]; index?: Record<string, KgNode> }

function slug(s: string, i = 0): string {
  return (String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `n${i}`);
}

export function buildKnowledgeGraphFromRun(run: any): KnowledgeGraph {
  const nodes: KgNode[] = [];
  const edges: KgEdge[] = [];
  const add = (n: KgNode) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); };
  const link = (from: string, to: string, kind: KgEdgeKind) => { if (from && to && !edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind }); };

  // Requirement (the mission/prompt is the top-level requirement this run traces to).
  const reqId = 'requirement:run';
  add({ id: reqId, kind: 'requirement', label: String(run?.prompt || run?.artifactName || 'Requirement'), attrs: { scope: run?.mission_context?.executionScope } });

  // Coverage items (from the Phase-5 risk-ordered coverage plan).
  const coverage: any[] = Array.isArray(run?.coverage_plan) ? run.coverage_plan : [];
  coverage.forEach((c, i) => {
    const id = `coverage:${slug(c?.title, i)}`;
    add({ id, kind: 'coverage', label: `${c?.kind}: ${c?.title}`, attrs: { kind: c?.kind, score: c?.score, caseIndex: c?.caseIndex } });
    link(reqId, id, 'refines');
  });

  // Cases.
  const cases: any[] = Array.isArray(run?.generated_cases) ? run.generated_cases : [];
  cases.forEach((tc, i) => {
    const id = `case:${slug(tc?.title, i)}`;
    add({ id, kind: 'case', label: String(tc?.title || `Case ${i + 1}`), attrs: { index: i } });
    // Coverage → Case by caseIndex.
    const cov = coverage.find((c) => c?.caseIndex === i);
    if (cov) link(`coverage:${slug(cov.title)}`, id, 'covers');
    else link(reqId, id, 'refines');
  });

  // Scripts (compiled or legacy) → implement a case by matching title.
  const scripts: any[] = Array.isArray(run?.playwright_scripts) ? run.playwright_scripts : [];
  scripts.forEach((s, i) => {
    const id = `script:${slug(s?.filename || s?.test_case_title, i)}`;
    add({ id, kind: 'script', label: String(s?.filename || s?.test_case_title || `script ${i + 1}`) });
    const tc = cases.find((c) => String(c?.title) === String(s?.test_case_title));
    const caseId = tc ? `case:${slug(tc.title)}` : cases[i] ? `case:${slug(cases[i].title, i)}` : null;
    if (caseId) link(caseId, id, 'implements');
  });

  // Evidence (execution result) → proven by scripts.
  const exec = run?.execution_result;
  if (exec) {
    const id = 'evidence:execution';
    add({ id, kind: 'evidence', label: `Execution: ${exec.passed || 0}/${exec.total || 0} passed`, attrs: { ok: exec.ok, passed: exec.passed, failed: exec.failed } });
    scripts.forEach((s, i) => link(`script:${slug(s?.filename || s?.test_case_title, i)}`, id, 'proves'));
    // Failures surface as bugs the evidence reveals.
    if (exec.failed > 0) {
      const bug = 'bug:execution_failures';
      add({ id: bug, kind: 'bug', label: `${exec.failed} failing test(s)`, attrs: { count: exec.failed } });
      link(id, bug, 'reveals');
    }
  }

  // Compiler diagnostics (ungrounded targets) → bugs in coverage/evidence to fix via re-discovery.
  const diags: any[] = Array.isArray(run?.compiler_diagnostics) ? run.compiler_diagnostics : [];
  if (diags.length) {
    const bug = 'bug:ungrounded_targets';
    add({ id: bug, kind: 'bug', label: `${diags.length} ungrounded target(s)`, attrs: { kinds: [...new Set(diags.map((d) => d.kind))] } });
    link(reqId, bug, 'reveals');
  }

  return indexKnowledgeGraph({ nodes, edges });
}

export function indexKnowledgeGraph(kg: KnowledgeGraph): KnowledgeGraph {
  const index: Record<string, KgNode> = {};
  for (const n of kg.nodes) index[n.id] = n;
  return { ...kg, index };
}

/** Explain a case: the requirement/coverage it traces to and the scripts/evidence that implement/prove it. */
export function explainCase(kg: KnowledgeGraph, caseId: string): {
  case: KgNode | null; coverage: KgNode[]; requirement: KgNode[]; scripts: KgNode[]; evidence: KgNode[];
} {
  const idx = kg.index || indexKnowledgeGraph(kg).index!;
  const node = idx[caseId] || null;
  const inbound = (to: string, kind: KgEdgeKind) => kg.edges.filter((e) => e.to === to && e.kind === kind).map((e) => idx[e.from]).filter(Boolean);
  const outbound = (from: string, kind: KgEdgeKind) => kg.edges.filter((e) => e.from === from && e.kind === kind).map((e) => idx[e.to]).filter(Boolean);
  const coverage = inbound(caseId, 'covers');
  const requirement = coverage.flatMap((c) => inbound(c.id, 'refines')).concat(inbound(caseId, 'refines'));
  const scripts = outbound(caseId, 'implements');
  const evidence = scripts.flatMap((s) => outbound(s.id, 'proves'));
  return { case: node, coverage, requirement, scripts, evidence };
}
