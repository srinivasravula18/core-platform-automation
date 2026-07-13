# CLAUDE.md

Project instructions for Claude Code working in this repo.

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

## Diagnostics on file

Two forensic, code-cited reports already exist from prior sessions — read them before re-deriving the same facts:
- `docs/diagnostics/agent-run-incident-report-2026-07-10.md` — live end-to-end run trace of "Generate 2 test cases for the List View" against the real app; root-caused the DOM-grounding/evidence-loss chain.
- `docs/diagnostics/pipeline-runtime-forensics-2026-07-10.md` — static code trace of orchestrator/tool-loop/context-builder/prompt-assembly/provider-request layers, with file:line citations and every truncation point.

## Working conventions

- Keep deliverable files (reports, diagnostics, plans) inside this repo (e.g. under `docs/`), not in the OS temp/scratchpad directory.
- Commits/PRs must not mention Claude or add an AI co-author trailer.
- Backend runs as `tsx server.ts` (`dev:backend`) with NO watch/hot-reload. After ANY backend (`server/**`, `server.ts`) code change, the running backend must be RESTARTED to load it — otherwise the live app/Agent Console keeps executing stale code. Order: (1) `npm run lint` (tsc --noEmit) passes, (2) relevant tests pass, (3) THEN restart the backend. Never conclude a backend change "works live" against a backend process older than the edit.
