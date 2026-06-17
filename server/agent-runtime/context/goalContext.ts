/**
 * GoalContext — the single, typed, shared grounding for a deep-run pipeline.
 *
 * "Strike 3": before this module, every worker in the deep run (case writer,
 * Playwright coder, CodeAnalyst) assembled its own notion of the run's
 * "understanding" ad hoc, so the three agents could disagree. The worst case:
 * the CASE WRITER resolved understanding with a chat-history fallback while the
 * CODER read RAW `run.approvedUnderstanding` — on the common path where
 * approvedUnderstanding is empty, the coder was grounded on "not provided"
 * while the case writer had real context. That divergence is the bug.
 *
 * This module is the SINGLE SOURCE OF TRUTH for resolving a run's understanding
 * and for the noise-filtering / chat-derivation helpers that feed it. Every
 * worker reads its grounding through `resolveUnderstanding(run)` (or
 * `buildGoalContext(run)`), so they cannot drift apart.
 */

/**
 * The consolidated grounding shared by every worker in a deep run. Assembled
 * once from the run record so the case writer, coder, and analyst all read the
 * SAME values instead of re-deriving their own.
 */
export interface GoalContext {
  /** The user's raw request prompt for this run. */
  prompt: string;
  /**
   * The authoritative understanding for the run: the human-approved text when
   * present, otherwise the richest grounded answer derived from the chat.
   * This is the value all workers must agree on.
   */
  understanding: string;
  /** The trimmed/noise-filtered conversation that led to this run (most recent turns). */
  conversation: string;
  /** Free-text scope context (e.g. "Project › App") used for knowledge matching. */
  scope: string;
  /** Resolved Playwright target URL for the run. */
  targetUrl: string;
  /** Live browser inspection context (what the inspector actually saw). */
  inspection: any;
  /** Source-grounded feature understanding (from the app's real code), if computed. */
  featureUnderstanding: any;
  /** Selected QA-repository context as prompt-ready text. */
  selectedQaText: string;
}

/**
 * Conversation turns that carry no scope signal — greetings, capability blurbs,
 * raw provider error dumps, and failed "I don't know" answers. They must never
 * be treated as the grounded understanding nor pollute the conversation context.
 *
 * NOTE: behavior is intentionally identical to the prior local copy in
 * server/features/agent/routes.ts — this module is now the single source.
 */
export function isNoiseTurn(content: string): boolean {
  const c = String(content || '').trim();
  if (c.length < 12) return true;
  if (/^\[(openai|anthropic|gemini|google|cli|deepseek|cerebras)\]/i.test(c)) return true; // provider error dump
  if (/invalid_type|invalid_value|"code"\s*:\s*"invalid_/i.test(c)) return true;            // schema-validation dump
  if (/^(hi|hello|hey)[.!,\s]/i.test(c)) return true;                                        // greeting
  if (/^(i['’]?m ready to help|i can draft a test plan|hi\.? i can)/i.test(c)) return true;  // capability blurb
  if (/no matching source files|i don['’]?t know|i can['’]?t list|could not read/i.test(c)) return true; // failed answer
  return false;
}

/**
 * The richest grounded assistant answer in the conversation — the substantive
 * reply the run should be grounded in (e.g. a feature inventory), not a short
 * ack/greeting. Scans the most recent assistant turns and returns the longest
 * substantive one, so a trailing "ok, doing it" never wins over the real answer
 * the cases must cover.
 *
 * NOTE: behavior is intentionally identical to the prior local copy in
 * server/features/agent/routes.ts — this module is now the single source.
 */
export function deriveUnderstandingFromChat(chatHistory: any): string {
  const turns = (Array.isArray(chatHistory) ? chatHistory : [])
    .filter((m: any) => m && m.role === 'assistant' && typeof m.content === 'string' && !isNoiseTurn(m.content))
    .slice(-6);
  if (!turns.length) return '';
  return turns.reduce((best: string, m: any) => (m.content.length > best.length ? m.content : best), '').trim();
}

/**
 * Resolve the ONE understanding every worker must share, centralizing what was
 * previously only the case-writer's logic: prefer the human-approved
 * understanding, else fall back to the richest grounded answer from THIS chat.
 *
 * Making the coder and analyst call this (instead of reading raw
 * run.approvedUnderstanding) is the fix that keeps all three workers grounded
 * on the same text.
 */
export function resolveUnderstanding(run: any): string {
  return (run?.approvedUnderstanding || '').trim() || deriveUnderstandingFromChat(run?.chat_history);
}

/**
 * Assemble the consolidated GoalContext from a run record. Uses
 * resolveUnderstanding for `understanding` so the object reflects the single
 * shared grounding. Read-only: it does not mutate the run.
 */
export function buildGoalContext(run: any): GoalContext {
  const conversation = (Array.isArray(run?.chat_history) ? run.chat_history : [])
    // Drop greetings / capability blurbs / provider-error dumps so the scope
    // signal isn't buried.
    .filter((m: any) => m && m.content && !(m.role === 'assistant' && isNoiseTurn(m.content)))
    .slice(-12)
    .map((m: any) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content).replace(/\s+/g, ' ').trim().slice(0, m.role === 'assistant' ? 2400 : 600)}`)
    .join('\n');

  return {
    prompt: run?.prompt || '',
    understanding: resolveUnderstanding(run),
    conversation,
    scope: run?.scope_context_text || '',
    targetUrl: run?.app_url || '',
    inspection: run?.inspection_context || null,
    featureUnderstanding: run?.feature_understanding || null,
    selectedQaText: run?.selected_qa_prompt_text || '',
  };
}
