/**
 * Test Data Engine — the single entry point. Given a field's semantics it infers intent and returns a
 * realistic value: identity-backed kinds (name/email/…) come from ONE coherent per-run identity so related
 * fields stay consistent; other kinds are generated from seeded providers keyed by the field so the same
 * field is stable across reruns while distinct fields differ. Constraints (maxLength/options/pattern) are
 * respected. SELECT never invents — it picks a real captured option. Deterministic, provider-agnostic,
 * model-agnostic; extend by adding a kind (types + inferKind + one entry in GENERATORS).
 */
import { SeededRandom } from './seededRandom';
import { buildIdentity } from './identity';
import { inferFieldKind } from './inferKind';
import { matchSchemaField, generateFromSchema, applyUnique } from './schemaResolve';
import * as p from './providers';
import type { FieldKind, FieldSemantics, GeneratedIdentity, ObjectSchema } from './types';

/** A generator gets the run identity and a per-FIELD seeded RNG (stable for that field). */
type Generator = (id: GeneratedIdentity, r: SeededRandom) => string;

const GENERATORS: Record<FieldKind, Generator> = {
  firstName: (id) => id.firstName,
  lastName: (id) => id.lastName,
  fullName: (id) => id.fullName,
  username: (id) => id.username,
  email: (id) => id.email,
  phone: (id) => id.phone,
  company: (id) => id.company,
  streetAddress: (id) => id.streetAddress,
  city: (id) => id.city,
  state: (id) => id.state,
  country: (id) => id.country,
  postalCode: (id) => id.postalCode,
  password: (id) => id.password,
  confirmPassword: (id) => id.password, // must match the password field within the run
  otp: (_id, r) => p.otp(r),
  search: (id, r) => r.pick([id.company.split(' ')[0], id.lastName, id.city]), // a plausible real-looking term
  url: (_id, r) => p.website(r),
  date: (_id, r) => p.isoDate(r),
  time: (_id, r) => p.timeValue(r),
  amount: (_id, r) => p.amount(r),
  quantity: (_id, r) => p.quantity(r),
  number: (_id, r) => p.integerValue(r),
  description: (_id, r) => p.loremPhrase(r),
  // Name-like fields feed create forms with uniqueness checks — a bare pool phrase collides across runs.
  title: (_id, r) => p.uniquePhrase(r),
  subject: (_id, r) => p.loremPhrase(r),
  apiName: (_id, r) => p.apiIdentifier(r),
  codePrefix: (_id, r) => p.shortCode(r),
  version: (_id, r) => p.versionString(r),
  employeeId: (_id, r) => p.prefixedId('EMP', 5, r),
  customerId: (_id, r) => p.prefixedId('CUST', 6, r),
  orderNumber: (_id, r) => p.prefixedId('ORD', 6, r),
  invoiceNumber: (_id, r) => p.prefixedId('INV', 6, r),
  referenceId: (_id, r) => p.prefixedId('REF', 8, r),
  pan: (_id, r) => p.pan(r),
  gst: (_id, r) => p.gst(r),
  aadhaar: (_id, r) => p.aadhaar(r),
  passport: (_id, r) => p.passport(r),
  license: (_id, r) => p.license(r),
  creditCard: () => p.creditCard(),
  cvv: (_id, r) => p.cvv(r),
  expiry: (_id, r) => p.expiry(r),
  unknown: (_id, r) => p.uniquePhrase(r),
};

/** A stable per-field key so the same field yields the same value across reruns. */
function fieldKey(sem: FieldSemantics): string {
  return String(sem.semanticName || sem.name || sem.id || sem.label || sem.placeholder || 'field').toLowerCase();
}

/** Apply captured constraints so the value stays valid (best-effort; never throws). */
function applyConstraints(value: string, sem: FieldSemantics, r: SeededRandom): string {
  let out = value;
  // Simple digit/alpha patterns are honored exactly; complex patterns are left as-is (best effort).
  const pat = String(sem.pattern || '').trim();
  const digitsOnly = /^\\?d(\{(\d+)(,(\d+))?\})?\+?\*?$|^\[0-9\]/.test(pat) || /^\d+$/.test(pat.replace(/[\\{}\d,+*\[\]]/g, ''));
  if (pat && digitsOnly) {
    const m = /\{(\d+)/.exec(pat);
    out = r.digits(m ? Number(m[1]) : Math.max(3, out.replace(/\D/g, '').length || 4));
  }
  const max = typeof sem.maxLength === 'number' && sem.maxLength > 0 ? sem.maxLength : null;
  if (max && out.length > max) out = out.slice(0, max);
  const min = typeof sem.minLength === 'number' && sem.minLength > 0 ? sem.minLength : null;
  if (min && out.length < min) out = (out + p.loremPhrase(r).replace(/\s/g, '')).slice(0, Math.max(min, out.length)).padEnd(min, 'x');
  if (sem.required && !out) out = p.loremPhrase(r);
  return out;
}

/** Is a plan-provided value meaningful test intent to KEEP, or a blank/generic placeholder to replace? */
function isGenericPlanValue(value: string | undefined | null): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return true;
  return /^(auto|value|text|sample|test|test\s?data|placeholder|input|xxx+|todo|n\/?a|string|example|dummy|foo|bar)$/.test(v)
    || /^(known|some|a|an|the)[\s_-]/.test(v)  // "known partial app name", "some value"
    // Author placeholders like "unique_label", "any parent app", "valid values", "test-prefix" — these
    // describe the KIND of value, not a value; filling them verbatim breaks form validation/uniqueness.
    || /^(unique|any|valid|some|existing|test|sample|dummy|generic|placeholder|appropriate|desired|required)([ _-][a-z0-9]+)+$/.test(v)
    || /random|no\s?match|gibberish/.test(v);
}

export class TestDataEngine {
  private readonly identity: GeneratedIdentity;
  private readonly runSeed: string;
  /** Backend schema(s) for API-acceptance-conformant generation; empty → pure DOM-semantic generation. */
  private readonly schemas: ObjectSchema[];

  /** Seed from a run-UNIQUE string (the runId) so each run's identity is distinct — no cross-run duplicate
   * name/email/code — while staying consistent within the run. Optional backend schema drives API conformance. */
  constructor(runSeed: string, schemas?: ObjectSchema[] | null) {
    this.runSeed = String(runSeed || 'testflow');
    this.identity = buildIdentity(this.runSeed);
    this.schemas = Array.isArray(schemas) ? schemas : [];
  }

  /** The run's coherent identity (exposed for reuse/consistency by callers that need it directly). */
  getIdentity(): GeneratedIdentity { return this.identity; }

  /** Whether any object schema was supplied — lets callers prefer schema-driven behavior only when it exists. */
  hasSchema(): boolean { return this.schemas.length > 0; }

  /** Does the backend API mark this field REQUIRED? The schema is the authority on which fields a create
   * form must fill; used by the compiler to complete a form before submit even when the plan omitted it. */
  isRequiredBySchema(sem: FieldSemantics): boolean {
    return matchSchemaField(sem, this.schemas)?.required === true;
  }

  /** Resolve a text value for a FILL. Explicit meaningful plan value wins; else schema-conformant when a
   * backend field matches; else DOM-semantic generation. Uniqueness-constrained fields are kept distinct. */
  fillValue(sem: FieldSemantics, planValue?: string | null): string {
    if (!isGenericPlanValue(planValue)) return String(planValue);
    const field = matchSchemaField(sem, this.schemas);

    // API-acceptance path: a matched backend field's type/picklist/reference decides a conformant value.
    if (field) {
      const conformant = generateFromSchema(field, sem, this.identity, this.schemas, this.runSeed);
      if (conformant != null) return conformant;
    }

    const kind = inferFieldKind(sem);
    const r = new SeededRandom(`${this.runSeed}:${kind}:${fieldKey(sem)}`);
    const raw = (GENERATORS[kind] ?? GENERATORS.unknown)(this.identity, r);
    // Apply the schema's uniqueness constraint to the semantic value so create forms avoid dup-key errors.
    return applyUnique(applyConstraints(raw, sem, r), field, this.runSeed);
  }

  /**
   * Resolve a SELECT value to a REAL option (never invents). Prefers the plan value if it matches an
   * option; otherwise picks the first meaningful enabled option (skips placeholder rows like "Select…").
   */
  selectValue(sem: FieldSemantics, planValue?: string | null): string {
    const options = (sem.options || []).filter((o) => o && !o.disabled);
    const wanted = String(planValue ?? '').trim().toLowerCase();
    if (wanted) {
      const hit = options.find((o) => String(o.value ?? '').toLowerCase() === wanted || String(o.label ?? '').toLowerCase() === wanted);
      if (hit) return String(hit.value ?? hit.label ?? '');
    }
    const meaningful = options.filter((o) => {
      const t = `${o.label ?? ''} ${o.value ?? ''}`.trim().toLowerCase();
      return t && !/^(select|choose|--|please\s|none|pick|all)\b/.test(t) && String(o.value ?? '') !== '';
    });
    const pool = meaningful.length ? meaningful : options;
    const r = new SeededRandom(`${this.runSeed}:select:${fieldKey(sem)}`);
    if (pool.length) return String((pool[r.int(0, pool.length - 1)]).value ?? (pool[r.int(0, pool.length - 1)]).label ?? '');

    // Live <select> had no captured options (dynamic dropdown) — fall back to the backend field's picklist.
    const field = matchSchemaField(sem, this.schemas);
    const picks = (field?.picklistValues || []).filter(Boolean);
    if (picks.length) return String(picks[r.int(0, picks.length - 1)]);
    return String(planValue ?? '');
  }
}
