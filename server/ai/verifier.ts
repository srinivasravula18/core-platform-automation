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
  // Optional, additive signals. Kept OPTIONAL so existing callers (and the .ok blocking
  // gates in agent/routes.ts) are unaffected — these only SURFACE confidence, never block.
  ratio?: number; // 0..1 coverage/grounding ratio when meaningful
  severity?: 'ok' | 'weak' | 'fail'; // 'weak' = passed the gate but low-confidence
}

/** Did the inspector actually SEE the live application? (catches the blind-inspection class) */
export function assessInspection(ctx: any): VerifierVerdict {
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, reason: 'No inspection context was produced.' };
  }
  const nav = (ctx.visibleNavigation || []).length;
  const forms = (ctx.visibleForms || []).length;
  const tables = (ctx.visibleTables || []).length;
  const observed = nav + forms + tables;
  // "Blind" means the inspector could not READ the page at all. A 'blocked' GOAL — e.g. the
  // list records were still "Loading…", or one sub-step couldn't complete — is NOT blind when
  // the page WAS observed: the captured navigation/forms/tables are valid grounding for cases.
  // Only treat it as blind when nothing at all was observed (the real blind-inspection class).
  if (observed === 0) {
    const why = Array.isArray(ctx.warnings) && ctx.warnings.length ? `: ${ctx.warnings.join('; ')}` : '';
    return { ok: false, reason: `Inspector observed no navigation, forms, or tables — it could not read the live page${why}.` };
  }
  return {
    ok: true,
    reason: `Observed ${nav} navigation item(s), ${forms} form(s), ${tables} table(s)${ctx.goalStatus === 'blocked' ? ' (goal only partially reached — grounding on the observed page)' : ''}.`,
  };
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
  if (tokens.size === 0) return { ok: false, severity: 'fail', ratio: 0, reason: 'The inspector observed nothing on the page, so these cases are not grounded in the live application.' };

  let grounded = 0;
  for (const c of cases) {
    const text = JSON.stringify([c?.title, c?.description, c?.steps]).toLowerCase();
    if ([...tokens].some((tok) => text.includes(tok))) grounded += 1;
  }
  const ratio = grounded / cases.length;
  if (grounded === 0) {
    return { ok: false, severity: 'fail', ratio, reason: `None of the ${cases.length} generated cases reference anything the inspector observed on the page — they appear ungrounded (written from the prompt, not the live app).` };
  }
  // WHY surface-but-don't-block on low ratio: the gate's .ok stays "at least one grounded"
  // because hard-blocking on ratio caused false-negatives (a few legitimately-novel cases
  // dragging the average down, rejecting good runs). Honest flagging via severity='weak' is
  // safer than both silent green AND over-rejection — the reviewer sees the low coverage.
  const severity: VerifierVerdict['severity'] = ratio < 0.5 ? 'weak' : 'ok';
  const base = `${grounded}/${cases.length} cases reference observed page content (${Math.round(ratio * 100)}% grounded).`;
  const reason = severity === 'weak'
    ? `${base} — LOW COVERAGE: only ${Math.round(ratio * 100)}% of cases are grounded; review before trusting.`
    : base;
  return { ok: true, severity, ratio, reason };
}

/** Did the scripts actually execute and produce real verdicts? (catches false-green) */
export function assessExecution(execResult: any): VerifierVerdict {
  if (!execResult || typeof execResult !== 'object') {
    return { ok: false, severity: 'fail', reason: 'No execution result was recorded — nothing actually ran.' };
  }
  const total = Number(execResult.total) || 0;
  if (total === 0) {
    return { ok: false, severity: 'fail', reason: 'Execution produced zero tests — no verdict was obtained.' };
  }
  const failed = Number(execResult.failed) || 0;
  if (failed > 0) {
    return { ok: false, severity: 'fail', reason: `${failed} of ${total} test(s) failed${execResult.error ? `: ${execResult.error}` : '.'}` };
  }
  const passed = Number(execResult.passed) || 0;
  const skipped = Number(execResult.skipped) || 0;
  // False-green leak: failed===0 && total>0 is NOT a green light when every test was SKIPPED.
  // A skipped test yields no positive verdict, so "0 failed" here means "nothing was actually
  // proven" — report it honestly instead of laundering skips into a pass.
  if (failed === 0 && passed === 0) {
    return { ok: false, severity: 'fail', reason: `Execution ran ${total} test(s) but NONE passed (${skipped} skipped) — no positive verdict was obtained.` };
  }
  const note = skipped > 0 ? ` (${skipped} skipped)` : '';
  return { ok: true, severity: 'ok', reason: `${passed || total}/${total} test(s) passed${note}.` };
}

/**
 * Guards the "feature reports tested while sub-features were silently skipped" failure:
 * a top-level feature can look covered while whole sub-features have zero cases. We map each
 * declared sub-feature to the cases and flag any with no test at all. Same token-overlap idea
 * as assessCasesGrounding/observedTokens — tokenize the sub-feature name and check the case text.
 */
export function assessFeatureCompleteness(
  feature: string,
  subFeatures: Array<{ name: string } | string>,
  cases: any[],
): VerifierVerdict & { covered: string[]; uncovered: string[] } {
  const names = (subFeatures || [])
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .map((n) => String(n || '').trim())
    .filter((n) => n.length > 0);

  if (names.length === 0) {
    // Nothing to verify — don't manufacture a failure when no sub-features were declared.
    return { ok: true, severity: 'ok', ratio: 1, reason: `Feature "${feature}": no sub-features were provided to verify.`, covered: [], uncovered: [] };
  }

  // Precompute each case's combined searchable text once.
  const caseTexts = (cases || []).map((c) =>
    JSON.stringify([c?.title, c?.description, c?.steps, c?.tags]).toLowerCase(),
  );

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const name of names) {
    // Tokenize like observedTokens: lowercase, alphanumeric words length >= 3. Short fragments
    // are dropped, which conveniently filters most generic stopword-like noise. A sub-feature is
    // covered if ANY of its meaningful tokens appears in ANY case's text.
    const toks = name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    const isCovered = toks.length > 0 && caseTexts.some((text) => toks.some((tok) => text.includes(tok)));
    (isCovered ? covered : uncovered).push(name);
  }

  const ok = uncovered.length === 0;
  const ratio = covered.length / Math.max(1, names.length);
  const reason = ok
    ? `All ${names.length} sub-features of "${feature}" have at least one test case.`
    : `Feature "${feature}": ${covered.length}/${names.length} sub-features covered; UNCOVERED: ${uncovered.join(', ')}.`;
  return { ok, severity: ok ? 'ok' : 'fail', ratio, reason, covered, uncovered };
}
