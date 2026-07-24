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

export interface SimpleStep { action: string; expected: string; group?: string; groupIndex?: number }

const humanizedSchema = z.object({
  steps: z.array(z.object({
    action: z.string().describe('One concise, human-readable test step, as a QA analyst would write it.'),
    expected: z.string().describe('The concrete expected result for that step.'),
  })).min(1),
});

export async function humanizeRecordedSteps(
  steps: SimpleStep[],
  ctx: { title?: string; url?: string } = {},
): Promise<SimpleStep[]> {
  const clean = steps.filter((s) => s.action && s.action.trim());
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
- NEVER invent steps, fields, assertions, URLs, or data that are not in the recorded actions.
- Keep any masked secret (••••••) masked — never write a real password.
- Return strict JSON: {"steps":[{"action":string,"expected":string}, ...]}.`,
      schema: humanizedSchema,
    });
    if (shortCircuit || !object?.steps?.length) return steps; // no provider / empty → deterministic fallback
    return object.steps.map((s) => ({ action: s.action, expected: s.expected }));
  } catch {
    return steps; // any failure → deterministic Stage-1 steps (never worse, never blocked)
  }
}
