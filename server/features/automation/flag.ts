/** Record & Play desktop agent — permanently on, no env toggle. Real, actively-used feature
 * (Schedules/Local Agent/Automation Data nav) — confirmed 2026-08-06, do not disable. */
export function isRemoteAgentEnabled(): boolean {
  return true;
}

/** Human-in-the-loop pauses — permanently on, no env flag. */
export function isPauseResumeEnabled(): boolean {
  return true;
}

/** Recorder step coalescing + logical grouping (see stepGrouping.ts) — permanently on, no env flag.
 * Presentation-only: the recorded Playwright script is never altered, so playback is unaffected. */
export function isRecorderStepGroupingEnabled(): boolean {
  return true;
}
