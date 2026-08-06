export const AUTOMATION_BROWSER_PERMISSIONS = ['geolocation', 'camera', 'microphone', 'notifications'] as const;
export type AutomationBrowserPermission = typeof AUTOMATION_BROWSER_PERMISSIONS[number];

export interface BrowserPermissionSettings {
  permissions: AutomationBrowserPermission[];
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  fakeMedia?: boolean;
  acceptDialogs?: boolean;
}

export function normalizeBrowserPermissionSettings(value: unknown): BrowserPermissionSettings {
  const input = value && typeof value === 'object' ? value as Record<string, any> : {};
  const allowed = new Set<string>(AUTOMATION_BROWSER_PERMISSIONS);
  const permissions = Array.from(new Set((Array.isArray(input.permissions) ? input.permissions : [])
    .map(String).filter((permission): permission is AutomationBrowserPermission => allowed.has(permission))));
  const latitude = Number(input.geolocation?.latitude);
  const longitude = Number(input.geolocation?.longitude);
  const accuracy = Number(input.geolocation?.accuracy);
  const geolocation = permissions.includes('geolocation')
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { latitude, longitude, ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}) }
    : undefined;
  return {
    permissions,
    ...(geolocation ? { geolocation } : {}),
    ...(input.fakeMedia === true && permissions.some((permission) => permission === 'camera' || permission === 'microphone') ? { fakeMedia: true } : {}),
    ...(input.acceptDialogs === true ? { acceptDialogs: true } : {}),
  };
}
