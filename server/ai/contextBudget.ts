import { contextWindowFor, maxOutputFor } from './providers/types';
import { estimateTokens } from '../features/agent/evidence/registry';

export const PROMPT_BUDGET_VERSION = 1;

export interface ContextCandidate {
  key: string;
  content: string;
  priority: number;
  tokenEstimate?: number;
}

export interface ContextBudgetEntry {
  key: string;
  included: boolean;
  reason: string;
  tokenEstimate: number;
}

export function assemblePromptBudget(
  candidates: ContextCandidate[],
  opts: { model: string; reservedForOutput?: number; reservedForSystemAndInstructions?: number },
) {
  const available = Math.max(0, contextWindowFor(opts.model) - (opts.reservedForOutput ?? maxOutputFor(opts.model)) - (opts.reservedForSystemAndInstructions ?? 2_000));
  const ordered = candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index);
  const included: ContextCandidate[] = [];
  const entries: ContextBudgetEntry[] = [];
  let totalTokens = 0;
  for (const { candidate } of ordered) {
    const tokenEstimate = candidate.tokenEstimate ?? estimateTokens(candidate.content);
    const remaining = available - totalTokens;
    const fits = tokenEstimate <= remaining;
    if (fits) {
      totalTokens += tokenEstimate;
      included.push(candidate);
    }
    entries.push({
      key: candidate.key,
      included: fits,
      reason: fits
        ? `included - ${tokenEstimate} tokens, ${available - totalTokens} remaining`
        : `excluded - would exceed budget by ${tokenEstimate - remaining} tokens (${Math.max(0, remaining)} remaining)`,
      tokenEstimate,
    });
  }
  return { included, entries, totalTokens };
}
