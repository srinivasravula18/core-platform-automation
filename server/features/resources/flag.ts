/**
 * RECYCLE_BIN_CASCADE — when off, deleting a plan/suite removes only that row (historic behaviour).
 * When on, it also removes the descendants it exclusively owns and detaches the shared ones.
 * The recycle bin itself is always available; only the cascade is gated.
 */
export function isRecycleBinCascadeEnabled(): boolean {
  const raw = String(process.env.RECYCLE_BIN_CASCADE ?? '1').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
