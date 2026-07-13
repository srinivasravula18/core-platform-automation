/**
 * Validation Gate (Phase 4) — mechanically enforces the success criteria on a COMPILED spec (not the
 * MissionRunner, which legitimately navigates/logs in). Any match is a hard failure: it means a hallucinated
 * construct slipped in. This is the guarantee that the compiler — not the LLM — owns navigation/login/locators.
 */
export interface GateViolation { rule: string; message: string; line: number; snippet: string }
export interface GateResult { ok: boolean; violations: GateViolation[] }

const FORBIDDEN: { rule: string; re: RegExp; message: string }[] = [
  { rule: 'RAW_GOTO', re: /\bpage\s*\.\s*goto\s*\(/, message: 'page.goto() is forbidden in a compiled spec — navigation belongs to MissionRunner.' },
  { rule: 'RAW_URL', re: /\bnew\s+URL\s*\(/, message: 'new URL() is forbidden — the mission owns URLs.' },
  { rule: 'SEARCH_PARAMS', re: /\.\s*searchParams\b/, message: 'searchParams manipulation is forbidden — never re-derive navigation.' },
  { rule: 'INLINE_LOGIN', re: /\b(loginIfNeeded|logoutIfAlreadySignedIn)\b/, message: 'Inline login helpers are forbidden — login belongs to MissionRunner.' },
  { rule: 'POSITIONAL_GUESS', re: /\.\s*(first|nth)\s*\(/, message: '.first()/.nth() is forbidden — resolve a unique verified selector instead of guessing.' },
  { rule: 'HARDCODED_APPID', re: /appId\s*[:=]\s*["'][^"']+["']/, message: 'Hardcoded appId is forbidden — it comes from the mission.' },
];

/**
 * Validate a compiled spec string. Lines inside the MISSION constant (the single allowed navigation entry)
 * are still scanned, but the allowed forbidden-free spec never contains these constructs. Returns all
 * violations with line numbers.
 */
export function validateCompiledOutput(code: string): GateResult {
  const violations: GateViolation[] = [];
  const lines = String(code || '').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const f of FORBIDDEN) {
      if (f.re.test(line)) violations.push({ rule: f.rule, message: f.message, line: i + 1, snippet: line.trim().slice(0, 160) });
    }
  });
  return { ok: violations.length === 0, violations };
}
