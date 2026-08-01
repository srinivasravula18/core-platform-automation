# Demo Runbook — Tag-Native Composition + Versioning (end-to-end, UI)

A click-by-click script to demo the whole feature set. Each section has **Do** (what to click) and
**Say** (the talking point). Budget ~12–15 min for the full run.

---

## 0. Prep (do this ~5 min before the demo)

1. **Both servers up:**
   - Backend: `npm run dev:backend` (port **3001**, no hot-reload — restart it after any server change).
   - Frontend: `npm run dev:frontend` (port **3000**).
2. **Seed a fresh, pristine demo set** (idempotent, safe to re-run):
   ```
   npm run seed:versioning-demo
   ```
   It prints the IDs it created — keep that output visible. It creates:
   - a case taken **v1 → v10** (`[VDEMO] Checkout & login flow`)
   - a second case (`[VDEMO] Password reset flow`)
   - a **Plan → Suite → Cases + Run** hierarchy, all tag-defined by `@versioning-demo`
   - a manual run with a case pinned to an older version
   - one extra case added *after* acceptance so a **drift notification** is already waiting
3. **(Optional but strong)** show the automated proof first:
   ```
   npm run test:versioning-e2e
   ```
   Point at the green checklist — every scenario below is covered by an automated test.
4. **Log in**: open `http://localhost:3000`, sign in as `admin` / `admin@2026`.
5. Everything demo-related is tagged **`@versioning-demo`** / prefixed **`[VDEMO]`** — type that in any
   search box to find it, and delete anything with that tag/prefix afterward to clean up.

> If you demoed on this data already and it looks "used", just re-run step 2 for a clean slate.

---

## 1. The one-line pitch (say first, 30 sec)

> "Organization is 100% tag-based — no folders. You compose suites, plans, and runs by choosing tags,
> and the system resolves the matching cases. Every case has a full Git-like version history. Each
> container can pin a different version of the same case. And nothing changes membership or versions
> silently — you always get a review notification."

---

## 2. Tag-native composition — build a suite by tags (2 min)

**Do:**
1. Left nav → **Test Suites** → **New Suite** (or the create button).
2. Name it `Demo Sanity Suite`.
3. Under **Link Test Cases**, click **Search & link by tag**.
4. In the picker, click the **`@versioning-demo`** chip (or search a tag). Watch the **matched cases
   preview** update live. Toggle **All / Any** to show intersection vs union.
5. Select a couple of cases → **Use selected cases**.
6. Back in the modal, the cases show as **removable chips** (no giant scrolling list), and a line says
   **"Tag-defined … new matches will surface for review after saving."** → **Create Suite**.

**Say:** "I never picked a folder. I picked a tag, previewed exactly what matches, and the suite is now
*tag-defined* — so it keeps watching for new matching cases."

*(Optional: repeat the same flow on **Test Plans** and **Test Runs** — identical composer everywhere.)*

---

## 3. Version graph — v1 → v10, diff, restore (3 min)

**Do:**
1. Left nav → **Test Cases**. Search **`[VDEMO] Checkout`**.
2. On that row, click the **Version history** (clock) action.
3. Show the **timeline v10 → v1** with change summaries, author, timestamps, and a **HEAD** badge on top.
4. Click any older node (e.g. **v3**) → the **diff panel** shows that version vs its parent, with
   per-step **added / changed** markers.
5. Click **Restore this version** on an older node → confirm the dialog ("appends a new revision,
   history preserved") → **Confirm**.
6. Reopen the history: a **new top node** appears (kind **rollback**, "Rolled back to revision N"), HEAD
   now equals the restored content. **Nothing was deleted.**

**Say:** "This is Git for test cases — every content edit is an immutable node. I can diff any two and
restore any prior version; restore is append-only, so history is never lost."

---

## 4. Version pins — same case, different version per container (2 min)

**Do:**
1. Left nav → **Test Runs**. Open the **`[VDEMO] Versioning manual run`**.
2. In the case table, find the **Version** column. It shows each case's pinned version (e.g. **@v5**).
3. Open the dropdown on a case → pick a different version (e.g. **@v2** or **@latest**). The manual step
   list re-seeds to that version's steps.
4. Now open **Test Suites → `[VDEMO] Versioning suite`** and show the **same case** pinned to a
   **different** version (e.g. **@v3**) in *its* Version column.

**Say:** "The exact same case can run at **@v5** in this run, **@v3** in that suite, while its HEAD is
**@v11** — pins are per-container and independent. That's how you re-run an old version in one place
without disturbing anything else."

---

## 5. Membership drift — the three-way notification (2 min)

The seed already left one new matching case, so a banner is waiting.

**Do:**
1. Open the **`[VDEMO] Versioning suite`** (or plan/run). Note the **"N new cases match this suite's
   tags"** banner at the top.
2. Click **Review** to expand the matched cases (checkboxes).
3. Show the **three choices**:
   - **Add to this** — merges the new case into this group's membership.
   - **Create new** — spins the new matches into a *separate* new suite/plan/run, leaving this one alone.
   - **Dismiss** — ignores them; they stop nagging.
4. Pick one (e.g. **Add to this**) → banner clears, membership updates.

**Say:** "New cases that match the tag are never added silently. You review and choose — add here, fork
a new group, or dismiss. And each container decides independently."

*(To generate a fresh notification live: Test Cases → New Case → tag it `@versioning-demo` → save, then
reopen the suite — the banner reappears.)*

---

## 6. Content drift — "a newer version exists" (2 min)

**Do:**
1. In **Test Cases**, edit the `[VDEMO] Checkout` case once (change a step) and save — this mints a new
   version, so any container pinned to an older version is now behind.
2. Open the **`[VDEMO] Versioning suite`** (which pins that case to an old `@vN`).
3. Show the **amber banner**: **"1 case has a newer version than pinned … @v3 → @v11"** with an
   **Update to latest** button.
4. Click **Update to latest** → the pin clears (case now follows **@latest**), banner disappears, the
   Version column flips to **@latest**.

**Say:** "The flip side of pinning: if I pinned an old version and a newer one lands, I get told —
'@v3 → @v11'. One click updates to latest, or I leave the pin to stay reproducible. My choice, never
automatic."

---

## 7. The linked hierarchy (1 min)

**Do:**
1. Left nav → **Test Plans** → open **`[VDEMO] Versioning plan`**.
2. Show the tabs: **Linked Test Suites**, **Linked Test Cases**, **Linked Test Runs** — the full
   **Plan → Suite → Cases + Run** chain, all built from tags.
3. Point out the **Version** column on the plan's cases and its own **drift banner**.

**Say:** "One plan, one tag query, and the whole hierarchy — suite, cases, run — hangs together, each
level with its own review-gated drift and version control."

---

## 8. (Optional) Automated runs only offer scripted cases (30 sec)

**Do:**
1. **Test Runs → New Run → Run Type: Automated.**
2. **Test Cases with Playwright Scripts** → **Search & link by tag** → note the picker only offers cases
   that actually have a script.

**Say:** "For automated runs we only let you pick cases that can actually execute — no dead runs."

---

## 9. Cleanup (after the demo)

- Delete anything tagged **`@versioning-demo`** or prefixed **`[VDEMO]`** (Test Cases / Suites / Plans /
  Runs search → select → delete), or just leave it and re-seed next time.
- `npm run test:versioning-e2e` is self-cleaning and safe to run anytime.

---

## Quick reference — talking points cheat sheet

| Feature | One-liner |
|---|---|
| Tag-native composition | "Pick a tag, preview matches, create — no folders." |
| Version graph | "Git for test cases: history, diff, restore — append-only." |
| Version pins | "Same case at @v5 here, @v3 there, HEAD @v11 — independent." |
| Membership drift | "New matches → add / create-new / dismiss. Never silent." |
| Content drift | "Pinned behind latest? '@v3 → @v11 · Update to latest'." |
| Hierarchy | "Plan → Suite → Cases + Run, all from one tag query." |

## If something looks off mid-demo
- **No data / empty lists** → re-run `npm run seed:versioning-demo`.
- **A change didn't take on the backend** → restart `npm run dev:backend` (no hot-reload) and refresh.
- **Banner didn't refresh** → reload the page; drift is fetched on mount.
