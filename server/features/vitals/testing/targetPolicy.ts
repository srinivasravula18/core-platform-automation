import os from 'os';
import { vitalsQuery } from '../db';

export type TestTarget = { url: string; label: string; source: 'default' | 'configured' | 'sandbox'; pentestAllowed: boolean };

const normalize = (value: string) => new URL(value).toString().replace(/\/$/, '');
const defaultTarget = () => process.env.OBSERVABILITY_TARGET_BASE_URL?.trim() || `http://127.0.0.1:${process.env.SERVICE_PORT ?? process.env.PORT ?? 3001}`;
const configuredTargets = () => process.env.OBSERVABILITY_TEST_ALLOWED_TARGETS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
const sandboxPentestAllowed = () => !/^(0|false|no|off)$/i.test(process.env.OBSERVABILITY_PENTEST_ALLOW_SANDBOXES?.trim() ?? '');

export const isAllowedTarget = (target: string, allowed: string[]) => {
  try { return allowed.some((candidate) => normalize(candidate) === normalize(target)); } catch { return false; }
};

export const sandboxTargets = (rows: { name: string; hostname: string | null; server: string | null; service_port: number | null }[], localHost = os.hostname()): TestTarget[] =>
  rows.flatMap((row) => {
    if (!row.service_port) return [];
    const reportedHost = (row.server ?? row.hostname ?? '').trim();
    const host = !reportedHost || reportedHost.toLowerCase() === localHost.toLowerCase() ? '127.0.0.1' : reportedHost;
    return [{ url: `http://${host}:${row.service_port}`, label: row.name, source: 'sandbox' as const, pentestAllowed: sandboxPentestAllowed() }];
  });

export async function resolveTestTargets(): Promise<TestTarget[]> {
  let discovered: TestTarget[] = [];
  try {
    discovered = sandboxTargets(await vitalsQuery<{ name: string; hostname: string | null; server: string | null; service_port: number | null }>(
      'select name, hostname, server, service_port from meta.sandbox_environment where running = true and service_port is not null order by name',
    ));
  } catch { /* A standalone Vitals store has no sandbox registry. */ }
  const all = [
    { url: defaultTarget(), label: 'This service', source: 'default' as const, pentestAllowed: true },
    ...configuredTargets().map((url) => ({ url, label: url, source: 'configured' as const, pentestAllowed: true })),
    ...discovered,
  ];
  const deduped = new Map<string, TestTarget>();
  for (const target of all) {
    try {
      const key = normalize(target.url);
      const existing = deduped.get(key);
      if (!existing || target.pentestAllowed) deduped.set(key, target);
    } catch { /* Ignore malformed operator configuration. */ }
  }
  return [...deduped.values()];
}
