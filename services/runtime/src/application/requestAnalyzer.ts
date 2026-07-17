/**
 * Request analyzer (Phase 3) — deterministic speech-act + topic normalization.
 * It produces structured router INPUT only: it has no entity authority, cannot
 * select a capability, and never calls a model.
 */

import type { SpeechAct } from '../domain/types';

export interface TopicHints {
  test: boolean;
  /** Specifically case/script/coverage nouns — separates generation from plan/suite CRUD. */
  caseNoun: boolean;
  code: boolean;
  defect: boolean;
  requirement: boolean;
  api: boolean;
  flow: boolean;
  architecture: boolean;
  workspace: boolean;
  recall: boolean;
  failure: boolean;
  review: boolean;
}

export interface AnalyzedRequest {
  speechAct: SpeechAct;
  isQuestion: boolean;
  wantsExecution: boolean;
  topics: TopicHints;
}

function clean(text: string): string {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function analyzeRequest(message: string): AnalyzedRequest {
  const text = clean(message);

  const topics: TopicHints = {
    test: /\b(test\s*cases?|cases?|scripts?|tests?|coverage|scenarios?|suites?|playwright)\b/.test(text),
    caseNoun: /\b(test\s*cases?|cases?|scripts?|coverage|scenarios?)\b/.test(text),
    code: /\b(code|diff|commit|branch|repo|repository|codebase|pull request|pr\b|implementation)\b/.test(text),
    defect: /\b(defects?|bugs?)\b/.test(text),
    requirement: /\b(requirements?|reequi\w*|requirment\w*|user stor(?:y|ies))\b/.test(text),
    api: /\b(apis?|endpoints?|rest|swagger|openapi)\b/.test(text),
    flow: /\b(flows?|journeys?|workflows?|navigation)\b/.test(text),
    architecture: /\b(architecture|architectural|subsystem|design of|structure of)\b/.test(text),
    workspace: /\b(plans?|suites?|folders?|reports?|organi[sz]e|move|rename|delete)\b/.test(text),
    recall: /\b(what (?:have|did) (?:we|i)|previous(?:ly)?|earlier (?:you|we)|so far|before this|last time|history of (?:this|our))\b/.test(text),
    failure: /\b(fail(?:ed|ing|ures?)?|errors?|broke|broken|crash(?:ed|es)?|not working|timed? ?out)\b/.test(text),
    review: /\b(review|assess|evaluate|verdict|quality)\b/.test(text),
  };

  const wantsExecution = /\b(run|execute|re-?run|play|trigger)\b/.test(text) && !/\bwhy\b/.test(text);
  const isCreate = /\b(generate|create|write|draft|author|build|make|add)\b/.test(text) && !wantsExecution;
  const isModify = /\b(update|modify|edit|change|fix|rename|move|delete|remove|archive)\b/.test(text);
  const isReview = /\b(review|audit|assess|evaluate)\b/.test(text);
  const isCompare = /\b(compare|versus|vs\.?|difference between)\b/.test(text);
  const isExplain = /\b(why|explain|how come|root cause|reason)\b/.test(text);
  const isQuestion = /\?\s*$/.test(text)
    || /^\s*(what|which|why|how|where|when|who|do|does|did|is|are|can|could|should|would|tell me|show me)\b/.test(text);

  let speechAct: SpeechAct;
  if (wantsExecution && !isQuestion) speechAct = 'run';
  else if (isCreate && !isQuestion) speechAct = 'create';
  else if (isModify && !isQuestion) speechAct = 'modify';
  else if (isReview && !isQuestion) speechAct = 'review';
  else if (isCompare) speechAct = 'compare';
  else if (isExplain) speechAct = 'explain';
  else speechAct = 'ask';

  return { speechAct, isQuestion: isQuestion || speechAct === 'ask' || speechAct === 'explain', wantsExecution, topics };
}
