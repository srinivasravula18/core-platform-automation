/**
 * Synthesize a Playwright test script from verified DOM elements (blackboard).
 * Ported from agentic-test-platform's synthesizeScriptFromBlackboard.
 * Builds test steps directly from the element data — no LLM guessing needed.
 */

export interface BlackboardElement {
  tag: string;
  text: string | null;
  role: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  name: string | null;
  id: string | null;
  type: string | null;
  resolved_selector: string | null;
  selector_strategy?: string;
  fallback_selector?: string | null;
  status: string;
  visible: boolean;
  disabled: boolean;
  ariaHasPopup?: string | null;
  ariaExpanded?: string | null;
}

function locatorFor(el: BlackboardElement): string {
  if (el.resolved_selector) {
    const s = el.resolved_selector;
    if (s.startsWith('role=')) {
      const m = s.match(/role=(\w+)\[name="([^"]+)"\]/);
      if (m) return `page.getByRole('${m[1]}', { name: '${m[2].replace(/'/g, "\\'")}' })`;
    }
    if (s.startsWith('text=')) return `page.getByText('${s.slice(5).replace(/'/g, "\\'")}')`;
    if (s.startsWith('#')) return `page.locator('${s.replace(/'/g, "\\'")}')`;
    if (s.startsWith('[')) return `page.locator('${s.replace(/'/g, "\\'")}')`;
  }
  if (el.ariaLabel) return `page.getByLabel('${el.ariaLabel.replace(/'/g, "\\'")}')`;
  if (el.placeholder) return `page.getByPlaceholder('${el.placeholder.replace(/'/g, "\\'")}')`;
  if (el.id) return `page.locator('#${el.id.replace(/'/g, "\\'")}')`;
  if (el.name && el.tag) return `page.locator('${el.tag}[name="${el.name.replace(/"/g, '\\"')}"]')`;
  if (el.text && el.text.length <= 60) return `page.getByText('${el.text.replace(/'/g, "\\'")}', { exact: true })`;
  if (el.fallback_selector) return `page.locator('${el.fallback_selector.replace(/'/g, "\\'")}')`;
  return '';
}

function uniqueId(el: BlackboardElement): string {
  return (el.text || el.ariaLabel || el.name || el.id || el.placeholder || `${el.tag}_${Math.random().toString(36).slice(2, 6)}`)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'element';
}

export function synthesizeScriptFromElements(opts: {
  title: string;
  baseUrl: string;
  elements: BlackboardElement[];
  actionLabel?: string;
  caseSteps?: { action: string; expected: string }[];
}): string {
  const { title, baseUrl, elements, caseSteps } = opts;
  const lines: string[] = [];

  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test('${title.replace(/'/g, "\\'")}', async ({ page }) => {`);
  lines.push(`  await page.goto('${baseUrl}');`);
  lines.push(`  await page.waitForLoadState('domcontentloaded');`);
  lines.push(`  await page.waitForTimeout(1500);`);
  lines.push('');

  const buttons = elements.filter((e) => e.tag === 'button' || e.role === 'button');
  const inputs = elements.filter((e) => e.tag === 'input' || e.role === 'textbox' || e.role === 'combobox' || e.tag === 'textarea');
  const selects = elements.filter((e) => e.tag === 'select');
  const links = elements.filter((e) => e.tag === 'a');

  if (caseSteps && caseSteps.length) {
    for (let i = 0; i < caseSteps.length; i++) {
      const step = caseSteps[i];
      const stepId = `step-${i + 1}`;
      const actionLower = step.action.toLowerCase();

      if (/click|press|tap|open|select|choose/i.test(actionLower)) {
        const el = buttons.find((b) =>
          step.action.toLowerCase().includes((b.text || '').toLowerCase()) ||
          step.action.toLowerCase().includes((b.ariaLabel || '').toLowerCase())
        ) || links.find((l) =>
          step.action.toLowerCase().includes((l.text || '').toLowerCase()) ||
          step.action.toLowerCase().includes((l.ariaLabel || '').toLowerCase())
        );
        if (el) {
          const loc = locatorFor(el);
          if (loc) {
            lines.push(`  // ${step.action}`);
            if (el.ariaHasPopup || el.ariaExpanded === 'false') {
              lines.push(`  await ${loc}.click();`);
              lines.push(`  await page.waitForTimeout(400);`);
            } else {
              lines.push(`  await ${loc}.click();`);
            }
            lines.push('');
            continue;
          }
        }
        lines.push(`  // ${step.action}`);
        lines.push('');
      }

      if (/fill|enter|type|input|write/i.test(actionLower)) {
        const fieldLabel = step.action.replace(/^(fill|enter|type|input|write)\s+/i, '').slice(0, 30);
        const el = inputs.find((inp) =>
          (inp.ariaLabel || '').toLowerCase().includes(fieldLabel.toLowerCase()) ||
          (inp.placeholder || '').toLowerCase().includes(fieldLabel.toLowerCase()) ||
          (inp.name || '').toLowerCase().includes(fieldLabel.toLowerCase())
        ) || inputs.find((inp) =>
          (inp.text || '').toLowerCase().includes(fieldLabel.toLowerCase())
        );
        if (el) {
          const loc = locatorFor(el);
          if (loc) {
            lines.push(`  // ${step.action}`);
            lines.push(`  await ${loc}.fill('${fieldLabel.replace(/'/g, "\\'")}');`);
            lines.push('');
            continue;
          }
        }
        lines.push(`  // ${step.action}`);
        lines.push('');
        continue;
      }

      if (/select.*option|choose|pick/i.test(actionLower)) {
        const selectLabel = step.action.replace(/^(select|choose|pick)\s+/i, '').slice(0, 30);
        const el = selects.find((s) =>
          (s.ariaLabel || '').toLowerCase().includes(selectLabel.toLowerCase()) ||
          (s.name || '').toLowerCase().includes(selectLabel.toLowerCase())
        );
        if (el) {
          const loc = locatorFor(el);
          if (loc) {
            lines.push(`  // ${step.action}`);
            lines.push(`  await ${loc}.selectOption({ index: 1 });`);
            lines.push('');
            continue;
          }
        }
        lines.push(`  // ${step.action}`);
        lines.push('');
        continue;
      }

      if (/verify|check|assert|should|expect|wait/i.test(actionLower)) {
        lines.push(`  // verify: ${step.action}`);
        lines.push('');
        continue;
      }

      // generic: write the step as comment
      lines.push(`  // ${step.action}`);
      lines.push('');
    }
  }

  // verify at least one assertion
  if (lines.filter((l) => l.includes('expect(')).length <= 1) {
    const firstButton = buttons[0];
    if (firstButton) {
      const loc = locatorFor(firstButton);
      if (loc) lines.push(`  await expect(${loc}).toBeVisible();`);
    }
  }

  lines.push('});');
  return lines.join('\n');
}
