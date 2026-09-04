# Vitals Local Sandbox Runner Migration Plan

## 1. Executive Summary

Move the approved Pentest and Load Lab profile registry, sandbox target discovery, and server-side runner from `D:\core-platform` into TestFlow AI. TestFlow will run only fixed, versioned profiles against locally registered/allowlisted targets; it will not use Vitals → Connect for execution and will never accept a command from the browser.

## 2. Existing Architecture

Core Platform owns `testing/profiles.ts`, `testing/target-policy.ts`, `testing/runner.ts`, and `/api/tests/*`. Its UI reads that local catalog, selects registered sandbox targets, and starts a fixed script.

TestFlow's Vitals backend currently reads `obs` data through `vitalsQuery` and proxies profile/run actions to a configured remote control plane. Its Pentest page is reporting-only; Load Lab has a generic remote launcher.

## 3. Dependency Graph

`Vitals UI` → `server/features/vitals/routes.ts` → `runs.ts` → **new local profile/target/runner modules** → `obs.test_run`, `obs.test_run_log`, process runner, copied test assets.

`meta.sandbox_environment` → target policy → approved target list → profile validation → spawned fixed script.

## 4. Runtime Flow

1. UI requests the local profile catalog.
2. Server combines fixed profiles with currently running sandbox rows and configured allowlisted targets.
3. User selects a profile/target and confirms security traffic.
4. Server validates profile id, bounded parameters, target membership, concurrency, and security authorization.
5. Server starts the fixed local script, streams logs, persists status/summary, and supports abort.

## 5. Evidence Flow

Runner stdout/stderr becomes ordered `obs.test_run_log` rows. K6/ZAP/security summaries are stored in `obs.test_run.summary` and displayed by existing Vitals run-report and engagement components.

## 6. Context Flow

The Vitals AI tools read the same local profile catalog and stage a profile/target/parameter preview. They retain the existing later-turn human confirmation before starting any real run.

## 7. Prompt Flow

Replace the current “connect a monitored console” execution wording with local-run availability wording. Prompts continue to prohibit arbitrary scripts, arbitrary targets, and same-turn execution after preview.

## 8. Current Problems

- TestFlow has no local profile registry or runner.
- Pentest does not load live Security profiles or sandbox targets.
- TestFlow's current execution path depends on an external control-plane connection.
- The authoritative Core scripts and their runner dependencies are absent from this repository.

## 9. Root Cause Analysis

Vitals was deliberately implemented as a product-neutral reporting/control client. That design omits the product-specific script paths, target registry integration, process spawning, and runner availability checks that Core Platform owns.

## 10. Proposed Architecture

Port the Core runner pattern into `server/features/vitals/testing/`, but adapt it to TestFlow's Express/Postgres conventions. Copy only profiles and scripts that can execute with TestFlow's installed/runtime-supported dependencies. Keep all commands server-derived and target policy server-enforced.

## 11. Complete Refactoring Strategy

Phase 1 establishes a local catalog, target policy, and API contract without starting processes. Phase 2 ports the runner and compatible test assets, persists logs/summaries, and removes proxy execution. Phase 3 makes Pentest and Load Lab consume the local catalog and updates AI-tool messaging. Each phase is independently build- and test-verified.

## 12. Every File That Must Change

| File | Change | Risk |
| --- | --- | --- |
| `server/features/vitals/testing/profiles.ts` (new) | Fixed profile registry and parameter schemas | High |
| `server/features/vitals/testing/targetPolicy.ts` (new) | Sandbox/configured target allowlist | High |
| `server/features/vitals/testing/runner.ts` (new) | Spawn/abort/log/summary lifecycle | High |
| `server/features/vitals/runs.ts` | Replace control proxy with local catalog/runner | High |
| `server/features/vitals/routes.ts` | Local profile, runner, run, log-stream routes | High |
| `server/features/vitals/agent.ts` | Local execution capability wording | Medium |
| `server/features/vitals/agentTools.ts` | Local preview/start contract | Medium |
| `src/pages/vitals/Pentest.tsx` | Security profile and sandbox launcher | Medium |
| `src/components/vitals/RunLauncher.tsx` | Category/authorization-aware local launcher | Medium |
| `src/pages/vitals/LoadLab.tsx` | Local catalog/runner state presentation | Low |
| `src/lib/vitals/api.ts` | Local runner/profile types if contract differs | Medium |
| `server/db/schema.sql` | Idempotent local observability run/log tables if absent | High |
| `scripts/setup-db.bat` | Verify/apply schema path unchanged and local tables provisioned | Medium |
| `tests/security/*`, `tests/load/*` (new copied subset) | Approved, portable Core test scripts | High |
| `tests/scripts/vitalsLocalRunner.test.ts` (new) | Profile/target/validation/command safety checks | Medium |

## 13. Why Each File Must Change

The first three modules replace the Core-only ownership boundary. `runs.ts` and routes become the sole local execution entry points. UI/API/agent files consume the resulting local contract. Schema/setup make persisted evidence available in a fresh TestFlow installation. Script assets are required because a profile path without its repository file cannot run.

## 14. Risk Level Per File

High-risk files spawn processes, authorize targets, accept inputs, or alter persistence. Medium-risk files change API/UI/agent behavior. Load Lab presentation is low risk because it already consumes a profile catalog.

## 15. Backward Compatibility Concerns

Existing read-only Vitals usage must continue to work. Existing `obs.test_run` history remains visible. Remove no endpoint without preserving its response shape where current UI/agent callers depend on it. Remote Connect stays usable for observability-store reads, but no longer gates local execution.

## 16. Migration Strategy

Add local modules and feature-flag-free local routes first. Retain response fields currently returned by `listKnownProfiles`. Then change callers to local behavior. Copy only scripts with verified dependencies and replace Core-only repository assumptions with TestFlow paths/configuration. Do not copy credentials, user pools, or environment-specific launch wrappers.

## 17. Testing Strategy

Unit-test parameter bounds, profile/category restrictions, exact target matching, security-only pentest targets, command derivation, and abort behavior. Verify schema idempotence with `scripts/setup-db.bat`. Build server/client, then run an approved low-risk smoke profile against a local sandbox only.

## 18. Rollback Strategy

Keep the previous proxy implementation isolated until local execution passes validation. Rollback is restoring `runs.ts` to proxy calls and disabling the local launcher; persisted run history remains valid and no destructive target operation occurs during rollback.

## 19. Estimated Implementation Effort

Three phases, approximately 2–4 focused implementation passes. The runner/script portability audit is the dominant effort because Core scripts depend on Core repository structure and installed binaries.

## 20. Recommended Implementation Order

- [ ] Phase 1 — Local profile catalog and sandbox target policy. Files: new `testing/profiles.ts`, `testing/targetPolicy.ts`, `runs.ts`, `routes.ts`, API types. Risk: High.
- [ ] Phase 2 — Local process runner and portable script assets. Files: new `testing/runner.ts`, selected `tests/security/*` and `tests/load/*`, schema/setup, runner tests. Risk: High.
- [ ] Phase 3 — Pentest/Load Lab/agent migration and end-to-end verification. Files: Pentest, RunLauncher, LoadLab, agent/agentTools, tests. Risk: Medium.
