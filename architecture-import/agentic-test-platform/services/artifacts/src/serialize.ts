import type { TestCase } from "@atp/shared";
import type { Requirement, TestPlan } from "./schemas.ts";

/** IEEE-829 test plan → Markdown (committed to the workspace, shown in chat). */
export function testPlanToMarkdown(p: TestPlan): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_none_");
  return `# Test Plan ${p.identifier}

## Scope
${p.scope}

## Features to test
${list(p.featuresToTest)}

## Features not to test
${list(p.featuresNotToTest)}

## Approach
${p.approach}

## Item pass/fail criteria
${p.passFailCriteria}

## Suspension & resumption criteria
${p.suspensionCriteria}

## Deliverables
${list(p.deliverables)}

## Environment
${p.environment}

## Responsibilities
${p.responsibilities}

## Schedule
${p.schedule}

## Risks & contingencies
${list(p.risks)}

## Approvals
${list(p.approvals)}
`;
}

export function caseToMarkdown(c: TestCase): string {
  const steps = c.steps.map((s, i) => `${i + 1}. ${s.action} → _${s.expected}_`).join("\n");
  return `### ${c.code} — ${c.title}
- **Object:** ${c.object} · **Kind:** ${c.kind} · **Technique:** ${c.technique} · **Priority:** ${c.priority}
- **Suites:** ${c.suiteTypes.join(", ")}
- **Preconditions:** ${c.preconditions.join("; ") || "none"}
- **Requirements:** ${c.requirementRefs.join(", ") || "none"}

${steps}

**Expected:** ${c.expectedResult}`;
}

/** Requirements Traceability Matrix → Markdown table. */
export function rtmToMarkdown(reqs: Requirement[], links: Array<{ requirement: string; cases: string[] }>): string {
  const byReq = new Map(links.map((l) => [l.requirement, l.cases]));
  const rows = reqs.map((r) => `| ${r.code} | ${r.description} | ${(byReq.get(r.code) ?? []).join(", ") || "⚠️ none"} |`);
  return `# Requirements Traceability Matrix

| Requirement | Description | Covering cases |
|---|---|---|
${rows.join("\n")}`;
}
