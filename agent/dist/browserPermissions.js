export function normalizeBrowserPermissionSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const allowed = new Set(['geolocation', 'camera', 'microphone', 'notifications']);
    const permissions = Array.from(new Set((Array.isArray(input.permissions) ? input.permissions : [])
        .map(String).filter((permission) => allowed.has(permission))));
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
export function browserPermissionPrelude(settings, appUrl) {
    if (!settings.permissions.length && !settings.acceptDialogs)
        return '';
    let origin = '';
    try {
        origin = new URL(appUrl).origin;
    }
    catch { /* grant for the isolated context below */ }
    const grant = settings.permissions.length
        ? `await context.grantPermissions(${JSON.stringify(settings.permissions)}${origin ? `, { origin: ${JSON.stringify(origin)} }` : ''});`
        : '';
    const dialogs = settings.acceptDialogs ? `page.on('dialog', (dialog) => { void dialog.accept().catch(() => {}); });` : '';
    return `import { test as __testflowBrowserSetup } from 'playwright/test';\n__testflowBrowserSetup.beforeEach(async ({ context, page }) => { ${grant} ${dialogs} });\n`;
}
//# sourceMappingURL=browserPermissions.js.map