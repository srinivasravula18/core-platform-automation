/**
 * Versioned, loss-aware compact context assembly (LangGraph migration, Phase 2; Appendix A.4/Section 6.2).
 *
 * The forensic root cause this exists to close: prior context assembly truncated silently (`.slice()`
 * caps with no record), so a later phase could never tell whether evidence never existed or was cut
 * for length. Every candidate — included or excluded — gets a `ContextBudgetEntry` with a `reason`
 * informative enough to answer a "why wasn't X in the prompt" question from that one field alone.
 *
 * Pure leaf module: no I/O, no model calls, deterministic given its inputs. Reuses `contextWindowFor`/
 * `maxOutputFor` from the model-capability registry (never a hardcoded token limit) and the existing
 * `estimateTokens` heuristic from the evidence registry (not a second copy of the same estimator).
 */
import { contextWindowFor, maxOutputFor } from '../providers/types';
import { estimateTokens } from '../../features/agent/evidence/registry';
import type { ContextBudgetEntry } from '../../features/agent/workflow/state';

export const PROMPT_BUDGET_VERSION = 1;

/** Small fixed reservation for the system prompt + task instructions when the caller doesn't supply one. */
const DEFAULT_RESERVED_FOR_SYSTEM_AND_INSTRUCTIONS = 2000;

export interface ContextCandidate {
  key: string;
  content: string;
  /** Higher survives cuts first. Caller decides ordering semantics (e.g. mission > evidence > history). */
  priority: number;
  /** Estimated tokens for this piece; if omitted, this module estimates it via `estimateTokens`. */
  tokenEstimate?: number;
}

export interface AssemblePromptBudgetOptions {
  model: string;
  /** Tokens to hold back for the model's response; defaults to `maxOutputFor(model)`. */
  reservedForOutput?: number;
  /** Tokens to hold back for the system prompt + instructions; defaults to a small fixed constant. */
  reservedForSystemAndInstructions?: number;
}

export interface AssemblePromptBudgetResult {
  included: ContextCandidate[];
  entries: ContextBudgetEntry[];
  totalTokens: number;
}

function tokensFor(candidate: ContextCandidate): number {
  return candidate.tokenEstimate ?? estimateTokens(candidate.content);
}

/**
 * Greedy priority-ordered inclusion: sort by priority descending, walk the list, include while there's
 * room. Every candidate gets an entry regardless of outcome — this is the whole point of the module.
 */
export function assemblePromptBudget(
  candidates: ContextCandidate[],
  opts: AssemblePromptBudgetOptions,
): AssemblePromptBudgetResult {
  const reservedForOutput = opts.reservedForOutput ?? maxOutputFor(opts.model);
  const reservedForSystemAndInstructions = opts.reservedForSystemAndInstructions ?? DEFAULT_RESERVED_FOR_SYSTEM_AND_INSTRUCTIONS;
  const availableForInput = Math.max(0, contextWindowFor(opts.model) - reservedForOutput - reservedForSystemAndInstructions);

  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index)
    .map((entry) => entry.candidate);

  const included: ContextCandidate[] = [];
  const entries: ContextBudgetEntry[] = [];
  let totalTokens = 0;

  for (const candidate of ordered) {
    const tokenEstimate = tokensFor(candidate);
    const remaining = availableForInput - totalTokens;

    if (tokenEstimate <= remaining) {
      totalTokens += tokenEstimate;
      included.push(candidate);
      entries.push({
        key: candidate.key,
        included: true,
        reason: `included — ${tokenEstimate} tokens, ${availableForInput - totalTokens} remaining`,
        tokenEstimate,
      });
    } else {
      const overBy = tokenEstimate - remaining;
      entries.push({
        key: candidate.key,
        included: false,
        reason: `excluded — would exceed budget by ${overBy} tokens (only ${Math.max(0, remaining)} remaining)`,
        tokenEstimate,
      });
    }
  }

  return { included, entries, totalTokens };
}
