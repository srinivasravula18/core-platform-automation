/**
 * REMOTE_AGENT_V1 — dark-launch flag for the Record & Play local desktop agent module.
 *
 * Unset or 0 = the feature is fully inert: no agent routes register behavior, no WS
 * gateway attaches, no scheduler ticks, and the frontend renders no Automation-agent UI.
 * The existing app (including the legacy cloud-side /api/playwright/codegen recorder) is
 * byte-for-byte unchanged. Follows the AGENT_GRAPH_V2 / isWorkflowGraphEnabled() pattern.
 */
export function isRemoteAgentEnabled(): boolean {
  const raw = String(process.env.REMOTE_AGENT_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Recorder step coalescing + logical grouping (see stepGrouping.ts). This is the default product
 * behavior — recorded interactions are coalesced and grouped into collapsible blocks in the created
 * Test Case, so it needs no env var to turn on. The RECORDER_STEP_GROUPING env var exists ONLY as an
 * escape hatch to fall back to the legacy 1 script-line -> 1 flat step behavior (set it to 0/false/off).
 * Presentation-only: the recorded Playwright script is never altered, so playback is unaffected.
 */
export function isRecorderStepGroupingEnabled(): boolean {
  const raw = String(process.env.RECORDER_STEP_GROUPING ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return true;
}
