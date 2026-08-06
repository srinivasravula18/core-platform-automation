/** Per-case repair — permanently on. Re-grounds+re-authors on a partial compile instead of
 * abandoning dropped cases; bounded by MAX_REDISCOVERY_ATTEMPTS. Costs latency+tokens per retry. */
export function isPerCaseRepairEnabled(): boolean {
  return true;
}
