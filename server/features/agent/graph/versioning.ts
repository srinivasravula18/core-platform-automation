/**
 * Versioning-driven regression (Phase 6) — turns the Object Repository's append-only history into regression
 * SIGNALS. Because evidence is never overwritten (see objectRepository), a control whose verified selector
 * changed between runs is a concrete regression signal: the UI a prior test relied on has shifted. This is
 * read-only over the repository.
 */
import { getControl, listControls } from './objectRepository';

export interface RegressionSignal {
  key: string;
  control: string;
  fromVersion: number;
  toVersion: number;
  changedAt: string;
  before: string | null;
  after: string | null;
  kind: 'selector-changed' | 'role-changed' | 'label-changed';
}

/** Regression signal for a single control (null if it never changed). Compares current vs the prior snapshot. */
export function controlRegression(key: string): RegressionSignal | null {
  const rec = getControl(key);
  if (!rec || !rec.history.length) return null;
  const prev = rec.history[rec.history.length - 1];
  const cur = rec.current;
  let kind: RegressionSignal['kind'] | null = null;
  let before: string | null = null;
  let after: string | null = null;
  if (prev.selector !== cur.selector) { kind = 'selector-changed'; before = prev.selector; after = cur.selector; }
  else if (prev.role !== cur.role) { kind = 'role-changed'; before = prev.role; after = cur.role; }
  else if (prev.label !== cur.label) { kind = 'label-changed'; before = prev.label; after = cur.label; }
  if (!kind) return null;
  return { key, control: cur.semanticName, fromVersion: prev.version, toVersion: cur.version, changedAt: cur.lastVerified, before, after, kind };
}

/** All regression signals in a scope (highest version delta first). */
export function computeRegressions(filter: { platform?: string; application?: string; module?: string; object?: string } = {}): RegressionSignal[] {
  return listControls(filter)
    .map((r) => controlRegression(r.key))
    .filter((s): s is RegressionSignal => !!s)
    .sort((a, b) => (b.toVersion - b.fromVersion) - (a.toVersion - a.fromVersion));
}
