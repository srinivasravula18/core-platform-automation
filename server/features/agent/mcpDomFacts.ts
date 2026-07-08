import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { startMcpSession, closeMcpSession, type McpSession } from '../../ai/tools/mcpClient';
import { createAuthStorageState } from '../evidence/evidenceService';
import { normalizeTargetUrl } from '../../shared/url';

type McpDomFact = {
  kind: 'button' | 'link' | 'input' | 'select' | 'textarea' | 'tab' | 'menuitem' | 'checkbox' | 'radio' | 'text';
  role: string;
  label: string;
  locator: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
  options?: string[];
};

type McpDomFacts = {
  source: 'playwright-mcp';
  page: { url: string; title: string; headings: string[] };
  intentTerms: string[];
  missingIntentTerms: string[];
  actionables: McpDomFact[];
  assertions: McpDomFact[];
  tables: { label: string; headers: string[]; sampleRows: Record<string, string>[] }[];
  accessibilitySnapshot: string;
  coverage: { actionables: number; assertions: number; tables: number };
};

function intentTerms(goal: string): string[] {
  const seen = new Set<string>();
  return [...String(goal || '').matchAll(/[A-Za-z][A-Za-z0-9 ]{2,40}/g)]
    .map((m) => m[0].replace(/\s+/g, ' ').trim())
    .filter((v) => v.length >= 3 && v.length <= 40)
    .filter((v) => !/^(verify|should|when|then|page|screen|click|open|select|enter|test case)$/i.test(v))
    .filter((v) => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

async function prepareAuth(url: string, credentials?: { username?: string; password?: string }) {
  if (!credentials?.username || !credentials?.password) return { storageStatePath: '', sessionItems: null as Record<string, string> | null };
  const storageStatePath = join(tmpdir(), `mcp-dom-auth-${randomUUID()}.json`);
  const res = await createAuthStorageState(url, { username: credentials.username, password: credentials.password }, storageStatePath).catch(() => null);
  return res?.ok
    ? { storageStatePath, sessionItems: res.sessionStorage?.items || null }
    : { storageStatePath: '', sessionItems: null };
}

async function injectSession(session: McpSession, url: string, items: Record<string, string> | null) {
  await session.client.callTool({ name: 'browser_navigate', arguments: { url } });
  if (!items || !Object.keys(items).length) return;
  await session.client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => { const items = ${JSON.stringify(items)}; for (const k in items) sessionStorage.setItem(k, items[k]); return true; }`,
    },
  }).catch(() => undefined);
  await session.client.callTool({ name: 'browser_navigate', arguments: { url } }).catch(() => undefined);
}

function textFromMcp(res: any): string {
  return (Array.isArray(res?.content) ? res.content : [])
    .map((c: any) => (c?.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

async function evaluateJson(session: McpSession, fn: string) {
  const res = await session.client.callTool({ name: 'browser_evaluate', arguments: { function: fn } });
  const raw = textFromMcp(res);
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {};
}

export async function collectMcpDomFacts(opts: {
  targetUrl: string;
  goal: string;
  credentials?: { username?: string; password?: string };
}): Promise<McpDomFacts> {
  const url = normalizeTargetUrl(opts.targetUrl);
  const terms = intentTerms(opts.goal);
  const auth = await prepareAuth(url, opts.credentials);
  let session: McpSession | null = null;
  try {
    session = await startMcpSession({
      toolFilter: (name) => ['browser_navigate', 'browser_snapshot', 'browser_evaluate', 'browser_wait_for'].includes(name),
      extraArgs: auth.storageStatePath ? ['--storage-state', auth.storageStatePath] : [],
      timeoutMs: 20_000,
    });
    await injectSession(session, url, auth.sessionItems);
    await session.client.callTool({ name: 'browser_wait_for', arguments: { time: 1 } }).catch(() => undefined);
    const snapshot = textFromMcp(await session.client.callTool({ name: 'browser_snapshot', arguments: {} }).catch(() => null)).slice(0, 12_000);
    const facts = await evaluateJson(session, `() => {
      const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const roleOf = (el) => {
        const r = el.getAttribute('role'); if (r) return r;
        const t = el.tagName.toLowerCase(); const it = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'a') return 'link'; if (t === 'button') return 'button'; if (t === 'select') return 'combobox';
        if (t === 'textarea') return 'textbox'; if (t === 'input') return it === 'checkbox' ? 'checkbox' : it === 'radio' ? 'radio' : 'textbox';
        return '';
      };
      const labelOf = (el) => clean(el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.textContent || el.value || el.getAttribute('name')).slice(0, 90);
      const loc = (el, role, label) => {
        const tid = el.getAttribute('data-testid'); if (tid) return 'page.getByTestId(' + JSON.stringify(tid) + ')';
        const id = el.id || ''; if (/^[A-Za-z][\\w-]{1,80}$/.test(id) && !/[a-f0-9]{8,}|\\d{5,}/i.test(id)) return 'page.locator(' + JSON.stringify('#' + id) + ')';
        if (el.labels?.[0]?.textContent) return 'page.getByLabel(' + JSON.stringify(clean(el.labels[0].textContent)) + ', { exact: true })';
        if (el.getAttribute('placeholder')) return 'page.getByPlaceholder(' + JSON.stringify(clean(el.getAttribute('placeholder'))) + ', { exact: true })';
        if (role && label) return 'page.getByRole(' + JSON.stringify(role) + ', { name: ' + JSON.stringify(label) + ', exact: true })';
        return label ? 'page.getByText(' + JSON.stringify(label) + ', { exact: true })' : '';
      };
      const toFact = (el) => {
        const role = roleOf(el); const label = labelOf(el); if (!label) return null;
        const tag = el.tagName.toLowerCase();
        const kind = role === 'tab' ? 'tab' : role === 'menuitem' ? 'menuitem' : role === 'checkbox' ? 'checkbox' : role === 'radio' ? 'radio' : tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'input' ? 'input' : 'button';
        return { kind, role: role || tag, label, locator: loc(el, role, label), visible: visible(el), enabled: !el.disabled, value: typeof el.value === 'string' ? el.value : undefined, options: tag === 'select' ? Array.from(el.options || []).map((o) => clean(o.textContent)).filter(Boolean).slice(0, 20) : undefined };
      };
      const actionables = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[contenteditable="true"]'))
        .map(toFact).filter((x) => x && x.visible && x.locator).slice(0, 120);
      const assertions = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"],[role="alert"],[role="status"],th,[role="columnheader"],[data-testid*="empty" i],[data-testid*="error" i]'))
        .map((el) => { const label = labelOf(el); return label ? { kind: 'text', role: roleOf(el) || el.tagName.toLowerCase(), label, locator: loc(el, roleOf(el), label), visible: visible(el), enabled: true } : null; })
        .filter((x) => x && x.visible).slice(0, 120);
      const tables = Array.from(document.querySelectorAll('table,[role="grid"],[role="table"]')).filter(visible).slice(0, 8).map((table) => {
        const headers = Array.from(table.querySelectorAll('th,[role="columnheader"]')).map((h) => clean(h.innerText || h.textContent)).filter(Boolean).slice(0, 30);
        const rows = Array.from(table.querySelectorAll('tbody tr,[role="row"]')).slice(0, 5).map((row) => {
          const cells = Array.from(row.querySelectorAll('td,[role="gridcell"],[role="cell"]')).map((c) => clean(c.innerText || c.textContent)).slice(0, headers.length || 12);
          const out = {}; cells.forEach((v, i) => out[headers[i] || 'col_' + (i + 1)] = v); return out;
        });
        return { label: clean(table.getAttribute('aria-label') || table.getAttribute('caption') || ''), headers, sampleRows: rows };
      });
      return { page: { url: location.href, title: document.title, headings: Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).map((h) => clean(h.innerText || h.textContent)).filter(Boolean).slice(0, 30) }, actionables, assertions, tables, bodyText: clean(document.body?.innerText).slice(0, 5000) };
    }`);
    const body = String(facts.bodyText || '').toLowerCase();
    const missingIntentTerms = terms.filter((term) => !body.includes(term.toLowerCase())).slice(0, 12);
    return {
      source: 'playwright-mcp',
      page: facts.page || { url, title: '', headings: [] },
      intentTerms: terms,
      missingIntentTerms,
      actionables: facts.actionables || [],
      assertions: facts.assertions || [],
      tables: facts.tables || [],
      accessibilitySnapshot: snapshot,
      coverage: {
        actionables: (facts.actionables || []).length,
        assertions: (facts.assertions || []).length,
        tables: (facts.tables || []).length,
      },
    };
  } finally {
    await closeMcpSession(session);
  }
}

export function renderMcpDomFactsForPrompt(facts: any): string {
  if (!facts?.source) return '';
  const actionables = (facts.actionables || []).slice(0, 80).map((f: any) => `- ${f.kind} ${JSON.stringify(f.label)} role=${f.role}`).join('\n');
  const assertions = (facts.assertions || []).slice(0, 60).map((f: any) => `- ${f.role} ${JSON.stringify(f.label)}`).join('\n');
  const tables = (facts.tables || []).slice(0, 6).map((t: any) => `- table ${JSON.stringify(t.label || '')} headers=${(t.headers || []).join(' | ')} rows=${(t.sampleRows || []).length}`).join('\n');
  return `\nPLAYWRIGHT MCP DOM FACTS: live labels/text only. Use selectors only from the verified selector registry.\nPage: ${facts.page?.url || ''} title=${facts.page?.title || ''}\nMissing terms: ${(facts.missingIntentTerms || []).join(', ') || 'none'}\nActionables:\n${actionables || '(none)'}\nAssertions:\n${assertions || '(none)'}\nTables:\n${tables || '(none)'}\n`;
}
