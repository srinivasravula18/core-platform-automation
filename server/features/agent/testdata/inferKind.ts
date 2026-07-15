/**
 * Field-kind inference — a declarative RULE TABLE, not an if-else chain. Each rule tests the combined
 * semantic signals (label + name + id + placeholder + aria + semanticName) plus optional type/autocomplete/
 * role predicates. Rules are evaluated most-specific-first; the first match wins. Adding a field kind means
 * adding one rule here and one generator in engine.ts — nothing else changes.
 *
 * Never relies on a single attribute: the haystack blends every text signal, and autocomplete/type/role act
 * as strong corroborating predicates (an autocomplete token or input type is authoritative when present).
 */
import type { FieldKind, FieldSemantics } from './types';

interface Rule {
  kind: FieldKind;
  /** Regex over the blended text signals (label/name/id/placeholder/aria/semanticName), or null. */
  text?: RegExp;
  /** Exact autocomplete tokens that authoritatively imply this kind. */
  autocomplete?: string[];
  /** Input `type` values that authoritatively imply this kind. */
  type?: string[];
  /** Extra guard (e.g. must also look like a password for confirmPassword). */
  guard?: (sem: FieldSemantics, hay: string) => boolean;
}

// Ordered most-specific → most-general. Confirm/first/last before generic name; ids before generic number.
const RULES: Rule[] = [
  { kind: 'confirmPassword', text: /(confirm|re-?enter|repeat|verify).*(password|pass)|password.*(again|confirm)/ },
  { kind: 'password', type: ['password'], text: /pass(word|code|phrase)?\b/ },
  { kind: 'otp', text: /\botp\b|one[-\s]?time|verification\s?code|2fa|mfa|auth(entication)?\s?code/ },
  { kind: 'cvv', text: /\bcvv\b|\bcvc\b|security\s?code|card\s?verification/ },
  { kind: 'expiry', text: /expir|valid\s?thru|mm\s?\/\s?yy/ },
  { kind: 'creditCard', text: /card\s?number|credit\s?card|debit\s?card/, autocomplete: ['cc-number'] },

  { kind: 'firstName', text: /first\s?name|given\s?name|fore\s?name|\bfname\b/, autocomplete: ['given-name'] },
  { kind: 'lastName', text: /last\s?name|sur\s?name|family\s?name|\blname\b/, autocomplete: ['family-name'] },
  // No bare \bname\b here — it would swallow "Company Name"/"Product Name" etc. before their own rules.
  { kind: 'fullName', text: /full\s?name|your\s?name|contact\s?name|display\s?name|^\s*name\s*$/, autocomplete: ['name'] },
  { kind: 'username', text: /user\s?name|login\s?id|\buserid\b|\blogin\b|handle/, autocomplete: ['username'] },
  { kind: 'email', type: ['email'], text: /e-?mail/, autocomplete: ['email'] },
  { kind: 'phone', type: ['tel'], text: /phone|mobile|\btel\b|contact\s?(no|number)|cell/, autocomplete: ['tel'] },

  { kind: 'company', text: /company|organi[sz]ation|business\s?name|employer|firm/, autocomplete: ['organization'] },
  { kind: 'streetAddress', text: /address|street|address\s?line/, autocomplete: ['street-address', 'address-line1'] },
  { kind: 'city', text: /\bcity\b|\btown\b|locality/, autocomplete: ['address-level2'] },
  { kind: 'state', text: /\bstate\b|province|region/, autocomplete: ['address-level1'] },
  { kind: 'country', text: /country/, autocomplete: ['country', 'country-name'] },
  { kind: 'postalCode', text: /zip|postal|pin\s?code|post\s?code/, autocomplete: ['postal-code'] },

  { kind: 'employeeId', text: /employee\s?(id|no|number|code)|\bemp\s?id\b|staff\s?(id|number)/ },
  { kind: 'customerId', text: /customer\s?(id|no|number)|client\s?(id|number)|account\s?(id|number|no)/ },
  { kind: 'orderNumber', text: /order\s?(no|number|id)|\bpo\s?(no|number)\b|purchase\s?order/ },
  { kind: 'invoiceNumber', text: /invoice\s?(no|number|id)|bill\s?(no|number)/ },
  { kind: 'referenceId', text: /reference|\bref\s?(no|id|number)\b|tracking\s?(id|number)|transaction\s?id/ },

  { kind: 'pan', text: /\bpan\b|permanent\s?account/ },
  { kind: 'gst', text: /\bgst(in)?\b|tax\s?id|vat\s?(no|number)/ },
  { kind: 'aadhaar', text: /aadha?ar|uid(ai)?/ },
  { kind: 'passport', text: /passport/ },
  { kind: 'license', text: /licen[sc]e|driving\s?licen[sc]e|\bdl\s?(no|number)\b/ },

  { kind: 'url', type: ['url'], text: /\burl\b|website|web\s?site|\blink\b|homepage/, autocomplete: ['url'] },
  { kind: 'date', type: ['date', 'datetime-local'], text: /\bdate\b|\bdob\b|birth|\bfrom\b|\bto\b|deadline|due/ },
  { kind: 'time', type: ['time'], text: /\btime\b|\bhour\b|schedule/ },
  { kind: 'amount', text: /amount|price|cost|total|salary|\bfee\b|payment|balance|budget/ },
  // \bcount\b — an unbounded "count" matches the substring in "ac<count>", "dis<count>", etc.
  { kind: 'quantity', text: /quantity|\bqty\b|\bcount\b|number\s?of|\bunits\b/ },
  { kind: 'search', type: ['search'], text: /search|find|filter|query|look\s?up/, guard: (s) => (s.role || '') === 'searchbox' || true },
  { kind: 'number', type: ['number'], guard: (s) => (s.role || '') === 'spinbutton' || (s.type || '') === 'number' },

  { kind: 'description', text: /description|comment|note|remark|message|details|about|summary|feedback|reason/ },
  { kind: 'title', text: /\btitle\b|\bsubject\b|heading|\bname\b/ },
];

/** Blend all text signals into one lowercased haystack. */
function haystack(sem: FieldSemantics): string {
  return [sem.label, sem.name, sem.id, sem.placeholder, sem.ariaLabel, sem.semanticName]
    .map((s) => String(s || '')).join(' ').toLowerCase();
}

export function inferFieldKind(sem: FieldSemantics): FieldKind {
  const hay = haystack(sem);
  const ac = String(sem.autocomplete || '').toLowerCase().trim();
  const type = String(sem.type || '').toLowerCase().trim();

  // Autocomplete/type are authoritative — a matching token wins immediately over text heuristics.
  for (const rule of RULES) {
    if (ac && rule.autocomplete?.includes(ac)) return rule.kind;
    if (type && rule.type?.includes(type)) {
      if (!rule.guard || rule.guard(sem, hay)) return rule.kind;
    }
  }
  // Then text signals, most-specific-first.
  for (const rule of RULES) {
    if (rule.text && rule.text.test(hay)) {
      if (!rule.guard || rule.guard(sem, hay)) return rule.kind;
    }
  }
  // A multi-line control with no clearer signal is free-text.
  if (type === 'textarea' || sem.role === 'textbox') return 'description';
  return 'unknown';
}
