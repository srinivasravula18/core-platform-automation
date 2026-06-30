import type { ObjectDescriptor, TestCase, TestStep } from "@atp/shared";
import { sampleValue } from "./sample.ts";

/**
 * Deterministic ISTQB-style test-case generator from object metadata.
 * Produces the mechanical cases (CRUD, required-negative, picklist EP, reference integrity,
 * access-control). The Case Designer agent layers business-flow/judgment cases on top.
 */
export function generateCases(d: ObjectDescriptor): TestCase[] {
  const obj = d.object.api_name;
  const up = obj.toUpperCase();
  const cases: TestCase[] = [];
  const editable = d.fields.filter((f) => f.api_name !== "id");
  const required = editable.filter((f) => f.required);

  const fillSteps: TestStep[] = editable
    .filter((f) => f.required)
    .map((f) => ({
      action: `Enter ${f.label}`,
      target: { object: obj, field: f.api_name },
      data: sampleValue(f, d.picklists),
      expected: `${f.label} accepts the value`,
    }));

  // CRUD create (sanity + bvt + regression)
  cases.push({
    code: `TC-${up}-CREATE`,
    title: `Create a ${d.object.label} with valid data`,
    object: obj,
    kind: "ui",
    technique: "crud",
    suiteTypes: ["sanity", "bvt", "regression"],
    priority: "p1",
    preconditions: [`User has create permission on ${obj}`],
    steps: [
      { action: `Open the new ${d.object.label} form`, expected: "Create form is shown" },
      ...fillSteps,
      { action: "Click Save", expected: `A ${d.object.label} record is created and shown in detail view` },
    ],
    expectedResult: `${d.object.label} is persisted with the entered values`,
    requirementRefs: [`REQ-${up}-CRUD`],
  });

  // required-field negatives (regression)
  for (const f of required) {
    cases.push({
      code: `TC-${up}-REQ-${f.api_name.toUpperCase()}`,
      title: `Reject create when required '${f.label}' is missing`,
      object: obj,
      kind: "ui",
      technique: "negative-required",
      suiteTypes: ["regression"],
      priority: "p2",
      preconditions: [`User has create permission on ${obj}`],
      steps: [
        { action: `Open the new ${d.object.label} form`, expected: "Create form is shown" },
        ...fillSteps.filter((s) => s.target?.field !== f.api_name),
        { action: "Click Save", expected: `A validation error is shown for ${f.label}; record is not saved` },
      ],
      expectedResult: `Required-field validation blocks save when ${f.label} is empty`,
      requirementRefs: [`REQ-${up}-${f.api_name.toUpperCase()}-REQUIRED`],
    });
  }

  // picklist equivalence partitions (regression)
  for (const f of editable.filter((f) => f.type === "picklist")) {
    const values = d.picklists[f.api_name] ?? [];
    cases.push({
      code: `TC-${up}-EP-${f.api_name.toUpperCase()}`,
      title: `Accept each valid '${f.label}' option`,
      object: obj,
      kind: "ui",
      technique: "equivalence-partition",
      suiteTypes: ["regression"],
      priority: "p3",
      preconditions: [`User has create permission on ${obj}`],
      steps: [
        {
          action: `For each option of ${f.label}, create a record`,
          target: { object: obj, field: f.api_name },
          data: values.map((v) => v.value),
          expected: "Each option is accepted and persisted",
        },
      ],
      expectedResult: `All ${values.length || "defined"} picklist options for ${f.label} are valid`,
      requirementRefs: [`REQ-${up}-${f.api_name.toUpperCase()}-OPTIONS`],
    });
  }

  // reference integrity (regression)
  for (const f of editable.filter((f) => f.type === "reference")) {
    cases.push({
      code: `TC-${up}-REF-${f.api_name.toUpperCase()}`,
      title: `Reject create when '${f.label}' references a non-existent ${f.reference_object}`,
      object: obj,
      kind: "ui",
      technique: "reference-integrity",
      suiteTypes: ["regression"],
      priority: "p2",
      preconditions: [`User has create permission on ${obj}`],
      steps: [
        { action: `Set ${f.label} to an invalid ${f.reference_object} reference`, target: { object: obj, field: f.api_name }, expected: "Lookup rejects the value" },
        { action: "Click Save", expected: "Referential-integrity error; record not saved" },
      ],
      expectedResult: `${f.label} enforces a valid ${f.reference_object} reference`,
      requirementRefs: [`REQ-${up}-${f.api_name.toUpperCase()}-FK`],
    });
  }

  // access-control (regression) — roles without edit must not edit
  for (const p of d.permissions.filter((p) => !p.can_edit)) {
    cases.push({
      code: `TC-${up}-ACL-${p.role.toUpperCase()}`,
      title: `Role '${p.role}' cannot edit ${d.object.label}`,
      object: obj,
      kind: "ui",
      technique: "access-control",
      suiteTypes: ["regression"],
      priority: "p2",
      preconditions: [`Logged in as a user with role '${p.role}'`],
      steps: [
        { action: `Open a ${d.object.label} detail page`, expected: "Detail view is shown" },
        { action: "Attempt to edit", expected: "Edit action is unavailable or denied" },
      ],
      expectedResult: `Role '${p.role}' is read-only for ${obj} per permission metadata`,
      requirementRefs: [`REQ-${up}-ACL-${p.role.toUpperCase()}`],
    });
  }

  return cases;
}
