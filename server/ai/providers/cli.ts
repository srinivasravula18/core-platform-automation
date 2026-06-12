import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  AIProvider,
  GenerateObjectOptions,
  GenerateTextOptions,
  ProviderHealth,
  ProviderName,
  ProviderResponse,
} from './types';
import { classifyError } from './types';

type CliTool = 'codex' | 'claude';

function commandFor(tool: CliTool) {
  if (tool === 'codex') return process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) return JSON.parse(objectMatch[0]);
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
    throw new Error('CLI model did not return valid JSON');
  }
}

function coerceToSchemaShape(parsed: unknown, schema: z.ZodTypeAny): unknown {
  const expectedArrayKeys = ['scripts', 'test_cases', 'flows', 'cases', 'playwright_scripts', 'tests', 'items'];
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
    if (Array.isArray(parsed)) return { [arrayKey]: parsed };
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (obj[arrayKey] === undefined) {
        const namedArrayKey = expectedArrayKeys.find((k) => Array.isArray(obj[k]));
        const arrProp = namedArrayKey ? obj[namedArrayKey] : Object.values(obj).find((v) => Array.isArray(v));
        if (arrProp) obj[arrayKey] = arrProp;
      }
      return obj;
    }
    return parsed;
  } catch {
    return parsed;
  }
}

function coerceFromValidationError(parsed: unknown, error: any): unknown {
  const issue = Array.isArray(error?.issues) ? error.issues.find((i: any) => Array.isArray(i?.path) && i.path.length === 1 && i.expected === 'array') : undefined;
  const missingKey = issue?.path?.[0];
  if (!missingKey || typeof missingKey !== 'string') return parsed;
  if (Array.isArray(parsed)) return { [missingKey]: parsed };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const arrProp = Object.values(obj).find((v) => Array.isArray(v));
    if (arrProp) return { ...obj, [missingKey]: arrProp };
  }
  return parsed;
}

function normalizePriority(value: unknown): 'Low' | 'Medium' | 'High' | 'Critical' {
  const text = String(value || '').toLowerCase();
  if (text.includes('critical')) return 'Critical';
  if (text.includes('high') || text.includes('bvt') || text.includes('smoke')) return 'High';
  if (text.includes('low')) return 'Low';
  return 'Medium';
}

function normalizeCaseType(value: unknown): 'Manual' | 'Automated' | 'Both' {
  const text = String(value || '').toLowerCase();
  if (text.includes('both')) return 'Both';
  if (text.includes('auto') || text.includes('playwright')) return 'Automated';
  return 'Manual';
}

function stringifyField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => stringifyField(item)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map((item) => stringifyField(item)).filter(Boolean).join('; ');
  return value === undefined || value === null ? '' : String(value);
}

function normalizeTestCasePayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const cases = Array.isArray(root.test_cases) ? root.test_cases : Array.isArray(root.cases) ? root.cases : undefined;
  if (!cases) return parsed;

  root.test_cases = cases.map((rawCase, index) => {
    const testCase = rawCase && typeof rawCase === 'object' ? { ...(rawCase as Record<string, unknown>) } : {};
    const title = stringifyField(testCase.title || testCase.name || testCase.scenario || `Test case ${index + 1}`);
    const normalizedSteps = (Array.isArray(testCase.steps) ? testCase.steps : []).map((rawStep, stepIndex) => {
      const step = rawStep && typeof rawStep === 'object' ? rawStep as Record<string, unknown> : { action: rawStep };
      const action = stringifyField(step.action || step.step || step.instruction || step.description || `Execute step ${stepIndex + 1}`);
      const expected = stringifyField(step.expected || step.expectedResult || step.expected_result || step.assertion || step.result || step.outcome)
        || 'The expected result for this step is observed.';
      return { action, expected };
    });

    return {
      ...testCase,
      title,
      description: stringifyField(testCase.description || testCase.summary || testCase.objective || testCase.purpose) || title,
      preconditions: stringifyField(testCase.preconditions || testCase.precondition || testCase.prerequisites) || 'Application is reachable and required test credentials are available.',
      tags: Array.isArray(testCase.tags) ? testCase.tags.map((tag) => stringifyField(tag)).filter(Boolean) : ['@ui', '@positive'],
      priority: normalizePriority(testCase.priority),
      type: normalizeCaseType(testCase.type),
      steps: normalizedSteps.length ? normalizedSteps : [{ action: 'Open the target page.', expected: 'The target page loads successfully.' }],
    };
  });
  return root;
}

function slugifyFilename(value: string, fallback: string): string {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback}.spec.ts`;
}

function normalizeScriptPayload(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const root = parsed as Record<string, unknown>;
  const scripts = Array.isArray(root.scripts) ? root.scripts : Array.isArray(root.playwright_scripts) ? root.playwright_scripts : undefined;
  if (!scripts) return parsed;

  root.scripts = scripts.map((rawScript, index) => {
    const script = rawScript && typeof rawScript === 'object' ? { ...(rawScript as Record<string, unknown>) } : { code: rawScript };
    const title = stringifyField(script.test_case_title || script.title || script.name || script.testName || script.test_name || `Generated Playwright script ${index + 1}`);
    const code = stringifyField(script.code || script.script || script.source || script.content || script.playwright || script.test || script.body);
    return {
      ...script,
      test_case_title: title,
      filename: stringifyField(script.filename || script.file || script.path) || slugifyFilename(title, `generated-script-${index + 1}`),
      code: code || `import { test, expect } from '@playwright/test';\n\ntest('${title.replace(/'/g, "\\'")}', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('body')).toBeVisible();\n});`,
    };
  });
  return root;
}

async function runProcess(command: string, args: string[], stdin: string, timeoutMs = 300_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env, NO_COLOR: '1' };
    // The Test Flow AI backend may be launched from inside a Codex session. Do not
    // pass parent-session internals to a nested `codex exec`; they can make the
    // child CLI choose the wrong auth/runtime path.
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SANDBOX_NETWORK_DISABLED;
    delete env.CODEX_MANAGED_BY_NPM;
    delete env.CODEX_MANAGED_PACKAGE_ROOT;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`.trim()));
    });
    child.stdin.end(stdin);
  });
}

export class AccountCliProvider implements AIProvider {
  readonly name: ProviderName;
  private defaultModel: string;
  private tool: CliTool;

  constructor(name: ProviderName, tool: CliTool, defaultModel: string) {
    this.name = name;
    this.tool = tool;
    this.defaultModel = defaultModel;
  }

  private modelId(opts: { model?: string }) {
    return opts.model || this.defaultModel;
  }

  private buildPrompt(opts: GenerateTextOptions) {
    return `${opts.system ? `${opts.system}\n\n` : ''}${opts.prompt}`;
  }

  private async run(opts: GenerateTextOptions): Promise<string> {
    const model = this.modelId(opts);
    if (this.tool === 'codex') {
      const outFile = path.join(os.tmpdir(), `testflow-codex-${randomUUID()}.txt`);
      // In ChatGPT subscription auth mode, Codex should use its own local config
      // model/provider. Passing the app's SDK model can force API-key auth.
      const args = ['exec', '--cd', process.cwd(), '--sandbox', 'read-only', '--color', 'never', '--output-last-message', outFile, '-'];
      try {
        await runProcess(
          commandFor('codex'),
          args,
          this.buildPrompt(opts),
        );
        return (await fs.readFile(outFile, 'utf8')).trim();
      } finally {
        await fs.unlink(outFile).catch(() => undefined);
      }
    }

    return await runProcess(
      commandFor('claude'),
      ['-p', '--model', model, '--permission-mode', 'dontAsk', '--output-format', 'text', this.buildPrompt(opts)],
      '',
    );
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const text = await this.run({ prompt: 'Reply with OK only.', maxTokens: 8 });
      return { ok: /\bOK\b/i.test(text), provider: this.name, model: this.defaultModel, error: /\bOK\b/i.test(text) ? undefined : text.slice(0, 200), checkedAt };
    } catch (err: any) {
      return { ok: false, provider: this.name, model: this.defaultModel, error: err?.message || String(err), checkedAt };
    }
  }

  async generateText(opts: GenerateTextOptions): Promise<ProviderResponse<string>> {
    const start = Date.now();
    const text = await this.run(opts);
    return {
      object: text,
      text,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      model: this.modelId(opts),
      provider: this.name,
      latencyMs: Date.now() - start,
    };
  }

  async generateObject<T>(opts: GenerateObjectOptions<unknown>): Promise<ProviderResponse<T>> {
    const start = Date.now();
    const schemaZ = opts.schema as z.ZodTypeAny;
    const prompt = `${opts.prompt}\n\nReturn ONLY a JSON object matching the requested schema. No markdown, no code fences, no commentary.`;
    const text = await this.run({ ...opts, prompt });
    try {
      const parsed = normalizeScriptPayload(normalizeTestCasePayload(coerceToSchemaShape(extractJson(text), schemaZ)));
      try {
        const object = schemaZ.parse(parsed) as T;
        return {
          object,
          text,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          model: this.modelId(opts),
          provider: this.name,
          latencyMs: Date.now() - start,
        };
      } catch (validationError: any) {
        const recovered = coerceFromValidationError(parsed, validationError);
        const object = schemaZ.parse(recovered) as T;
        return {
          object,
          text,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          model: this.modelId(opts),
          provider: this.name,
          latencyMs: Date.now() - start,
        };
      }
    } catch (error: any) {
      throw classifyError(this.name, 200, error?.message || 'CLI model did not return schema-valid JSON');
    }
  }
}
