import type { ApiRequestCase, GroundedLocator, ObjectDescriptor, TestCase } from "@atp/shared";
import { lintScript, defaultChromeAllow } from "@atp/grounding";

/**
 * Accuracy / confidence scoring by COMPARING the agent's response against the repo's metadata
 * (the source of truth) — not arbitrary weights.
 *
 * accuracy = matched references / total references, where every object/field the agent referenced
 * and every locator it emitted is checked to actually exist in (and agree with) the repo metadata.
 * A hallucinated field or an ungrounded locator is a mismatch and lowers the score. For a fully
 * grounded (deterministic) output this is 100%; for an LLM that invents a field it drops measurably.
 */
export type ConfidenceLevel = "high" | "medium" | "low";

export interface Mismatch {
  kind: "object" | "field" | "locator";
  value: string;
  reason: string;
}

export interface RepoMatch {
  /** 0–100 = matched / total references that exist in the repo metadata */
  score: number;
  matched: number;
  total: number;
  level: ConfidenceLevel;
  mismatches: Mismatch[];
}

export function levelFor(score: number): ConfidenceLevel {
  if (score >= 90) return "high";
  if (score >= 70) return "medium";
  return "low";
}

const LOCATOR_RE = /getByLabel\(|getByTestId\(|getByPlaceholder\(|getByRole\([^)]*name\s*:|\.locator\(/g;
function countLocators(src: string): number {
  return (src.match(LOCATOR_RE) ?? []).length;
}

export interface AgentOutput {
  cases?: TestCase[];
  apiCases?: ApiRequestCase[];
  script?: string;
  catalog?: GroundedLocator[];
}

/** Compare the agent's produced artifacts to the repo metadata and score the agreement. */
export function scoreAgainstRepo(descriptor: ObjectDescriptor, agent: AgentOutput): RepoMatch {
  const fieldSet = new Set(descriptor.fields.map((f) => f.api_name));
  const objApi = descriptor.object.api_name;
  let total = 0;
  let matched = 0;
  const mismatches: Mismatch[] = [];

  const checkField = (field: string, where: string) => {
    total++;
    if (fieldSet.has(field)) matched++;
    else mismatches.push({ kind: "field", value: field, reason: `field '${field}' not found in ${objApi} metadata (${where})` });
  };
  const checkObject = (obj: string) => {
    total++;
    if (obj === objApi) matched++;
    else mismatches.push({ kind: "object", value: obj, reason: `object '${obj}' does not match ${objApi}` });
  };

  // UI cases: object + every targeted field must exist in the repo
  for (const c of agent.cases ?? []) {
    checkObject(c.object);
    for (const s of c.steps) if (s.target?.field) checkField(s.target.field, "case step");
  }

  // API payloads: every key is a field reference (values may be intentionally invalid in negatives,
  // so we only verify the field NAMES against the repo, not the test data values)
  for (const r of agent.apiCases ?? []) {
    for (const k of Object.keys(r.body ?? {})) checkField(k, "api payload");
  }

  // Script: every locator must be grounded in the repo-derived catalog (selector-lint)
  if (agent.script && agent.catalog) {
    const locs = countLocators(agent.script);
    const ungrounded = lintScript(agent.script, agent.catalog, defaultChromeAllow).violations.filter((v) => v.kind === "ungrounded" || v.kind === "xpath");
    total += locs;
    matched += Math.max(0, locs - ungrounded.length);
    for (const v of ungrounded) mismatches.push({ kind: "locator", value: v.locator, reason: v.reason });
  }

  const score = total === 0 ? 100 : Math.round((matched / total) * 100);
  return { score, matched, total, level: levelFor(score), mismatches };
}

/** Run accuracy = grounding agreement of the executed scripts (repo match), reported with pass-rate. */
export interface RunAccuracy extends RepoMatch {
  passRate: number;
  flaky: number;
}
export function scoreRun(repoMatch: RepoMatch, run: { total: number; passed: number; flaky: number }): RunAccuracy {
  return { ...repoMatch, passRate: run.total === 0 ? 0 : Math.round((run.passed / run.total) * 100), flaky: run.flaky };
}
