# Agent Download — Flat Bundle Redesign (Phase 0, analysis only)

**Date:** 2026-08-03 · **Status:** awaiting approval · **Scope:** agent download/packaging only

## 1. Executive Summary

The downloadable desktop agent is served as a **ZIP inside a ZIP**. The end user extracts twice: once
in Explorer (producing a 309 MB `runtime.zip`), then again inside `start.bat`, which shells out to
PowerShell `Expand-Archive` to unpack **690 MB across 1,288 files** before the agent ever contacts the
cloud. That second extraction — measured at ~24 s on a fast local SSD, and materially worse on a slow
or antivirus-scanned corporate disk — is the unexplained wait after double-clicking `start.bat`, and it
is why `start.bat` appears to "do nothing but talk to the server" only much later.

The nesting exists for a real reason: it lets the server keep **one** pre-compressed archive and wrap it
with a per-user `config.json` at near-zero CPU per download. That server-side win is currently paid for
by every end user.

Both can be had at once. A ZIP central directory can be re-emitted cheaply, so the server can stream its
cached compressed bytes **verbatim** into a *flat* ZIP and append `config.json` after them — no
recompression, no nesting. This also makes the exact response size knowable up front, which today's
streaming build cannot do, giving `Content-Length`, a real browser progress bar, and resumable downloads.

Proven feasible: `.testflow-pw/scratch/proto-flat-zip.ts` builds such a ZIP from a cached archive and
verifies it extracts correctly with `Expand-Archive`.

**Outcome:** one extraction instead of two, `start.bat` becomes launch-only, exact size + resume, and no
change to the self-contained-single-ZIP architecture that end users without install permissions require.

## 2. Existing Architecture

| Component | Responsibility |
|---|---|
| `server/features/automation/bundleBrowsers.ts` | At boot, downloads Windows Chromium + headless-shell into `agent/browsers/` |
| `server/features/automation/downloadService.ts` | Builds/caches the runtime ZIP; streams the per-user outer ZIP |
| `server/features/automation/routes.ts:861-868` | `GET /api/automation/agent/download` — mints a pairing token, delegates to `streamAgentZip` |
| `agent/start.bat` | Extracts `runtime.zip`, then launches `node dist/index.js` |
| `src/pages/automation/LocalAgent.tsx`, `src/components/NoAgentState.tsx` | Trigger the download |

Bundle composition on disk (measured):

| Part | Size |
|---|---|
| `agent/browsers/chromium-1228` | 416 MB |
| `agent/browsers/chromium_headless_shell-1228` | 270 MB |
| `agent/node_modules` | 23 MB |
| `agent/dist` + launchers | < 1 MB |
| **Total** | **~690 MB / 1,882 files** |

## 3. Dependency Graph

```
routes.ts ──▶ downloadService.ts ──▶ archiver ──▶ res
   │                 │
   │                 └──▶ agent/ (AGENT_BUNDLE_DIR) ──▶ cache dir (AGENT_BUNDLE_CACHE_DIR)
   └──▶ bundleBrowsers.ts ──▶ cdn.playwright.dev
```

`downloadService.ts` has no dependants other than `routes.ts` and `scripts/test-agent-download-cache.ts`.
The blast radius of this redesign is therefore small and well fenced.

## 4. Runtime Flow (current)

1. **Boot** — `ensureBundledChromium()` then `warmAgentBundleCache()` (`routes.ts:84-86`).
2. **Warm** — `ensureRuntimeCache()` zips everything except `start.bat` into
   `runtime-<sig>.zip` (`downloadService.ts:113-142`).
3. **Download** — `streamAgentZip()` creates a *second* archive containing the cached ZIP as a
   **stored** entry, plus `start.bat` and `config.json` (`downloadService.ts:171-181`).
4. **User, extraction 1** — Explorer unzips → `runtime.zip` (309 MB) + `start.bat` + `config.json`.
5. **User, extraction 2** — `start.bat` runs `Expand-Archive` on `runtime.zip`, deletes it
   (`agent/start.bat:10-19`).
6. **Launch** — `node dist/index.js` registers with the cloud.

## 5. Byte Flow

690 MB on disk → 309 MB cached (deflate 6) → streamed verbatim inside a stored outer entry → written to
the user's disk as 309 MB → re-inflated to 690 MB → 309 MB deleted. Peak user disk: ~1 GB. Bytes written
to the user's disk: ~1 GB for a 690 MB payload.

## 6. Context Flow / 7. Prompt Flow

Not applicable — this subsystem carries no LLM context or prompts. Sections retained for template parity.

## 8. Current Problems

| # | Problem | Evidence |
|---|---|---|
| P1 | User extracts twice; the second is 690 MB / 1,288 files via `Expand-Archive` (~24 s measured locally) | `agent/start.bat:10-19` |
| P2 | `start.bat` silently owns packaging, not launching — surprising and undocumented behaviour | `agent/start.bat` vs `docs/automation/install-guide.md:28` ("Double-click start.bat. That's it.") |
| P3 | No `Content-Length` / `Accept-Ranges` → no progress bar, dropped WAN transfer restarts from 0 MB | `downloadService.ts:158-159` sets only type + disposition |
| P4 | Peak ~1 GB disk on the user's machine for a 690 MB agent | derived from §5 |
| P5 | Reverse proxy buffers the whole response to disk before sending (default `proxy_buffering on`) | server-side; snippet added to `docs/automation/operations.md` |

Already fixed this session (not re-listed as open): mtime-keyed cache rebuilt ~690 MB on every redeploy;
stale cache ZIPs never pruned; compression level 1 → 6 (334 MB → 309 MB measured).

## 9. Root Cause Analysis

The nested ZIP is a **server-side caching strategy leaking into the client-side install experience**.
Commit `32db3d3` ("Bundle agent runtime for offline setup") chose nesting because `archiver` cannot
append pre-compressed entries through its public API — so the only apparent way to avoid recompressing
690 MB per download was to embed the cache whole as a stored entry.

That premise is false. The ZIP format stores each entry's compressed bytes contiguously, followed by a
central directory of records pointing at them. Appending an entry **after** the existing data section
leaves every cached offset valid, so a flat ZIP can be assembled by: streaming the cached file's data
section unchanged → writing `config.json`'s local header + bytes → replaying the cached central
directory verbatim → appending one new central record → writing a fresh EOCD. Cost per download is one
sequential file read plus ~200 bytes of new framing, and every size involved is known before the first
byte ships.

## 10. Proposed Architecture

```
warm (once):   agent/ ──deflate──▶ runtime-<sig>.zip   [start.bat INCLUDED, config.json excluded]
               + record: dataSectionSize, centralDirBytes, entryCount

download:      [cached data section]  (streamed from disk, verbatim)
               [config.json local header + bytes]      ← per user, ~200 B
               [cached central directory]  (verbatim)
               [config.json central record + EOCD]     ← per user, ~100 B
               Content-Length = exact, computed before streaming
               Accept-Ranges: bytes → resumable
```

The user receives **one flat ZIP**: `dist/`, `node_modules/`, `browsers/`, `start.bat`, `config.json`.
One Explorer extraction. `start.bat` reverts to launch-only.

Rejected alternatives:

- **tar.xz payload** — 28 % smaller (measured: a 269 MB slice → 114 MB deflate vs 82 MB xz), but it
  *requires* the nested archive and a `start.bat` extraction step, i.e. exactly the design being removed.
  Size and single-extraction are in direct tension; single-extraction wins per the product constraint.
- **Splitting into a small launcher that fetches the runtime** — violates the self-contained requirement
  (end users cannot download components at setup time).
- **Recompressing per download** — 690 MB of deflate per user; unusable.

## 11. Complete Refactoring Strategy

1. Add a small, dependency-free ZIP re-framing module: parse EOCD + central directory of the cached
   file, expose `{ dataSectionSize, centralDirectory, entryCount }`, and build the trailing framing for
   one appended stored entry.
2. Include `start.bat` **in** the cached archive (it is no longer per-user; only `config.json` is).
3. Rewrite `streamAgentZip` to set `Content-Length`/`Accept-Ranges` and stream
   data-section → config → central directory → EOCD, honouring `Range`.
4. Reduce `start.bat` to launch-only; keep a one-release compatibility branch that still expands
   `runtime.zip` if present, so bundles downloaded before the change keep working.
5. Update install guide + operations runbook.
6. Extend `test:agent-download-cache` to assert flatness, exact `Content-Length`, byte-identical
   `Range` resumption, and successful `Expand-Archive`.

## 12-14. Files to Change

| File | Why | Risk |
|---|---|---|
| `server/features/automation/zipReframe.ts` *(new)* | EOCD/central-directory parsing + trailing framing; isolated and unit-testable | **Medium** — binary format correctness; mitigated by round-trip tests through `Expand-Archive` |
| `server/features/automation/downloadService.ts` | `streamAgentZip` emits a flat ZIP with exact length + Range; `runtimeEntries()` stops excluding `start.bat` | **Medium** — the download path itself; behind a flag until validated |
| `agent/start.bat` | Drop the extraction block; keep a legacy branch for already-downloaded bundles | **Low** — additive fallback preserves old bundles |
| `scripts/test-agent-download-cache.ts` | Cover flat layout, `Content-Length`, `Range`, real extraction | **Low** — test only |
| `docs/automation/install-guide.md` | "unzip and run" is now literally true; drop the one-time-preparation wording | **Low** |
| `docs/automation/operations.md` | Note the cache now includes `start.bat`; invalidation implications | **Low** |

Six files. No schema, API-shape, or agent-runtime changes.

## 15. Backward Compatibility

- **Route, auth, pairing-token semantics, filename: unchanged.** The client needs no change.
- **Bundles already on user machines**: unaffected — they run their own `start.bat`.
- **A bundle downloaded pre-change, extracted post-change**: still contains `runtime.zip`; the retained
  legacy branch in `start.bat` handles it.
- **Cache invalidation**: including `start.bat` changes the content signature once, forcing exactly one
  rebuild on first deploy. Expected and self-healing.
- **`AGENT_BUNDLE_DIR` / `AGENT_BUNDLE_CACHE_DIR` / `AGENT_BUNDLE_ZIP_LEVEL`**: unchanged.

## 16. Migration Strategy

Ship behind `AGENT_FLAT_BUNDLE` (default **off**). Enable on the test environment, verify a real
end-to-end install on a clean Windows machine, then default on. Remove the flag and the legacy
`start.bat` branch one release later.

## 17. Testing Strategy

1. `npm run lint` (tsc --noEmit).
2. `npm run test:agent-download-cache`, extended to assert: no `runtime.zip` entry; `dist/index.js`,
   `browsers/**`, `start.bat`, `config.json` all at top level; `Content-Length` equals bytes actually
   streamed; a `Range`-resumed download is byte-identical to a whole one; `Expand-Archive` produces a
   runnable tree.
3. Real-bundle check against the actual 690 MB `agent/` directory: warm, download, extract, confirm
   `chromium.exe` and `chrome-headless-shell.exe` are present and executable.
4. Live: download from the test environment, extract once, run `start.bat`, confirm the agent pairs and
   shows **Connected** — and that no extraction step appears.
5. Regression: confirm an old nested bundle still starts.

## 18. Rollback Strategy

Set `AGENT_FLAT_BUNDLE=0` and restart the backend — `streamAgentZip` returns to the nested path with no
data migration. The cache is rebuilt automatically from the content signature. Full revert is the six
files above; nothing persists in the database.

## 19. Estimated Effort

| Phase | Effort |
|---|---|
| Phase 1 — `zipReframe.ts` + tests | ~3 h |
| Phase 2 — `streamAgentZip` flat path, Content-Length, Range | ~3 h |
| Phase 3 — `start.bat`, docs, live verification | ~2 h |
| **Total** | **~1 day**, one subsystem, 6 files |

## 20. Recommended Implementation Order

- [x] **Phase 1 — ZIP re-framing core.** Files: `server/features/automation/zipReframe.ts` (new),
      `scripts/test-zip-reframe.ts` (new), `package.json`. Risk: **Medium**. Gate: 23 checks, incl.
      round-trips through `Expand-Archive` and `unzipper`.
- [x] **Phase 2 — Flat download path.** Files: `server/features/automation/downloadService.ts`,
      `server/features/automation/routes.ts`, `scripts/test-agent-download-cache.ts`. Risk: **Medium**.
      Gate: lint, extended cache test, real-bundle download + extraction.
- [x] **Phase 3 — Launcher + docs.** Files: `agent/start.bat`,
      `docs/automation/install-guide.md`, `docs/automation/operations.md`. Risk: **Low**. Gate: the real
      bundle extracts once and `start.bat` reaches the agent with no unpacking step.

## Delivered (2026-08-03)

Implemented as planned, with one deviation: **no `AGENT_FLAT_BUNDLE` flag** — the requirement was to
keep configuration in code, so the flat path is unconditional and rollback is a code revert. The
`AGENT_BUNDLE_ZIP_LEVEL` variable introduced during the earlier fixes was likewise folded into a
constant.

Measured on the real 690 MB bundle:

| | Before | After |
|---|---|---|
| Extractions by the end user | 2 | **1** |
| Peak disk during install | ~1 GB | ~690 MB |
| Download bytes | 334 MB | **309 MB** |
| `Content-Length` / resume | none | **exact / `Range` supported** |
| Server work per download | re-wrap 334 MB | **~0.8 s byte copy** |
| Cache rebuild per redeploy | full ~690 MB re-zip | **none** (content-keyed) |

Live evidence — the extracted bundle launched straight into the agent:

```
Starting TestFlow Agent on http://localhost:2424 ...
"msg":"TestFlow Agent starting"
"msg":"browser: ready (incl. ffmpeg for video)"     ← bundled Chromium resolved, no download
"msg":"local API listening on 127.0.0.1" port 2424
```

Still open, both outside this plan's scope: reverse-proxy buffering on the test host (snippet in the
operations runbook), and the fact that unzipping an update over an existing folder overwrites
`config.json` and forces re-pairing (documented as a manual step in the install guide).

## Out of Scope (separate decisions)

- Reverse-proxy buffering (`proxy_buffering off`) — server-side; snippet already in the operations
  runbook, needs someone with box access.
- Reducing payload below ~309 MB — blocked by the self-contained constraint; see §10 rejected
  alternatives.
