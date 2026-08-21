---
name: research-app-behavior
description: Research application behavior, test areas, edge cases, missing coverage, or feature coverage from the codebase. Use for questions about how the app works or what to test; not for persisted workspace lookup or live execution.
---

# Research App Behavior

Treat the selected application's codebase as the source of truth for behavior. Search for the feature, read the relevant implementation, and follow imports when the behavior depends on connected modules. Do not infer behavior from names, common conventions, or partial matches.

For "what to test" requests, organize the answer by grounded sub-feature and include only evidenced validations, limits, loading/empty/error states, roles, flags, and failure paths. Do not stop at the happy path.

For missing edge or negative coverage, use `find_untested_edges` once. Its result is already source-grounded: summarize it and stop; do not start a second edge search or extra code searches unless the tool failed or the user explicitly asks for deeper source analysis. For a feature/sub-feature coverage audit, use `analyze_feature_coverage`. When either question depends on existing persisted cases, use `query_workspace` for the actual case records.

Keep code locations internal. If the codebase does not establish an answer, say what is unknown instead of inventing it.
