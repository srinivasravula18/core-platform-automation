/**
 * check_url — is a target actually serving, without opening a browser.
 *
 * Inspecting a page to answer "is it up?" costs a browser launch and a minute; worse, an agent that
 * lands on an error page treats it as the product and writes cases about a "404 Not Found" heading.
 * This is one bounded HTTP request that returns the status and a plain-language verdict instead.
 */
import type { AgentTool, ToolContext } from '../../ai/tools/types';

const TIMEOUT_MS = 8000;

/** Status → what it means for testability. Auth walls are fine; the run signs in. */
function verdict(status: number): { ok: boolean; meaning: string } {
  if (status === 401 || status === 403) return { ok: true, meaning: 'reachable — requires sign-in, which the run performs' };
  if (status === 404 || status === 410) return { ok: false, meaning: `the server returned ${status} — nothing is served at that address` };
  if (status === 502 || status === 503 || status === 504) return { ok: false, meaning: `the server is not responding (${status})` };
  if (status >= 500) return { ok: false, meaning: `the server is failing (${status})` };
  return { ok: true, meaning: `reachable (${status})` };
}

export const urlHealthTool: AgentTool = {
  spec: {
    name: 'check_url',
    description:
      'Check whether a URL is serving, using ONE HTTP request — no browser. Returns the status code and whether the ' +
      'target is testable. Use this before inspecting or authoring anything against a target; never open a browser ' +
      'just to find out if a server is up. A target that is not responding must stop the work, not be tested.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to check.' },
      },
      required: ['url'],
    },
  },
  async execute(rawArgs: Record<string, unknown>, _ctx: ToolContext) {
    const url = String((rawArgs || {}).url || '').trim();
    if (!url) return { ok: false, error: 'no url was provided' };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, url, error: 'not a valid URL' }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, url, error: `unsupported protocol "${parsed.protocol}"` };

    const started = Date.now();
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const { ok, meaning } = verdict(res.status);
      return { ok, url, status: res.status, meaning, ms: Date.now() - started };
    } catch (err: any) {
      const code = String(err?.cause?.code || err?.name || '');
      const meaning = /TimeoutError|ETIMEDOUT|ABORT/i.test(code) ? 'the server is not responding (timed out)'
        : /ENOTFOUND|EAI_AGAIN/i.test(code) ? 'the address could not be resolved'
        : /ECONNREFUSED/i.test(code) ? 'the server refused the connection — it is not running'
        : `the server is unreachable (${code || 'unknown error'})`;
      return { ok: false, url, meaning, ms: Date.now() - started };
    }
  },
};
