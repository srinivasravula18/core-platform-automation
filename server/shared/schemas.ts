import { z } from 'zod';

function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map((item) => stringifyField(item)).filter(Boolean).join('; ');
  return value === undefined || value === null ? '' : String(value);
}

function scriptFilename(value: string, fallback: string): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.spec.ts`;
}

function fallbackScript(title: string): string {
  return `import { test, expect } from '@playwright/test';\n\ntest('${title.replace(/'/g, "\\'")}', async ({ page }) => {\n  await page.goto('/');\n  // Add your assertions here\n});`;
}

export const appFlowsSchema = z.object({
  flows: z.array(z.object({
    name: z.string().describe('Name of the user flow'),
    description: z.string().describe('Detailed description of the flow'),
    pages: z.array(z.string()).describe('Pages involved'),
  }))
});

export const testCasesSchema = z.object({
  test_cases: z.array(z.object({
    title: z.string(),
    description: z.string(),
    preconditions: z.string(),
    tags: z.array(z.string()),
    priority: z.enum(['Low', 'Medium', 'High', 'Critical']),
    type: z.enum(['Manual', 'Automated', 'Both']),
    steps: z.array(z.object({
      action: z.string(),
      expected: z.string()
    }))
  }))
});

const playwrightScriptItemSchema = z.preprocess((value) => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : { code: value };
  const title = stringifyField(raw.test_case_title || raw.title || raw.name || raw.testName || raw.test_name || raw.caseTitle || raw.case_title) || 'Generated Playwright script';
  const filename = stringifyField(raw.filename || raw.file || raw.path) || scriptFilename(title, 'generated-playwright-script');
  const code = stringifyField(raw.code || raw.script || raw.source || raw.content || raw.playwright || raw.test || raw.body) || fallbackScript(title);
  return { ...raw, test_case_title: title, filename, code };
}, z.object({
  test_case_title: z.string(),
  filename: z.string(),
  code: z.string()
}));

export const playwrightScriptsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return { scripts: value };
  if (!value || typeof value !== 'object') return { scripts: [] };
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.scripts)) return raw;
  if (Array.isArray(raw.playwright_scripts)) return { ...raw, scripts: raw.playwright_scripts };
  if (Array.isArray(raw.tests)) return { ...raw, scripts: raw.tests };
  return { ...raw, scripts: [] };
}, z.object({
  scripts: z.array(playwrightScriptItemSchema)
}));
