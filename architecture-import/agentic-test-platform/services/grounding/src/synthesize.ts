import type {
  FieldType,
  GroundedLocator,
  LocatorStrategy,
  LocatorTemplate,
  MetadataField,
  ObjectDescriptor,
  RenderProfile,
} from "@atp/shared";

/** single-quote a value for embedding in a Playwright expression */
function q(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
}

function buildExpression(strategy: LocatorStrategy, value: string, role?: string): string {
  switch (strategy) {
    case "getByLabel":
      return `page.getByLabel(${q(value)})`;
    case "getByRole":
      return `page.getByRole(${q(role ?? "textbox")}, { name: ${q(value)} })`;
    case "getByTestId":
      return `page.getByTestId(${q(value)})`;
    case "getByPlaceholder":
      return `page.getByPlaceholder(${q(value)})`;
    case "css":
      return `page.locator(${q(value)})`;
  }
}

const FALLBACK: LocatorTemplate = { strategy: "css", template: '[name="{api_name}"]', stability: 10 };

/** Synthesize ONE grounded locator for a field from the render profile. */
export function synthesizeLocator(
  object: string,
  field: MetadataField,
  profile: RenderProfile,
): GroundedLocator {
  const tpl = profile.byFieldType[field.type as FieldType] ?? FALLBACK;
  const value = interpolate(tpl.template, {
    api_name: field.api_name,
    label: field.label,
    object,
  });
  return {
    object,
    field: field.api_name,
    strategy: tpl.strategy,
    value,
    role: tpl.role,
    stability: tpl.stability,
    expression: buildExpression(tpl.strategy, value, tpl.role),
  };
}

/** Build the full element catalog for an object — every field gets a grounded locator. */
export function buildCatalog(descriptor: ObjectDescriptor, profile: RenderProfile): GroundedLocator[] {
  return descriptor.fields.map((f) => synthesizeLocator(descriptor.object.api_name, f, profile));
}

/** Resolve the route URL for an object action from the profile convention. */
export function routeFor(
  profile: RenderProfile,
  kind: keyof RenderProfile["routes"],
  vars: { app: string; object: string; id?: string },
): string {
  return interpolate(profile.routes[kind], {
    app: vars.app,
    object: vars.object,
    id: vars.id ?? ":id",
  });
}
