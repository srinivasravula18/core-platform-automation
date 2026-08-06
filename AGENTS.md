# AGENTS.md

Project instructions for Codex/other coding agents working in this repo. (Mirrors `CLAUDE.md`, kept in sync — see that file for the Claude Code equivalent.)

## Non-negotiable coding rules (apply to me AND every spawned agent)

- **No hardcoding, anywhere.** Never hardcode app/product facts (product names, URLs, ports, endpoints, selectors, field names, auth keys, module lists) in code, prompts, or understanding. Everything app-specific must be LEARNED from the connected repo/URL/OpenAPI at runtime. If you find hardcoding, remove it and route the value through the understanding/learning layer — never just report it.
- **Comments: precise and short.** One line where possible; no large multi-line blocks. Say why, not what.
- **Never commit and never push without explicit approval for that specific action.** Approval given for one commit does NOT carry to the next one. Leave finished work in the working tree for review via `git diff`. This applies to every agent, including autonomous/looping runs.
- **Backend has no hot reload.** It runs as `tsx server.ts`. After ANY `server/**` or `server.ts` change the backend must be RESTARTED to load it. Order: (1) `npm run lint` (tsc --noEmit) passes, (2) relevant tests pass, (3) THEN restart. Never conclude a backend change "works live" against a process older than the edit.

## Explaining results (applies to every answer, especially after research/code search)

After any deep code search, audit, forensic trace, or multi-step research, **do not dump the full findings as the answer.** Lead with a version readable in under a minute:

1. **Verdict first** — 1-3 sentences. What is true, what it means. No preamble.
2. **One ASCII diagram** whenever there is a sequence, pipeline, changing count, or decision tree.
3. **One concrete end-to-end example** with real values from the actual finding — walk one case all the way through.
4. **Then** the detail, clearly separated, so the reader can stop once they have what they need.

If asked "should I do X or not", answer yes/no in the first line, then explain. Full `file:line` evidence belongs in the written deliverable under `docs/`, not the chat answer.

## Review disciplines

Apply the matching discipline whenever its trigger fits. Claude Code loads these automatically from `.claude/skills/<name>/SKILL.md`; other agents should follow the condensed rules below and may read the full file for detail.

**Universal rules for all of them:** cite `file:line` for every claim; inspect current code, never memory or docs; *"a mechanism exists"* is not a finding — *"the mechanism fired on this run"* is; if something cannot be determined from the code, write `DEFECT: unanswerable — <why>` rather than describing intended behavior; and always separate **built** from **live** (a subsystem that is flag-gated off, has zero callers, or runs shadow-only is not the current behavior).

### 1. `agent-pipeline-forensics` — debugging a pipeline run
Pick one real persisted run and justify the choice. Trace every stage boundary with **literal payloads** copied from the store, not descriptions. Build the count chain explicitly and name the single boundary where multiplication/loss happens. Classify each boundary `1:1` / `1:N` / `N:1` / decoupled. Check whether a traceable id survives each hop. Distinguish deliberate short-circuits from mislabelled failures. Prove the negative — where exactly was the missing thing lost.

### 2. `memory-canonicalization-audit` — any state/memory store
Per store ask: canonical or shadow? insert-only or versioned? what exactly enforces scope (quote the `WHERE`)? can two writers disagree? Hunt leaks on **every** read path: `OR col IS NULL` predicates, unscoped `SELECT *`, process-global caches keyed without owner, call sites that default the scope, wildcard/empty-owner buckets, stores keyed only by a guessable id. Distinguish raw-transcript re-read from extracted durable facts; a longer lookback is not memory.

### 3. `tool-call-safety-review` — new/changed tool or dispatch logic
Effect (`read`/`write`/`destructive`) must be **declared, never name-inferred**. Arguments must be schema-validated **before** dispatch. Capability re-checked **at dispatch**, not only when building the tool list. Write/destructive tools need deterministic re-read verification that **gates acceptance**, not merely informs the model. Terminal success must not be self-declared ("stopped calling tools" ≠ "succeeded"). Bound and disclose result truncation.

### 4. `prompt-injection-and-scope-audit` — prompts and personas
Trace the literal system string: does it route through the shared policy composer, or is it a standalone constant that skips injection/safety/scope policy? Can an override **replace** rather than layer onto the stack? Enumerate every untrusted channel (repo files, DB text, DOM, tool results, prior turns, uploads) and verify each is delimited and marked non-instructional. Secrets flow by reference only. Check the prompt does not contradict the agent's real tool permissions.

### 5. `agent-handoff-contract-check` — A's output becomes B's input
Structural schema match, then **semantic** match (same name for the same concept; same meaning per field), then **identity survival** (does a per-item id cross the boundary?), then **actual consumption** — grep the consumer for the field; a stage can be handed data it never reads. Where identity is missing, check whether anything reconstructs it positionally; positional reconstruction across a non-`1:1` boundary is always wrong.

### 6. `evidence-step-correspondence-check` — artifacts don't map to steps
Build the count chain with real numbers (source units → intermediate → runner calls → artifacts). The single non-`1:1` arrow is the whole answer. Check whether the UI maps by explicit id or **positional index**. Rule out retries, polling, before/after pairs (read the code, not stale comments), and harness-level extras before blaming the multiplier. Report semantic duplication too — N artifacts of one unchanged screen.

### 7. `concurrency-and-crash-safety-review` — dispatch, scheduling, shared state
Trace the exact line that starts work: awaited, fire-and-forget, or queued? Is there a concurrency cap? Two writers on one key: overwrite, version, or reject? Watch for per-item writes mirrored as **whole-key replace** — that silently discards all but the last. On crash: what is in-memory only, does the checkpoint hold payloads or just references, does work resume or fail? For multi-instance, check in order: boot-time reconcilers without ownership checks, per-process registries, in-memory DB mirrors, timers without leader election.

### 8. `eval-golden-set-runner` — before/after any prompt or pipeline change
Verify eval entry points resolve to real files before trusting a script list. Capture the baseline **before** changing anything. Report per-metric, never one aggregate; state sample size and the noise floor; name every regressed fixture with its diff. Prefer property assertions over golden strings wherever output has legitimate variation. Never estimate a score — if the suite did not run, there is no number.

### 9. `data-governance-check` — new store, PII field, or diligence prep
Is there a **single** deletion path per user/workspace? Does every table holding user content have an enforced owner FK with cascade (not a bare `owner_id TEXT`)? Is time-based retention being mistaken for erasure? Which routes actually write the audit log — and is there any read/access logging? What content egresses to third parties (prompts carry source code, DOM, records), and is it classified or redacted **outbound**, not just on the response?

### 10a. `phase-reviewer` (VICTOR) — independent gate on completed work
VP-level reviewer who accepts or rejects a finished phase. Claude Code loads this from `.claude/agents/phase-reviewer.md`; other agents should adopt the role directly. **Reviews only — never writes code.**

Verdict is exactly one of `APPROVED` / `APPROVED_WITH_FOLLOWUPS` / `REJECTED`; never a fourth, never an unlabelled hedge. Checks in order: (1) did it do what the plan said, and stay in scope; (2) **is it proven or merely claimed** — was the backend restarted before any live check, did the eval actually run, would a test fail without the fix; (3) is it correct — read the diff, not the summary, and look for this codebase's known failure modes (dual-writer divergence, null-column scope leaks, per-item writes mirrored as whole-key replaces, verification computed but not gating, positional zips across non-`1:1` boundaries, flag-gated code that is not live, newly hardcoded app facts); (4) does it hold up against current vendor/open-source best practice — web search allowed, cite what was consulted, and justify fit against this system's constraints rather than importing a pattern because it is popular; (5) which KPI moved, and by how much.

Reject unproven security or data-isolation fixes without exception. Cite `file:line` for every criticism. State precisely what would change the verdict.

### 10. `principal-engineer-review` — full architecture/production review
Umbrella. Analysis only by default; no code changes during review. Run dimensions in root-cause order: safety → data isolation → canonical state → topology → tool calling → agent dynamics → observability → evaluation → cost/reliability → governance. Take a position on every finding; include what is genuinely good and worth preserving. Name the 2-4 root causes that explain most individual findings. Remediation only when asked, phased, ordered by impact per unit of risk. Never promise 100% accuracy for an LLM system.

## Architecture-change process ("Principal Architect" mode)

When asked to redesign or overhaul a major subsystem (e.g. the Context & Evidence Pipeline, the orchestrator, the agent pipeline), follow this process. This was requested explicitly and applies to any future "act as Principal/Staff Architect" request.

### Phase 0 — Analysis only (default mode; never skip this)

- Do NOT modify files, create commits, refactor, generate patches/diffs, or implement anything during analysis.
- Inspect the actual current codebase (not memory/notes) before making any claim about behavior.
- Produce a single implementation-plan document covering:
  1. Executive Summary
  2. Existing Architecture
  3. Dependency Graph
  4. Runtime Flow
  5. Evidence Flow
  6. Context Flow
  7. Prompt Flow
  8. Current Problems
  9. Root Cause Analysis
  10. Proposed Architecture
  11. Complete Refactoring Strategy
  12. Every file that must change
  13. Why each file must change
  14. Risk level per file
  15. Backward compatibility concerns
  16. Migration strategy
  17. Testing strategy
  18. Rollback strategy
  19. Estimated implementation effort
  20. Recommended implementation order, as a phase checklist (Phase 1/2/3... with Files + Risk level each)
- Wait for explicit approval on a **later turn** before implementing. A single message that both asks for analysis and says "approved, now execute" is NOT sufficient approval — confirm scope first if the request is ambiguous.

### Phase 1+ — Implementation (only after explicit, separate approval)

- **Scope cap per phase: 10-15 files, OR one architectural subsystem — whichever is smaller.** If a phase would need more than that, stop after finishing the current subsystem and produce a fresh implementation plan for the rest instead of continuing in the same pass. Favor several small, independently verifiable refactors over one large one.
- Follow the approved plan exactly. Do not redesign beyond the approved scope.
- Preserve existing APIs unless a change is unavoidable; preserve existing business logic and agent behavior where possible.
- Implement one phase at a time. After each phase: verify compilation, run tests, fix errors, verify no regressions. Do not start the next phase until the current one is validated.
- Every change must: match existing conventions, preserve backward compatibility, minimize disruption, comment architecture-level changes, avoid unnecessary abstraction/duplication/dead code.
- Before considering any phase complete, verify: build succeeds, existing tests pass, no compile/type errors, no broken imports, no new circular dependencies, existing APIs/agents still work, DOM inspection still works, repo grounding still works, metadata still works, prompt/context assembly works with no silent truncation, validation gates work, Playwright generation uses verified evidence only.
- After each phase, report: summary of changes, files modified, reason per change, risks, validation performed, remaining work.
- At the end of all phases, produce a final production-readiness report.

## Autonomous phase loop (when running the remediation programme unattended)

The plan of record is `docs/plans/master-accuracy-remediation-plan-2026-08-01.md`. The durable state is `docs/plans/PHASE-PROGRESS.md` — **read it first, append after every phase.** Context compacts and sessions end; the ledger is the only thing that survives, so never rely on conversation memory to carry phase state.

Loop per phase: **VERIFY** the defect is real in current code (parallel specialists, `file:line`) → **IMPLEMENT** within scope (10-15 files or one subsystem) → **VALIDATE** lint, tests, then **restart the backend** → **PROVE** with the eval suite, or state honestly that it does not exist yet → **REVIEW** by the phase-reviewer, who returns one of the three verdicts → **RECORD** in the ledger → **ADVANCE** or rework.

`REJECTED` means fix and re-submit — it does not mean stop, and it does not mean skip. A phase may be re-attempted; a phase may not be silently abandoned.

**Hard stops — halt and wait for the human on any of these, and only these:**
1. An irreversible or destructive operation is required (schema migration with data loss, deleting user data, force-push, rewriting published history).
2. A security or data-isolation fix cannot be **proven** by a test that would fail without it.
3. The eval regresses beyond tolerance and two consecutive fix attempts fail.
4. The plan itself is wrong — the premise does not match current code — so continuing would build on a false foundation.

Everything else is decided and recorded, not escalated. Questions that need a human but do not block progress go in the ledger's open-questions section; the loop continues around them.

## Diagnostics on file

Forensic, code-cited reports already exist from prior sessions — read them before re-deriving the same facts:
- `docs/diagnostics/agent-run-incident-report-2026-07-10.md` — live end-to-end run trace of "Generate 2 test cases for the List View" against the real app; root-caused the DOM-grounding/evidence-loss chain.
- `docs/diagnostics/pipeline-runtime-forensics-2026-07-10.md` — static code trace of orchestrator/tool-loop/context-builder/prompt-assembly/provider-request layers, with file:line citations and every truncation point.
- `docs/diagnostics/context-evidence-pipeline-architecture-plan-2026-07-10.md` — analysis-only architecture review and phased implementation plan for the Context & Evidence Pipeline redesign (not yet approved/implemented).
- `docs/diagnostics/context-evidence-pipeline-change-classification-2026-07-10.md` — P0-P3 classification of every proposed change from that plan, with confirmed-issue mapping, risk, and effort per item.

## Working conventions

- Any change to the desktop Record & Play agent (`agent/`) must increment the agent version in `agent/package.json`, `agent/package-lock.json`, and `agent/src/version.ts` before building or publishing the agent bundle.
- Keep deliverable files (reports, diagnostics, plans) inside this repo (e.g. under `docs/`), not in the OS temp/scratchpad directory.
- `server/db/schema.sql` is the authoritative database schema. Every schema change must remain idempotent for both new and existing databases and must verify `scripts/setup-db.bat`; update the setup script in the same change whenever the schema path or application process changes.
- Do not publish reports/plans/diagnostics to any external hosted-artifact/preview service — keep everything as files in this repo only.
- Commits/PRs must not mention any AI tool by name or add an AI co-author trailer.
