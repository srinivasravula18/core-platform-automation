/**
 * Locator grounding types.
 *
 * Because the platform renders DOM from metadata by a consistent convention, we learn that
 * convention ONCE (render profile) and synthesize a real Playwright locator for any field of
 * any object. No per-app scraping, no hallucinated ids.
 */
import type { FieldType } from "./metadata.ts";

/** Playwright locator strategies, ordered best→worst for shadow-DOM-safe stability. */
export type LocatorStrategy =
  | "getByTestId"
  | "getByLabel"
  | "getByRole"
  | "getByPlaceholder"
  | "css";

export interface LocatorTemplate {
  strategy: LocatorStrategy;
  /** Template string; {api_name} and {label} are interpolated. For getByRole, role is set too. */
  template: string;
  role?: string;
  /** higher = more stable (testid 100 … raw css 10). Used to rank candidates. */
  stability: number;
}

/** Learned once per platform version from the component library (or seeded by config). */
export interface RenderProfile {
  /** platform version / snapshot this profile was learned from */
  version: string;
  /** how each field type renders */
  byFieldType: Partial<Record<FieldType, LocatorTemplate>>;
  /** URL patterns; {app}/{object}/{id} interpolated */
  routes: {
    list: string; // e.g. "/app/{app}/{object}/list"
    detail: string; // e.g. "/app/{app}/{object}/{id}"
    create: string; // e.g. "/app/{app}/{object}/new"
    edit: string; // e.g. "/app/{app}/{object}/{id}/edit"
  };
}

/** A concrete, catalog-verified locator a generated script may use. */
export interface GroundedLocator {
  object: string;
  field: string;
  strategy: LocatorStrategy;
  /** the resolved selector value (label text, role name, css, or testid) */
  value: string;
  role?: string;
  stability: number;
  /** Playwright expression, e.g. `page.getByLabel('Start Date')` */
  expression: string;
}
