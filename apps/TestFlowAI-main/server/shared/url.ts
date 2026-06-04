import { db } from './storage';

export function normalizeTargetUrl(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function getUrlMatchKey(url: string) {
  const normalized = normalizeTargetUrl(url || '');
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return normalized.replace(/\/+$/, '').toLowerCase();
  }
}

export const domainPattern = /\b((?:https?:\/\/)?(?:(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?(?:\/[^\s]*)?)/i;

export function extractTargetUrl(message: string) {
  const match = String(message || '').match(domainPattern);
  if (!match) return '';
  return normalizeTargetUrl(match[1].replace(/[),.;!?]+$/, ''));
}

export function extractCredentials(message: string) {
  const text = message || '';
  const usernameMatch =
    text.match(/\b(?:username|user\s*name|user|login|id)\s*(?:is|:|=)?\s*([^\n,;]+?)(?=\s+(?:and\s+)?(?:password|pass|pwd)\b|[,;.]|$)/i);
  const passwordMatch =
    text.match(/\b(?:password|pass|pwd)\s*(?:is|:|=)?\s*([^\n,;]+?)(?=\s+(?:and\s+)?(?:username|user\s*name|user|login|id)\b|[,;.]|$)/i);

  return {
    username: usernameMatch?.[1]?.trim() || '',
    password: passwordMatch?.[1]?.trim() || '',
  };
}

export function buildCredentialContext(credentials: any) {
  if (!credentials?.username || !credentials?.password) {
    return 'No login credentials were provided.';
  }

  return `Use these exact login credentials when a login step is needed: username/email "${credentials.username}" and password "${credentials.password}". Generated test steps and Playwright scripts must explicitly fill these values instead of saying only "valid credentials".`;
}

export function findSettingsCredentials(targetUrl: string) {
  const targetKey = getUrlMatchKey(targetUrl);
  if (!targetKey) return { username: '', password: '', source: 'none' };

  const allCredentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const selectedCredentials = allCredentials.filter((item: any) => item?.isPlaywrightTarget);
  const searchSpace = selectedCredentials.length ? selectedCredentials : allCredentials;
  const match = searchSpace.find((item: any) => {
    const siteKey = getUrlMatchKey(item?.url || '');
    return siteKey && (targetKey === siteKey || targetKey.startsWith(siteKey) || siteKey.startsWith(targetKey));
  });

  return {
    username: match?.username?.trim?.() || '',
    password: match?.password?.trim?.() || '',
    source: match ? 'settings' : 'none',
  };
}

export function normalizeLookupText(value: string) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findSettingsSiteByName(message: string) {
  const normalizedMessage = ` ${normalizeLookupText(message)} `;
  if (!normalizedMessage.trim()) return null;

  const allCredentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const selectedCredentials = allCredentials.filter((item: any) => item?.isPlaywrightTarget);
  const searchSpace = selectedCredentials.length ? selectedCredentials : allCredentials;
  return searchSpace.find((item: any) => {
    const name = normalizeLookupText(item?.name || '');
    return name && normalizedMessage.includes(` ${name} `);
  }) || null;
}

export function findSettingsPlaywrightTargetUrl() {
  const credentials = Array.isArray(db.settings?.siteCredentials) ? db.settings.siteCredentials : [];
  const selected = credentials.filter((item: any) => item?.isPlaywrightTarget && item?.url);
  if (selected.length > 0) return normalizeTargetUrl(selected[0].url);

  if (credentials.length === 1 && credentials[0]?.url) {
    return normalizeTargetUrl(credentials[0].url);
  }

  return '';
}

export function resolveAgentTargetUrl(prompt: string, appUrl: string) {
  const explicitUrl = normalizeTargetUrl(appUrl || extractTargetUrl(prompt || '') || '');
  if (explicitUrl) return explicitUrl;

  const siteByName = findSettingsSiteByName(prompt || '');
  if (siteByName?.url) return normalizeTargetUrl(siteByName.url);

  return findSettingsPlaywrightTargetUrl();
}

export function resolveAgentCredentials(prompt: string, targetUrl: string) {
  const chatCredentials = extractCredentials(prompt || '');
  if (chatCredentials.username && chatCredentials.password) {
    return { ...chatCredentials, source: 'chat' };
  }

  const siteByName = findSettingsSiteByName(prompt || '');
  if (siteByName?.username && siteByName?.password) {
    return {
      username: String(siteByName.username || '').trim(),
      password: String(siteByName.password || '').trim(),
      source: 'settings-name',
      siteName: siteByName.name || '',
    };
  }

  return findSettingsCredentials(targetUrl);
}
