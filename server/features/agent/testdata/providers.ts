/**
 * Value providers for the Test Data Engine — reusable generation corpora and formatters, NOT fixed
 * answers. A pool of first names composed with a seeded pick is "generate from a provider/factory", the
 * exact pattern the task asks for; no single literal is ever THE hardcoded value. Everything flows through
 * a SeededRandom so output is deterministic per run. Pools are intentionally synthetic/test-safe.
 */
import type { SeededRandom } from './seededRandom';

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Cameron', 'Drew',
  'Priya', 'Arjun', 'Neha', 'Rohan', 'Ananya', 'Vikram', 'Meera', 'Sanjay', 'Kavya', 'Aditya',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Patel', 'Sharma',
  'Reddy', 'Nair', 'Kumar', 'Mehta', 'Iyer', 'Bose', 'Chopra', 'Rao', 'Verma', 'Gupta',
];
const COMPANY_HEADS = ['Nimbus', 'Vertex', 'Aurora', 'Quanta', 'Meridian', 'Cobalt', 'Summit', 'Orbit', 'Lumen', 'Apex'];
const COMPANY_TAILS = ['Labs', 'Systems', 'Technologies', 'Solutions', 'Analytics', 'Networks', 'Dynamics', 'Works'];
const STREETS = ['Maple', 'Oak', 'Cedar', 'Pine', 'Birch', 'Elm', 'Ridge', 'Lake', 'Hill', 'Park'];
const STREET_TYPES = ['St', 'Ave', 'Rd', 'Blvd', 'Ln', 'Way'];
const CITIES = ['Riverton', 'Fairview', 'Lakeside', 'Springdale', 'Brookfield', 'Ashford', 'Westbrook', 'Kingsport'];
const STATES = ['California', 'Texas', 'New York', 'Karnataka', 'Maharashtra', 'Telangana', 'Ontario', 'Bavaria'];
const COUNTRIES = ['United States', 'India', 'Canada', 'United Kingdom', 'Australia', 'Germany'];
const EMAIL_DOMAINS = ['example.test', 'mail.test', 'sample.test']; // .test TLD is reserved — never a real address
const LOREM = [
  'automated regression coverage', 'smoke test verification', 'boundary validation scenario',
  'end to end workflow check', 'permission gated behavior', 'data integrity assertion',
];

const slug = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function firstName(r: SeededRandom): string { return r.pick(FIRST_NAMES); }
export function lastName(r: SeededRandom): string { return r.pick(LAST_NAMES); }

export function username(first: string, last: string, r: SeededRandom): string {
  return `${slug(first)}.${slug(last)}${r.int(1, 99)}`;
}

export function email(first: string, last: string, r: SeededRandom): string {
  return `${slug(first)}.${slug(last)}@${r.pick(EMAIL_DOMAINS)}`;
}

/** E.164-ish synthetic number; +1 555 area is reserved for fiction, so never a real line. */
export function phone(r: SeededRandom): string {
  return `+1555${r.digits(7)}`;
}

export function company(r: SeededRandom): string {
  return `${r.pick(COMPANY_HEADS)} ${r.pick(COMPANY_TAILS)}`;
}

export function streetAddress(r: SeededRandom): string {
  return `${r.int(10, 9999)} ${r.pick(STREETS)} ${r.pick(STREET_TYPES)}`;
}
export function city(r: SeededRandom): string { return r.pick(CITIES); }
export function state(r: SeededRandom): string { return r.pick(STATES); }
export function country(r: SeededRandom): string { return r.pick(COUNTRIES); }
export function postalCode(r: SeededRandom): string { return r.digits(r.pick([5, 6])); }

/** A strong password reused for password+confirm within a run (uppercase, lowercase, digit, symbol). */
export function password(r: SeededRandom): string {
  return `Tf${r.alnum(4, 'abcdefghijkmnpqrstuvwxyz')}${r.digits(3)}!${r.alnum(2)}`;
}

export function loremPhrase(r: SeededRandom): string { return r.pick(LOREM); }

export function website(r: SeededRandom): string { return `https://${r.pick(COMPANY_HEADS).toLowerCase()}.example.test`; }

/** A prefixed identifier, e.g. EMP-4821, ORD-90342. Prefix derived from intent, digits seeded. */
export function prefixedId(prefix: string, digitsLen: number, r: SeededRandom): string {
  return `${prefix}-${r.digits(digitsLen)}`;
}

/* --- Synthetic government/financial IDs — structurally valid FORMATS, never real numbers, test-only --- */
export function pan(r: SeededRandom): string { return `${r.alnum(5, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${r.digits(4)}${r.alnum(1, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')}`; }
export function gst(r: SeededRandom): string { return `${r.digits(2)}${pan(r)}${r.digits(1)}Z${r.digits(1)}`; }
export function aadhaar(r: SeededRandom): string { return `${r.digits(4)} ${r.digits(4)} ${r.digits(4)}`; }
export function passport(r: SeededRandom): string { return `${r.alnum(1, 'ABCDEFGHJKLMNPQRTVWXYZ')}${r.digits(7)}`; }
export function license(r: SeededRandom): string { return `${r.alnum(2)}${r.digits(2)}${r.alnum(2)}${r.digits(4)}`; }
/** Test card in the Playwright/Stripe-style reserved test range — never a chargeable card. */
export function creditCard(): string { return '4242424242424242'; }
export function cvv(r: SeededRandom): string { return r.digits(3); }
export function expiry(r: SeededRandom): string { return `${String(r.int(1, 12)).padStart(2, '0')}/${r.int(28, 34)}`; }
export function otp(r: SeededRandom): string { return r.digits(6); }

export function amount(r: SeededRandom): string { return `${r.int(1, 9999)}.${r.digits(2)}`; }
export function quantity(r: SeededRandom): string { return String(r.int(1, 99)); }
export function integerValue(r: SeededRandom): string { return String(r.int(1, 999)); }

/** ISO date within a plausible range (past 2y … future 1y), deterministic. Base epoch passed in for purity. */
export function isoDate(r: SeededRandom): string {
  const y = r.int(2024, 2027);
  const m = String(r.int(1, 12)).padStart(2, '0');
  const d = String(r.int(1, 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function timeValue(r: SeededRandom): string {
  return `${String(r.int(0, 23)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}`;
}
