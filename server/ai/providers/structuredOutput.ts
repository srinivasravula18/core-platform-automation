/**
 * Shared structured-output normalization for ALL providers.
 *
 * Previously each provider (openai/anthropic/cli) carried its own drifted copy of
 * these helpers, and they were tuned to "succeed at all costs" — fabricating values
 * when the model's JSON didn't match the schema. That manufactured hallucinations:
 *   - an off-enum status was SNAPPED to the first allowed value (e.g. an inspector
 *     "blocked" silently became "continue"),
 *   - a missing array field was filled from "the first array of any property",
 *   - missing test-case steps/assertions were replaced with canned fake content.
 *
 * This module is the single, NON-FABRICATING version. It still performs SAFE
 * coercion (wrap a bare array/string into its single object key, remap a known
 * alias key, cast a primitive to string, snap an enum ONLY on an exact
 * case-insensitive match) — but it never invents a value the model did not
 * produce. When it cannot safely repair, it leaves the data invalid so the
 * caller fails honestly (retry, or a classified error) instead of proceeding on
 * fabricated data.
 */

import { z } from 'zod';

/** Flatten a model value into a string. Used only for fields the schema declares as string. */
export function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map((item) => stringifyField(item)).filter(Boolean).join('; ');
  return value === undefined || value === null ? '' : String(value);
}

export function slugifyScriptFilename(value: string, fallback: string): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.spec.ts`;
}

/**
 * Honest no-code stub: a test that FAILS loudly when the model produced no
 * Playwright code, so a missing script can never masquerade as a green pass.
 */
export function noCodeFailingStub(title: string): string {
  const safe = String(title || 'untitled').replace(/'/g, "\\'");
  return `import { test, expect } from '@playwright/test';\n\ntest('${safe} (no code generated)', async () => {\n  expect(false, 'The model produced no Playwright code for this test case.').toBe(true);\n});`;
}

function getAtPath(root: any, path: Array<string | number>): unknown {
  let node = root;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[key as any];
  }
  return node;
}

function setAtPath(root: any, path: Array<string | number>, value: unknown): void {
  if (!path.length) return;
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (node == null || typeof node !== 'object') return;
    node = node[path[i] as any];
  }
  if (node && typeof node === 'object') node[path[path.length - 1] as any] = value;
}

/**
 * Reconcile a parsed response with an object schema that has a single array (and
 * optionally a single string) field. SAFE remaps only:
 *  - a bare array/string is wrapped into the expected key,
 *  - a missing array key is filled from a KNOWN ALIAS key (cases→test_cases).
 * It does NOT grab "the first array/string of any property" — that misattributes
 * unrelated data (e.g. `notes` becoming `scripts`).
 */
export function coerceToSchemaShape(parsed: unknown, schema: z.ZodTypeAny): unknown {
  const expectedArrayKeys = ['scripts', 'test_cases', 'flows', 'cases', 'playwright_scripts', 'tests', 'items'];
  const expectedStringKeys = ['name', 'title', 'artifactName', 'artifact_name', 'label'];
  try {
    const def: any = (schema as any)?._def;
    const isObjectSchema = def?.typeName === 'ZodObject' || def?.type === 'object';
    if (!isObjectSchema) return parsed;
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const keys = Object.keys(shape || {});
    if (!keys.length) return parsed;
    const arrayKey = keys.find((k) => {
      const childDef = (shape[k] as any)?._def;
      return childDef?.typeName === 'ZodArray' || childDef?.type === 'array';
    }) || keys[0];
    const stringKey = keys.find((k) => {
      const childDef = (shape[k] as any)?._def;
      return childDef?.typeName === 'ZodString' || childDef?.type === 'string';
    });
    if (Array.isArray(parsed)) return { [arrayKey]: parsed };
    if (stringKey && typeof parsed === 'string') return { [stringKey]: parsed };
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj[arrayKey] === undefined) {
        // 1) Named alias (cases→test_cases, etc.).
        const namedArrayKey = expectedArrayKeys.find((k) => k !== arrayKey && Array.isArray(obj[k]));
        if (namedArrayKey) {
          obj[arrayKey] = obj[namedArrayKey];
        } else {
          // 2) UNAMBIGUOUS single array: if the object has exactly one array-valued
          //    property, it must be the intended one (handles a model using a key we
          //    don't alias, e.g. "testCases"). Safe — not the "grab any array" guess,
          //    which only applies when there are multiple arrays to choose between.
          const arrayProps = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
          if (arrayProps.length === 1) obj[arrayKey] = obj[arrayProps[0]];
        }
      }
      if (stringKey && obj[stringKey] === undefined) {
        const namedStringKey = expectedStringKeys.find((k) => k !== stringKey && typeof obj[k] === 'string');
        if (namedStringKey) obj[stringKey] = obj[namedStringKey];
      }
      return obj;
    }
    return parsed;
  } catch {
    return parsed;
  }
}

/**
 * Repair the SAFE subset of Zod validation drift:
 *  - wrap a bare array/string returned for a single-key schema,
 *  - cast a PRIMITIVE (number/boolean) into a string field,
 *  - snap an enum ONLY when there is an exact case-insensitive match ("high"→"High").
 *
 * It deliberately does NOT: stringify an object/array (lossy fabrication), or snap
 * an unrecognized enum to the first allowed value (the "blocked→continue" bug). When
 * it can't safely fix a field it leaves it invalid so the caller fails honestly.
 */
export function repairValidationError(parsed: unknown, error: any): unknown {
  const issues: any[] = Array.isArray(error?.issues) ? error.issues : [];
  const topWrap = issues.find((i) => Array.isArray(i?.path) && i.path.length === 1 && ['array', 'string'].includes(i?.expected));
  if (topWrap && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    const key = topWrap.path[0];
    if (typeof key === 'string') {
      if (topWrap.expected === 'array' && Array.isArray(parsed)) parsed = { [key]: parsed };
      else if (topWrap.expected === 'string' && typeof parsed === 'string') parsed = { [key]: parsed };
    }
  }
  if (!parsed || typeof parsed !== 'object') return parsed;
  for (const issue of issues) {
    const path: Array<string | number> = Array.isArray(issue?.path) ? issue.path : [];
    if (!path.length) continue;

    // A string field that came back as a PRIMITIVE → safe cast. Objects/arrays are
    // left alone (flattening them loses structure the model actually produced).
    if (issue.expected === 'string') {
      const cur = getAtPath(parsed, path);
      if (typeof cur === 'number' || typeof cur === 'boolean') setAtPath(parsed, path, String(cur));
    }

    // Enum/literal outside the allowed set → snap ONLY on an exact case-insensitive
    // match. Never default to allowed[0]: a garbled verdict must fail, not be invented.
    if (issue.code === 'invalid_value' || issue.code === 'invalid_enum_value') {
      const allowed: any[] = issue.values || issue.options || [];
      const cur = getAtPath(parsed, path);
      if (allowed.length && typeof cur === 'string') {
        const match = allowed.find((a) => String(a).toLowerCase() === cur.toLowerCase());
        if (match !== undefined) setAtPath(parsed, path, match);
      }
    }
  }
  return parsed;
}

export function normalizePriority(value: unknown): 'Low' | 'Medium' | 'High' | 'Critical' {
  const text = String(value || '').toLowerCase();
  if (text.includes('critical')) return 'Critical';
  if (text.includes('high') || text.includes('bvt') || text.includes('smoke')) return 'High';
  if (text.includes('low')) return 'Low';
  return 'Medium';
}

export function normalizeCaseType(value: unknown): 'Manual' | 'Automated' | 'Both' {
  const text = String(value || '').toLowerCase();
  if (text.includes('both')) return 'Both';
  if (text.includes('auto') || text.includes('playwright')) return 'Automated';
  return 'Manual';
}

/**
 * Normalize a test-case payload's SHAPE (alias keys, string casts, priority/type
 * defaults) WITHOUT fabricating content. A missing step list stays empty, a missing
 * assertion stays empty — so the downstream grounding gate can catch a thin case
 * instead of a fake "Open the target page / loads successfully" masking it.
 */
export function normalizeTestCasePayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const cases = Array.isArray(root.test_cases) ? root.test_cases : Array.isArray(root.cases) ? root.cases : undefined;
  if (!cases) return parsed;

  root.test_cases = cases.map((rawCase, index) => {
    const testCase = rawCase && typeof rawCase === 'object' ? { ...(rawCase as Record<string, unknown>) } : {};
    const title = stringifyField(testCase.title || testCase.name || testCase.scenario || `Test case ${index + 1}`);
    const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
    const normalizedSteps = steps.map((rawStep) => {
      const step: Record<string, unknown> = rawStep && typeof rawStep === 'object' ? (rawStep as Record<string, unknown>) : { action: rawStep };
      const action = stringifyField(step.action || step.step || step.instruction || step.description);
      const expected = stringifyField(step.expected || step.expectedResult || step.expected_result || step.assertion || step.result || step.outcome);
      return { action, expected }; // no canned filler — empties surface a thin step honestly
    });

    const description = stringifyField(testCase.description || testCase.summary || testCase.objective || testCase.purpose) || title;
    return {
      ...testCase,
      title,
      description,
      preconditions: stringifyField(testCase.preconditions || testCase.precondition || testCase.prerequisites),
      tags: Array.isArray(testCase.tags) ? testCase.tags.map((tag) => stringifyField(tag)).filter(Boolean) : [],
      priority: normalizePriority(testCase.priority),
      type: normalizeCaseType(testCase.type),
      steps: normalizedSteps, // may be [] — never a fabricated step
    };
  });
  return root;
}

/** Normalize a script payload's shape; use the honest failing stub when code is absent. */
export function normalizeScriptPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const scripts = Array.isArray(root.scripts) ? root.scripts : Array.isArray(root.playwright_scripts) ? root.playwright_scripts : undefined;
  if (!scripts) return parsed;

  root.scripts = scripts.map((rawScript, index) => {
    const script: Record<string, unknown> = rawScript && typeof rawScript === 'object' ? { ...(rawScript as Record<string, unknown>) } : { code: rawScript };
    const title = stringifyField(script.test_case_title || script.title || script.name || script.testName || script.test_name || `Generated Playwright script ${index + 1}`);
    const code = stringifyField(script.code || script.script || script.source || script.content || script.playwright || script.test || script.body);
    return {
      ...script,
      test_case_title: title,
      filename: stringifyField(script.filename || script.file || script.path) || slugifyScriptFilename(title, `generated-script-${index + 1}`),
      code: code || noCodeFailingStub(title),
    };
  });
  return root;
}
