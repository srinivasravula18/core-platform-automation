/** REMOTE_AGENT_V1 — dark-launch flag for the Record & Play local desktop agent. Unset/0 = fully inert. */
export function isRemoteAgentEnabled(): boolean {
  const raw = String(process.env.REMOTE_AGENT_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Code-level flag for human-in-the-loop pauses. Change to 1 when the feature is ready to enable. */
export let PAUSE_RESUME_V1: 0 | 1 = 1;

/** Allows tests/bootstrap code to change the code-level flag without an environment variable. */
export function setPauseResumeV1(value: 0 | 1): void {
  PAUSE_RESUME_V1 = value;
}

export function isPauseResumeEnabled(): boolean {
  return PAUSE_RESUME_V1 === 1;
}

/** Recorder step grouping — on by default; RECORDER_STEP_GROUPING=0 falls back to flat steps. Presentation only. */
export function isRecorderStepGroupingEnabled(): boolean {
  const raw = String(process.env.RECORDER_STEP_GROUPING ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}
