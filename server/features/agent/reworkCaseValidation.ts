export function requestsAdditionalCaseStep(feedback: unknown): boolean {
  const instruction = String(feedback || '').trim();
  return /\badd\s+(?:(?:a|an|the|one|another|new|additional|extra|final|more|following)\s+){0,4}(?:(?!(?:to|in|for)\b)[\w-]+\s+){0,2}steps?\b/i.test(instruction)
    || /\b(?:append|insert|create)\b[^.!?\n]{0,80}\bsteps?\b/i.test(instruction)
    || /\b(?:add|include)\b[^.!?\n]{0,80}\bas\s+(?:a\s+)?(?:new|additional|extra)?\s*(?:test\s+)?step\b/i.test(instruction);
}

export function addedStepRequirementSatisfied(feedback: unknown, before: unknown[], after: unknown[]): boolean {
  return !requestsAdditionalCaseStep(feedback) || after.length > before.length;
}

export async function generateValidCaseRework<T extends { steps?: unknown[] }>(
  feedback: unknown,
  beforeSteps: unknown[],
  generate: (isRetry: boolean) => Promise<T>,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generate(attempt > 0);
    if (addedStepRequirementSatisfied(feedback, beforeSteps, result.steps || [])) return result;
  }
  return null;
}
