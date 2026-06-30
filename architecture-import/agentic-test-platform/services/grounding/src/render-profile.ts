import type { RenderProfile } from "@atp/shared";

/**
 * Seed render profile encoding the platform's *default* rendering convention.
 *
 * The indexer's render-convention learner (packages/indexer) refines this by AST-parsing the
 * real component library and overwriting per-field-type templates. Until then this seed is a
 * sensible, shadow-DOM-safe default: label/role first (Playwright's getByLabel/getByRole pierce
 * shadow DOM), css [name=] as the last resort, XPath never.
 *
 * ponytail: a hand-seeded convention is enough to ship; the learner upgrades accuracy when the
 * component library proves it renders differently.
 */
export const defaultRenderProfile: RenderProfile = {
  version: "seed",
  byFieldType: {
    text: { strategy: "getByLabel", template: "{label}", stability: 70 },
    textarea: { strategy: "getByLabel", template: "{label}", stability: 70 },
    email: { strategy: "getByLabel", template: "{label}", stability: 70 },
    phone: { strategy: "getByLabel", template: "{label}", stability: 70 },
    url: { strategy: "getByLabel", template: "{label}", stability: 70 },
    number: { strategy: "getByLabel", template: "{label}", stability: 70 },
    currency: { strategy: "getByLabel", template: "{label}", stability: 70 },
    date: { strategy: "getByLabel", template: "{label}", stability: 70 },
    datetime: { strategy: "getByLabel", template: "{label}", stability: 70 },
    boolean: { strategy: "getByRole", role: "checkbox", template: "{label}", stability: 80 },
    picklist: { strategy: "getByRole", role: "combobox", template: "{label}", stability: 80 },
    multipicklist: { strategy: "getByRole", role: "listbox", template: "{label}", stability: 80 },
    reference: { strategy: "getByLabel", template: "{label}", stability: 65 },
  },
  routes: {
    list: "/app/{app}/{object}/list",
    detail: "/app/{app}/{object}/{id}",
    create: "/app/{app}/{object}/new",
    edit: "/app/{app}/{object}/{id}/edit",
  },
};

/** Platform chrome (Save/New/etc.) that scripts legitimately use beyond field locators. */
export const defaultChromeAllow: Array<{ role: string; name: string }> = [
  { role: "button", name: "Save" },
  { role: "button", name: "Save & New" },
  { role: "button", name: "Cancel" },
  { role: "button", name: "Delete" },
  { role: "button", name: "Edit" },
  { role: "button", name: "New" },
  { role: "link", name: "New" },
];
