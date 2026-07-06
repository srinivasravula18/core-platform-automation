/**
 * observe_page / act_on_page — the tool-loop inspector's eyes and hands.
 *
 * The page session (browser, login, target URL, credentials) is opened by the HARNESS and
 * carried in ToolContext.scratch — the model never supplies a URL or credential. The model
 * only ever sees the dehydrated observation (indexed elements) and acts by element id, so
 * every step is grounded in what is actually on the live page.
 */

import type { AgentTool, ToolContext } from './types';
import { observePage, actOnPage } from '../../features/agent/pageSession';

function sessionIdFrom(ctx: ToolContext): string {
  const id = String((ctx.scratch as any)?.pageSessionId || '');
  if (!id) throw new Error('No live page session is attached to this run.');
  return id;
}

/** Strip the server-side raw context before the observation goes to the model. */
function forModel(observation: any) {
  const { raw, ...rest } = observation || {};
  void raw;
  return rest;
}

export const observePageTool: AgentTool = {
  spec: {
    name: 'observe_page',
    description: 'Read the CURRENT state of the live page: every interactive element as "[id] kind | label", plus headings, tables (with headers + row counts), forms, and a page-text excerpt. Call this to re-ground after anything changes. Element ids are only valid for the page state they were observed on.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async execute(_args, ctx) {
    return forModel(await observePage(sessionIdFrom(ctx)));
  },
};

export const actOnPageTool: AgentTool = {
  spec: {
    name: 'act_on_page',
    description: 'Perform ONE action on the live page by element id from the latest observe_page result: click a button/link/tab, type into a field (text + Enter), or select a dropdown option. Returns whether it worked, a screenshot path, and the FRESH observation after the action — always ground your next step in that fresh observation.',
    parameters: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'The [id] of the element from the latest observe_page result (e.g. "agent-action-12").' },
        action: { type: 'string', enum: ['click', 'type', 'select'], description: 'click = press the element; type = fill text then Enter; select = choose a dropdown option.' },
        text: { type: 'string', description: 'The text to type or the option label to select. Ignored for click.' },
      },
      required: ['elementId', 'action'],
    },
  },
  async execute(args, ctx) {
    const result = await actOnPage(sessionIdFrom(ctx), {
      elementId: String(args.elementId || ''),
      action: (['click', 'type', 'select'].includes(String(args.action)) ? String(args.action) : 'click') as 'click' | 'type' | 'select',
      text: args.text === undefined ? undefined : String(args.text),
      intent: String((ctx.scratch as any)?.inspectionIntent || ''),
    });
    return { ok: result.ok, note: result.note, screenshot: result.screenshot, observation: forModel(result.observation) };
  },
};

export const pageTools: AgentTool[] = [observePageTool, actOnPageTool];
