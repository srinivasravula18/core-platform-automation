/**
 * The single goal router.
 *
 *   classifyGoal()  — one LLM call that PROPOSES a classification.
 *   decideRoute()   — a pure function that DECIDES the route, enforcing the
 *                     safety rules that used to be spread across frontend
 *                     regexes and backend keyword matches.
 *
 * Keeping the guardrails in decideRoute() (not in the prompt) means they are
 * deterministic and testable: see scripts/eval-routing.ts.
 */

import { z } from 'zod';
import { getOrchestrator } from '../../ai/orchestrator';
import type { ChatTurn, SelectedApp } from '../../ai/controller';
import type { Route, RouteKind, RawGoalClassification, RoutingContext, RouteTarget } from './types';
import { normalizeQaVocab, processInput } from '../inputProcessing';

/**
 * Below this confidence the router refuses to guess and asks instead. This one
 * constant replaces a pile of regex heuristics: "when unsure, clarify" is the
 * single most important accuracy lever (see the architecture review).
 */
export const CONFIDENCE_FLOOR = 55;

/** Routes that perform an action and therefore need a concrete app target. */
const TARGET_REQUIRED: ReadonlySet<RouteKind> = new Set<RouteKind>(['generate_cases', 'deep_test_run']);

const VALID_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
  'answer', 'clarify', 'generate_cases', 'deep_test_run', 'code_analysis', 'workspace_action', 'requirement_draft',
]);

/** True when the message is asking to create/write/draft a REQUIREMENT (not test cases). */
function looksLikeRequirementDraft(message: string): boolean {
  const text = cleanText(message);
  // Must have a creation verb
  if (!/\b(?:create|write|draft|generate|discover|make|add)\b/.test(text)) return false;
  // Must mention "requirement" in any spelling/truncation, OR "req" as a standalone word/prefix
  const hasReqWord = /\breequi|\brequ[a-z]*ment|\bRequirement|\brequirment|\brequirement|\brequirnment|\brequiremnts|\breq(?:s|uirements?|uirment)?\b/i.test(message)
    || /\breq\b/i.test(text);
  if (!hasReqWord) return false;
  // Must NOT also be asking for test cases / scripts / runs (those are generate_cases)
  return !/\b(?:test\s+cases?|cases?|scripts?|playwright|suite|run)\b/.test(text);
}

function clampConfidence(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function cleanText(value: string): string {
  const lowered = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return normalizeQaVocab(lowered);
}

function targetAliases(app: RouteTarget): string[] {
  const name = cleanText(app?.name || '').replace(/[_-]+/g, ' ');
  const url = cleanText(app?.url || '');
  const aliases = new Set<string>();
  if (name) aliases.add(name);
  if (/\badmin\b/.test(name) && (/\blocal\b/.test(name) || /\blocalhost\b|127\.0\.0\.1/.test(url))) aliases.add('local admin');
  if (/\bkeystone\b/.test(name) && (/\blocal\b/.test(name) || /\blocalhost\b|127\.0\.0\.1/.test(url))) aliases.add('local keystone');
  return [...aliases].sort((a, b) => b.length - a.length);
}

function textHasAlias(text: string, alias: string): boolean {
  return !!alias && new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}

function looksLikeQuestionOrCoverageAsk(message: string): boolean {
  const text = cleanText(message);
  if (!text) return false;
  if (/\b(generate|draft|create|write|author|build|make|run|execute|rerun|re-run|playwright)\b/.test(text)) return false;
  if (/\?$/.test(text)) return true;
  if (/\b(what|which|how|where|why|do|does|did|can|could|should|would|is|are)\b/.test(text)) return true;
  const coverageAsk =
    // A "list" COMMAND — but "list view(s)" is a feature noun, not a request to enumerate coverage.
    (/\b(show|tell|outline|summari[sz]e|map)\b/.test(text) || (/\blist\b/.test(text) && !/\blist\s+views?\b/.test(text)))
    // "end to end"/"e2e" is a SCOPE qualifier (an action: "test X end to end"), never a coverage-ask noun on
    // its own, so it must not flip an imperative into an informational answer.
    && /\b(features?|test areas?|coverage|scenarios?|workflows?|journeys?|modules?|pages?|screens?)\b/.test(text);
  const whatToTest =
    /\b(features?\s+to\s+test|what\s+(?:should|can)\s+(?:i|we)\s+test|what\s+to\s+test|test\s+areas?|coverage\s+areas?)\b/.test(text);
  return coverageAsk || whatToTest;
}

function resolveNamedTarget(message: string, ctx: RoutingContext): RouteTarget | undefined {
  const text = cleanText(message).replace(/[_-]+/g, ' ');
  const candidates = [
    ...(Array.isArray(ctx.selectedApps) ? ctx.selectedApps : []),
    ...(Array.isArray(ctx.availableApps) ? ctx.availableApps : []),
  ].filter(Boolean);
  const seen = new Set<string>();
  const matched = candidates.map((app) => {
    const key = cleanText(`${app?.name || ''} ${app?.url || ''}`);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const alias = targetAliases(app).find((a) => textHasAlias(text, a));
    return alias ? { app, score: alias.length } : null;
  }).filter(Boolean) as Array<{ app: RouteTarget; score: number }>;
  matched.sort((a, b) => b.score - a.score);
  if (matched.length === 1) return matched[0].app;
  if (matched.length > 1 && matched[0].score > matched[1].score) return matched[0].app;
  if (matched.length > 1) {
    return {
      name: matched.map((item) => item.app.name).filter(Boolean).join(' + '),
      url: matched.map((item) => item.app.url).filter(Boolean).join(', ') || undefined,
    };
  }
  return undefined;
}

function heuristicClassifyGoal(message: string, ctx: RoutingContext = {}): RawGoalClassification {
  const text = cleanText(message);
  const target = resolveNamedTarget(message, ctx) || resolveTarget({
    kind: 'answer',
    confidence: 70,
    isQuestion: false,
    isImperative: false,
    wantsExecution: false,
    scope: message,
    target: {},
    missing: [],
    clarifyingQuestion: '',
    reason: 'heuristic target resolution',
  }, ctx) || {};
  const scope = String(message || '').trim();
  const wantsAllAboveTested = /\btest\b/.test(text)
    && /\b(?:all\s+(?:of\s+)?(?:the\s+)?above|all\s+(?:of\s+)?(?:these|those)|above\s+cases?|listed\s+cases?)\b/.test(text);
  // "end to end"/"e2e" is scope, not an execution command — "test the list view end to end" should generate
  // E2E cases (review-first), not auto-run. Only an explicit run/execute verb (or "run all the above") executes.
  const hasExecutionVerb = wantsAllAboveTested || /\b(run|execute|rerun|re-run|playwright)\b/.test(text);
  const hasGenerationVerb = /\b(generate|draft|write|author|create|build|make)\b/.test(text);
  const hasCodeVerb = /\b(analy[sz]e|review|diff|recent changes|repo|repository|codebase|code changes?)\b/.test(text);
  const hasWorkspaceVerb = /\b(plan|suite|folder|report|defect|move|organize|organise|navigate|open|go to)\b/.test(text);
  const isQuestion = looksLikeQuestionOrCoverageAsk(message);

  if (isQuestion) {
    return {
      kind: 'answer',
      confidence: 86,
      isQuestion: true,
      isImperative: false,
      wantsExecution: false,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic informational/test-coverage request',
    };
  }

  if (hasCodeVerb && !hasGenerationVerb && !hasExecutionVerb) {
    return {
      kind: 'code_analysis',
      confidence: 78,
      isQuestion: false,
      isImperative: true,
      wantsExecution: false,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic code-analysis request',
    };
  }

  if (hasWorkspaceVerb && !hasExecutionVerb && !/\btest|case|coverage|scenario|qa\b/.test(text)) {
    return {
      kind: 'workspace_action',
      confidence: 75,
      isQuestion: false,
      isImperative: true,
      wantsExecution: false,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic workspace action request',
    };
  }

  if (hasExecutionVerb) {
    return {
      kind: 'deep_test_run',
      confidence: 82,
      isQuestion: false,
      isImperative: true,
      wantsExecution: true,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic execution request',
    };
  }

  if (looksLikeRequirementDraft(message)) {
    return {
      kind: 'requirement_draft',
      confidence: 88,
      isQuestion: false,
      isImperative: true,
      wantsExecution: false,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic requirement-draft request',
    };
  }

  if (hasGenerationVerb || /\b(test|case|cases|coverage|scenario|scenarios|qa)\b/.test(text)) {
    return {
      kind: 'generate_cases',
      confidence: 74,
      isQuestion: false,
      isImperative: true,
      wantsExecution: false,
      scope,
      target,
      missing: [],
      clarifyingQuestion: '',
      reason: 'heuristic case-generation request',
    };
  }

  return {
    kind: 'answer',
    confidence: 60,
    isQuestion: false,
    isImperative: false,
    wantsExecution: false,
    scope,
    target,
    missing: [],
    clarifyingQuestion: '',
    reason: 'heuristic fallback',
  };
}

/** Map the model's free-form label onto a canonical RouteKind. */
function canonicalKind(raw: string): RouteKind {
  const k = String(raw || '').toLowerCase().trim();
  if (VALID_KINDS.has(k as RouteKind)) return k as RouteKind;
  // Tolerate common synonyms the model may emit.
  if (/run|execute|e2e|playwright/.test(k)) return 'deep_test_run';
  if (/requirement/.test(k)) return 'requirement_draft';
  if (/case|generate|draft|author/.test(k)) return 'generate_cases';
  if (/analy|diff|review|repo|code/.test(k)) return 'code_analysis';
  if (/plan|suite|folder|report|organi|move|defect|navigate/.test(k)) return 'workspace_action';
  if (/clarif|ask|ambig/.test(k)) return 'clarify';
  return 'answer';
}

/** Resolve a concrete target from the model's guess, the selected apps, or the conversation. */
export function resolveTarget(raw: RawGoalClassification, ctx: RoutingContext): RouteTarget | null {
  const url = raw.target?.url?.trim();
  const name = raw.target?.name?.trim();
  // A concrete URL from the model wins — the user named or pasted a real address.
  if (url) return { url, name: name || undefined };
  // No model URL: an explicitly SELECTED app (which carries a real URL) beats the model's bare
  // NAME guess, which is often a feature/tab label ("Accounts CRM") rather than a configured app.
  // This makes the user's selection authoritative — never ask "which app?" when one is selected.
  const selWithUrl = (ctx.selectedApps || []).find((a) => a && a.url?.trim());
  if (selWithUrl) return { url: selWithUrl.url!.trim(), name: selWithUrl.name?.trim() || name || undefined };
  // Otherwise the model's bare name, then any selected app, then the remembered conversation target.
  if (name) return { url: undefined, name };
  const selAny = (ctx.selectedApps || []).find((a) => a && a.name?.trim());
  if (selAny) return { url: undefined, name: selAny.name!.trim() };
  if (ctx.conversationTarget && (ctx.conversationTarget.url || ctx.conversationTarget.name)) {
    return ctx.conversationTarget;
  }
  return null;
}

function clarify(raw: RawGoalClassification, reason: string, fallbackQuestion?: string): Route {
  const q = (raw.clarifyingQuestion || '').trim() || fallbackQuestion
    || 'Could you say a bit more about what you want me to do?';
  return { kind: 'clarify', confidence: clampConfidence(raw.confidence), clarifyingQuestion: q, reason };
}

/**
 * THE SAFETY NET. Pure, deterministic, and the single authority on routing.
 *
 * Rules, in order of precedence:
 *   1. A question that is not an explicit command is ALWAYS answered, never acted on.
 *      (kills "I asked X and it generated/ran Y".)
 *   2. Low confidence → clarify. Never guess. (the biggest accuracy lever.)
 *   3. A generation request the user did not ask to EXECUTE stays a draft
 *      (generate_cases), never auto-runs Playwright. (kills "drafted → executed".)
 *   4. A target-requiring action with no resolvable app → clarify which app.
 *      (kills "ran against a hardcoded/wrong URL".)
 *
 * Deliberately NOT here: a generic "model said something is missing → clarify"
 * gate. Benchmarking showed it over-clarifies (the model over-reports missing
 * details). Whether a domain detail (plan name, which cases) is missing is the
 * DOWNSTREAM handler's call, not routing's — routing only needs a target for
 * target-requiring kinds. `raw.missing` is still carried for the dispatcher.
 */
export function decideRoute(raw: RawGoalClassification, ctx: RoutingContext = {}): Route {
  const confidence = clampConfidence(raw.confidence);

  // 1) Never convert a pure question into an action.
  if (raw.isQuestion && !raw.isImperative) {
    return { kind: 'answer', confidence, scope: raw.scope, reason: 'question, not a command' };
  }

  // 2) When unsure, ask — don't guess.
  if (confidence < CONFIDENCE_FLOOR) {
    return clarify(raw, `confidence ${confidence} < floor ${CONFIDENCE_FLOOR}`);
  }

  let kind = canonicalKind(raw.kind);

  // An 'answer' label needs no further gating.
  if (kind === 'answer') return { kind, confidence, scope: raw.scope, reason: raw.reason || 'informational' };

  // 3) Generation the user did not ask to RUN stays a review-first draft.
  if (kind === 'deep_test_run' && !raw.wantsExecution) {
    kind = 'generate_cases';
  }

  // 4) Target-requiring actions must have a resolvable target (from the model, the
  //    selected app, or the conversation). This OVERRIDES a model 'clarify' that was
  //    only about a missing target: if we can resolve one, proceed.
  if (TARGET_REQUIRED.has(kind)) {
    const target = resolveTarget(raw, ctx);
    if (!target) {
      return clarify(raw, 'no resolvable target app',
        'Which app should I run this against? Select one in the top-bar app switcher (or the "Apps to test" picker) and I\'ll proceed.');
    }
    return { kind, confidence, scope: raw.scope, target, reason: raw.reason || kind };
  }

  // requirement_draft — codebase-only, no target needed.
  if (kind === 'requirement_draft') return { kind, confidence, scope: raw.scope, reason: raw.reason || 'requirement draft from codebase' };

  // The model explicitly asked to clarify (e.g. a bare demonstrative with no scope).
  if (kind === 'clarify') return clarify(raw, raw.reason || 'model asked to clarify');

  return { kind, confidence, scope: raw.scope, reason: raw.reason || kind };
}

const goalSchema = z.object({
  kind: z.string(),
  confidence: z.number(),
  isQuestion: z.boolean(),
  isImperative: z.boolean(),
  wantsExecution: z.boolean(),
  scope: z.string().default(''),
  target: z.object({ url: z.string().default(''), name: z.string().default('') }).default({ url: '', name: '' }),
  missing: z.array(z.string()).default([]),
  clarifyingQuestion: z.string().default(''),
  reason: z.string().default(''),
});

function buildRouterPrompt(message: string, history: ChatTurn[] | undefined, apps: SelectedApp[] | undefined): string {
  const convo = (Array.isArray(history) ? history : [])
    .slice(-12)
    .map((m) => `${m.role === 'assistant' ? 'assistant' : 'user'}: ${String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`)
    .filter((l) => l.length > 6)
    .join('\n');
  const appList = (Array.isArray(apps) ? apps : [])
    .filter((a) => a && (a.baseUrl || a.name))
    .map((a) => `${a.name || a.baseUrl} (${a.baseUrl || 'no url'})`).join(', ');

  return `You are the SINGLE router for a QA test-automation assistant. Classify the user's LATEST message into one routing decision. Do NOT answer it; only classify.

${appList ? `Selected app(s) under test: ${appList}. Treat the selected app as THE target for any action — set target to it and do NOT report the target as missing.\n` : 'No app is currently selected.\n'}${convo ? `\nConversation so far (oldest first):\n${convo}\n` : ''}
Latest message:
"${message}"

Return JSON with these fields:
- kind: one of "answer" (a question/discussion to answer), "requirement_draft" (create/write/draft/generate a REQUIREMENT or requirements doc — codebase research only, no live app), "generate_cases" (draft test cases), "deep_test_run" (inspect a live app + generate + RUN), "code_analysis" (analyze repo/diff), "workspace_action" (create/modify a plan, suite, run, folder, report, defect, etc.), "clarify" (too ambiguous to act). IMPORTANT: if the user asks to "create requirements", "write requirements", "draft a requirement", or similar (even with typos like "reequipments", "requriments"), always use "requirement_draft" — never "generate_cases" or "deep_test_run".
- confidence: 0-100. Use 70+ only when the intent is clear; 40-69 when ambiguous; <40 when guessing.
- isQuestion: true if the latest message is a question or exploratory follow-up (e.g. "what about sorting?", "do we have X?", ends with "?").
- isImperative: true ONLY if it is a clear command to act now ("generate the cases", "run it", "do it", "proceed", "go ahead").
- wantsExecution: true if the user wants the tests actually RUN against the app (not merely drafted/reviewed).
- scope: a short phrase naming exactly what to test or answer about, carried forward from the conversation (do not restate the whole message).
- target: { url, name } of the app to act on if you can determine it from the message, conversation, or selected app; otherwise leave both "".
- missing: list any REQUIRED detail that is absent for an action (e.g. "target app", "plan name", "scope"). Empty for questions.
- clarifyingQuestion: if kind is "clarify" or something required is missing, the single best question to ask. Otherwise "".
- reason: one short sentence explaining the classification.

Critical rules:
- If the latest message is a QUESTION or discussion, kind="answer" and isImperative=false. Never classify a question as an action.
- Only use "deep_test_run"/"generate_cases"/"workspace_action" when there is a clear imperative command.
- A bare demonstrative ("this", "that feature", "it") with no named feature/app/url is NOT enough — if you cannot resolve a concrete scope or target, use "clarify".
- When genuinely unsure between answering and acting, choose "answer".`;
}

export interface ClassifyGoalInput {
  message: string;
  history?: ChatTurn[];
  apps?: SelectedApp[];
  workspaceId?: string;
  userId?: string;
}

/** One LLM call producing a raw (untrusted) classification. */
export async function classifyGoal(input: ClassifyGoalInput): Promise<RawGoalClassification> {
  // Use the dedicated goalRouter system prompt ("classify, don't answer") rather than
  // chatAssistant, whose conversational rules conflict with a JSON classifier.
  const orch = await getOrchestrator('goalRouter', {
    workspaceId: input.workspaceId || 'default',
    userId: input.userId,
  });
  const result = await orch.generateObject<z.infer<typeof goalSchema>>({
    prompt: buildRouterPrompt(input.message, input.history, input.apps),
    schema: goalSchema,
    temperature: 0,
    userMessage: input.message,
    hasHistory: Array.isArray(input.history) && input.history.length > 0,
  });

  // Guardrail short-circuit (e.g. provider refusal) → treat as a plain answer.
  if (result.shortCircuit) {
    return {
      kind: 'answer', confidence: 60, isQuestion: true, isImperative: false, wantsExecution: false,
      scope: '', target: {}, missing: [], clarifyingQuestion: '', reason: 'guardrail short-circuit',
    };
  }
  const o: any = result.object || {};
  return {
    kind: String(o.kind || 'answer'),
    confidence: clampConfidence(o.confidence),
    isQuestion: !!o.isQuestion,
    isImperative: !!o.isImperative,
    wantsExecution: !!o.wantsExecution,
    scope: String(o.scope || ''),
    target: { url: String(o.target?.url || '') || undefined, name: String(o.target?.name || '') || undefined },
    missing: Array.isArray(o.missing) ? o.missing.map(String).filter(Boolean) : [],
    clarifyingQuestion: String(o.clarifyingQuestion || ''),
    reason: String(o.reason || ''),
  };
}

/** Convenience: classify (LLM) then decide (deterministic) in one call. */
export async function routeGoal(input: ClassifyGoalInput, ctx: RoutingContext = {}): Promise<{ route: Route; raw: RawGoalClassification }> {
  // Input Processing Layer: recover spelling + canonicalize vocabulary ONCE, then classify on the cleaned
  // message so a typo/variant ("give testcases", "tset cases", "keyston") routes the same as its correct
  // form. The original message is preserved for the LLM's own context; only the classification sees the
  // normalized text. Genuinely novel phrasings still fall through to classifyGoal (the semantic fallback).
  const processed = processInput(input.message, ctx);
  const normalizedInput: ClassifyGoalInput = processed.normalized && processed.normalized !== input.message.toLowerCase()
    ? { ...input, message: processed.normalized }
    : input;
  const direct = heuristicClassifyGoal(normalizedInput.message, ctx);
  const shouldBypassModel = looksLikeQuestionOrCoverageAsk(normalizedInput.message);
  let raw: RawGoalClassification;
  if (shouldBypassModel) {
    raw = direct;
  } else {
    try {
      // Give the model the corrected message but keep the original as userMessage so its reply reads naturally.
      raw = await classifyGoal({ ...normalizedInput, message: `${normalizedInput.message}` });
    } catch {
      raw = direct;
    }
  }
  if (!raw.target?.url && !raw.target?.name && (direct.target?.url || direct.target?.name)) {
    raw = { ...raw, target: direct.target };
  }
  if (canonicalKind(raw.kind) === 'clarify' && TARGET_REQUIRED.has(canonicalKind(direct.kind)) && (direct.target?.url || direct.target?.name)) {
    raw = direct;
  }
  return { route: decideRoute(raw, ctx), raw };
}
