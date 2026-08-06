# Codegen Post-Login Freeze and Polling Performance Audit

Date: 2026-08-04  
Scope: local desktop-agent codegen recording, the post-login Accounts page, and repeated TestFlow UI API requests.  
Change status: analysis only; no runtime code was changed by this audit.

## Executive conclusion

The freeze is occurring in the codegen Chromium renderer, not in the TestFlow backend or the desktop agent's script-streaming loop. During the affected recording, the inspected-page renderer reached about 900 MB working set and accumulated 216.7 CPU-seconds in a roughly four-minute session. The complete codegen browser tree was about 1.7 GB working set at the sampled instant.

The most likely trigger is the combination of a large/dynamic post-login DOM and Playwright 1.61.1 recorder work executed synchronously in that renderer:

- moving onto each new element generates a locator on the page thread;
- the recorder observes the entire `document.body` subtree while recording;
- each recorded action builds an accessibility tree for the whole document before dispatching the action.

This attribution is high-confidence as a contributing cause, but it is not a flamegraph-proven sole cause because the affected browser closed before DevTools performance capture could be attached.

The TestFlow UI has a separate request-amplification problem. Multiple mounted components independently poll the same resources. In particular, the global running indicator repeatedly requests the complete `/api/agent-runs` history and the server performs full-list normalization even though the indicator only needs active run summaries.

## Evidence captured

### Affected recording timeline

- Agent log: recording `REC-1785839593234-SQX407` started at `2026-08-04T10:33:13.621Z` and finalized at `2026-08-04T10:37:12.885Z`.
- The generated script was only 719 bytes. Script volume and the once-per-second file poll are therefore not credible causes of the freeze.
- The agent log contained no recorder error during this interval.
- The generated script reached the post-login URL and recorded the attempted `Apps` button click. Input reached Playwright, but the target UI did not visibly react normally.

### Live process snapshot

- Inspected-page renderer: approximately 900 MB working set, 833 MB private memory, 216.7 accumulated CPU-seconds.
- Another codegen browser child accumulated 85.7 CPU-seconds and used approximately 184 MB working set.
- The desktop agent remained responsive at approximately 112 MB working set and under two accumulated CPU-seconds.
- Two top-level Chromium processes under codegen are expected: Playwright codegen opens an inspected browser and an Inspector application. They are not, by themselves, proof of an accidental duplicate recording.

### Running package mismatch

- The active downloaded bundle reports agent version `1.0.0`.
- The server currently publishes agent version `1.0.2`.
- The running bundle does not contain `dist/codegen.js`; it still invokes Playwright's CLI directly.
- The repository's 1.0.2 launcher grants permissions before navigation and uses a persistent site profile in [agent/src/codegen.ts](../../agent/src/codegen.ts) and [agent/src/recorder.ts](../../agent/src/recorder.ts).

Updating to 1.0.2 is required for compatibility and the permission fix, but it is not sufficient proof that the large-DOM recorder stall is solved: 1.0.2 still enables Playwright's internal recorder and therefore retains the same injected selector/accessibility-tree hot path.

## Root-cause ranking

### P1 — Recorder work blocks the inspected page renderer (high confidence)

The installed Playwright 1.61.1 injected recorder performs the following work on the target page's main renderer thread:

1. `RecordActionTool.onMouseMove` reacts whenever the hovered DOM element changes.
2. `_updateModelForHoveredElement` synchronously calls `generateSelector(...)` and updates the overlay.
3. A `MutationObserver` watches `document.body` with `{ childList: true, subtree: true }` while an element is hovered.
4. `performAction` calls `_captureAutoExpectSnapshot`, which runs `generateAriaTree(document.documentElement, { mode: "autoexpect" })` before dispatching the action.

The screenshot's locator tooltip confirms that this injected recorder path was active. A dense grid causes frequent target changes while the mouse moves; a dynamic application also feeds the whole-body observer. Full-document accessibility-tree generation then adds a second synchronous cost at click time.

### P1 — Full-history polling for a tiny global indicator (high confidence)

[src/components/RunningIndicator.tsx](../../src/components/RunningIndicator.tsx) fetches `/api/agent-runs`, filters it to `status === "running"`, and keeps only `id`, `prompt`, and `conversationId`. It currently:

- polls every eight seconds;
- polls once in the pathname effect;
- polls again in the timer setup effect;
- polls on window focus.

[server/features/agent/routes.ts](../../server/features/agent/routes.ts) answers that request by loading all agent runs, scope-filtering them, checking orphan state, normalizing generated cases, and annotating proof for every row. It also sends `Cache-Control: no-store`, so every request returns and recomputes a full `200` payload.

This is disproportionate work for a global active-count control and explains the repeated large `agent-runs` responses in the network capture.

### P2 — Independent polling owners amplify `/agents` requests (high confidence)

[src/lib/useAutomation.ts](../../src/lib/useAutomation.ts) creates a separate ten-second `/api/automation/agents` interval for every `useAgents()` call. Current consumers include Test Cases, CodegenPanel, Test Runs, Local Agent, and the Automation dashboard. Opening CodegenPanel inside Test Cases mounts a second consumer on the same screen.

The automation pages already subscribe to `/api/automation/events`, but they retain their polling timers as well. Each `useAgentEvents()` call also opens its own EventSource rather than sharing one connection.

`304` reduces response body bytes for cacheable endpoints, but it does not remove browser scheduling, authentication, routing, repository reads, ETag evaluation, or connection overhead.

### P2 — Dependency range permits unreviewed recorder changes (medium confidence)

[agent/package.json](../../agent/package.json) declares both Playwright dependencies as `^1.60.0`, while [agent/package-lock.json](../../agent/package-lock.json) resolves 1.61.1. The application also calls the internal `_enableRecorder` API. An unpinned dependency plus an internal API makes recorder behavior vulnerable to changes outside this repository's compatibility surface.

This is a release-risk finding, not proof that 1.61.1 alone introduced the freeze. A controlled A/B run is required before selecting another version.

### Not supported as the primary cause

- **Agent-to-cloud streaming:** the agent reads a small file once per second and transmits only when it changes ([agent/src/recorder.ts](../../agent/src/recorder.ts)). The captured script was 719 bytes.
- **Backend/WebSocket failure:** no recording error was logged, and the click was written to the generated script.
- **Network polling causing the codegen tab freeze:** the repeated `agents` and `agent-runs` calls belong to the TestFlow management UI, not the separately launched codegen page. They should be optimized, but they are not the primary cause of the target application's renderer stall.

## Recommended implementation order

### 1. Operational correction now

1. Stop the currently running 1.0.0 agent.
2. Download and start the 1.0.2 package.
3. Verify the Local Agent card reports 1.0.2 before starting a fresh recording.
4. Start a new recording; an already-open 1.0.0 codegen window cannot acquire the new launcher behavior.

This fixes the known version and permission mismatch and gives a valid baseline for performance measurement.

### 2. Replace full-history polling with a slim active-run response

Smallest sustainable change:

- add a scoped endpoint that returns only active run descriptors: `id`, `prompt`, `conversationId`, and `status`;
- perform the status filter in the repository/database query rather than loading all history;
- make `RunningIndicator` call that endpoint;
- remove one of its duplicate immediate mount polls;
- pause or substantially slow the fallback poll while `document.hidden`.

A global run event stream can replace the fallback later, but it is not necessary for the first optimization.

### 3. Consolidate automation freshness

- Use one shared automation EventSource per browser tab.
- Refresh agents on `agent.online` and `agent.offline` events.
- Keep one slow focus/visibility fallback for missed events instead of a timer per component.
- Deduplicate simultaneous refreshes so Test Cases and CodegenPanel share one in-flight `/agents` request.

Do not remove all fallback freshness until heartbeat-expiry/offline behavior is covered; the current live stream emits socket online/offline changes, while liveness also depends on heartbeat freshness.

### 4. Benchmark the recorder before selecting a code change

Run the same authenticated Accounts page under:

1. plain headed Chromium without recorder injection;
2. the current Playwright 1.61.1 recorder;
3. a candidate exact Playwright version selected for comparison.

For each run, capture:

- DOM element count and accessibility-node count;
- mutations per second after the list settles;
- renderer CPU and working/private memory at idle, hover, and click;
- Long Tasks and Interaction to Next Paint;
- time from click to the Apps menu becoming visible.

If plain Chromium is healthy and recorder mode is not, pin the exact passing Playwright version first. If every recorder version stalls, the durable choices are target-app DOM virtualization/stabilization or a deliberately reduced recorder mode; do not patch `node_modules` without a versioned, runnable regression check.

### 5. Reduce target-page selector cost where possible

For the Accounts application (outside this repository):

- virtualize large table bodies so off-screen rows are not mounted;
- stop unnecessary subtree churn after list load;
- add stable `data-testid` values to high-frequency controls such as Apps, list selectors, search, and New;
- profile accessible-name computation for the grid.

These changes help the application itself and reduce Playwright locator-generation work.

## Security finding discovered during the audit

The old codegen bundle wrote the typed password into its raw `.spec.ts` file. The agent then streams the raw script, and [server/features/automation/recordingService.ts](../../server/features/automation/recordingService.ts) persists that script before derived step masking occurs. The existing masking in [server/features/automation/stepGrouping.ts](../../server/features/automation/stepGrouping.ts) protects human-readable derived steps, not the raw executable script.

This is production-blocking credential exposure and should be handled separately from performance: replace sensitive fills with secret placeholders before disk/cloud persistence, and migrate/delete already captured plaintext secrets. No secret value is reproduced in this report.

## Acceptance gates

- Agent card and startup log both report 1.0.2 or newer.
- Accounts page idle renderer CPU stays below 10% of one core after settling.
- Hovering across the grid does not produce repeated long tasks over 50 ms.
- Apps click is visibly applied within 500 ms at the 95th percentile.
- Codegen renderer working set remains below an agreed ceiling (initial target: 500 MB for this page).
- The global header no longer downloads full agent-run history on a fixed interval.
- Only one automation EventSource exists per tab.
- Hidden tabs do not continue high-frequency polling.
- No raw recording file, WebSocket/SSE frame, database row, or generated script contains a typed secret.

## Audit limitations

- The affected recording ended before a Chromium performance trace or heap snapshot could be captured.
- The authenticated target application's source and DOM metrics were not available in this repository.
- The in-app browser surface was unavailable, so no console log, DOM snapshot, or rendered interaction replay was collected.
- Process, package, agent-log, generated-script, and exact installed-recorder-source evidence were collected locally and are sufficient to identify the renderer hot path and polling amplification, but a controlled authenticated A/B profile remains required before claiming the final recorder fix.
