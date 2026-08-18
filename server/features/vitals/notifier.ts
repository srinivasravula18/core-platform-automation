/**
 * Alert notification delivery.
 *
 * A firing instance is routed through the store's notification-policy tree to one contact point.
 * Only two kinds exist because only two are honest without a deploy: `webhook` posts the payload,
 * and `log` records the delivery so a rule can be wired end to end with no external endpoint.
 *
 * Delivery is attempted at most once per transition — the caller decides when a transition happened.
 */

import { vitalsQuery } from './db';

export type NotificationPayload = {
  ruleId: string;
  title: string;
  state: string;
  severity: string;
  value: number | null;
  threshold: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  at: string;
};

type PolicyRow = {
  id: string;
  parent_id: string | null;
  matchers: { label: string; value: string }[];
  contact_point_id: string | null;
  sort_order: number;
};

type ContactPointRow = {
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  enabled: boolean;
};

/** Depth-first through the policy tree; the deepest matching node wins, else the root's own point. */
export const selectContactPoint = (policies: PolicyRow[], labels: Record<string, string>): string | null => {
  const matches = (policy: PolicyRow) => (policy.matchers ?? []).every((matcher) => labels[matcher.label] === matcher.value);

  const walk = (parentId: string | null, depth: number): string | null => {
    if (depth > 12) return null; // a cyclic or absurdly deep tree must not hang the evaluator
    const children = policies.filter((policy) => policy.parent_id === parentId && matches(policy)).sort((a, b) => a.sort_order - b.sort_order);
    for (const child of children) {
      const deeper = walk(child.id, depth + 1);
      if (deeper) return deeper;
      if (child.contact_point_id) return child.contact_point_id;
    }
    return null;
  };

  const root = policies.find((policy) => policy.parent_id === null);
  return walk(root?.id ?? null, 0) ?? root?.contact_point_id ?? null;
};

const WEBHOOK_TIMEOUT_MS = 8_000;

const deliver = async (contactPoint: ContactPointRow, payload: NotificationPayload): Promise<string> => {
  if (!contactPoint.enabled) return 'skipped (disabled)';
  if (contactPoint.type !== 'webhook') return 'logged';

  const url = String(contactPoint.settings?.url ?? '');
  if (!url) return 'skipped (no url)';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return `webhook ${response.status}`;
  } catch (error) {
    return `webhook failed: ${(error as Error).message}`;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Route and deliver one transition. `labelsHash` scopes the delivery stamp to the exact instance,
 * so a rule firing for one label set does not mark its siblings as notified.
 */
export const notify = async (payload: NotificationPayload, labelsHash: string): Promise<string> => {
  const [policies, contactPoints] = await Promise.all([
    vitalsQuery<PolicyRow>(`select id, parent_id, matchers, contact_point_id, sort_order from obs.notification_policy`),
    vitalsQuery<ContactPointRow>(`select id, name, type, settings, enabled from obs.contact_point`),
  ]);

  const contactPointId = selectContactPoint(policies, payload.labels);
  const contactPoint = contactPoints.find((row) => row.id === contactPointId) ?? null;
  const outcome = contactPoint ? await deliver(contactPoint, payload) : 'no matching contact point';

  await vitalsQuery(`update obs.alert_instance set last_notified_at = now() where rule_id = $1 and labels_hash = $2`, [
    payload.ruleId,
    labelsHash,
  ]);
  return outcome;
};
