---
name: memory-canonicalization-audit
description: Use when auditing or changing any state/memory store — cross-session persistence, conversation history, scope and permission boundaries, or when two stores might hold the same fact. Also use when a user reports "it forgot what I told it" or "it remembered the wrong thing". Checks canonical-vs-shadow, versioning, scope enforcement, and writer divergence.
---

# Memory canonicalization audit

One question drives everything: **for each fact, is there exactly one place that owns it?**

## The four questions — ask per store

1. **Canonical or shadow?** Is this the authoritative store for this fact, or a copy? If a copy, what keeps it in sync, and what happens when sync fails silently?
2. **Insert-only or versioned?** Insert-only + no invalidation means contradictions accumulate forever and a stale row can win a later read.
3. **What exactly enforces scope?** Quote the `WHERE` clause. Scope filtered in application code *after* a broad fetch is a leak waiting for a code path that forgets to filter.
4. **Can two writers disagree?** If two paths write the same logical fact under different keys or to different tables, they will drift. Find the read that picks between them and check its tie-break rule.

## Read-path leak hunt (do this exhaustively, not on the obvious path)

- [ ] Any `OR <col> IS NULL` in a scope predicate → every null-owner row matches **every** user.
- [ ] Any unscoped `SELECT *` reachable from live code — traces, debug endpoints, exports, admin views.
- [ ] Process-global caches/singletons keyed without the owner.
- [ ] Call sites that omit or default the scope argument — check that owner/project/app are threaded from the authenticated request, not defaulted.
- [ ] Wildcard/empty-owner fallbacks that collapse distinct users into one shared bucket.
- [ ] Stores keyed only by a guessable id (conversation, thread, run) with no ownership check → IDOR.

## Cross-session behavior

- Does the store carry a conversation/thread id? If yes, it **cannot** serve cross-session recall — say so plainly rather than calling it "memory".
- Distinguish **raw transcript re-read** from **extracted durable facts**. A longer lookback window is not memory.
- Is there a promotion step from session → durable? If none exists, say so; that absence is usually the whole finding.
- What is the recall trigger — every request, keyword, semantic, or only when explicitly asked?
- Retrieval ranking: can an older superseded fact outrank its own correction? Check the score weights.
- TTL: per-fact-type and justified, or a blanket sweep that drops still-valid facts?

## Contradiction handling

Trace one fact saved twice with different values, then recalled. Report literally what recall returns — both rows, newest, or highest-scoring. If both can reach a prompt simultaneously, that is a defect regardless of how the model handles it.

## Failure and control

- [ ] Store unavailable → does the request fail loudly or silently proceed without memory? Silent degradation with no signal means the user cannot distinguish "recall failed" from "nothing stored".
- [ ] Is there any user-visible signal that memory was used?
- [ ] Can a user or admin **view, correct, or delete** what is stored? A write-only memory that can be poisoned and never inspected is a defect, not a feature.

## Report

Table per store: scope key · canonical? · versioned? · survives restart? · cross-session? · leak risk. Then the ranked defects. Never conclude "memory works" from the existence of a store — trace one fact end to end.
