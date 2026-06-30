import type { GroundedLocator } from "@atp/shared";

/**
 * Selector-lint — the model-independent anti-hallucination backstop.
 *
 * Extracts every element locator from a generated Playwright spec and asserts each maps to a
 * real catalog entry (or the platform-chrome allowlist). Unknown locator, XPath, or
 * waitForTimeout => hard fail, bounced back to the Script Engineer with the real candidates.
 *
 * ponytail: regex extraction, not a full TS AST. Ceiling: it won't see locators built from
 * variables/concatenation. Upgrade to ts-morph if generated code starts composing selectors
 * dynamically — until then scripts use literal locators and regex is enough.
 */

export interface LintViolation {
  kind: "ungrounded" | "xpath" | "hard-wait";
  locator: string;
  reason: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
  /** real, grounded locator values for this object — fed back for self-heal */
  candidates: string[];
}

export interface ChromeAllow {
  role: string;
  name: string;
}

function catalogKeys(catalog: GroundedLocator[], chrome: ChromeAllow[]): Set<string> {
  const keys = new Set<string>();
  for (const l of catalog) {
    if (l.strategy === "getByLabel") keys.add(`label|${l.value}`);
    else if (l.strategy === "getByTestId") keys.add(`testid|${l.value}`);
    else if (l.strategy === "getByRole") keys.add(`role|${l.role ?? ""}|${l.value}`);
    else if (l.strategy === "css") keys.add(`css|${l.value}`);
    else if (l.strategy === "getByPlaceholder") keys.add(`placeholder|${l.value}`);
  }
  for (const c of chrome) keys.add(`role|${c.role}|${c.name}`);
  return keys;
}

const STR = `['"]([^'"]+)['"]`;
const RE = {
  label: new RegExp(`getByLabel\\(\\s*${STR}`, "g"),
  testid: new RegExp(`getByTestId\\(\\s*${STR}`, "g"),
  placeholder: new RegExp(`getByPlaceholder\\(\\s*${STR}`, "g"),
  role: new RegExp(`getByRole\\(\\s*${STR}\\s*,\\s*\\{[^}]*name:\\s*${STR}`, "g"),
  locator: new RegExp(`\\.locator\\(\\s*${STR}`, "g"),
  hardWait: /waitForTimeout\s*\(/g,
};

export function lintScript(
  source: string,
  catalog: GroundedLocator[],
  chrome: ChromeAllow[] = [],
): LintResult {
  const keys = catalogKeys(catalog, chrome);
  const violations: LintViolation[] = [];
  const check = (key: string, display: string) => {
    if (!keys.has(key)) violations.push({ kind: "ungrounded", locator: display, reason: "not in metadata catalog" });
  };

  for (const m of source.matchAll(RE.label)) check(`label|${m[1]}`, `getByLabel('${m[1]}')`);
  for (const m of source.matchAll(RE.testid)) check(`testid|${m[1]}`, `getByTestId('${m[1]}')`);
  for (const m of source.matchAll(RE.placeholder)) check(`placeholder|${m[1]}`, `getByPlaceholder('${m[1]}')`);
  for (const m of source.matchAll(RE.role)) check(`role|${m[1]}|${m[2]}`, `getByRole('${m[1]}', { name: '${m[2]}' })`);

  for (const m of source.matchAll(RE.locator)) {
    const val = m[1] ?? "";
    if (val.startsWith("//") || val.startsWith("xpath=") || val.startsWith("(//")) {
      violations.push({ kind: "xpath", locator: `locator('${val}')`, reason: "XPath is banned (brittle)" });
    } else {
      check(`css|${val}`, `locator('${val}')`);
    }
  }

  if (RE.hardWait.test(source)) {
    violations.push({ kind: "hard-wait", locator: "waitForTimeout(...)", reason: "use auto-waiting assertions, not fixed sleeps" });
  }

  return { ok: violations.length === 0, violations, candidates: catalog.map((l) => l.expression) };
}
