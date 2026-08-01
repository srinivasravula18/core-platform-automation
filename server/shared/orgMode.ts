// Tag-native organization (default ON): tags — not folders — are the organizing axis across the app,
// including agent runs. Setting TAG_NATIVE_ORG=false restores the legacy mandatory-folder behavior
// (a rollback switch). Read lazily so .env loaded after imports still applies.
export function tagNativeOrgEnabled(): boolean {
  return String(process.env.TAG_NATIVE_ORG ?? 'true').trim().toLowerCase() !== 'false';
}
