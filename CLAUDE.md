# CLAUDE.md

Project instructions for Claude Code working in this repo.

## Non-negotiable coding rules (apply to me AND every spawned agent)

- **No hardcoding, anywhere.** Never hardcode app/product facts (names like admin/keystone/shockwave, URLs, ports, endpoints, selectors, field names, auth keys, module lists) in code, prompts, or understanding. Everything app-specific must be LEARNED from the connected repo/URL/OpenAPI at runtime. If you find hardcoding, remove it and route the value through the understanding/learning layer — never just report it.
- **Comments: precise and short.** One line where possible; no large multi-line comment blocks. Say why, not what. Match surrounding density.
- **Never commit and never push without explicit approval for that specific action.** Approval given for one commit does NOT carry to the next one. Leave finished work in the working tree for review via `git diff`. This applies to every agent, including autonomous/looping runs.

## Explaining results (applies to every answer, especially after research/code search)

After any deep code search, audit, forensic trace, or multi-agent research task, **do not dump the full findings as the answer.** Lead with a version I can read in under a minute:

1. **Verdict first** — 1-3 sentences. What is true, what it means for me. No preamble.
2. **One ASCII diagram** showing the flow, the chain, or the before/after. Use it whenever there is a sequence, a pipeline, a count that changes, or a decision tree.
3. **One concrete end-to-end example** with real values from the actual finding — walk one case all the way through. Not an abstract description of the mechanism.
4. **Then** the detail, clearly separated, so I can stop reading once I have what I need.

Rules for the summary:
- Answer the question I actually asked before adding anything else.
- If I ask "should I do X or not" — say yes or no in the first line, then explain. Never bury the recommendation.
- Full `file:line` evidence still belongs in the written deliverable (`docs/`), not in the chat answer. Chat = understanding; docs = record.
- Long output is fine in a file. In chat, brevity is the requirement, not a courtesy.

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
- `server/db/schema.sql` is the authoritative database schema. Every schema change must remain idempotent for both new and existing databases and must verify `scripts/setup-db.bat`; update the setup script in the same change whenever the schema path or application process changes.
- Commits/PRs must not mention Claude or add an AI co-author trailer.
- Backend runs as `tsx server.ts` (`dev:backend`) with NO watch/hot-reload. After ANY backend (`server/**`, `server.ts`) code change, the running backend must be RESTARTED to load it — otherwise the live app/Agent Console keeps executing stale code. Order: (1) `npm run lint` (tsc --noEmit) passes, (2) relevant tests pass, (3) THEN restart the backend. Never conclude a backend change "works live" against a backend process older than the edit.
