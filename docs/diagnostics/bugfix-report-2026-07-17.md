# Bug-Fix Report — 16-Issue Sweep (2026-07-17)

All 16 reported bugs (Divya/santhosh/sai, 07/17) root-caused and fixed. Uncommitted. Lint (`tsc --noEmit`) clean; regression suites green (78 workflow-state, 21 conversation-memory, 20 truncation). Live-verified against the running app (frontend :3000 / backend :3001) via Playwright.

## Root causes (grouped by architectural flaw)

| Flaw | Bugs | Fix |
|---|---|---|
| Graph engine never persisted first-class QA rows (plan/suite/case/run/report only lived in `agent_runs` JSON) | 7, part of 4/5, and the REAL cause of 3 | Terminal-artifact persister injected into the workflow runtime (`registerTerminalArtifactPersister`); `save-cases` now materializes plan+suite BEFORE case upserts (`ensureAgentPlanAndSuite`) — previously cases hit `cases_test_plan_id_fkey`, the rejection was unhandled, and the HTTP response never returned (the "Save All spins forever" mechanism, reproduced live in the backend log) |
| Fetch-once pages, no invalidation | 4, 5 | `useDataVersion` zustand store + `invalidateData()`; TestRepository/TestCases refetch on data-version, visibilitychange, project/app change; GeneratedCases save falls back to `POST /api/cases` on missing id/404, surfaces errors, adopts returned id |
| Volatile client state killed by remount/overwrite | 10, 11 | `selectedAppIds` persisted per-workspace in localStorage with validation against loaded apps; load-token guard so stale/failed conversation loads can never wipe a live thread; full turn snapshots persisted (PUT body carries `turns`) |
| Unguarded async / loading states | 3, 8 | `fetchWithTimeout` + `res.ok` + inline error surfacing across every DeepRunResult action; `AbortSignal.timeout(15s)` on all core-platform metadata fetches + 120s phase deadline + terminal `skipped` emission + 15-min client stall guard (verified live: "metadata map unavailable … proceeding without metadata") |
| Truncation-blind AI parsing | 12 | All three providers throw a classified retryable error on `length`/`max_tokens` finish; balanced-brace JSON extractor rejects unterminated payloads (greedy regex removed); auto mode now enforces the complexity-derived case-count floor with the pad-up loop |
| No prescriptive coverage for object targets | 13 | Metadata-grounded OBJECT COVERAGE CONTRACT (CRUD/required-validation/negative-boundary/permissions/relationships) injected into the legacy case-writer prompt; equivalent evidence-grounded rule + count guidance added to the LangGraph authoring prompt. App-agnostic: all specifics come from live metadata |
| Requirement drafting had zero conversation threading | 15 | Client sends `conversationId`+history; server assembles stored-conversation context (`assembleConversationContext`) into the feature-analyst prompt as reference-resolution-only context |
| Blind fixed-slice history everywhere (memory) | 15, "agent forgets" | R1–R8 completion: understand-request, explain/stream, and requirement paths now reconstruct server-side (ledger + summary segments + budgeted turns), client history is fallback only |
| Naming from URL host at creation time | 6 | `buildContextualArtifactName` (application · module — scope) preferred at creation AND display; host fallback only when no context exists; `POST /api/cases` returns the generated id |
| UI layout/scroll defects | 9, 14, 16 | Folder-ask card extracted to memoized `FolderAskCard` with local draft state (no per-keystroke global re-render); flex-wrap + truncate + z-50; auto-scroll gated on "user near bottom" with `behavior:'auto'` during streaming |
| Missing features | 1, 2 | Multimodal `images` support in all three providers (+ orchestrator pass-through) with validation caps; attachments UI in both rework blocks; bulk multi-select rework in GeneratedCases (id-keyed, 4-way concurrency, partial-failure tolerant, aria-live progress) |

## Live verification (Playwright, admin/admin@2026)

- Memory: follow-up "what did we discuss earlier" correctly recalled prior 34-case thread — across a backend restart.
- App selection persisted across reload/new-chat (localStorage `tfa_selected_apps::<project>`).
- Chat restored fully after reload and restart; orphaned pre-restart run card degrades gracefully.
- Deep run end-to-end: router → understanding → FolderAskCard (typed custom folder, no jank) → graph stages → 2 correctly-scoped cases authored; Metadata chip resolved (timeout path exercised for real).
- Save All: button → "Saved" in seconds; `TC-8357-1/2` + `PLAN-83571704` + `SUITE-83571704` in Postgres with FK links; cases visible in /cases without manual refresh.

## Remaining technical debt

- Plan→suite→cases→run bundle is idempotent (deterministic ids + upserts) but not yet wrapped in one `withTransaction` (repository upserts would need an optional client param).
- R6 graph prior-evidence seeding (reuse of previous runs' evidence under the graph engine) — deferred; depends on the now-fixed artifact persistence.
- Run-completion should also fire the frontend `invalidateData()` (currently covered by visibilitychange/project-change refetch).
- `git stash` incident during the session: recovery verified edit-by-edit; safety copies remain at `stash@{0}` and `.testflow-pw/scratch/AgentConsole.tsx.pre-stashpop-backup` — drop after confirming.
