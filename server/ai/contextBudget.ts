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
  truncated?: boolean;
}

const CHARS_PER_TOKEN = 4;
/** Below this many remaining tokens, a truncated snippet isn't worth including — exclude instead. */
const MIN_TRUNCATED_TOKENS = 50;

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
      entries.push({ key: candidate.key, included: true, reason: `included - ${tokenEstimate} tokens, ${available - totalTokens} remaining`, tokenEstimate });
    } else if (remaining >= MIN_TRUNCATED_TOKENS) {
      // Doesn't fully fit but there's meaningful room left — truncate rather than silently drop.
      const truncatedContent = `${candidate.content.slice(0, remaining * CHARS_PER_TOKEN)}\n[...truncated to fit context budget]`;
      const truncatedTokens = estimateTokens(truncatedContent);
      totalTokens += truncatedTokens;
      included.push({ ...candidate, content: truncatedContent, tokenEstimate: truncatedTokens });
      entries.push({ key: candidate.key, included: true, truncated: true, reason: `truncated - ${tokenEstimate} tokens needed, ${remaining} available`, tokenEstimate: truncatedTokens });
    } else {
      entries.push({
        key: candidate.key,
        included: false,
        reason: `excluded - would exceed budget by ${tokenEstimate - remaining} tokens (${Math.max(0, remaining)} remaining)`,
        tokenEstimate,
      });
    }
  }
  return { included, entries, totalTokens };
}
