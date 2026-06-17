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

/**
 * Below this confidence the router refuses to guess and asks instead. This one
 * constant replaces a pile of regex heuristics: "when unsure, clarify" is the
 * single most important accuracy lever (see the architecture review).
 */
export const CONFIDENCE_FLOOR = 55;

/** Routes that perform an action and therefore need a concrete app target. */
const TARGET_REQUIRED: ReadonlySet<RouteKind> = new Set<RouteKind>(['generate_cases', 'deep_test_run']);

const VALID_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
  'answer', 'clarify', 'generate_cases', 'deep_test_run', 'code_analysis', 'workspace_action',
]);

function clampConfidence(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Map the model's free-form label onto a canonical RouteKind. */
function canonicalKind(raw: string): RouteKind {
  const k = String(raw || '').toLowerCase().trim();
  if (VALID_KINDS.has(k as RouteKind)) return k as RouteKind;
  // Tolerate common synonyms the model may emit.
  if (/run|execute|e2e|playwright/.test(k)) return 'deep_test_run';
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
  if (url || name) return { url: url || undefined, name: name || undefined };
  const sel = (ctx.selectedApps || []).find((a) => a && (a.url?.trim() || a.name?.trim()));
  if (sel) return { url: sel.url?.trim() || undefined, name: sel.name?.trim() || undefined };
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
- kind: one of "answer" (a question/discussion to answer), "generate_cases" (draft test cases), "deep_test_run" (inspect a live app + generate + RUN), "code_analysis" (analyze repo/diff), "workspace_action" (create/modify a plan, suite, run, folder, report, defect, etc.), "clarify" (too ambiguous to act).
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
  const raw = await classifyGoal(input);
  return { route: decideRoute(raw, ctx), raw };
}
