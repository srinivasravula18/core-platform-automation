/**
 * Data-driven expression + transform engine.
 *
 * A binding expression is literal text with `{{ token }}` interpolations. Each token is a
 * SOURCE (a dataset column name or a built-in generator) optionally piped through one or more
 * TRANSFORMS:
 *
 *   {{First Name}}                 -> the row's "First Name" column value
 *   {{First Name | upper}}         -> transformed to upper-case
 *   Mr. {{Last Name | title}}      -> literal text + a transformed column
 *   {{uuid}} {{today}} {{rowNumber}} {{env.BASE_URL}}
 *
 * Resolution runs on the server at materialize time, so every generated value is snapshotted
 * into the per-row job script (deterministic replay). Columns win over generators so real data
 * is never shadowed by a same-named keyword.
 */

import { randomUUID, randomBytes } from 'crypto';

export interface RowContext {
  columns: Array<{ id: string; name: string }>;
  values: Record<string, string | null | undefined>;
  rowNumber?: number;
  runToken?: string;   // per-batch token — namespaces every generated value so reruns never collide
  rowSeq?: number;     // per-row sequence within the batch
}

/** Mint a unique, human-greppable token for one batch run. 6 bytes (48 bits) is birthday-safe to
 *  millions of runs — the 3-byte token collided in the low thousands, undermining the whole
 *  "reruns never collide" guarantee. Still short enough to embed in emails/usernames and grep for. */
export function newRunToken(): string {
  return randomBytes(6).toString('hex');
}

type Transform = (input: string, args: string[]) => string;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

// Format a Date with a small, predictable token set (no external date library).
function formatDate(input: string | Date, fmt: string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return typeof input === 'string' ? input : '';
  const map: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => map[token] ?? token);
}

const TRANSFORMS: Record<string, Transform> = {
  upper: (value) => value.toUpperCase(),
  lower: (value) => value.toLowerCase(),
  trim: (value) => value.trim(),
  title: (value) => value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()),
  capitalize: (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value),
  prefix: (value, [text = '']) => text + value,
  suffix: (value, [text = '']) => value + text,
  default: (value, [fallback = '']) => (value ? value : fallback),
  truncate: (value, [count = '0']) => { const size = Number(count); return Number.isFinite(size) && size > 0 ? value.slice(0, size) : value; },
  replace: (value, [from = '', to = '']) => (from ? value.split(from).join(to) : value),
  number: (value, [decimals = '0']) => { const parsed = Number(value); if (!Number.isFinite(parsed)) return value; const places = Number(decimals); return Number.isFinite(places) ? parsed.toFixed(places) : String(parsed); },
  dateformat: (value, [fmt = 'YYYY-MM-DD']) => formatDate(value, fmt),
};

function emailDomain(): string {
  return (process.env.TEST_EMAIL_DOMAIN || 'example.test').trim();
}

// Small offline faker — realistic-but-synthetic values, varied deterministically by run + row.
const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Katherine', 'Dennis', 'Barbara', 'Edsger', 'Radia', 'Ken'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Johnson', 'Ritchie', 'Liskov', 'Dijkstra', 'Perlman', 'Thompson'];
const COMPANY = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Cyberdyne', 'Soylent'];
const WORD = ['alpha', 'bravo', 'delta', 'echo', 'nimbus', 'quartz', 'zephyr', 'onyx', 'cobalt', 'ember'];
const CITY = ['Springfield', 'Rivertown', 'Lakeview', 'Fairhaven', 'Bridgeport', 'Greenfield', 'Ashford', 'Millbrook', 'Westwood', 'Northgate'];
const COUNTRY = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Japan', 'Australia', 'Brazil', 'India', 'Netherlands'];
const STREET = ['Maple', 'Oak', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Chestnut', 'Walnut', 'Aspen'];
const JOBTITLE = ['Engineer', 'Analyst', 'Manager', 'Designer', 'Coordinator', 'Specialist', 'Consultant', 'Architect', 'Lead', 'Director'];

function hashToken(token: string): number {
  let hash = 0;
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function pick(list: string[], context: RowContext, salt = 0): string {
  const seq = Number(context.rowSeq ?? context.rowNumber ?? 0);
  return list[(seq + salt + hashToken(context.runToken || '')) % list.length];
}

// A stable-but-varied number derived from run + row (+ salt), so faker.int/phone don't all collide.
function numFor(context: RowContext, salt: number): number {
  const seq = Number(context.rowSeq ?? context.rowNumber ?? 0);
  return (hashToken(context.runToken || '') + seq * 2654435761 + salt) >>> 0;
}

function faker(kind: string, context: RowContext): string {
  const seq = context.rowSeq ?? context.rowNumber ?? '';
  switch (kind) {
    case 'firstname': return pick(FIRST, context);
    case 'lastname': return pick(LAST, context, 3);
    case 'fullname': case 'name': return `${pick(FIRST, context)} ${pick(LAST, context, 3)}`;
    case 'company': return pick(COMPANY, context);
    case 'word': return pick(WORD, context);
    case 'city': return pick(CITY, context);
    case 'country': return pick(COUNTRY, context);
    case 'jobtitle': case 'job': return `${pick(WORD, context, 1)} ${pick(JOBTITLE, context)}`;
    case 'street': case 'address': return `${100 + (numFor(context, 7) % 9900)} ${pick(STREET, context)} St`;
    case 'phone': return `+1${String(2000000000 + (numFor(context, 11) % 7999999999)).slice(0, 10)}`;
    case 'int': case 'number': return String(numFor(context, 13) % 100000);
    case 'boolean': case 'bool': return numFor(context, 17) % 2 === 0 ? 'true' : 'false';
    case 'url': return `https://${pick(COMPANY, context).toLowerCase()}.example.test/${pick(WORD, context, 5)}`;
    case 'email': return `${pick(FIRST, context).toLowerCase()}.${pick(LAST, context, 3).toLowerCase()}+${context.runToken || 'run'}-${seq}@${emailDomain()}`;
    default: return '';
  }
}

// Built-in generators, used only when a token does not match a real column name. `unique.*` and
// `faker.email` embed the run token + row sequence so every produced value is globally unique.
function generator(name: string, context: RowContext): string | null {
  const lower = name.trim().toLowerCase();
  const seq = context.rowSeq ?? context.rowNumber ?? '';
  const runToken = context.runToken || 'run';
  if (lower === 'unique' || lower.startsWith('unique.')) {
    switch (lower.split('.')[1] || 'id') {
      case 'email': return `qa+${runToken}-${seq}@${emailDomain()}`;
      case 'username': case 'user': return `qa_${runToken}_${seq}`;
      case 'slug': return `qa-${runToken}-${seq}`;
      default: return `${runToken}-${seq}`;
    }
  }
  if (lower.startsWith('faker.')) return faker(lower.slice(6), context);
  switch (lower) {
    case 'uuid': return randomUUID();
    case 'now': return new Date().toISOString();
    case 'today': return formatDate(new Date(), 'YYYY-MM-DD');
    case 'timestamp': return String(Date.now());
    case 'seq': return String(seq);
    case 'run': case 'run.id': return runToken;
    case 'row':
    case 'rownumber':
    case 'iteration': return String(context.rowNumber ?? '');
    default: return null;
  }
}

// Generators that guarantee a fresh value on every run (used to validate `unique`-intent fields).
const UNIQUE_GENERATORS = /^\s*(unique\.|unique\b|uuid\b|timestamp\b|faker\.email\b)/i;

/** Does an expression reference at least one generator that is guaranteed unique across runs? */
export function expressionHasUniqueGenerator(expression: string): boolean {
  const tokens: string[] = String(expression ?? '').match(/\{\{([^}]+)\}\}/g) || [];
  return tokens.some((token) => UNIQUE_GENERATORS.test(token.replace(/[{}]/g, '').split('|')[0]));
}

// Split "name(arg1, arg2)" into a transform name and its (quote-stripped) arguments.
function parseTransform(raw: string): { name: string; args: string[] } {
  const match = raw.trim().match(/^([A-Za-z]+)\s*(?:\((.*)\))?$/);
  if (!match) return { name: raw.trim().toLowerCase(), args: [] };
  const args = (match[2] ?? '')
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part, index, all) => !(index === all.length - 1 && part === '' && all.length === 1));
  return { name: match[1].toLowerCase(), args };
}

function resolveSource(token: string, context: RowContext): string {
  const trimmed = token.trim();
  // env.NAME -> process environment (never throws on unknown; yields empty).
  const envMatch = trimmed.match(/^env\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (envMatch) return String(process.env[envMatch[1]] ?? '');
  // Real column data wins over generator keywords.
  const column = context.columns.find((item) => item.name.toLowerCase() === trimmed.toLowerCase());
  if (column) { const value = context.values[column.id]; return value == null ? '' : String(value); }
  const generated = generator(trimmed, context);
  return generated ?? '';
}

function resolveToken(token: string, context: RowContext): string {
  const [source, ...pipes] = token.split('|');
  let value = resolveSource(source, context);
  for (const pipe of pipes) {
    const { name, args } = parseTransform(pipe);
    const transform = TRANSFORMS[name];
    if (transform) value = transform(value, args);
  }
  return value;
}

/**
 * Resolve a binding expression against one dataset row. A single bare `{{token}}` returns the raw
 * resolved value; anything with surrounding literals is concatenated as a string.
 */
export function resolveExpression(expression: string, context: RowContext): string {
  const text = String(expression ?? '');
  const single = text.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (single) return resolveToken(single[1], context);
  return text.replace(/\{\{([^}]+)\}\}/g, (_, token) => resolveToken(String(token), context));
}

/** The tokens surfaced in the UI's "Variables" palette, grouped for display. */
export const BUILTIN_VARIABLES: Array<{ token: string; label: string; group: 'unique' | 'faker' | 'other' }> = [
  { token: '{{unique.email}}', label: 'Fresh email', group: 'unique' },
  { token: '{{unique.username}}', label: 'Fresh username', group: 'unique' },
  { token: '{{unique.id}}', label: 'Fresh id', group: 'unique' },
  { token: '{{uuid}}', label: 'UUID', group: 'unique' },
  { token: '{{timestamp}}', label: 'Timestamp', group: 'unique' },
  { token: '{{faker.firstName}}', label: 'First name', group: 'faker' },
  { token: '{{faker.lastName}}', label: 'Last name', group: 'faker' },
  { token: '{{faker.fullName}}', label: 'Full name', group: 'faker' },
  { token: '{{faker.email}}', label: 'Realistic email', group: 'faker' },
  { token: '{{faker.company}}', label: 'Company', group: 'faker' },
  { token: '{{faker.phone}}', label: 'Phone', group: 'faker' },
  { token: '{{faker.city}}', label: 'City', group: 'faker' },
  { token: '{{faker.country}}', label: 'Country', group: 'faker' },
  { token: '{{faker.jobTitle}}', label: 'Job title', group: 'faker' },
  { token: '{{faker.int}}', label: 'Number', group: 'faker' },
  { token: '{{seq}}', label: 'Batch sequence', group: 'other' },
  { token: '{{run.id}}', label: 'Run id', group: 'other' },
  { token: '{{today}}', label: 'Today (date)', group: 'other' },
  { token: '{{rowNumber}}', label: 'Row number', group: 'other' },
];
