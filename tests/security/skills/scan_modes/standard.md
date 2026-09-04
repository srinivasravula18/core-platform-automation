# Scan mode: standard
> Routine assessment — balanced breadth and depth. The default for most engagements.

- Full recon and surface mapping before testing: endpoints, auth model, roles, inputs.
- Test all primary vulnerability classes across the mapped surface, with automated tools (nuclei/sqlmap-style) as force-multipliers, then hand-validate every hit.
- Chase multi-step and business-logic issues where recon suggests them.
- Iterate on promising leads to escalate impact, but stop once a clear high-impact PoC exists.
- Deduplicate; report validated findings with concrete evidence and remediation.
