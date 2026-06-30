import type { MetadataField, PicklistValue } from "@atp/shared";

/** Deterministic valid sample value for a field (reproducible runs; no randomness). */
export function sampleValue(field: MetadataField, picklists: Record<string, PicklistValue[]> = {}): unknown {
  switch (field.type) {
    case "text":
    case "textarea": {
      const base = `Sample ${field.label}`;
      return field.max_length && field.max_length < base.length ? base.slice(0, field.max_length) : base;
    }
    case "email":
      return "qa@example.com";
    case "phone":
      return "+15555550100";
    case "url":
      return "https://example.com";
    case "number":
    case "currency":
      return field.min ?? 1;
    case "boolean":
      return true;
    case "date":
      return "2026-07-01";
    case "datetime":
      return "2026-07-01T09:00:00Z";
    case "picklist": {
      const first = (picklists[field.api_name] ?? []).find((p) => p.active);
      return first?.value ?? "Pending";
    }
    case "multipicklist": {
      const first = (picklists[field.api_name] ?? []).find((p) => p.active);
      return first ? [first.value] : ["Pending"];
    }
    case "reference":
      // placeholder the executor resolves to a real id via query_sample_records
      return `<<ref:${field.reference_object ?? "record"}>>`;
  }
}

/** A value of the WRONG type for negative/contract testing. */
export function wrongTypeValue(field: MetadataField): unknown {
  switch (field.type) {
    case "boolean":
      return "not-a-boolean";
    case "number":
    case "currency":
      return "not-a-number";
    case "date":
    case "datetime":
      return "not-a-date";
    case "picklist":
    case "multipicklist":
      return 12345; // a number where an enum string is expected
    default:
      return { unexpected: "object" }; // an object where a scalar is expected
  }
}
