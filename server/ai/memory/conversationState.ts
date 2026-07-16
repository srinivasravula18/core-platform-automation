import { AgentRuns, Defects } from '../../db/repository';
import { ensureSummarySegments, renderSummarySegments } from './conversationSummary';

export interface ConversationLedger {
  lines: string[];
  runIds: string[];
}

export async function loadConversationLedger(conversationId: string): Promise<ConversationLedger> {
  if (!conversationId) return { lines: [], runIds: [] };
  const runs = (await AgentRuns.list()).filter((run: any) => String(run.conversationId || '') === conversationId)
    .sort((a: any, b: any) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const runIds = runs.map((run: any) => String(run.id));
  const lines: string[] = [];
  for (const run of runs) {
    lines.push(`run ${run.id}: ${run.status || 'unknown'} - ${String(run.prompt || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    for (const testCase of run.generatedCases || run.generated_cases || []) {
      lines.push(`case ${testCase.id || testCase.caseId || 'unassigned'}: ${testCase.title || testCase.name || 'Untitled case'}`);
    }
    for (const script of run.playwrightScripts || run.playwright_scripts || []) {
      lines.push(`script ${script.id || script.filename || 'unassigned'}: ${script.title || script.name || script.filename || 'Generated script'}`);
    }
  }
  if (runIds.length) {
    const defects = (await Defects.list()).filter((defect: any) => runIds.includes(String(defect.sourceRunId || '')));
    for (const defect of defects) lines.push(`defect ${defect.id}: ${defect.status || 'New'} - ${defect.title || 'Untitled defect'}`);
  }
  return { lines, runIds };
}

export function renderConversationLedger(ledger: ConversationLedger): string {
  if (!ledger.lines.length) return '';
  return `\n\nCONVERSATION ACTIVITY LEDGER (deterministic records):\n${ledger.lines.join('\n')}`;
}

export async function loadConversationHandoff(conversationId: string): Promise<string> {
  if (!conversationId) return '';
  const [ledger, segments] = await Promise.all([
    loadConversationLedger(conversationId),
    ensureSummarySegments(conversationId),
  ]);
  return `${renderConversationLedger(ledger)}${renderSummarySegments(segments)}`.trim();
}
