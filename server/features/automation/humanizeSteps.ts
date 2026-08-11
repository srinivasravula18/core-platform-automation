/**
 * Record & Play — AI humanization of recorded steps.
 *
 * Stage 1 (stepGrouping) turns codegen into clean, correctly-labelled, secret-masked atomic actions.
 * This stage rewrites those into a natural, intent-level manual test case — grouping related actions
 * (e.g. filling user id + password) and giving each step a real expected result — the way a QA
 * analyst would write it. It is GROUNDED strictly on the recorded actions (never invents steps or
 * assertions) and falls back to the Stage-1 steps whenever no AI provider is available or the call
 * fails, so the output is never worse than the deterministic parse and never blocked on the LLM.
 */

import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import { concreteExpectedResult } from './stepGrouping';

// sourceStepIds ('step:N', 0-based into the recorded-actions list below) — which raw actions this
// humanized step groups, so live execution can be attributed back to it (see stepGrouping.ts's
// wrapRecordedScriptSteps, which uses the SAME 'step:N' ids on the SAME atomic-step list).
export interface SimpleStep { action: string; expected: string; group?: string; groupIndex?: number; sourceStepIds?: string[] }

const humanizedSchema = z.object({
  steps: z.array(z.object({
    action: z.string().describe('One concise, human-readable test step, as a QA analyst would write it.'),
    expected: z.string().describe('The concrete expected result for that step.'),
    sourceIndexes: z.array(z.number().int().min(1)).min(1).describe('1-based numbers, from the numbered recorded-actions list, of every action this step groups.'),
  })).min(1),
});

export async function humanizeRecordedSteps(
  steps: SimpleStep[],
  ctx: { title?: string; url?: string } = {},
): Promise<SimpleStep[]> {
  const clean = steps.filter((s) => s.action && s.action.trim());
  // Each Stage-1 action becomes its own `step:N` id, matching wrapRecordedScriptSteps's numbering on
  // the same atomic-action list — the fallback path below keeps this 1:1 correlation even without the LLM.
  steps = clean.map((step, i) => ({ ...step, expected: concreteExpectedResult(step.action, step.expected), sourceStepIds: [`step:${i}`] }));
  if (clean.length < 2) return steps; // nothing meaningful to group
  try {
    const orch = await getOrchestrator('caseReworker');
    const { object, shortCircuit } = await orch.generateObject<z.infer<typeof humanizedSchema>>({
      prompt: `You are a senior QA engineer writing a MANUAL test case from a RECORDED browser session.
Test case: "${ctx.title || 'Recorded test'}"${ctx.url ? `\nStarting URL: ${ctx.url}` : ''}

Below are the exact recorded actions (already cleaned, with real field names). Rewrite them into a
concise, readable manual test case that a human QA would write.

Recorded actions (the SOURCE OF TRUTH — do not add anything that is not here):
${clean.map((s, i) => `${i + 1}. ${s.action}`).join('\n')}

Rules:
- Group related low-level actions into one meaningful step (e.g. filling the user id AND the password
  becomes one step like "Enter valid login credentials").
- Write each step as an action a tester performs, in plain language ("Open the login page", "Enter
  valid credentials", "Click the Login button", "Create a new app named 'Auto test 1'").
- For every step give a concrete Expected Result grounded in what the actions imply (e.g. after
  clicking Login and then navigating to an apps URL: "Login succeeds and the Apps page loads").
- sourceIndexes must list EVERY numbered action that step groups — every number 1..${clean.length} must
  appear in exactly one step's sourceIndexes.
- NEVER invent steps, fields, assertions, URLs, or data that are not in the recorded actions.
- Keep any masked secret (••••••) masked — never write a real password.
- Return strict JSON: {"steps":[{"action":string,"expected":string,"sourceIndexes":number[]}, ...]}.`,
      schema: humanizedSchema,
    });
    if (object?.steps) object.steps.forEach((step) => { step.expected = concreteExpectedResult(step.action, step.expected); });
    if (shortCircuit || !object?.steps?.length) return steps; // no provider / empty → deterministic fallback
    // A malformed/partial index list (LLM error) would break correlation silently — fall back rather
    // than ship steps with wrong or missing sourceStepIds.
    const seen = new Set<number>();
    for (const s of object.steps) for (const n of s.sourceIndexes) seen.add(n);
    if (seen.size !== clean.length) return steps;
    return object.steps.map((s) => ({ action: s.action, expected: s.expected, sourceStepIds: s.sourceIndexes.map((n) => `step:${n - 1}`) }));
  } catch {
    return steps; // any failure → deterministic Stage-1 steps (never worse, never blocked)
  }
}
