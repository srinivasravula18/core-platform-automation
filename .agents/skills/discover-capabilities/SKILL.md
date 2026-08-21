---
name: discover-capabilities
description: Research relevant agent skills, MCP servers, and tools for a user's requested workflow. Use when asked to find, compare, or recommend capabilities; do not install or connect anything.
---

# Discover Capabilities

Research candidate skills, MCP servers, and tools that match the user's request. Use web search and authoritative sources where available: official vendor documentation and repositories first, then established registries such as skills.sh and the official MCP Registry.

Return a concise candidate manifest for each viable option:

```text
name:
kind: skill | MCP server | tool
source:
owner and version/commit:
purpose:
reputation or audit evidence:
required permissions and side effects:
overlap with existing capabilities:
recommendation: recommend | reject | investigate
reason:
```

State any uncertainty plainly. Prefer maintained, source-verifiable projects and reuse an existing capability when it covers the request.

Safety boundary: this skill is research only. Never install, download, configure, authenticate, connect, enable, invoke, or execute a discovered capability. Do not change files or credentials. End by requesting explicit approval for any recommended installation or connection; approval is a separate step and must name the candidate and intended permissions.
