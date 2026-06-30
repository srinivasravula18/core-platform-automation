import type { ApiRequestCase, ObjectDescriptor } from "@atp/shared";
import { sampleValue, wrongTypeValue } from "./sample.ts";

const OBJ = (d: ObjectDescriptor) => d.object.api_name;
const path = (d: ObjectDescriptor) => `/api/data/${OBJ(d)}`;

/** Build a schema-valid request body. By default includes required fields only. */
export function buildValidBody(d: ObjectDescriptor, includeOptional = false): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of d.fields) {
    if (f.api_name === "id") continue; // server-assigned
    if (f.required || includeOptional) body[f.api_name] = sampleValue(f, d.picklists);
  }
  return body;
}

/**
 * Schema-driven payload mutator: valid + boundary + invalid request cases from field metadata.
 * Deterministic — same descriptor always yields the same cases (reproducible, cacheable).
 */
export function generateRequests(d: ObjectDescriptor): ApiRequestCase[] {
  const cases: ApiRequestCase[] = [];
  const valid = buildValidBody(d);
  const up = OBJ(d).toUpperCase();

  // 1) happy path
  cases.push({
    caseId: `API-${up}-VALID`,
    object: OBJ(d),
    variant: "valid",
    rationale: "all required fields present with valid values",
    method: "POST",
    path: path(d),
    body: valid,
    expect: { statusClass: "2xx" },
  });

  // 2) negative — required field omitted (one case per required field)
  for (const f of d.fields) {
    if (!f.required || f.api_name === "id") continue;
    const body = { ...valid };
    delete body[f.api_name];
    cases.push({
      caseId: `API-${up}-REQ-${f.api_name.toUpperCase()}`,
      object: OBJ(d),
      variant: "invalid",
      rationale: `required field '${f.api_name}' omitted`,
      method: "POST",
      path: path(d),
      body,
      expect: { statusClass: "4xx", reason: `missing required ${f.api_name}` },
    });
  }

  // 3) negative — wrong type (typed fields only; text accepts any string)
  for (const f of d.fields) {
    if (["text", "textarea", "email", "phone", "url"].includes(f.type)) continue;
    if (f.api_name === "id") continue;
    cases.push({
      caseId: `API-${up}-TYPE-${f.api_name.toUpperCase()}`,
      object: OBJ(d),
      variant: "invalid",
      rationale: `field '${f.api_name}' set to wrong type`,
      method: "POST",
      path: path(d),
      body: { ...valid, [f.api_name]: wrongTypeValue(f) },
      expect: { statusClass: "4xx", reason: `type violation on ${f.api_name}` },
    });
  }

  // 4) negative — picklist value out of set
  for (const f of d.fields) {
    if (f.type !== "picklist" && f.type !== "multipicklist") continue;
    cases.push({
      caseId: `API-${up}-ENUM-${f.api_name.toUpperCase()}`,
      object: OBJ(d),
      variant: "invalid",
      rationale: `picklist '${f.api_name}' set to a value outside its set`,
      method: "POST",
      path: path(d),
      body: { ...valid, [f.api_name]: "__NOT_A_VALID_OPTION__" },
      expect: { statusClass: "4xx", reason: `enum violation on ${f.api_name}` },
    });
  }

  // 5) boundary — string max_length and numeric max, when the metadata exposes constraints
  for (const f of d.fields) {
    if ((f.type === "text" || f.type === "textarea") && f.max_length) {
      cases.push(boundaryCase(d, up, f.api_name, "len-at-max", "x".repeat(f.max_length), "2xx", valid));
      cases.push(boundaryCase(d, up, f.api_name, "len-over-max", "x".repeat(f.max_length + 1), "4xx", valid));
    }
    if ((f.type === "number" || f.type === "currency") && typeof f.max === "number") {
      cases.push(boundaryCase(d, up, f.api_name, "at-max", f.max, "2xx", valid));
      cases.push(boundaryCase(d, up, f.api_name, "over-max", f.max + 1, "4xx", valid));
    }
  }

  return cases;
}

function boundaryCase(
  d: ObjectDescriptor,
  up: string,
  field: string,
  tag: string,
  value: unknown,
  cls: "2xx" | "4xx",
  valid: Record<string, unknown>,
): ApiRequestCase {
  return {
    caseId: `API-${up}-BVA-${field.toUpperCase()}-${tag.toUpperCase()}`,
    object: d.object.api_name,
    variant: "boundary",
    rationale: `boundary ${tag} on '${field}'`,
    method: "POST",
    path: `/api/data/${d.object.api_name}`,
    body: { ...valid, [field]: value },
    expect: { statusClass: cls, reason: `boundary ${tag} on ${field}` },
  };
}
