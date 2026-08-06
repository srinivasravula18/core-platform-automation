---
name: tool-call-safety-review
description: Use when adding a new agent tool, changing a tool's arguments or effects, reviewing tool-calling dispatch/loop logic, or auditing whether write and destructive tools are actually gated and verified. Checks declared-not-inferred capability, pre-dispatch argument validation, and whether mutation verification gates acceptance.
---

# Tool-call safety review

Every tool the model can call is an action surface. This review answers one question per tool: **can this execute something the user did not authorize, or report success it did not achieve?**

## The three rules

1. **Effect is declared, never inferred.** A tool must state `read` / `write` / `destructive` explicitly. Inferring effect from the tool *name* means a mutating tool with a benign name silently escapes both the destructive filter and write-verification.
2. **Validate before dispatch.** Arguments come from the model and must be checked against the tool's own schema *before* `execute` runs — not re-validated ad hoc inside each tool body.
3. **Verification must gate, not inform.** Deterministic re-read of the real system after a write is only worth having if a failed re-read forces rejection. Feeding the failure back to the model as a suggestion is not enforcement.

## Checklist — new or changed tool

- [ ] `capability.effect` declared explicitly; `permissions` listed if the action needs them.
- [ ] Argument schema is complete and constrained (enums where the value set is closed; required fields marked). Assume every argument is adversarial — it is model-authored.
- [ ] The tool body does not re-implement authorization. Scope (owner/project/app) is enforced in the **query**, not filtered in application code after a broad fetch.
- [ ] No app/product facts hardcoded — URLs, ports, endpoints, field names, credentials, auth routes. These must come from the learned understanding / credential-resolution layer. (Project rule; see `CLAUDE.md`.)
- [ ] Secrets flow **by reference**, never interpolated into a prompt, a tool description, or a returned payload.
- [ ] The description tells the model **when to use it and when not to** — not just what it does. Vague descriptions are the top cause of wrong-tool selection.
- [ ] Return shape follows one convention (throw vs `{ok:false, error}`) consistent with sibling tools.
- [ ] Result size is bounded, and truncation is **disclosed** in the payload — an undisclosed cut lets the model read partial data as complete.
- [ ] If the effect is `write` or `destructive`: a deterministic re-read verification exists, is wired for this tool, and its failure is consequential.
- [ ] Name does not collide with an existing tool in any registry that could be merged.

## Checklist — dispatch loop audit

- [ ] Unknown tool name → structured error returned to the model with recovery guidance (not a crash, not a silent no-op).
- [ ] Capability/permission re-checked **at dispatch**, not only when building the tool list. Visibility filtering alone means any tool that reaches the loop can execute its full effect.
- [ ] Loop pathology guards exist: repeated identical calls, consecutive failures, step ceiling, token/cost budget — each with a defined fallback at the cap.
- [ ] The terminal success flag is not self-declared. "The model stopped calling tools" must not equal "the task succeeded."
- [ ] Empty and unexpected-shape results have handling guidance, not just error results.
- [ ] Tool exposure is filtered per request where the catalog is large — sending every schema on every turn is both a cost and a selection-accuracy problem.
- [ ] Independent read calls in one round can run concurrently; writes stay serial and verified.

## Red flags (stop and report)

- Effect determined by a regex over the tool name.
- `permissions`/`capability` optional in the tool type.
- Verification result computed and then only logged or passed to the model.
- A write tool whose success is inferred from the absence of a thrown error.
- Interpreters, shells, package runners, or arbitrary-URL fetchers exposed as tools without an explicit, reviewed justification.
- A tool that both reads sensitive data and can send data outbound, with no mediation between them.

See `references/verification-patterns.md` for what a sound re-read verification looks like per mutation type.
