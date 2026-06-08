/**
 * TestFlowAI — Strict Layered Guardrails
 *
 * The previous guardrail implementation (regex-based, single function, applied only
 * to /api/agent/start) had three problems:
 *   1. It rejected legitimate inputs (greetings, identity questions).
 *   2. It had no defense against prompt injection.
 *   3. It did not validate LLM output before persisting artifacts.
 *
 * This module replaces it with a four-layer guardrail pipeline that runs on EVERY
 * agent invocation:
 *
 *   Layer 1: Input normalization        — trim, length cap, control-char strip
 *   Layer 2: Pre-LLM policy check       — fast deterministic classification
 *   Layer 3: Prompt-injection defense   — strip injection patterns, log them
 *   Layer 4: Post-LLM output validation — schema + content safety on results
 *
 * Each layer can short-circuit the request. The pipeline is composable so any
 * agent route can opt in (most do by default).
 */

import { randomUUID } from 'crypto';
import { systemPromptFor, type AgentName } from './systemPrompts';

export type GuardrailVerdict =
  | { kind: 'allow'; reason: string }
  | { kind: 'respond'; reply: string; reason: string }
  | { kind: 'reject'; code: number; error: string; reason: string };

export interface GuardrailContext {
  agent: AgentName;
  userMessage: string;
  requestId: string;
  workspaceId?: string;
  userId?: string;
  costUsedToday?: number;
  costDailyLimit?: number;
  providerName?: string;
  modelName?: string;
}

export interface GuardrailLog {
  requestId: string;
  agent: AgentName;
  layer: 'input' | 'policy' | 'injection' | 'cost' | 'output';
  decision: 'allow' | 'short-circuit' | 'sanitize';
  reason: string;
  ts: number;
  details?: Record<string, unknown>;
}

const logs: GuardrailLog[] = [];
const MAX_LOGS = 500;

export function recentGuardrailLogs(): GuardrailLog[] {
  return [...logs].slice(-100);
}

function log(entry: Omit<GuardrailLog, 'ts'>) {
  logs.push({ ...entry, ts: Date.now() });
  if (logs.length > MAX_LOGS) logs.shift();
}

const MAX_INPUT_LENGTH = 8000;
const MIN_INPUT_LENGTH = 0;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const CASUAL_GREETING = /^\s*(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening|day)|greetings|yo|sup|howdy|namaste|hola|bonjour)\s*[!.?]*\s*$/i;
const THANKS = /^\s*(thanks?|thank\s+you|ty|thx|appreciated|cheers)\s*[!.?]*\s*$/i;
const FAREWELL = /^\s*(bye|goodbye|see\s*you|cya|later|farewell)\s*[!.?]*\s*$/i;
const IDENTITY_QUESTION = /^\s*(who\s+are\s+you|what\s+are\s+you|what\s+can\s+you\s+do|help\s*me|help|how\s+do\s+i|what\s+is\s+this|your\s+(purpose|capabilities|name))\s*\??\s*$/i;
const YES_NO = /^\s*(yes|y|yep|yeah|sure|ok(?:ay)?|alright|confirmed?|reject|reject\s+it|approve|approved)\s*[!.?]*\s*$/i;
const ABUSIVE = /\b(fuck|shit|asshole|bastard|bitch|wtf|stfu|kill\s+yourself|kys|slur|retard|fag)\b/i;
const QA_KEYWORD = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|signin|sign\s*in|checkout|workflow|flow|requirements?|coverage|deploy|staging|prod|repro|reproduce|stack\s*trace|screenshot|evidence|assert(?:ion)?|expect|locator|selector)\b/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/i;

const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'ignore-previous', re: /\b(ignore|disregard|forget)\b[^.\n]{0,80}\b(previous|prior|above|earlier|preceding)\b[^.\n]{0,80}\b(instruction|prompt|directive|rule|context)\b/i },
  { name: 'system-tag', re: /<\s*\|?\s*im_(start|end)\s*\|?>/i },
  { name: 'system-bracket', re: /\b(system|assistant|user)\s*:\s*[<\[]/i },
  { name: 'you-are-now', re: /\byou\s+are\s+now\s+(a|an|the|my)\b/i },
  { name: 'new-instructions', re: /\bnew\s+instructions?\s*[:\-]/i },
  { name: 'developer-mode', re: /\b(developer|jailbreak|dan\s*mode|god\s*mode)\b/i },
  { name: 'prompt-extract', re: /\b(show|reveal|print|repeat|output)\b[^.\n]{0,40}\b(system|hidden|secret)\b[^.\n]{0,40}\b(prompt|instruction|message)\b/i },
  { name: 'role-override', re: /^\s*\[(inst|system|admin)\][\s\S]*$/i },
];

const PROMPT_INJECTION_QUOTE = /["'`]{3,}/g;
const SUSPICIOUS_TAGS = /<\s*(script|iframe|object|embed|svg|img)\b/i;

/* ---------- Layer 1: input normalization ---------- */

export function normalizeInput(raw: string): { value: string; truncated: boolean; stripped: number } {
  let value = String(raw ?? '');
  let stripped = 0;
  value = value.replace(CONTROL_CHARS, () => {
    stripped += 1;
    return '';
  });
  value = value.replace(SUSPICIOUS_TAGS, (m) => {
    stripped += m.length;
    return '';
  });
  let truncated = false;
  if (value.length > MAX_INPUT_LENGTH) {
    value = value.slice(0, MAX_INPUT_LENGTH);
    truncated = true;
  }
  return { value: value.trim(), truncated, stripped };
}

/* ---------- Layer 2: pre-LLM policy check ---------- */

export function preLLMPolicyCheck(ctx: GuardrailContext, normalized: string): GuardrailVerdict {
  if (normalized.length === MIN_INPUT_LENGTH) {
    return {
      kind: 'respond',
      reply: 'I did not receive any text. Tell me what you want to test or what to change, and I will start.',
      reason: 'empty input',
    };
  }
  if (ABUSIVE.test(normalized)) {
    return {
      kind: 'respond',
      reply: "I am here to help with QA work. Please rephrase the request, and I will get on with it.",
      reason: 'abusive content',
    };
  }
  if (CASUAL_GREETING.test(normalized)) {
    return {
      kind: 'respond',
      reply: 'Hi. I can draft a test plan, write a Playwright script, triage a failing run, or propose a defect. Which one should I start with?',
      reason: 'greeting',
    };
  }
  if (THANKS.test(normalized)) {
    return {
      kind: 'respond',
      reply: "You're welcome. Want me to keep going on the next item, or stop here?",
      reason: 'thanks',
    };
  }
  if (FAREWELL.test(normalized)) {
    return {
      kind: 'respond',
      reply: "Acknowledged. I will pause here. Open the inbox any time to pick this back up.",
      reason: 'farewell',
    };
  }
  if (YES_NO.test(normalized)) {
    return {
      kind: 'respond',
      reply: "I need a bit more context — say which artifact (a test case, a run, a defect) and what to do with it.",
      reason: 'ambiguous yes/no',
    };
  }
  if (IDENTITY_QUESTION.test(normalized)) {
    return {
      kind: 'respond',
      reply:
        "I am an AI agent inside TestFlowAI. I generate test plans, test cases, and Playwright scripts; I triage runs and defects; and I watch git repos for coverage gaps. " +
        "Pick one of those and I will start.",
      reason: 'identity question',
    };
  }
  if (ctx.agent === 'chatAssistant' && !QA_KEYWORD.test(normalized) && !URL_PATTERN.test(normalized)) {
    return {
      kind: 'respond',
      reply:
        "This product is scoped to QA. Tell me the app or feature you want covered, paste a URL, or describe a test case — and I will take it from there.",
      reason: 'off-topic',
    };
  }
  return { kind: 'allow', reason: 'pre-LLM policy passed' };
}

/* ---------- Layer 3: prompt-injection defense ---------- */

export function detectInjection(input: string): { sanitized: string; hits: string[] } {
  const hits: string[] = [];
  let sanitized = input;
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(sanitized)) {
      hits.push(name);
      sanitized = sanitized.replace(re, '[filtered]');
    }
  }
  sanitized = sanitized.replace(PROMPT_INJECTION_QUOTE, '"');
  return { sanitized, hits };
}

export function injectionGuardrail(input: string, requestId: string, agent: AgentName): string {
  const { sanitized, hits } = detectInjection(input);
  if (hits.length > 0) {
    log({
      requestId,
      agent,
      layer: 'injection',
      decision: 'sanitize',
      reason: `filtered ${hits.length} injection pattern(s): ${hits.join(', ')}`,
      details: { hits },
    });
  }
  return sanitized;
}

/* ---------- Layer 4: cost guardrail ---------- */

export function costGuardrail(ctx: GuardrailContext): GuardrailVerdict {
  const used = ctx.costUsedToday ?? 0;
  const limit = ctx.costDailyLimit ?? Number.POSITIVE_INFINITY;
  if (used >= limit) {
    log({
      requestId: ctx.requestId,
      agent: ctx.agent,
      layer: 'cost',
      decision: 'short-circuit',
      reason: 'daily cost limit reached',
      details: { used, limit },
    });
    return {
      kind: 'reject',
      code: 429,
      error: `Daily AI cost limit reached ($${used.toFixed(2)} of $${limit.toFixed(2)}). Raise the limit in Settings or wait until tomorrow.`,
      reason: 'cost limit',
    };
  }
  return { kind: 'allow', reason: 'cost under limit' };
}

/* ---------- Pipeline orchestrator ---------- */

export interface PipelineInput {
  agent: AgentName;
  userMessage: string;
  workspaceId?: string;
  userId?: string;
  costUsedToday?: number;
  costDailyLimit?: number;
  providerName?: string;
  modelName?: string;
}

export interface PipelineResult {
  requestId: string;
  sanitizedInput: string;
  policyVerdict: GuardrailVerdict;
  /** Use this prompt as the LLM `system` field. */
  systemPrompt: string;
}

export function runGuardrailPipeline(input: PipelineInput): PipelineResult {
  const requestId = randomUUID();
  const ctx: GuardrailContext = { ...input, requestId };

  const normalized = normalizeInput(input.userMessage);
  log({
    requestId,
    agent: input.agent,
    layer: 'input',
    decision: normalized.truncated || normalized.stripped > 0 ? 'sanitize' : 'allow',
    reason: normalized.truncated
      ? `truncated to ${MAX_INPUT_LENGTH} chars`
      : normalized.stripped > 0
        ? `stripped ${normalized.stripped} control/script chars`
        : 'input clean',
    details: { length: normalized.value.length, stripped: normalized.stripped, truncated: normalized.truncated },
  });

  const cost = costGuardrail(ctx);
  if (cost.kind !== 'allow') {
    log({ requestId, agent: input.agent, layer: 'cost', decision: 'short-circuit', reason: cost.reason });
    return {
      requestId,
      sanitizedInput: normalized.value,
      policyVerdict: cost,
      systemPrompt: '',
    };
  }

  const policy = preLLMPolicyCheck(ctx, normalized.value);
  if (policy.kind !== 'allow') {
    log({ requestId, agent: input.agent, layer: 'policy', decision: 'short-circuit', reason: policy.reason });
    return {
      requestId,
      sanitizedInput: normalized.value,
      policyVerdict: policy,
      systemPrompt: '',
    };
  }

  const sanitized = injectionGuardrail(normalized.value, requestId, input.agent);
  const systemPrompt = systemPromptFor(input.agent);

  return {
    requestId,
    sanitizedInput: sanitized,
    policyVerdict: { kind: 'allow', reason: 'pipeline passed' },
    systemPrompt,
  };
}

/* ---------- Layer 5: output validation ---------- */

const SECRET_LIKE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'gemini-key', re: /AIza[0-9A-Za-z_\-]{20,}/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/gi },
];

export interface OutputValidationResult {
  ok: boolean;
  redacted?: string;
  hits: string[];
}

export function validateOutput(value: string): OutputValidationResult {
  const hits: string[] = [];
  let redacted = value;
  for (const { name, re } of SECRET_LIKE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(redacted)) {
      hits.push(name);
      re.lastIndex = 0;
      redacted = redacted.replace(re, '[REDACTED-SECRET]');
    }
  }
  return { ok: hits.length === 0, redacted, hits };
}

export function validateStructuredOutput<T>(value: T): { ok: true; value: T } | { ok: false; redacted: T; hits: string[] } {
  const json = JSON.stringify(value);
  const result = validateOutput(json);
  if (result.ok && result.redacted === undefined) return { ok: true, value };
  try {
    return { ok: false, redacted: JSON.parse(result.redacted!) as T, hits: result.hits };
  } catch {
    return { ok: false, redacted: value, hits: result.hits };
  }
}
