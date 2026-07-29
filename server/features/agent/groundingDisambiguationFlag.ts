/** GROUNDING_DISAMBIGUATION_V1 — on: a control that is NOT unique on the page by role+name (e.g. a per-row
 * "Edit"/"Delete" button, one per grid row) is rescued with a ROW-KEY-SCOPED locator
 * (`tr:has-text("<rowKey>") >> role=button[name="Edit"]`) — a genuinely unique locator, not a banned
 * `.first()` — instead of being demoted to non-executable "pool" evidence and dropped from the catalog.
 * This recovers cases that target repeated/row controls (a dominant cause of the cases→scripts skip).
 * Off (default) = legacy behavior byte-for-byte (non-unique controls are excluded). */
export function isGroundingDisambiguationEnabled(): boolean {
  const raw = String(process.env.GROUNDING_DISAMBIGUATION_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
