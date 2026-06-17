/**
 * Grounded verification gates.
 *
 * The 2025 consensus: intrinsic self-correction (a model grading itself) is fragile;
 * GROUNDED self-correction — anchored in real signals — is what works. This app has
 * real signals: what the inspector actually observed in the live DOM, and what
 * Playwright actually did. These gates turn those signals into accept/reject verdicts
 * the agent loop uses to decide whether to proceed or retry.
 *
 * Each gate is a cheap, deterministic check (no extra LLM call) so it can run on every
 * step without cost. An optional LLM-judge can be layered on top later.
 */

export interface VerifierVerdict {
  ok: boolean;
  reason: string;
}

/** Did the inspector actually SEE the live application? (catches the blind-inspection class) */
export function assessInspection(ctx: any): VerifierVerdict {
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, reason: 'No inspection context was produced.' };
  }
  if (ctx.goalStatus === 'blocked') {
    const why = Array.isArray(ctx.warnings) && ctx.warnings.length ? `: ${ctx.warnings.join('; ')}` : '';
    return { ok: false, reason: `Inspector reported goalStatus=blocked${why}.` };
  }
  const nav = (ctx.visibleNavigation || []).length;
  const forms = (ctx.visibleForms || []).length;
  const tables = (ctx.visibleTables || []).length;
  if (nav + forms + tables === 0) {
    return { ok: false, reason: 'Inspector observed no navigation, forms, or tables — it could not read the live page.' };
  }
  return { ok: true, reason: `Observed ${nav} navigation item(s), ${forms} form(s), ${tables} table(s).` };
}

/** Collect the human-readable tokens the inspector actually observed on the page. */
function observedTokens(inspection: any): Set<string> {
  const tokens = new Set<string>();
  const add = (s: unknown) => {
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .forEach((w) => tokens.add(w));
  };
  for (const a of inspection?.visibleNavigation || []) add(typeof a === 'string' ? a : a?.text);
  for (const f of inspection?.visibleForms || []) {
    add(f?.name || f?.label);
    for (const field of f?.fields || []) add(field?.name || field?.label);
  }
  for (const t of inspection?.visibleTables || []) {
    add(t?.label);
    for (const h of t?.headers || []) add(h);
  }
  for (const at of inspection?.assertionTargets || []) add(typeof at === 'string' ? at : at?.text);
  return tokens;
}

/**
 * Are the generated cases grounded in what the inspector saw? Heuristic, not perfect:
 * if the inspector saw real page content but NONE of the generated cases reference any
 * observed token, the cases were almost certainly written from the prompt alone (the
 * ungrounded-tests failure). Returns ok with a coverage ratio when grounded.
 */
export function assessCasesGrounding(cases: any[], inspection: any): VerifierVerdict {
  if (!Array.isArray(cases) || cases.length === 0) {
    return { ok: false, reason: 'No test cases were generated.' };
  }
  const tokens = observedTokens(inspection);
  // If the inspector saw nothing (blind inspection), the cases CANNOT be grounded in the
  // live app — say so honestly instead of reporting a misleading "ok".
  if (tokens.size === 0) return { ok: false, reason: 'The inspector observed nothing on the page, so these cases are not grounded in the live application.' };

  let grounded = 0;
  for (const c of cases) {
    const text = JSON.stringify([c?.title, c?.description, c?.steps]).toLowerCase();
    if ([...tokens].some((tok) => text.includes(tok))) grounded += 1;
  }
  const ratio = grounded / cases.length;
  if (grounded === 0) {
    return { ok: false, reason: `None of the ${cases.length} generated cases reference anything the inspector observed on the page — they appear ungrounded (written from the prompt, not the live app).` };
  }
  return { ok: true, reason: `${grounded}/${cases.length} cases reference observed page content (${Math.round(ratio * 100)}% grounded).` };
}

/** Did the scripts actually execute and produce real verdicts? (catches false-green) */
export function assessExecution(execResult: any): VerifierVerdict {
  if (!execResult || typeof execResult !== 'object') {
    return { ok: false, reason: 'No execution result was recorded — nothing actually ran.' };
  }
  const total = Number(execResult.total) || 0;
  if (total === 0) {
    return { ok: false, reason: 'Execution produced zero tests — no verdict was obtained.' };
  }
  const failed = Number(execResult.failed) || 0;
  if (failed > 0) {
    return { ok: false, reason: `${failed} of ${total} test(s) failed${execResult.error ? `: ${execResult.error}` : '.'}` };
  }
  return { ok: true, reason: `${execResult.passed ?? total}/${total} test(s) passed.` };
}
