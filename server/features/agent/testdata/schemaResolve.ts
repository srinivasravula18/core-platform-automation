/**
 * Schema-aware value resolution — the "API acceptance" layer. When the backend object schema is available,
 * a DOM field is matched to its backend field and the value is generated to CONFORM to that field (real
 * picklist value, real reference from the sample record, correct data type, required) while staying UNIQUE
 * for constraint fields (name/code/email) so create forms don't hit duplicate-key errors. When no schema
 * field matches, the caller falls back to DOM-semantic inference — this layer never blocks, only enriches.
 */
import { SeededRandom } from './seededRandom';
import type { FieldSemantics, GeneratedIdentity, ObjectSchema, SchemaField } from './types';

const norm = (s: unknown): string => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Match a DOM field to its backend field by name/id/label/semanticName ↔ apiName/label. Exact-normalized. */
export function matchSchemaField(sem: FieldSemantics, schemas: ObjectSchema[] | undefined | null): SchemaField | null {
  if (!schemas?.length) return null;
  const keys = [sem.name, sem.id, sem.label, sem.semanticName].map(norm).filter(Boolean);
  if (!keys.length) return null;
  const keySet = new Set(keys);
  for (const schema of schemas) {
    for (const field of schema.fields) {
      const cand = [norm(field.apiName), norm(field.label)].filter(Boolean);
      if (cand.some((c) => keySet.has(c))) return field;
    }
  }
  return null;
}

const dt = (f: SchemaField): string => String(f.dataType || 'text').toLowerCase();

/** True for backend types whose value must come from a fixed/related set — the engine must not invent them. */
export function isConstrainedType(f: SchemaField): boolean {
  return /picklist|select|enum|option|multi/.test(dt(f)) || /reference|lookup|relation|foreign/.test(dt(f));
}

/** A short deterministic token so uniqueness-constrained fields differ per run even if the identity repeats. */
function uniqueToken(runSeed: string): string {
  return new SeededRandom(`uniq:${runSeed}`).alnum(4).toLowerCase();
}

/**
 * Generate a value that the API will accept for `field`. Returns null when this layer has no better answer
 * than the DOM-semantic fallback (so the caller keeps its existing behavior).
 */
export function generateFromSchema(
  field: SchemaField,
  sem: FieldSemantics,
  identity: GeneratedIdentity,
  schemas: ObjectSchema[],
  runSeed: string,
): string | null {
  const type = dt(field);
  const r = new SeededRandom(`${runSeed}:schema:${field.apiName}`);

  // Picklist/enum → a REAL allowed value (never invents). Prefer the schema; a live <select> is handled elsewhere.
  if (/picklist|select|enum|option|multi/.test(type)) {
    const opts = (field.picklistValues || []).filter(Boolean);
    return opts.length ? String(opts[r.int(0, opts.length - 1)]) : null;
  }

  // Reference/lookup → reuse the sample record's real related id for this field (a value the API already accepted).
  if (/reference|lookup|relation|foreign/.test(type)) {
    for (const s of schemas) {
      const v = s.sample?.[field.apiName];
      if (v != null && v !== '') return String(typeof v === 'object' ? (v as any).id ?? (v as any).value ?? '' : v);
    }
    return null; // no real reference available → let the caller decide (usually skip/diagnostic)
  }

  const unique = field.unique ? `.${uniqueToken(runSeed)}` : '';

  if (/email/.test(type)) {
    return field.unique ? identity.email.replace('@', `${uniqueToken(runSeed)}@`) : identity.email;
  }
  if (/bool|checkbox|switch/.test(type)) return r.next() < 0.5 ? 'true' : 'false';
  if (/currency|money|decimal|amount|number|int|float|percent/.test(type)) {
    return /int/.test(type) ? String(r.int(1, 999)) : `${r.int(1, 9999)}.${r.digits(2)}`;
  }
  if (/datetime|timestamp/.test(type)) return `${r.int(2024, 2027)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}T09:00`;
  if (/date/.test(type)) return `${r.int(2024, 2027)}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
  if (/time/.test(type)) return `${String(r.int(0, 23)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}`;
  if (/url|link/.test(type)) return `https://ref-${uniqueToken(runSeed)}.example.test`;
  if (/phone|tel/.test(type)) return identity.phone;

  // Plain text/string with a schema type but no special handling → null so the caller's DOM-semantic
  // inference (which understands the LABEL, e.g. First Name) drives, plus a uniqueness token when required.
  if (unique) return null; // caller generates the semantic value; uniqueness is applied there via applyUnique
  return null;
}

/** Append a run-scoped uniqueness token to an already-generated value for a unique-constrained field. */
export function applyUnique(value: string, field: SchemaField | null, runSeed: string): string {
  if (!field?.unique || !value) return value;
  const tok = uniqueToken(runSeed);
  if (/@/.test(value)) return value.replace('@', `${tok}@`);           // email: before the @
  if (/^\S+$/.test(value)) return `${value}${tok}`;                    // single token: suffix
  return `${value} ${tok}`;                                            // phrase: append
}
