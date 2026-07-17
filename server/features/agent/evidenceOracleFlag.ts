/**
 * EVIDENCE_ORACLE_V1 — dark-launch flag for evidence-grounded bug finding.
 *
 * Off (default) = today's behavior byte-for-byte: assertion verbs are trusted 1:1 and observed DOM
 * state is not carried past grounding. On = observed element state (disabled/readonly/value/selected)
 * flows through to the compiler so state assertions can be validated against reality instead of guessed.
 * See docs/plans/evidence-grounded-bug-finding-plan.md. Follows the REMOTE_AGENT_V1 flag pattern.
 */
export function isEvidenceOracleEnabled(): boolean {
  const raw = String(process.env.EVIDENCE_ORACLE_V1 || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
