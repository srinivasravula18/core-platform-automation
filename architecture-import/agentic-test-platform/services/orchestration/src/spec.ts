import type { GroundedLocator, ObjectDescriptor, TestCase } from "@atp/shared";

const q = (v: string) => `'${v.replace(/'/g, "\\'")}'`;

/** Render a Playwright spec for a create case using ONLY grounded locator expressions. */
export function renderSpec(d: ObjectDescriptor, tc: TestCase, catalog: GroundedLocator[]): string {
  const byField = new Map(catalog.map((c) => [c.field, c]));
  const app = d.object.app;
  const obj = d.object.api_name;
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `// generated for ${tc.code} — locators are grounded against the metadata catalog`,
    `test(${q(tc.title)}, async ({ page }) => {`,
    `  await page.goto('/app/${app}/${obj}/new');`,
  ];
  for (const f of d.fields.filter((f) => f.required && f.api_name !== "id")) {
    const loc = byField.get(f.api_name);
    if (!loc) continue;
    const value = f.type === "date" ? "2026-07-01" : `Sample ${f.label}`;
    lines.push(`  await ${loc.expression}.fill(${q(value)});`);
  }
  lines.push(`  await page.getByRole('button', { name: 'Save' }).click();`);
  lines.push(`  await expect(page.getByText('Saved')).toBeVisible();`);
  lines.push(`});`);
  return lines.join("\n");
}
