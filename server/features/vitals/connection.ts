/**
 * Where Vitals reads from, stored as data instead of environment.
 *
 * A connection is a record in this application's own settings store, editable from the Connect page
 * and effective immediately — no .env edit and no restart. Environment variables remain a fallback
 * so an existing deployment keeps working, but nothing here requires them.
 *
 * Two independent halves, either of which may be absent:
 *   - `database` — a direct read of the monitored product's `obs` schema, what every page renders from.
 *   - `control` — the product's own console API. Reads never use it; it exists because starting a load
 *     or security run is a process on the machine that owns the profile scripts.
 */

import { Settings } from '../../db/repository';
import { decryptSecret, encryptSecret, getWebsite, resolveCredentials } from '../credentials/credentialsService';

const SETTINGS_KEY = 'vitals.connection';

/** Marks a stored string as ciphertext, so a plaintext value written by hand still loads. */
const SEALED = 'enc:';

/** What a control-plane call actually needs, once everything has been resolved. */
export type VitalsControlConfig = {
  baseUrl: string;
  username: string;
  password: string;
};

/**
 * How the control plane's credentials are obtained. Preferring a reference to Settings → Credentials
 * means the operator password lives in exactly one place: rotating it there fixes Vitals too, and
 * this record never holds a second copy to go stale.
 *
 * Typing one in directly stays possible, because a customer's observability console is not always an
 * application they registered for testing.
 */
export type VitalsControlRef =
  | { kind: 'credential'; websiteId: string; loginId?: string; baseUrlOverride?: string }
  | { kind: 'inline'; baseUrl: string; username: string; password: string };

export type VitalsAlertingConfig = {
  /** Off by default: the monitored product's own console may already own evaluation. */
  enabled: boolean;
  intervalSeconds: number;
  /** Whether this evaluator delivers notifications, or only writes instance state. */
  notify: boolean;
};

export type VitalsConnection = {
  databaseUrl: string | null;
  /** The reference, not the secret — call resolveControl() for something usable. */
  control: VitalsControlRef | null;
  alerting: VitalsAlertingConfig;
  sloTargetPct: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Where each half came from, so the UI can say "inherited from the environment". */
  source: { database: 'stored' | 'environment' | 'none'; control: 'stored' | 'environment' | 'none' };
};

export const DEFAULT_ALERTING: VitalsAlertingConfig = { enabled: false, intervalSeconds: 60, notify: false };
const DEFAULT_SLO_TARGET_PCT = 99.9;

const seal = (value: string | null | undefined): string | null => (value ? `${SEALED}${encryptSecret(value)}` : null);

const unseal = (value: string | null | undefined): string | null => {
  if (!value) return null;
  if (!value.startsWith(SEALED)) return value;
  try {
    return decryptSecret(value.slice(SEALED.length));
  } catch {
    // A key rotation makes old ciphertext unreadable; treat it as absent rather than crashing every
    // page, and let the operator re-enter it on the Connect page.
    console.error('[vitals] stored connection secret could not be decrypted — re-enter it under Vitals → Connect.');
    return null;
  }
};

type StoredControl =
  | { kind?: 'credential'; websiteId: string; loginId?: string; baseUrlOverride?: string }
  | { kind?: 'inline'; baseUrl?: string; username?: string; password?: string | null };

type StoredShape = {
  databaseUrl?: string | null;
  control?: StoredControl | null;
  alerting?: Partial<VitalsAlertingConfig>;
  sloTargetPct?: number;
  updatedAt?: string;
  updatedBy?: string | null;
};

const isCredentialRef = (control: StoredControl | null | undefined): control is Extract<StoredControl, { websiteId: string }> =>
  Boolean(control && 'websiteId' in control && control.websiteId);

/** Cached because every query resolves the connection; invalidated on save, nothing else changes it. */
let cached: VitalsConnection | null = null;

const clampInterval = (seconds: unknown) => Math.min(3_600, Math.max(15, Number(seconds) || DEFAULT_ALERTING.intervalSeconds));

const clampSlo = (value: unknown) => Math.min(99.999, Math.max(90, Number(value) || DEFAULT_SLO_TARGET_PCT));

/** VITALS_DB_* parts, or a bare database name reusing this application's own Postgres. */
const databaseUrlFromEnvironment = (): string | null => {
  const url = process.env.VITALS_DATABASE_URL?.trim();
  if (url) return url;

  const database = process.env.VITALS_DB_NAME?.trim();
  if (!database) return null;

  const host = process.env.VITALS_DB_HOST?.trim();
  const user = process.env.VITALS_DB_USER?.trim();
  if (host && user) {
    const port = process.env.VITALS_DB_PORT?.trim() || '5432';
    const password = encodeURIComponent(process.env.VITALS_DB_PASSWORD ?? '');
    return `postgres://${encodeURIComponent(user)}:${password}@${host}:${port}/${database}`;
  }

  const appUrl = process.env.DATABASE_URL?.trim();
  if (!appUrl) return null;
  try {
    const parsed = new URL(appUrl);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  } catch {
    return null;
  }
};

const controlFromEnvironment = (): VitalsControlRef | null => {
  const baseUrl = process.env.VITALS_CONTROL_URL?.trim();
  const username = process.env.VITALS_CONTROL_USERNAME?.trim();
  const password = process.env.VITALS_CONTROL_PASSWORD;
  if (!baseUrl || !username || !password) return null;
  return { kind: 'inline', baseUrl: baseUrl.replace(/\/+$/, ''), username, password };
};

export async function readConnection(): Promise<VitalsConnection> {
  if (cached) return cached;

  let stored: StoredShape = {};
  try {
    stored = ((await Settings.getKVs())[SETTINGS_KEY] as StoredShape) ?? {};
  } catch (error) {
    console.error('[vitals] could not read the stored connection:', (error as Error).message);
  }

  const storedDatabaseUrl = unseal(stored.databaseUrl);

  let storedControl: VitalsControlRef | null = null;
  if (isCredentialRef(stored.control)) {
    storedControl = {
      kind: 'credential',
      websiteId: stored.control.websiteId,
      loginId: stored.control.loginId,
      baseUrlOverride: stored.control.baseUrlOverride?.replace(/\/+$/, ''),
    };
  } else if (stored.control) {
    const inline = stored.control as Extract<StoredControl, { baseUrl?: string }>;
    const password = unseal(inline.password);
    if (inline.baseUrl && inline.username && password) {
      storedControl = { kind: 'inline', baseUrl: inline.baseUrl.replace(/\/+$/, ''), username: inline.username, password };
    }
  }

  const environmentDatabaseUrl = databaseUrlFromEnvironment();
  const environmentControl = controlFromEnvironment();

  cached = {
    databaseUrl: storedDatabaseUrl ?? environmentDatabaseUrl,
    control: storedControl ?? environmentControl,
    alerting: {
      enabled: stored.alerting?.enabled ?? DEFAULT_ALERTING.enabled,
      intervalSeconds: clampInterval(stored.alerting?.intervalSeconds),
      notify: stored.alerting?.notify ?? DEFAULT_ALERTING.notify,
    },
    sloTargetPct: clampSlo(stored.sloTargetPct ?? process.env.VITALS_SLO_TARGET_PCT),
    updatedAt: stored.updatedAt ?? null,
    updatedBy: stored.updatedBy ?? null,
    source: {
      database: storedDatabaseUrl ? 'stored' : environmentDatabaseUrl ? 'environment' : 'none',
      control: storedControl ? 'stored' : environmentControl ? 'environment' : 'none',
    },
  };
  return cached;
}

export type ConnectionInput = {
  databaseUrl?: string | null;
  control?:
    | { kind: 'credential'; websiteId: string; loginId?: string; baseUrlOverride?: string }
    | { kind: 'inline'; baseUrl: string; username: string; password?: string }
    | null;
  alerting?: Partial<VitalsAlertingConfig>;
  sloTargetPct?: number;
};

/**
 * Merge-and-save. An omitted field keeps its stored value, so the UI can save the alerting section
 * without re-sending the database password; an explicit null clears that half.
 */
export async function saveConnection(input: ConnectionInput, actor: string | null): Promise<VitalsConnection> {
  const previousStored = (((await Settings.getKVs())[SETTINGS_KEY] as StoredShape) ?? {}) as StoredShape;
  const current = await readConnection();

  const databaseUrl =
    input.databaseUrl === undefined ? previousStored.databaseUrl ?? null : input.databaseUrl ? seal(input.databaseUrl) : null;

  let control: StoredShape['control'];
  if (input.control === undefined) {
    control = previousStored.control ?? null;
  } else if (input.control === null) {
    control = null;
  } else if (input.control.kind === 'credential') {
    // Only the reference is written. The password stays in Settings → Credentials, where it can be
    // rotated once and take effect everywhere.
    control = {
      kind: 'credential',
      websiteId: input.control.websiteId,
      loginId: input.control.loginId,
      baseUrlOverride: input.control.baseUrlOverride?.replace(/\/+$/, '') || undefined,
    };
  } else {
    // A blank password on an update means "keep the stored one" — the UI never round-trips it.
    const previousInline = isCredentialRef(previousStored.control) ? null : (previousStored.control as { password?: string | null } | null);
    const password = input.control.password ? seal(input.control.password) : previousInline?.password ?? null;
    control = { kind: 'inline', baseUrl: input.control.baseUrl.replace(/\/+$/, ''), username: input.control.username, password };
  }

  const next: StoredShape = {
    databaseUrl,
    control,
    alerting: {
      enabled: input.alerting?.enabled ?? current.alerting.enabled,
      intervalSeconds: clampInterval(input.alerting?.intervalSeconds ?? current.alerting.intervalSeconds),
      notify: input.alerting?.notify ?? current.alerting.notify,
    },
    sloTargetPct: clampSlo(input.sloTargetPct ?? current.sloTargetPct),
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };

  await Settings.setKV(SETTINGS_KEY, next);
  cached = null;
  return readConnection();
}

export async function clearConnection(actor: string | null): Promise<VitalsConnection> {
  await Settings.setKV(SETTINGS_KEY, { updatedAt: new Date().toISOString(), updatedBy: actor } satisfies StoredShape);
  cached = null;
  return readConnection();
}

/** Drops the cache so the next read re-resolves. Used after a save and by tests. */
export function invalidateConnection(): void {
  cached = null;
}

export class VitalsCredentialMissingError extends Error {}

/**
 * Turn the stored reference into something callable, reading Settings → Credentials each time so a
 * rotated password is picked up without touching this record.
 *
 * Resolution is deliberately not scoped to the calling user: the admin who saved the reference made
 * the authorisation decision, and the background alert evaluator has no user at all. Choosing the
 * credential is gated instead — only an admin can reach the Connect routes.
 */
export async function resolveControl(): Promise<VitalsControlConfig | null> {
  const { control } = await readConnection();
  return control ? resolveControlRef(control) : null;
}

/**
 * Resolve any reference, saved or not. The Connect page's test button uses this on a candidate so an
 * operator finds out the login is wrong before committing to it.
 */
export function resolveControlRef(control: VitalsControlRef): VitalsControlConfig {
  if (control.kind === 'inline') return control;

  const website = getWebsite(control.websiteId);
  if (!website) {
    throw new VitalsCredentialMissingError(
      'The credential this control plane points at no longer exists in Settings → Credentials. Pick another one under Vitals → Connect.',
    );
  }

  const resolved = resolveCredentials({ websiteId: control.websiteId, userId: control.loginId });
  if (!resolved?.username || !resolved?.password) {
    throw new VitalsCredentialMissingError(
      `"${website.name}" has no usable login in Settings → Credentials. Add one there, or pick a different credential under Vitals → Connect.`,
    );
  }

  const baseUrl = (control.baseUrlOverride || resolved.baseUrl || website.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new VitalsCredentialMissingError(`"${website.name}" has no base URL. Set one in Settings → Credentials, or override it under Vitals → Connect.`);
  }
  return { baseUrl, username: resolved.username, password: resolved.password };
}

/** Everything the Connect page may see — secrets reduced to whether one is set. */
export function redactConnection(connection: VitalsConnection) {
  let databaseSummary: string | null = null;
  if (connection.databaseUrl) {
    try {
      const parsed = new URL(connection.databaseUrl);
      databaseSummary = `${parsed.protocol}//${parsed.username ? `${parsed.username}@` : ''}${parsed.host}${parsed.pathname}`;
    } catch {
      databaseSummary = '(unparseable connection string)';
    }
  }
  const control = connection.control;
  const credential = control?.kind === 'credential' ? getWebsite(control.websiteId) : null;

  return {
    database: { configured: Boolean(connection.databaseUrl), summary: databaseSummary, source: connection.source.database },
    control: {
      configured: Boolean(control),
      mode: control?.kind ?? null,
      // For a credential reference these describe where it points, never the secret behind it.
      websiteId: control?.kind === 'credential' ? control.websiteId : null,
      loginId: control?.kind === 'credential' ? control.loginId ?? null : null,
      credentialName: credential?.name ?? (control?.kind === 'credential' ? '(deleted credential)' : null),
      baseUrl: control?.kind === 'inline' ? control.baseUrl : control?.baseUrlOverride ?? credential?.baseUrl ?? null,
      username: control?.kind === 'inline' ? control.username : null,
      source: connection.source.control,
    },
    alerting: connection.alerting,
    sloTargetPct: connection.sloTargetPct,
    updatedAt: connection.updatedAt,
    updatedBy: connection.updatedBy,
  };
}
