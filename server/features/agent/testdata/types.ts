/**
 * Test Data Engine — shared contracts. The engine infers a field's INTENT from every semantic signal
 * available (label, name, id, placeholder, aria, autocomplete, type, role, options, constraints), then
 * generates a realistic value from seeded providers — never a hardcoded literal, deterministic per run,
 * and consistent across related fields (First Name → Full Name → email all share one identity).
 */

/** The semantic clues about ONE field, assembled from evidence. Every field is optional — the engine
 * combines whatever is present and never depends on a single attribute. */
export interface FieldSemantics {
  label?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  autocomplete?: string | null;
  /** HTML input type (text/email/tel/number/date/password/search/url/…) or the control's tag. */
  type?: string | null;
  /** ARIA role (textbox/searchbox/combobox/spinbutton/…). */
  role?: string | null;
  /** Stable semantic handle minted by the Evidence Graph (e.g. 'FirstNameInput'). */
  semanticName?: string | null;
  /** Real <select>/listbox options captured live — SELECT picks from these, never invents. */
  options?: Array<{ label?: string; value?: string; disabled?: boolean }> | null;
  /** Constraints, when captured — respected so generated values stay valid. */
  maxLength?: number | null;
  minLength?: number | null;
  pattern?: string | null;
  min?: string | number | null;
  max?: string | number | null;
  required?: boolean | null;
}

/** The closed set of field intents the engine recognizes. `unknown` gets safe generic text. Extend by
 * adding a rule (inferKind) + a generator (engine) — no other file changes. */
export const FIELD_KINDS = [
  'firstName', 'lastName', 'fullName', 'username', 'email', 'phone', 'company',
  'streetAddress', 'city', 'state', 'country', 'postalCode',
  'password', 'confirmPassword', 'otp',
  'search', 'url', 'date', 'time', 'amount', 'quantity', 'number',
  'description', 'title', 'subject',
  'apiName', 'codePrefix', 'version',
  'employeeId', 'customerId', 'orderNumber', 'invoiceNumber', 'referenceId',
  'pan', 'gst', 'aadhaar', 'passport', 'license', 'creditCard', 'cvv', 'expiry',
  'unknown',
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

/** One backend field from the app's /describe schema — the authority on what the API will ACCEPT. */
export interface SchemaField {
  apiName: string;
  label?: string | null;
  /** Backend data type: text/email/currency/number/date/boolean/picklist/reference/… (as the API reports it). */
  dataType?: string | null;
  required?: boolean | null;
  /** Real allowed values for picklist fields — the engine picks from these, never invents. */
  picklistValues?: string[] | null;
  /** True when the field is a uniqueness constraint (name/code/email/number-like) — vary to avoid dup-key errors. */
  unique?: boolean | null;
}

/** An object's schema + one real sample record, used to generate API-acceptance-conformant values. */
export interface ObjectSchema {
  objectApiName: string;
  fields: SchemaField[];
  /** A real existing record (field apiName → value) — the gold standard for "the API already accepted this". */
  sample?: Record<string, unknown> | null;
}

/** A coherent synthetic identity, generated once per run and reused so related fields stay consistent. */
export interface GeneratedIdentity {
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  email: string;
  phone: string;
  company: string;
  streetAddress: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  /** A stable password reused for password + confirmPassword within the run. */
  password: string;
}
