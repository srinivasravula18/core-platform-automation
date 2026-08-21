---
name: prepare-live-testing
description: Prepare a reviewed scope for testing, verifying, validating, or exercising a live application feature. Use for actionable live-app requests; not for code-only research or persisted case generation.
---

# Prepare Live Testing

When the request names or selects a target URL, call `check_url` before any live-test preparation. A 401 or 403 is reachable; an unresolved address, refused connection, 404, or server failure is not. If the target is not reachable, stop and report the address and result rather than generating work against an error page.

For a reachable actionable request, call `prepare_test_scope` with the requested feature and target information. The reviewed downstream workflow determines the available evidence and presents behaviors and scenarios before execution.

Do not replace this workflow with a prose-only answer. Do not use this skill for a request that only asks to write persisted test cases or to explain source-code behavior.
