# Research Findings — Code-Level Audit + Architecture Review

**Repository:** `core-platform-automation` (TestFlowAI)
**Date:** 2026-07-04 (deep pass)
**Method:** This is a second, deeper pass that goes *into* the running code — typecheck, subprocess
handling, auth wiring, crypto, persistence, dead code — not just structure. Every finding was
reproduced against the working tree; the command or file:line that proves it is cited. Severity is
my own estimate; confidence is stated where it matters.

> How this differs from the first pass: the first pass judged the architecture (still valid,
> summarized in Part B). This pass found **concrete, fixable defects** — a red quality gate, a
> missing dependency, an unenforced auth guard, non-atomic writes, and stale dead code — plus it
> **corrects** two things the earlier review and the internal docs got wrong.

---

## Status — fixes applied 2026-07-04

Quick-win and low-risk findings have been fixed in the working tree; `npm run lint` now passes
clean (exit 0), where before it failed with 4 errors.

| Finding | Action taken | Verified |
|---|---|---|
| A1 tsconfig scope | Added `"mcp-servers"` to `tsconfig.json` `exclude` | lint green |
| A2 missing dep | `npm install` restored `@vscode/ripgrep` (`require.resolve` → RESOLVED) | lint green + runtime resolve |
| A4 non-atomic writes | `savePersistedData`/`savePersistedSettings` now temp-write + `fs.rename`, serialized per file (`storage.ts`) | lint |
| A5 execSync | `corePlatformMeta.ts:358` → arg-array `spawnSync` (no shell) | lint |
| A6 cred key | `encKey()` now throws in production when `CRED_ENC_KEY` unset (`credentialsService.ts`) | lint |
| A7 dead code | Removed `{false && ...}` block from `Reports.tsx` | lint |
| A3 auth gate | Global `apiAuthGate` — every `/api/*` requires auth except `health`, `app-config`, `auth/login`, `screenshot` (`<img>` can't send a bearer). Wired after `authContextMiddleware` in `apps/api/src/server.ts` | 9/9 gate unit tests + lint |
| F8 hygiene | `.gitignore` now covers `evidences/`, `output/`, `.runtime/`, `*.tmp-*` | — |

**Residual after A3:** `/api/screenshot` stays unauthenticated (consumed by `<img>` tags) and also
takes an arbitrary `url=` — a pre-existing SSRF surface tracked separately; A3 does not worsen it.
A hardening follow-up would sign screenshot URLs or route them through `/evidence` static.

**Not yet applied (architecture-scale, some need a product decision):** B1–B6.

---

# Part A — Code-level findings (this pass)

## A1 — 🔴 The only quality gate (`npm run lint`) is currently RED

`npm run lint` is `tsc --noEmit` (`package.json:28`) — the single CI/quality gate. It **fails today**
with 4 errors:

```
mcp-servers/core-platform-db/index.ts(1,24): Cannot find module '@modelcontextprotocol/sdk/server/index.js'
mcp-servers/core-platform-db/index.ts(2,38): Cannot find module '@modelcontextprotocol/sdk/server/stdio.js'
mcp-servers/core-platform-db/index.ts(3,63): Cannot find module '@modelcontextprotocol/sdk/types.js'
server/features/git-agent/gitAgentService.ts(5,24): Cannot find module '@vscode/ripgrep'
```

Two distinct root causes:

1. **tsconfig scope bug (3 errors).** `mcp-servers/core-platform-db` is a *separate npm package*
   with its own `package.json` (declares `@modelcontextprotocol/sdk`) and its own `tsc` build. The
   root `tsconfig.json` excludes `architecture-import` but **not** `mcp-servers` (`tsconfig.json:26-31`),
   so the root typecheck tries to compile a sub-package whose deps live elsewhere.
   **Fix:** add `"mcp-servers"` to the `exclude` array. One line.

2. **Missing installed dependency (1 error).** See A2.

**Impact:** any "lint must pass" gate (the redesign plan's Definition of Done requires it) is
currently unmeetable. Nobody can tell a real new type error from this standing noise.

---

## A2 — 🔴 `@vscode/ripgrep` is declared but not installed → git-agent import fails at runtime

- Declared in `package.json:37` (`"@vscode/ripgrep": "^1.18.0"`).
- **Not resolvable** — verified two ways:
  - `Test-Path node_modules\@vscode\ripgrep` → `False`
  - `node -e "require.resolve('@vscode/ripgrep')"` → `MODULE_NOT_FOUND`
- It is a **static top-level import** at `server/features/git-agent/gitAgentService.ts:5`
  (`import { rgPath } from '@vscode/ripgrep';`), and that module is loaded at server startup via
  `registerGitAgentRoutes`. A static import of a missing module throws at load — so from the
  current tree, `npm run dev:backend` (`tsx server.ts`) will crash on boot, and the esbuild bundle
  uses `--packages=external` (`package.json:15`) so `dist/server.cjs` would `require()`-fail the same way.

**Nuance (stated honestly):** because it's declared in `package.json`, a clean `npm install`
*should* restore it — the current tree is in a partial/corrupted install state. But it is broken
**right now**, and the fact that the declared dep went missing is worth understanding (was it
pruned? did an install fail silently?).
**Fix:** `npm install` to restore; if it keeps disappearing, pin it and check for a conflicting
prune step. Consider making the import lazy/guarded since the code at
`gitAgentService.ts:632` *already has a git-grep fallback path* — the hard import defeats the
graceful fallback the author intended.

---

## A3 — 🟠 `requireAuth` is defined but never guards any data route

- `requireAuth` exists (`server/features/auth/routes.ts:53`) but is referenced **exactly once** —
  its own definition (grep for `requireAuth` across `server/` = 1 hit).
- Only `requireAdmin` is applied, and only to `/api/users*` (`auth/routes.ts:94,98,109`).
- Data routes — `/api/requirements`, `/api/cases`, `/api/playwright/run`, etc. — are registered
  with no auth middleware (`apps/api/src/server.ts:85-100`). `authContextMiddleware` only *attaches*
  the user or `null` (`auth/routes.ts:48-51`); it does not reject.
- Unauthenticated requests resolve to `userId: '', role: ''` in the scope layer
  (`server/shared/scope.ts:39-40`), which collides with the `ownerId === ''` "legacy/admin" bucket
  (`credentialsService.ts:78` documents `'' = legacy/admin`). So an anonymous caller can read the
  legacy/admin-owned slice of data.

**Confidence/caveat:** this may be an intentional local-first, single-user design (the app is
self-hosted and the docs describe one Admin user). It is **not** a critical vuln for `localhost`.
But the moment this is exposed beyond one trusted machine — which the redesign plan's multi-user /
hosted direction implies — it is an authentication bypass on all business data.
**Fix:** apply `requireAuth` at the router level for all `/api/*` except `/api/auth/login`,
`/api/health`, `/api/app-config`. The function is already written; it just isn't wired.

---

## A4 — 🟠 Non-atomic JSON persistence can corrupt the entire datastore

- `savePersistedData` writes the whole DB with a single `fs.writeFile(dataFilePath, JSON.stringify(...))`
  (`server/shared/storage.ts:153`) — no temp-file-then-rename.
- `persistDataInBackground` is fire-and-forget with no write serialization
  (`storage.ts:179-183`), so concurrent mutations can interleave writes.

**Impact:** in JSON mode (the default when `DATABASE_URL` is unset — `.env.example:23-25`), a crash
or overlapping write mid-serialization truncates `.testflow-data.json`, which is the *entire* source
of truth. There is a `.bak-project-cleanup` snapshot but no rolling atomic guarantee.
**Fix (either):** write to `*.tmp` then `fs.rename` (atomic on same volume) and serialize writes
through a promise chain; **or** — better — make Postgres the only write path (see B2). This finding
is the concrete teeth behind the earlier "go Postgres-only" recommendation.

---

## A5 — 🟡 `execSync` with an interpolated shell string (inconsistent + injection-shaped)

`server/ai/tools/corePlatformMeta.ts:358` builds a shell command by string interpolation:

```ts
execSync(`git -C "${repoPath}" grep -rl "app\\.get\|..." -- "*.ts"`, { ... })
```

`repoPath` comes from `process.env.TARGET_REPO_PATH` (`:352`), so this is **not** attacker-facing
today — but it's the one place that breaks the codebase's own safe pattern. Everywhere else uses
`spawnSync('git', [args...])` with an argument array (`gitAgentService.ts:58`, `localRepo.ts:46,213`,
`playwright/routes.ts:62`), which cannot be shell-injected. A path with a space or shell
metacharacter also just breaks this call.
**Fix:** convert to `spawnSync('git', ['-C', repoPath, 'grep', ...])` like its siblings.

---

## A6 — 🟡 Credential encryption silently downgrades to a derivable key in production

`encKey()` (`credentialsService.ts:36-49`) derives from `CRED_ENC_KEY` if set; otherwise it warns
once and derives a key from `CRED_ENC_FALLBACK_KEY || ''` (`:47`). The crypto itself is correct
(AES-256-GCM, per-value IV, auth tag — `:51-68`), but with no real key the "encrypted" website
passwords are protected by a key anyone can reproduce.

There is **no hard failure in production**: `.env.example:11` says "A derived dev key is used if
unset." So a prod deploy that forgets `CRED_ENC_KEY` stores credentials under an effectively-public
key and never errors.
**Fix:** refuse to encrypt/refuse to boot when `DEPLOYMENT_MODE=production` and `CRED_ENC_KEY` is
unset. Fail loud, not silent. (Same "loud failure over silent green" principle the verifier already
follows elsewhere.)

---

## A7 — 🟢 Dead code the redesign plan said to remove is still present

The redesign plan (Phase 1) explicitly lists "Remove dead code at `Reports.tsx:638`." It's still
there, now at `src/pages/Reports.tsx:766`: `{false && activeStep && (` — an always-false render
branch. Grep confirms it's the only such block left in `src/`.
**Fix:** delete the block. Trivial, and it's a named DoD item.

---

## A8 — ✅ Corrections: things the docs/earlier review got WRONG (record so they aren't re-raised)

1. **`alert()`/`confirm()` are already gone.** The redesign plan wants them removed; grep finds the
   only occurrences are in the *doc comment* of `src/lib/dialog.tsx:4` describing the in-app
   replacement (`showAlert`/`showConfirm`, a zustand-backed dialog host). This DoD item is **done** —
   the plan and my first pass both imply it's outstanding.
2. **Skip-heavy false-green is fixed** — `assessExecution` fails runs where `failed===0 && passed===0`
   (`server/ai/verifier.ts:132-137`). The accuracy doc's "known leaks" list is stale.
3. **Grounding leniency is partially hardened** — sub-0.5 ratios flag `severity:'weak'`
   (`verifier.ts:105-114`), a documented trade-off, not an oversight.
4. **Defects DO carry `linked_case_id`/`linked_run_id`** at the schema level
   (`server/db/repository.ts:882`) — but `src/pages/Defects.tsx` never reads/writes them, so the
   link is invisible in the UI. Earlier claim "chain stops at cases" was wrong for the data model,
   right for the UI. (Feeds B4.)

---

## A9 — ✅ Verified-correct, do NOT "fix"

- **App-user passwords:** scrypt `salt:hash` with `timingSafeEqual` (`userStore.ts:35-48`). Correct.
- **Website credentials:** AES-256-GCM, per-value 12-byte IV, auth tag (`credentialsService.ts:51-68`). Correct.
- **Lazy crypto-key derivation** with a documented reason (dotenv loads after imports) — correct and non-obvious (`credentialsService.ts:30-49`).
- **Playwright codegen** is gated to localhost/non-production (`playwright/routes.ts:47-51`). Good.
- **Subprocess safety** — every subprocess except A5 uses arg-array `spawnSync`/`spawn`. Good.
- **Playwright run kill-switch** — SIGKILL timeout + per-run child registry for user "Stop"
  (`executionService.ts:277-285`). Good.

---

# Part B — Architecture findings (carried from the first pass, still valid)

Condensed; full reasoning was in the prior version. All re-confirmed this pass.

**B1 — UI surface duplication.** Three organizational surfaces over the same case inventory
(File System `/repository`, Test Plans `/plans`, Test Suites `/suites` — `src/App.tsx:44-46`) and
two agent chat surfaces (AgentConsole `/`,`/agent` + AgentPanel `/studio` — `App.tsx:37,369-371`).
Consolidate around a **Requirements → Cases → Runs → Traceability + Inbox + one console** spine;
every page cut is a page that doesn't need the approval-state/confidence/activity retrofit.

**B2 — `services/` migration is unenforced scaffolding.** 25 dirs / 441 lines of one-line
re-exports vs 26,211 lines in `server/`; no import-boundary lint rule. Finish one vertical
(`requirements`) *or* freeze it. Evict `architecture-import/` (168 files committed) to a branch.

**B3 — Dual JSON/Postgres persistence** — 96 `isPgEnabled()` branch points; A4 is its concrete
failure mode. Go Postgres-only before the approval state machine lands.

**B4 — Traceability is structural, not temporal, and shallower in UI than in data.** Matrix renders
requirement→case only (`Traceability.tsx:99-106`); requirements store bare paths with **no commit
SHA** (`repository.ts:1288`); no scheduler exists (the only `setInterval`s are SSE heartbeats).
Pin requirements to a commit SHA, add git-agent drift detection, and surface the full
requirement→case→run→defect chain (the schema already supports it — see A8.4).

**B5 — `ai/prioritization.ts` is unwired** — zero imports in `server/`. Investigation showed
there is **no run queue or concurrency gate anywhere** to wire it into (the accuracy doc's "per-
project semaphore" is aspirational, not implemented); that queue is the B7 background-execution
layer. **Resolved (2026-07-04):** kept the module (the policy is the hard part and is correct),
added `scripts/eval-prioritization.ts` + `npm run eval:prioritization` (17/17) to lock its
contract, and documented that wiring waits on B7. Do **not** treat it as dead — it is
verified-and-pending. Separately: the eval scripts referenced in `package.json`
(`eval:routing`/`eval:agents`/`eval:coercion`) point to files that do **not** exist in the repo —
broken script references worth cleaning up. And the end-to-end evalset (the accuracy doc's own #1
item) is still the highest-leverage reliability investment before adding more pattern modules.

**B7 — no background-execution layer** (new, split out from B5). No scheduler/queue exists (the
only `setInterval`s are SSE heartbeats). This is the shared dependency of prioritization (B5),
drift detection (B4), and "AI runs continuously" (the redesign plan's core promise). When built,
run it as a separate worker process (the first `services/` boundary worth enforcing — see B2).

**B6 — Code is the only requirements source** (`requirementService.ts:1-14`) → tests can't catch
"code is wrong vs intent" bugs. Add a spec/ticket ingestion channel with per-rule provenance
(`source: code|spec|human`); surface code-vs-spec conflicts to the Inbox.

---

# Prioritized fix list (this pass)

| # | Fix | Finding | Effort | Why now |
|---|---|---|---|---|
| 1 | Add `mcp-servers` to tsconfig `exclude`; `npm install` to restore `@vscode/ripgrep` | A1, A2 | minutes | quality gate is red; server won't boot from this tree |
| 2 | Delete dead block at `Reports.tsx:766` | A7 | minutes | named DoD item, already flagged |
| 3 | Wire `requireAuth` on all `/api/*` except auth/health/config | A3 | hours | auth exists but guards nothing |
| 4 | Atomic write (temp+rename) + serialized persistence, or go Postgres-only | A4, B3 | hours–days | protects the JSON-mode source of truth |
| 5 | `execSync` → `spawnSync` arg array in `corePlatformMeta.ts:358` | A5 | minutes | matches the codebase's safe pattern |
| 6 | Hard-fail on missing `CRED_ENC_KEY` in production | A6 | minutes | prevents silent credential downgrade |
| 7 | Commit-SHA pinning + drift detection on requirements | B4 | days | flagship differentiator |
| 8 | Consolidate UI around the spine; wire/delete `prioritization.ts` | B1, B5 | week+ | shrinks all later redesign work |
