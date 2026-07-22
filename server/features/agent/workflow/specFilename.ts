/**
 * Derive a stable, human-readable Playwright spec filename from a case TITLE (e.g.
 * "admin - verify Create an app…" -> "admin-verify-create-an-app.spec.ts"), instead of the internal
 * case id (case-1.spec.ts). The case id stays the linking key elsewhere; this only names the artifact.
 *
 * Pass a shared `used` set across one batch of scripts so two cases that slug to the same name get a
 * numeric suffix (-2, -3…) rather than colliding on disk when the specs are materialized for execution.
 */
export function specFilenameFromTitle(title: string, fallbackId: string, used?: Set<string>): string {
  const slug = (raw: string) => String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const base = slug(title) || slug(fallbackId) || 'case';
  let name = `${base}.spec.ts`;
  if (used) {
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}.spec.ts`;
    used.add(name);
  }
  return name;
}
