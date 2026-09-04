# Scan mode: deep
> Thorough, adversarial assessment — assume a determined attacker with time.

- Exhaustive recon: enumerate every endpoint, parameter, role, and state; map the full attack surface before concluding.
- Test every primary class AND the second tier: XXE, RCE, deserialization, prototype pollution, cache/host-header, CSRF, race conditions.
- Chain vulnerabilities: use one finding (e.g. SSRF) to reach deeper impact (metadata → credentials → lateral movement) within scope.
- Iterate persistently — expect many steps; do not give up on a promising lead after one failed payload.
- Mine parameters, fuzz inputs, and revisit surfaces recon flagged as complex.
- Still: only demonstrated, reproduced impact counts as a finding.
