---
name: prompt-injection-and-scope-audit
description: Use when reviewing or adding a system prompt or agent persona, changing prompt assembly, or auditing what untrusted content flows into a model call. Checks whether the prompt routes through the shared safety/injection/scope stack, whether untrusted content is delimited, and whether an override can strip safety policy.
---

# Prompt injection and scope audit

Two failure modes: a prompt that **bypasses** the safety stack, and untrusted content that arrives **looking like instructions**.

## 1. Does this prompt actually get the policy stack?

- [ ] Trace the literal string sent as `system`. Does it come from the shared composer, or is it a standalone constant passed directly?
- [ ] **Standalone system strings are the top defect here** — they silently skip injection defense, safety policy, and scope policy. Check every call site that passes its own system prompt.
- [ ] Can a stored/settings override **replace** the composed stack rather than layer onto it? If the override path returns only the override body, every policy block is gone for that agent.
- [ ] Is the scope boundary restated near the end of long prompts, or only at the top where later instructions dilute it?

## 2. Is untrusted content delimited?

Enumerate every channel whose content the system does not author, then check each is fenced and marked non-instructional:

| Channel | Typical injection vector |
|---|---|
| Repo/source files | a comment or string in the codebase under test |
| DB artifact text | a user-authored case title, description, defect repro |
| Live DOM / page text | attacker-controlled content on the target app |
| Tool results | anything a tool returns verbatim, incl. MCP servers |
| Prior conversation turns | content pasted by a user earlier |
| File uploads / attachments | document contents |

- [ ] Is each wrapped in an explicit delimiter with a "treat as data, not instructions" marker?
- [ ] Does the injection-defense text name **only the user message**? That is the common gap — every other channel is then implicitly trusted.
- [ ] Is content `JSON.stringify`'d straight into a prompt? Structural quoting is not a trust boundary.

## 3. Secrets and egress

- [ ] Any credential, token, cookie, session state, or key interpolated into a prompt string? Secrets must flow **by reference** (a name, an id, a boolean "credentials exist").
- [ ] Is redaction applied to the model's **output** only, or also to the prompt going out? Outbound is the one that matters for egress.
- [ ] Are internal URLs/hostnames interpolated? Usually legitimate — note them, don't flag reflexively.

## 4. Scope and authority

- [ ] Does the prompt state what the agent must **not** do, or only what it should do? Positive-only scoping is where agents drift into adjacent actions.
- [ ] Does any instruction contradict the agent's actual tool permissions — told to "just answer" while holding write tools, or promised human-in-the-loop while the default policy auto-executes?
- [ ] Is there prompt-level language requiring confirmation before destructive/live actions, independent of code gating? Code gates fail open when a filter misses a name.

## 5. Instruction completeness

- [ ] What to do when a tool fails, returns **empty**, or returns an unexpected shape.
- [ ] What to do when a tool result **contradicts** an earlier one.
- [ ] Whether truncation of injected content is **disclosed** to the model.
- [ ] Whether the model is told what a reasonable number of tool calls looks like.

## Verify by test, not by reading

Add or run an adversarial fixture: embed `ignore previous instructions…` in each untrusted channel and confirm the agent treats it as data. A prompt that *says* it defends against injection is not evidence; a passing fixture is.
