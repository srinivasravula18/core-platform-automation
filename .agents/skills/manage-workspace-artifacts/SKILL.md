---
name: manage-workspace-artifacts
description: Find, create, revise, generate, organize, or report on persisted QA workspace artifacts such as plans, suites, cases, runs, scripts, defects, reports, and folders. Use when existing artifacts or their IDs matter; not for live-app testing.
---

# Manage Workspace Artifacts

Workspace tools are the source of truth for persisted artifacts and their current state. Before acting on a referenced existing item (for example "that suite", "the last run", or "login cases"), use `query_workspace` to resolve real IDs in the active user, project, and app scope. Never guess an ID.

Use the matching artifact tool only after the needed references and required fields are known. A successful tool result is the only proof that an artifact was created, updated, moved, or generated; report exactly that result.

Use `create_cases` for persisted test-case artifacts. Do not substitute it for the reviewed live-testing workflow, and do not claim that a test was executed unless a run tool reports execution evidence.

Ask the user only for a required name, scope, or choice that cannot be obtained from workspace context or tool results.
