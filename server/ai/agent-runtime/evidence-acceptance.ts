import type { AcceptCheck, LiveEvidence, ToolInvocation } from '../tools/types';

function evidenceOf(call: ToolInvocation): LiveEvidence | null {
  if (call.error || !call.result || typeof call.result !== 'object') return null;
  const evidence = (call.result as { evidence?: unknown }).evidence;
  return evidence && typeof evidence === 'object' ? evidence as LiveEvidence : null;
}

export const acceptGroundedTargetAnswer = ({ finalText, steps, ctx }: Parameters<AcceptCheck>[0]): { ok: boolean; feedback?: string } => {
  if (!ctx.targetApps?.length) return { ok: true };
  const calls = steps.flatMap((step) => step.toolCalls).filter((call) => !call.error);
  if (!calls.length) return { ok: false, feedback: 'This target-backed answer has no successful current-turn tool evidence. Call the relevant authenticated API or repository tool before answering, including when correcting an earlier answer.' };

  const answer = finalText.toLocaleLowerCase();
  const evidence = calls.map(evidenceOf).filter(Boolean) as LiveEvidence[];
  const finalSubject = evidence.at(-1)?.subject;
  const missingScopes = [...new Set(evidence.filter((item) => item.subject === finalSubject).map((item) => item.scope.label?.trim()).filter(Boolean) as string[])]
    .filter((label) => !answer.includes(label.toLocaleLowerCase()));
  if (missingScopes.length) return { ok: false, feedback: `State the exact evidence scope in the answer: ${missingScopes.join(', ')}. Do not present a scoped result as a global result.` };
  return { ok: true };
};
