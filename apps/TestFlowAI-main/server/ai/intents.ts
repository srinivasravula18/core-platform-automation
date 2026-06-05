/**
 * Intent schema for the Universal AI Controller.
 *
 * The controller classifies the user's free-form request into one or more
 * intents. Each intent has a typed schema, a list of side effects, and a
 * pointer to the specialized agent that will execute it. The plan builder
 * chains intents into a workflow that the human reviews before execution.
 */

export type IntentKind =
  | 'navigate'
  | 'create_plan'
  | 'create_suite'
  | 'create_cases'
  | 'expand_case_steps'
  | 'rework_case'
  | 'create_run'
  | 'create_defect'
  | 'generate_script'
  | 'generate_report'
  | 'analyze_run'
  | 'triage_defect'
  | 'set_autonomy'
  | 'create_folder'
  | 'resolve_credentials'
  | 'create_inbox_reminder'
  | 'explain'
  | 'unknown';

export type SideEffect =
  | { type: 'read'; label: string }
  | { type: 'create'; entity: string; label: string; requiresApproval: boolean }
  | { type: 'update'; entity: string; label: string; requiresApproval: boolean }
  | { type: 'delete'; entity: string; label: string; requiresApproval: boolean }
  | { type: 'navigate'; path: string; label: string }
  | { type: 'run_workflow'; label: string };

export interface IntentDraft {
  kind: IntentKind;
  confidence: number;
  agent: string;
  title: string;
  description: string;
  params: Record<string, any>;
  sideEffects: SideEffect[];
  estimatedCostUsd: number;
}

export interface PlanStep {
  id: string;
  index: number;
  intent: IntentDraft;
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  result?: any;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  inboxItemId?: string;
}

export interface Plan {
  id: string;
  userMessage: string;
  summary: string;
  reasoning: string;
  steps: PlanStep[];
  estimatedCostUsd: number;
  createdAt: string;
  status: 'draft' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  workspaceId: string;
  userId?: string;
}

export const INTENT_LABELS: Record<IntentKind, string> = {
  navigate: 'Navigate',
  create_plan: 'Create test plan',
  create_suite: 'Create test suite',
  create_cases: 'Generate test cases',
  expand_case_steps: 'Expand case steps',
  rework_case: 'Rework test case',
  create_run: 'Create test run',
  create_defect: 'File defect',
  generate_script: 'Generate Playwright script',
  generate_report: 'Generate report',
  analyze_run: 'Analyze run',
  triage_defect: 'Triage defect',
  set_autonomy: 'Change autonomy level',
  create_folder: 'Create folder',
  resolve_credentials: 'Resolve credentials',
  create_inbox_reminder: 'Add inbox reminder',
  explain: 'Explain',
  unknown: 'Unknown',
};

export const AGENT_FOR_INTENT: Record<IntentKind, string> = {
  navigate: 'chatAssistant',
  create_plan: 'testPlanner',
  create_suite: 'suiteDesigner',
  create_cases: 'caseWriter',
  expand_case_steps: 'caseWriter',
  rework_case: 'caseWriter',
  create_run: 'chatAssistant',
  create_defect: 'defectTriage',
  generate_script: 'playwrightCoder',
  generate_report: 'defectTriage',
  analyze_run: 'defectTriage',
  triage_defect: 'defectTriage',
  set_autonomy: 'chatAssistant',
  create_folder: 'suiteDesigner',
  resolve_credentials: 'chatAssistant',
  create_inbox_reminder: 'chatAssistant',
  explain: 'chatAssistant',
  unknown: 'chatAssistant',
};

export function intentRequiresApproval(kind: IntentKind): boolean {
  switch (kind) {
    case 'navigate':
    case 'explain':
    case 'resolve_credentials':
    case 'analyze_run':
    case 'create_inbox_reminder':
      return false;
    default:
      return true;
  }
}

export function isDestructiveIntent(kind: IntentKind): boolean {
  return kind === 'rework_case' || kind === 'delete' as any;
}
