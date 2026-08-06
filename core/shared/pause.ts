export const PAUSE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type PauseKind = 'input' | 'manual_action';
export type PauseOutcome = 'resolved' | 'skipped' | 'expired' | 'aborted';

export interface PauseRequest {
  id: string;
  kind: PauseKind;
  prompt: string;
  hint?: string;
  masked?: boolean;
  timeoutMs?: number;
  onTimeout?: 'fail' | 'skip';
  requiresHeaded?: boolean;
}

export interface NormalizedPauseRequest extends PauseRequest {
  masked: boolean;
  timeoutMs: number;
  onTimeout: 'fail' | 'skip';
  requiresHeaded: boolean;
}

export interface PauseAnswer {
  pauseId: string;
  attempt: number;
  outcome: PauseOutcome;
  value?: string;
  resolvedBy: string;
}

export function normalizePauseRequest(request: PauseRequest): NormalizedPauseRequest {
  const id = String(request?.id || '').trim();
  const prompt = String(request?.prompt || '').trim();
  if (!id || !prompt) throw new Error('Pause id and prompt are required.');
  if (request.kind !== 'input' && request.kind !== 'manual_action') throw new Error('Pause kind must be input or manual_action.');
  if (request.onTimeout != null && request.onTimeout !== 'fail' && request.onTimeout !== 'skip') throw new Error('Pause onTimeout must be fail or skip.');
  const timeoutMs = request.timeoutMs ?? PAUSE_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Pause timeoutMs must be positive.');
  return {
    ...request,
    id,
    prompt,
    masked: request.masked ?? request.kind === 'input',
    timeoutMs,
    onTimeout: request.onTimeout ?? 'fail',
    requiresHeaded: request.requiresHeaded ?? request.kind === 'manual_action',
  };
}

export function pauseAttemptKey(jobId: string, pauseId: string, attempt: number): string {
  return JSON.stringify([jobId, pauseId, attempt]);
}
