## New Approach

Use a hybrid model with two layers:

- an operating model: `author`, `run`, and `repair`
- a stricter implementation pipeline: live-first, proof-gated, repo-last

This combines the useful part of the earlier architecture with the more realistic pipeline design.

## Core position

- AI should be used for understanding scope, expanding feature coverage, writing test cases, and repairing broken scripts.
- Deterministic Playwright should be used for routine regression execution.
- Saved Playwright scripts are the reusable asset.
- Repo/code understanding is fallback support, not the default first step.
- No guessed selectors should be allowed into generated scripts.

## Operating modes

### 1. Author mode

Use when the user is asking for new coverage, such as:

- `create test cases for List View`
- `generate regression for account creation`
- `cover saved views and export`

Goal:

- understand the request
- ground it in metadata and live UI
- generate human-readable cases
- generate reusable Playwright scripts only for proven steps

### 2. Run mode

Use when the user wants to execute existing automation, such as:

- `run the nightly regression`
- `execute list view smoke tests`
- `rerun account tests`

Goal:

- run saved scripts only
- no AI by default
- capture pass/fail/evidence

### 3. Repair mode

Use when existing automation failed, such as:

- `fix failing list view test`
- `selector broke after UI change`
- `continue from failed regression run`

Goal:

- isolate the failure
- inspect live DOM again
- repair only the failing script or step
- rerun only failed tests
- optionally persist the repair

## Implementation pipeline

This should be the main authoring pipeline.

### 1. Scope Gate

- Resolve project, platform, app, tab/object, folder, and target URL.
- If the request is for a shared feature and app/object scope is missing, ask the user.
- Do not start with repo search.
- Do not start with model guessing.
- Do not fetch broad metadata before scope is known.

Examples:

- `test list view` -> ask which app/object if multiple list views exist
- `test account list view in ED 106` -> enough scope, continue
- `create account T100` -> direct object/action scope is already clear

### 2. Auth Session

- Log in once.
- Save storage state and any required session state.
- Reuse the same authenticated session for inspection, verification, and authoring where possible.
- If login fails, rate limits block access, or session setup is incomplete, stop and report it honestly.

### 3. Metadata Fetch

- Fetch only the selected app/object metadata.
- Output only what helps authoring:
  - objects
  - tabs
  - fields
  - picklists
  - permissions
  - list views
  - sample records when safe/useful
- If metadata is unavailable, continue only with UI-visible behavior and mark metadata gaps explicitly.

Note:

- Metadata is not the first source of truth for UI selectors.
- Metadata is important for coverage, validation rules, field expectations, and permissions.

### 4. Live Inspector

- Use Playwright to reach the exact selected app/tab/object/page.
- Wait for real UI readiness, not just page load.
- Capture visible DOM, tables, forms, buttons, labels, empty states, and errors.
- Open safe menus or overflow containers when needed to reveal real controls.
- If the exact page cannot be reached, stop and mark the flow blocked.

This is the primary grounding source for automation.

### 5. Selector Registry

- Build a registry of verified selectors and proof IDs from the live page.
- Record where each selector came from:
  - visible DOM proof
  - metadata-backed only
  - blocked / missing
- Do not permit guessed selectors.

This is best treated as a strict phase/service even if it is not a separate named agent.

### 6. Case Planner and Case Writer

Use AI here, but only after scope, auth, metadata, and live inspection are available.

Responsibilities:

- expand the feature area into meaningful coverage
- write readable cases
- include expected result for every step
- classify each step as:
  - `verified`
  - `metadata-backed`
  - `blocked`

Example for `create test cases for List View`:

- list loading
- default columns
- sorting
- filtering
- pagination
- saved views
- export
- row selection
- inline edit
- empty state
- permission-restricted actions

Keep gap analysis inside this phase unless it becomes complex enough to justify its own component.

### 7. Script Author

- Generate Playwright only for steps with selector proof.
- Verified UI-backed steps can become automated steps.
- Metadata-backed-only steps should remain manual or blocked until the UI is proven.
- Do not synthesize selectors from naming intuition.

This is the point where reusable regression scripts are created.

### 8. Script Verifier

- Replay generated scripts and selectors in the same authenticated session when possible.
- Validate that the selectors and navigation path really work.
- If there is a mismatch, repair once from a fresh live DOM read.
- If still unresolved, block rather than guess.

### 9. Evidence Runner

- Run only verified scripts.
- Capture screenshots, traces, logs, and structured pass/fail outcomes.
- Report:
  - passed
  - failed
  - blocked
- Include missing-proof reasons when automation was intentionally not generated.

## Repo understanding

Repo/code search should not be a default main-path phase.

Use repo understanding only when:

- the user explicitly asks for source-grounded behavior
- metadata is incomplete
- the live UI cannot fully reveal the needed behavior
- a repair requires source-level confirmation
- the feature depends on implementation details not visible in UI or metadata

Rule:

- live UI first
- metadata in parallel or immediately after scope/auth
- repo last

## Scenario routing

### Scenario A: Broad feature request

Prompt:

- `create test cases for List View`

Route:

- Scope Gate
- ask for app/object if needed
- Auth Session
- Metadata Fetch
- Live Inspector
- Selector Registry
- Case Planner/Writer
- Script Author
- Script Verifier

### Scenario B: Direct UI action request

Prompt:

- `create account T100`

Route:

- do not force full case generation first
- use direct browser task execution or a very narrow authoring path
- inspect current form
- fill verified fields
- execute action
- capture result

This is not the same as generating a regression pack.

### Scenario C: Nightly regression

Prompt:

- `run nightly regression`

Route:

- Run mode only
- load saved scripts
- restore auth session
- execute
- collect evidence
- no AI unless failures trigger Repair mode

### Scenario D: Broken saved script

Prompt:

- `fix failing export test`

Route:

- Repair mode
- isolate failing script/step
- restore session
- inspect current live DOM
- repair selector/action once
- rerun failed test only
- persist patch if valid

## What to avoid

- Do not make repo search the first phase.
- Do not make metadata the only source of truth for UI automation.
- Do not let the model invent selectors.
- Do not force all direct UI tasks through full case generation.
- Do not run AI for every daily regression execution.
- Do not create too many thin agents that only rename simple phases.

## Final principle

The strongest design for this project is:

- author / run / repair as the top-level operating model
- scope-first, auth-first, live-first, proof-gated authoring pipeline
- metadata for controlled augmentation
- repo as fallback
- deterministic Playwright for repeat execution

Short version:

- vague prompt -> AI expands and grounds
- proven UI -> script authoring
- saved scripts -> cheap regression
- failures -> targeted AI repair only
