/**
 * Platform metadata domain types — mirror the live metadata API shape
 * (verified against the core_platform_db MCP: list_objects / get_object_fields).
 *
 * These are the SOURCE OF TRUTH for grounding. A metadata-driven (Salesforce-style)
 * platform renders its UI and CRUD APIs from this metadata, so test cases, payloads,
 * and locators are all derived from it rather than scraped from generated DOM.
 */

/** Field data types observed on the platform (extend as the platform adds types). */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "boolean"
  | "date"
  | "datetime"
  | "picklist"
  | "multipicklist"
  | "reference" // foreign key to another object (reference_object names the target)
  | "email"
  | "phone"
  | "url";

export interface MetadataApp {
  id: string;
  api_name: string;
  label: string;
}

export interface MetadataObject {
  id: string;
  api_name: string;
  label: string;
  /** 3-char key prefix, Salesforce-style (e.g. "acc" for account, "lve" for leave_request). */
  id_prefix: string;
  app: string;
  table_name?: string | null;
}

export interface MetadataField {
  id: string;
  api_name: string;
  label: string;
  type: FieldType;
  required: boolean;
  searchable: boolean;
  /** For type === "reference": the api_name of the target object. */
  reference_object?: string | null;
  /** Optional schema constraints when the platform exposes them. */
  max_length?: number | null;
  min?: number | null;
  max?: number | null;
}

export interface PicklistValue {
  value: string;
  label: string;
  active: boolean;
}

export type LayoutKind = "create" | "edit" | "detail" | "list";

export interface ObjectLayout {
  object: string;
  kind: LayoutKind;
  /** ordered field api_names shown on this layout */
  fields: string[];
}

export interface ValidationRule {
  object: string;
  name: string;
  /** platform expression that must evaluate true for a valid record */
  expr: string;
  message: string;
}

export type CrudRole = string;

export interface ObjectPermission {
  object: string;
  role: CrudRole;
  can_create: boolean;
  can_read: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

/** A fully-described object: the unit the generators and grounding operate on. */
export interface ObjectDescriptor {
  object: MetadataObject;
  fields: MetadataField[];
  picklists: Record<string, PicklistValue[]>; // field api_name -> values
  layouts: ObjectLayout[];
  validationRules: ValidationRule[];
  permissions: ObjectPermission[];
}
