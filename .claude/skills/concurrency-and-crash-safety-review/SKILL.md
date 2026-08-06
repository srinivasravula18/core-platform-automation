---
name: concurrency-and-crash-safety-review
description: Use when reviewing run dispatch, job scheduling, background work, or any code path where multiple requests, processes, or server instances could touch shared state. Also use before scaling to more than one instance. Checks concurrency caps, ownership/locking, crash recovery, and what breaks first horizontally.
---

# Concurrency and crash-safety review

Three questions: **how many can run at once, what happens when two touch the same thing, and what survives a crash.**

## 1. Dispatch shape

- [ ] Trace the exact line that starts the work after the request is accepted. Is it awaited, fire-and-forget, queued, or scheduled?
- [ ] A bare unawaited promise means: no backpressure, no retry, no visibility, and errors swallowed by whatever `.catch` is attached.
- [ ] Is the response sent **before** the work starts? If so, any guard that runs after the response cannot protect that request — only the next one.

## 2. Concurrency bound

- [ ] Is there a semaphore, pool, queue, or max-concurrent cap? If none, N users = N concurrent workloads on one process.
- [ ] Are expensive side resources (browsers, subprocesses, model calls) bounded separately from request concurrency?
- [ ] Is there per-user or per-tenant fairness, or can one caller starve everyone?
- [ ] Duplicate-submit protection: is it a **lock** or a content-equality heuristic? A heuristic loses to a race and to any input variation.

## 3. Shared-state safety

- [ ] Two writers on the same row/key: overwrite, version, or reject? Whole-row last-writer-wins silently drops the other writer's changes.
- [ ] Is there optimistic concurrency (version/etag) or an advisory lock on the hot path?
- [ ] Partial-update semantics: does a per-item write get mirrored as a **whole-key replace**? That pattern silently discards every item but the last — check any stash/mirror/sync layer for it.
- [ ] Is ownership of in-flight work represented anywhere, or is it implied by "whoever started it"?

## 4. Crash recovery

- [ ] What state is in-memory only at the moment of a crash? Enumerate it.
- [ ] Does the checkpoint hold **payloads or references**? References to artifacts that lived only in the dead process's memory make the checkpoint unusable for resume.
- [ ] On restart, does in-flight work resume, fail, or hang? A reconciler that marks everything failed is a deliberate choice — confirm it is deliberate.
- [ ] Is the failure visible to the user, or does the run just stop?

## 5. Multi-instance readiness (ask even if single-instance today)

Walk these in order; the first one that breaks is the answer:

- [ ] **Boot-time reconcilers** — does startup mutate shared state without an ownership or staleness check? A second instance booting can then kill the first's live work. This is usually the worst one.
- [ ] **Per-process registries/maps** — cancel, resume, and "is it running" checks that consult local memory return wrong answers cross-instance. Resume in particular can start a **second** worker on the same job.
- [ ] **In-memory collections mirroring the DB** — divergent copies, and any guard reading them is blind to the other instance.
- [ ] **Schedulers/timers** — `setInterval` with no leader election fires once per instance, duplicating every scheduled job.
- [ ] **Caches** — process-local caches keyed without a tenant, or that silently diverge.

## Report

State plainly: current concurrency bound (or "unbounded"), what is lost on crash, and **the specific first thing that breaks** on a second instance. Vague ("would need work") is not an answer — name the file and the mechanism.
