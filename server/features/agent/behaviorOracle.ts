/**
 * Behavior Oracle (observe-then-assert) — replaces GUESSED validation assertions with OBSERVED ones. A bounded
 * probe drives the opened form once (submit empty → which fields the app rejects + how; fill one → auto-derive
 * + transform) and records the facts; the author asserts them and the critic refutes any that contradict them.
 * App-agnostic (reads aria-invalid / inline .error / role=alert / required-* convention). Import-safe: the probe
 * takes a live `page`; render + critic helpers are pure.
 */

export type ValidationMechanism = 'aria-invalid' | 'inline-text' | 'alert' | 'button-disabled' | 'none';
export type TransformKind = 'verbatim' | 'lowercase' | 'uppercase' | 'trim' | 'truncated';

export interface FieldBehavior {
  /** Cleaned field label (required-asterisk / "(required)" stripped). */
  label: string;
  /** Stable id used to act on the field during the probe (empty when the control has no id). */
  fieldId: string;
  /** The app showed a validation error for THIS field when the form was submitted empty (strong signal). */
  requiredObserved: boolean;
  /** The DOM marks THIS field required (required / aria-required / a `*` or "required" in its label). */
  requiredDeclared?: boolean;
  /** Label of the field whose fill auto-populated this one (e.g. API Name derives from Label). */
  autoDerivedFrom?: string;
  /** How the app transformed a typed value in this field, when observed. */
  transform?: TransformKind;
  /** Captured hard length bound (maxlength), when present. */
  maxLength?: number;
}

export interface BehaviorObservation {
  /** True once a probe actually ran and read the form; false/absent → consumers ignore it (no guessing). */
  probed: boolean;
  /** The empty submit ACTUALLY triggered validation (≥1 field errored). When false the required-probe was
   * inconclusive — consumers must NOT infer any field is optional, only fall back to declared markers. */
  validationTriggered: boolean;
  /** Validation errors appear only AFTER a submit attempt (they do not exist on the freshly-opened form). */
  requiresSubmitToValidate: boolean;
  /** How the app surfaces a validation error, observed on the empty submit. */
  validationMechanism: ValidationMechanism;
  /** Label/text of the submit/create control the probe clicked. */
  submitLabel?: string;
  fields: FieldBehavior[];
}

/** A field is required if the DOM declares it required, or (when the form declares NO required markers at all)
 * the app rejected it empty. Declared markers WIN when present: a fully-empty submit makes cosmetically-required
 * fields (a client "X is required" fallback with no `*`) error too, so observed-only can't be trusted then. */
export function isRequiredField(f: FieldBehavior, obs?: { fields: FieldBehavior[] }): boolean {
  if (f.requiredDeclared === true) return true;
  if (obs && obs.fields.some((x) => x.requiredDeclared === true)) return false;
  return f.requiredObserved;
}

/** A field is CONFIDENTLY optional only when the probe actually triggered validation AND the field is not
 * required by the declared-aware rule — never inferred from a probe that failed to trigger anything. */
export function isConfidentlyOptional(obs: BehaviorObservation, f: FieldBehavior): boolean {
  return obs.validationTriggered && !isRequiredField(f, obs);
}

// --- Pure classifiers (unit-tested without a browser) -----------------------------------------------------

/** Compare a typed value to what the field held back → the transform the app applied. Conservative. */
export function classifyTransform(input: string, output: string, maxLength?: number | null): TransformKind {
  if (output === input) return 'verbatim';
  if (output === input.toLowerCase() && input !== input.toLowerCase()) return 'lowercase';
  if (output === input.toUpperCase() && input !== input.toUpperCase()) return 'uppercase';
  if (output === input.trim() && input !== input.trim()) return 'trim';
  if (maxLength && maxLength > 0 && output === input.slice(0, maxLength) && output.length < input.length) return 'truncated';
  return 'verbatim';
}

const CLEAN_LABEL = (s: string) => String(s || '')
  .replace(/\s*\*\s*$/, '')
  .replace(/\(\s*required\s*\)/i, '')
  .replace(/\s+required\s*$/i, '')
  .replace(/\s+/g, ' ')
  .trim();

// --- Prompt rendering -------------------------------------------------------------------------------------

/** The OBSERVED FORM BEHAVIOR block the authors see — turns the probe facts into authoring rules so validation
 * cases are written the ONLY correct way (single-field isolation) and never assert an error the app won't show. */
export function renderBehaviorForPrompt(obs: BehaviorObservation | null | undefined): string {
  if (!obs?.probed || !obs.fields.length) return '';
  const required = obs.fields.filter((f) => isRequiredField(f, obs)).map((f) => f.label);
  const optional = obs.fields.filter((f) => isConfidentlyOptional(obs, f)).map((f) => f.label);
  const derived = obs.fields.filter((f) => f.autoDerivedFrom);
  const transformed = obs.fields.filter((f) => f.transform && f.transform !== 'verbatim');
  const submit = obs.submitLabel ? `"${obs.submitLabel}"` : 'the create/save button';
  const lines: string[] = ['OBSERVED FORM BEHAVIOR (measured live on this form — assert ONLY what was observed; do NOT guess validation behaviour):'];
  if (required.length) lines.push(`- Fields the app requires (rejected empty or DOM-marked required): ${required.join(', ')}. Author one negative validation case per required field.`);
  if (optional.length) lines.push(`- Fields that showed NO error when submitted empty (do NOT author a "required"/validation case for these): ${optional.join(', ')}.`);
  for (const d of derived) lines.push(`- "${d.label}" AUTO-DERIVES from "${d.autoDerivedFrom}" (it fills itself) — do NOT assert it is required unless the case explicitly clears it after "${d.autoDerivedFrom}" is filled.`);
  for (const t of transformed) lines.push(`- "${t.label}" is transformed on entry (${t.transform}) — assert the app's ${t.transform} OUTPUT, never the raw typed value.`);
  lines.push(`- Validation errors appear ONLY AFTER clicking ${submit}; the freshly-opened form shows none. A FILLED required field shows NO error — only an EMPTY one does.`);
  lines.push(`- To test that "X is required": FILL every OTHER required field with a valid value, leave ONLY X empty, click ${submit}, THEN assert the error on X alone. Never assert a required-error on a field you filled, on a confirmed-optional field, or before the submit.`);
  return lines.join('\n');
}

// --- Critic helper (deterministic, high-precision) --------------------------------------------------------

const VALIDATION_INTENT = /\b(required|mandatory|validation|invalid|rejected|cannot|not\s+allowed|blank|empty|error)\b/i;
const ASSERTS_VALIDATION = /\b(error|warning|alert|invalid|rejected|not\s+allowed|cannot|must\s+(be\s+)?(provided|entered|filled|selected)|is\s+required|required\s+(field\s+)?(error|message|indicator)|validation)\b/i;
const FILL_VERB = /\b(fill|enter|type|input|provide|set|select|choose|complete)\b/i;
const LEAVE_EMPTY = /\b(leave|blank|empty|without|omit|skip|clear|remove)\b/i;

function isValidationText(t: string): boolean {
  if (/\bwith\s+(all\s+)?required\b/i.test(t)) return false; // positive "with all required fields" is not a validation case
  return VALIDATION_INTENT.test(t);
}
const mentions = (text: string, label: string) => label.length >= 3 && text.toLowerCase().includes(label.toLowerCase());

export interface BehaviorIssue { code: string; issue: string }

/** Refute a validation assertion that contradicts the observed behaviour (field not enforced / filled earlier /
 * auto-derived). High-precision: fires only on a probed field named in the asserting step. */
export function behaviorCritique(
  c: { title?: string; description?: string; steps?: Array<{ action?: string; expected?: string }> },
  obs: BehaviorObservation | null | undefined,
): BehaviorIssue[] {
  if (!obs?.probed || !obs.fields.length) return [];
  const steps = Array.isArray(c.steps) ? c.steps : [];
  if (!steps.length) return [];
  if (!isValidationText(`${c.title ?? ''}. ${c.description ?? ''}`)) return [];

  const out: BehaviorIssue[] = [];
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const expected = String(s.expected ?? '');
    if (!ASSERTS_VALIDATION.test(expected)) return;
    const probe = obs.fields.find((f) => f.label && mentions(`${s.action ?? ''} ${expected}`, f.label));
    if (!probe) return;
    const push = (code: string, issue: string) => { if (!seen.has(code + probe.label)) { seen.add(code + probe.label); out.push({ code, issue }); } };

    if (isConfidentlyOptional(obs, probe)) {
      push('assert-nonrequired', `Step ${i + 1} asserts a required/validation error on "${probe.label}", but on the live form that field is not enforced as required (no required marker; a fully-empty submit only shows a cosmetic message). Assert validation only on a required field (${obs.fields.filter((f) => isRequiredField(f, obs)).map((f) => f.label).join(', ') || 'none observed'}).`);
      return;
    }
    if (probe.autoDerivedFrom) {
      push('assert-autoderived', `Step ${i + 1} asserts "${probe.label}" is required, but on the live form "${probe.label}" AUTO-DERIVES from "${probe.autoDerivedFrom}" — it is not empty unless explicitly cleared after "${probe.autoDerivedFrom}" is filled. Either clear "${probe.label}" after filling "${probe.autoDerivedFrom}" and submit, or drop this case.`);
      return;
    }
    const filledEarlier = steps.slice(0, i).some((p) => {
      const a = String(p.action ?? '');
      return FILL_VERB.test(a) && !LEAVE_EMPTY.test(a) && mentions(a, probe.label);
    });
    if (filledEarlier) {
      push('assert-filled-field', `Step ${i + 1} asserts a required-field error on "${probe.label}", but an earlier step FILLS "${probe.label}" — a filled field shows no required error, so this always fails. To test that "${probe.label}" is required, leave ONLY it empty (fill every other required field with valid values), submit, then assert the error on it.`);
    }
  });
  return out;
}

// --- The probe (uses a live Playwright page; the only browser-touching part) ------------------------------

const EVAL_GATHER = (scopeSel: string) => `(() => {
  const scope = ${JSON.stringify(scopeSel)} ? (document.querySelector(${JSON.stringify(scopeSel)}) || document) : document;
  const labelEl = (el) => { try { if (el.id) return document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); } catch (e) {} return null; };
  const rawLabel = (el) => { const lab = labelEl(el); let l = lab ? (lab.textContent || '') : ''; if (!l) l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || ''; return String(l); };
  const clean = (l) => l.replace(/\\s*\\*\\s*$/, '').replace(/\\(\\s*required\\s*\\)/i, '').replace(/\\s+required\\s*$/i, '').replace(/\\s+/g, ' ').trim();
  const declaredReq = (el) => {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const lab = labelEl(el);
    if (lab && (lab.querySelector('.required-asterisk, .required, [class*="required" i], [class*="asterisk" i]') || /[*]|\\brequired\\b/i.test(lab.textContent || ''))) return true;
    const c = el.closest('.form-field, .field, .form-group');
    if (c && c.querySelector('.required-asterisk, [class*="required" i], [class*="asterisk" i]')) return true;
    return false;
  };
  const els = [...scope.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=search]):not([type=button]):not([type=submit]), textarea, select')];
  return els.map((el) => ({ fieldId: el.id || '', label: clean(rawLabel(el)), req: declaredReq(el), tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null, value: 'value' in el ? String(el.value || '') : '' }));
})()`;

const EVAL_ERRORS = (scopeSel: string) => `(() => {
  const scope = ${JSON.stringify(scopeSel)} ? (document.querySelector(${JSON.stringify(scopeSel)}) || document) : document;
  const errSel = '.error, .invalid, [class*="error" i], [aria-invalid="true"], [role="alert"]';
  const anyAlert = !!scope.querySelector('[role="alert"]');
  let anyAria = false, anyInline = false;
  const fieldErr = {};
  for (const el of scope.querySelectorAll('input, textarea, select')) {
    if (!el.id) continue;
    const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
    const container = el.closest('.form-field, .field, .form-group, div') || el.parentElement;
    const inlineErr = !!(container && container.querySelector('.error, .invalid, [class*="error" i]'));
    if (ariaInvalid) anyAria = true;
    if (inlineErr) anyInline = true;
    if (ariaInvalid || inlineErr) fieldErr[el.id] = true;
  }
  return { fieldErr, anyAria, anyInline, anyAlert, errorCount: scope.querySelectorAll(errSel).length };
})()`;

/** Find the submit/create control inside the form scope (app-agnostic verb match; primary preferred). */
const SUBMIT_VERB = /\b(create|save|add|submit|confirm|apply|register|update|finish|done|ok)\b/i;

async function findSubmitIn(root: any): Promise<{ locator: any; label: string } | null> {
  const buttons = root.locator('button, [role="button"], input[type="submit"]');
  const n = await buttons.count().catch(() => 0);
  let fallback: { locator: any; label: string } | null = null;
  for (let i = 0; i < Math.min(n, 30); i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const txt = CLEAN_LABEL(String((await b.textContent().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || (await b.getAttribute('aria-label').catch(() => '')) || ''));
    if (!txt || !SUBMIT_VERB.test(txt)) continue;
    if (/cancel|close|back|reset|discard|new\b/i.test(txt)) continue;
    const entry = { locator: b, label: txt };
    if (!fallback) fallback = entry;
    if (await b.isEnabled().catch(() => false)) return entry; // prefer an enabled submit
  }
  return fallback;
}

/** Prefer the submit inside the form scope; the overlay mark can land on an inner container without the
 * footer, so fall back to a page-wide search (the modal's Create/Save is the visible submit). */
async function findSubmit(page: any, scopeSel: string): Promise<{ locator: any; label: string } | null> {
  if (scopeSel) { const inScope = await findSubmitIn(page.locator(scopeSel)); if (inScope) return inScope; }
  return findSubmitIn(page);
}

/** Probe the OPENED form (discovery calls this while it's up). Non-destructive: the only click is a submit on an
 * EMPTY form the app rejects. Never throws — probed=false when it can't read the form. */
export async function probeFormBehavior(page: any, scopeSel: string): Promise<BehaviorObservation> {
  const empty: BehaviorObservation = { probed: false, validationTriggered: false, requiresSubmitToValidate: false, validationMechanism: 'none', fields: [] };
  try {
    const raw: any[] = await page.evaluate(EVAL_GATHER(scopeSel)).catch(() => []);
    const descriptors = (Array.isArray(raw) ? raw : []).filter((d) => d && (d.fieldId || d.label));
    if (!descriptors.length) return empty;

    const fields: FieldBehavior[] = descriptors.map((d) => ({
      label: CLEAN_LABEL(d.label), fieldId: String(d.fieldId || ''),
      requiredObserved: false, requiredDeclared: d.req === true, maxLength: d.maxLength || undefined,
    }));
    const byId = new Map(fields.map((f) => [f.fieldId, f]));

    // --- Auto-derive + transform probe: fill the FIRST fillable text field, then re-read every field's value.
    const firstText = descriptors.find((d) => d.fieldId && (d.tag === 'input' || d.tag === 'textarea') && d.type !== 'select-one');
    if (firstText) {
      const token = 'Zx Qy Probe';
      const filled = byId.get(firstText.fieldId);
      const before = new Map(descriptors.map((d) => [d.fieldId, String(d.value || '')]));
      const ok = await page.locator(`#${cssId(firstText.fieldId)}`).fill(token, { timeout: 4000 }).then(() => true).catch(() => false);
      if (ok) {
        await page.waitForTimeout(250).catch(() => undefined);
        const after: any[] = await page.evaluate(EVAL_GATHER(scopeSel)).catch(() => []);
        for (const a of Array.isArray(after) ? after : []) {
          const f = byId.get(a.fieldId);
          if (!f) continue;
          if (a.fieldId === firstText.fieldId && filled) filled.transform = classifyTransform(token, String(a.value || ''), a.maxLength);
          else if ((before.get(a.fieldId) || '') === '' && String(a.value || '').trim() !== '' && filled) f.autoDerivedFrom = filled.label;
        }
      }
    }

    // --- Required probe: clear every text field, submit, observe which fields the app rejects and how.
    for (const d of descriptors) {
      if (d.fieldId && (d.tag === 'input' || d.tag === 'textarea')) {
        await page.locator(`#${cssId(d.fieldId)}`).fill('', { timeout: 3000 }).catch(() => undefined);
      }
    }
    const submit = await findSubmit(page, scopeSel);
    let validationTriggered = false;
    let mechanism: ValidationMechanism = 'none';
    if (submit) {
      const enabledBefore = await submit.locator.isEnabled().catch(() => true);
      await submit.locator.click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(700).catch(() => undefined);
      const errs: any = await page.evaluate(EVAL_ERRORS(scopeSel)).catch(() => null);
      if (errs && errs.fieldErr) {
        for (const id of Object.keys(errs.fieldErr)) { const f = byId.get(id); if (f) f.requiredObserved = true; }
      }
      validationTriggered = fields.some((f) => f.requiredObserved) || Boolean(errs?.anyAlert);
      if (errs?.anyAria) mechanism = 'aria-invalid';
      else if (errs?.anyInline) mechanism = 'inline-text';
      else if (errs?.anyAlert) mechanism = 'alert';
      else if (!enabledBefore) mechanism = 'button-disabled';
    }

    return {
      probed: true,
      validationTriggered,
      // Errors are submit-gated when the app surfaces them post-submit (any observed mechanism except a
      // permanently-disabled button, which is its own gating story).
      requiresSubmitToValidate: validationTriggered || mechanism === 'inline-text' || mechanism === 'aria-invalid' || mechanism === 'alert',
      validationMechanism: mechanism,
      submitLabel: submit?.label,
      fields: fields.filter((f) => f.label),
    };
  } catch {
    return empty;
  }
}

/** CSS.escape-equivalent for an id used in a `#id` selector (ids here are simple, but guard odd chars). */
function cssId(id: string): string {
  return String(id).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
