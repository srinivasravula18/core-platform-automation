/**
 * Per-request context via AsyncLocalStorage — carries the acting user (Actor) through the whole
 * async request without threading it through every route/repository call. A middleware seeds it
 * once (see apps/api/src/server.ts); the repository layer reads `currentActor()` when stamping
 * lifecycle metadata (createdBy/updatedBy). Writes that run outside a request (schema seed,
 * background schedulers, detached agent-runtime promises) find no store and default to SYSTEM_ACTOR.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { type Actor, SYSTEM_ACTOR } from './metadata';

interface RequestContext {
  actor: Actor;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and everything it awaits) with the given actor as the current context. */
export function runWithActor<T>(actor: Actor, fn: () => T): T {
  return storage.run({ actor }, fn);
}

/** The acting user for the current async context, or SYSTEM when there is none. */
export function currentActor(): Actor {
  return storage.getStore()?.actor || SYSTEM_ACTOR;
}
