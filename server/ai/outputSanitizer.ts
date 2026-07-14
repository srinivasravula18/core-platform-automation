/**
 * Deterministic agent-output sanitization (LangGraph migration, Phase 6).
 *
 * Extracted (copied, not moved) from supervisor.ts's stripCodebaseLocationsForAgentConsole so the
 * graph engines enforce the established rule: agent answers must NEVER show file paths, filenames,
 * line numbers, or repo directories — source locations stay internal to the pipeline.
 * Additive by design: supervisor.ts/controller.ts/routes are intentionally NOT modified — consumer
 * migration onto this module is a documented follow-up.
 * Pure and deterministic: no config, no env reads, no I/O; idempotent over its own output.
 */

/** Strips codebase file/path/line references from user-facing text — verbatim supervisor.ts logic. */
export function stripCodebaseLocationsForAgentConsole(value: string): string {
  const sourceRef =
    /(?:^|[\s(;])(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]?(?:apps|server|src|tests?|docs|seeds|packages|api|lib|components|hooks|pages|shared|client|services|e2e|unit|features|db|scripts)[\\/])[\w./\\@-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;
  const bareFileRef =
    /(?:^|[\s(;])[\w.-]+\.(?:tsx?|jsx?|vue|svelte|py|go|java|rb|cs|php|json|ya?ml|sql|css|scss|html|spec\.ts|test\.ts)(?::\d+(?:-\d+)?)?/gi;
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/\s+referenced by\s+[^.]+(?=\.|$)/gi, '')
      .replace(sourceRef, ' ')
      .replace(bareFileRef, ' ')
      .replace(/\s*;\s*(?=;|$)/g, '')
      .replace(/\s+([,.;:])/g, '$1')
      .replace(/:\s*(?:;|\.)?\s*$/g, '')
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Canonical entry point for graph engines: sanitize a final user-facing agent answer. */
export function sanitizeAgentOutput(text: string): string {
  return stripCodebaseLocationsForAgentConsole(text);
}
