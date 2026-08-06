---
name: data-governance-check
description: Use when adding a data store or a field that could hold user content or PII, reviewing whether user data can be fully deleted or exported, preparing for a security questionnaire or due diligence, or auditing what leaves to third parties. Checks deletion path, ownership FKs, audit coverage, and egress classification.
---

# Data governance check

Answer as if a customer's security team is reading it, because eventually one will.

## 1. Deletion — "delete all our data"

- [ ] Is there a **single** deletion path per user and per workspace, or would erasure be a manual table-by-table exercise?
- [ ] Does every table holding user content have an **enforced owner FK** with cascade — not a bare `owner_id TEXT` with no reference? Without the FK, deleting a user orphans their data and you cannot even locate the rows.
- [ ] Are soft-delete and hard-delete used consistently? Mixed semantics mean "deleted" data is still present in some stores.
- [ ] Is time-based retention being mistaken for erasure? A TTL sweep is not a deletion path — it cannot answer a specific subject request.
- [ ] Derived stores count: memories, embeddings, traces, artifacts, summaries, caches, logs. Enumerate every one that holds user content.

**Report the honest answer.** "We would need to build that" is a legitimate finding and far better than an untested claim.

## 2. Export

- [ ] Can a customer's data be exported in a usable form?
- [ ] Does the export cover the same store list as the deletion path? A mismatch means one of the two is wrong.

## 3. Audit log

- [ ] Does an audit trail exist, and **which routes actually write to it**? Infrastructure existing is not coverage — grep the writer and list the call sites.
- [ ] Are agent-initiated mutations logged, or only human-initiated ones?
- [ ] Is there any **read/access** logging, or mutations only? Most questionnaires ask who *accessed* data, not just who changed it.
- [ ] Does each entry carry actor, action, entity, timestamp, and scope?

## 4. Third-party egress

- [ ] Enumerate what leaves your infrastructure and to whom. For LLM systems this includes prompt content: source code, DOM captures, database records, user-authored text.
- [ ] Is anything **classified by sensitivity** before it egresses, or is all content treated identically?
- [ ] Is redaction applied to the outbound prompt, or only to the model's response? Output-only redaction does nothing for egress.
- [ ] Is the egress inventory documented anywhere a legal/security team could review — or does it exist only as code?
- [ ] Are prompts also copied into internal traces/logs? That is a second copy of the same sensitive content with its own retention and access story.

## 5. Reproducibility and provenance

- [ ] Can you reconstruct which prompt version, which **served** model version, and which code build produced a given historical output?
- [ ] Is there a join key from usage/cost records back to the originating run?
- [ ] Are records stamped with the id that was *sent* or the one the provider *served*? Only the served id detects a silent provider-side change.

## 6. Regulated data

- [ ] If a customer's connected system could contain health, financial, or personal data, is there any classification or handling policy — or is all data handled identically?
- [ ] Is there a documented data-residency position?

## Report format

One row per store: holds user content? · owner FK? · in deletion path? · in export? · audited? · egresses where? Then the ranked gaps, with the diligence-blocking ones named explicitly.
