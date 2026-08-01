---
name: agent-handoff-contract-check
description: Use when one agent's or stage's output becomes another's input — adding a pipeline stage, changing a shared schema, or debugging why a downstream agent misinterpreted upstream content. Checks schema match, terminology drift, identity survival, and whether the receiver actually consumes what it is given.
---

# Agent handoff contract check

A handoff can pass schema validation and still be broken. Check four things, in this order.

## 1. Structural match

- [ ] Does the producer's output schema match what the consumer parses? Validate both sides against the same definition, not by eye.
- [ ] Are optional fields the consumer depends on actually populated in practice? Check a real payload, not the type.
- [ ] What happens on a partial/failed upstream — does the consumer receive an error, an empty value, or a **silently defaulted** one? Empty-string defaults are silent degradation: the consumer proceeds at full confidence with less information.

## 2. Semantic match (the one schemas cannot catch)

- [ ] Do both sides use the **same name for the same concept**? Multiple naming schemes for the same actor or field is a real, common defect — a receiver can mismap content that validates perfectly.
- [ ] Does a field mean the same thing on both sides? (`verified` meaning "schema-valid" upstream and "confirmed against reality" downstream is a silent correctness bug.)
- [ ] Are enum values interpreted identically, or does the consumer widen/narrow them?

## 3. Identity survival

- [ ] Does a per-item id (source step, case id, request id, run id) survive the boundary?
- [ ] If not, name the exact line that drops it and state the downstream cost — usually "results can no longer be attributed to their cause", which surfaces later as index-zipped mis-attribution.
- [ ] Where identity is missing, check whether any consumer **reconstructs it positionally**. Positional reconstruction across a non-1:1 boundary is always wrong; quantify how many items are mis-attributed.

## 4. Actual consumption

- [ ] **Grep the consumer for the field.** A stage can be handed data it never reads — check the options object it builds, not the signature it accepts.
- [ ] If the consumer ignores it, either the handoff is dead weight or a feature is silently not working. Decide which and say so.

## Prompt-mediated handoffs

When the "contract" is a prompt block rather than a typed payload:
- [ ] Is the block's absence distinguishable from its emptiness? An absent block that renders as `''` gives the receiver no signal that grounding is degraded.
- [ ] Is the block truncated, and is the truncation disclosed?
- [ ] Is the receiver instructed how to treat it — authoritative, advisory, or unverified?

## Raw vs mediated

Note which pattern each handoff uses:
- **Raw passthrough** — one agent's free text concatenated into another's prompt. Fast, but carries hallucinations and injection forward verbatim.
- **Mediated** — structured fact written to a shared store, read back by key with provenance.

Both are legitimate; a system should know which it is using where. Raw passthrough of a *critique* or *evidence claim* deserves particular scrutiny.
