# Phase progress ledger

**Purpose:** the durable memory of the remediation programme. Context windows compact and sessions end; this file does not. Any agent (Claude or Codex) resuming work reads this file FIRST to know exactly where things stand.

**Rules for whoever is running the loop:**
- Append after **every** phase — never batch updates, never rely on context to carry state.
- Record what was *observed*, not what was intended. "Restarted backend, confirmed X" not "should now work".
- Never delete an entry. Corrections are new entries that supersede, with a pointer to what they correct.
- If a phase is abandoned or re-scoped, write why. A silent gap is the one thing that breaks resumption.

---

## Status board

| Phase | Owner | Status | Reviewer verdict | Ledger entry |
|---|---|---|---|---|
| P0.3 plansByCase data loss | EVAN | NOT STARTED | — | — |
| P0.1 within-session context bug | ALICE | NOT STARTED | — | — |
| P0.2 cross-user memory leaks | BOB | NOT STARTED | — | — |
| P1 eval golden set | FIONA | BLOCKED — needs P0 | — | — |
| P2 safety + capability enforcement | CHARLIE | NOT STARTED | — | — |
| P3 accuracy engine | DIANA + CHARLIE | NOT STARTED | — | — |
| P4 memory that decides | BOB | NOT STARTED | — | — |
| P5 cost & reliability | EVAN | NOT STARTED | — | — |
| P6 governance | GRACE | NOT STARTED | — | — |
| P7 architecture consolidation | ORCHESTRATOR | NOT STARTED | — | — |

Status values: `NOT STARTED` · `IN PROGRESS` · `AWAITING REVIEW` · `REJECTED — REWORKING` · `DONE`

---

## Environment facts (verify at session start, correct here if changed)

- Backend: `tsx server.ts`, **no hot reload** — restart required after any `server/**` change.
- `AGENT_GRAPH_V2` default ON (LangGraph is the live executor).
- `AGENT_NATIVE_V1` default OFF (agent bus/blackboard is shadow-only).
- SUT (`D:\core-platform`) ports 5001/5002/5003 — **UP** as of 2026-08-01 14:40 (5001 API returns 404 on `/`, which is normal; 5002 Admin and 5003 Keystone return 200). Live verification is available. Re-check with `netstat -ano | grep LISTENING | grep -E ':(5001|5002|5003)\b'` — note `/dev/tcp` probes are unreliable in Git Bash and give false negatives.
- No eval suite exists until P1 completes. Any accuracy number before then is an estimate, not a measurement.

---

## Open questions for the human (do not block on these; record and continue)

<!-- Append items that genuinely need a human decision. The loop continues around them. -->

- [ ] P2.4 — `CORE_IDENTITY` promises human-in-the-loop while the default `auto` policy auto-executes against the live app. Which side wins: change the prompt, or change the default policy?
- [ ] P3.3 — should goal-navigation bias toward the mission's own subject rather than the first plausible create opener? (Design decision, not a defect fix.)

---

## Entries

<!--
Append one block per phase attempt. Template:

### <date> · <phase id> · <owner> · attempt <n>
**Goal:** one line
**Changed:** file list with one-line reason each
**Verified:** exactly what was observed, including whether the backend was restarted
**Eval:** before/after numbers, or "suite does not exist yet"
**Reviewer verdict:** APPROVED | APPROVED_WITH_FOLLOWUPS | REJECTED — plus the reason
**Follow-ups created:** any non-blocking items, appended to the plan
**Next:** what the loop does next
-->

_(no entries yet — first entry goes here)_
