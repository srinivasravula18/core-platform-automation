# Automation Data — redesigned screen (mockup, no code yet)

Goal of this doc: let you *see* the new interaction before we build it, and say "yes this is clear" or "no, still confusing." Grounded in the verified research (`automation-data-binding-ux-research.md`). No product facts hardcoded — field names below are illustrative.

Legend for value kinds (pills are color-coded):
`▦ Column` (blue) · `✦ Generated` (purple) · `⟳ Unique` (green) · `ƒ Computed` (amber) · plain text = literal.

---

## 1. The whole idea in one picture

Today you drag pills onto rows AND use a "Bind" menu AND auto-map — three ways, no clear winner. New model: **one** gesture. Each field has a `+ Get value from` button. Click it, pick where the value comes from. That's it.

```
   FIELD (from your script)          VALUE (what gets typed each run)
  ┌──────────────────────────┬─────────────────────────────────────────────┐
  │  Email                   │  ⟳ Fresh email            ▼   ✎   ✕          │
  │  First name              │  ▦ FirstName              ▼   ✎   ✕          │
  │  Date of birth           │  ▦ DOB                    ▼   ✎   ✕          │
  │  Age                     │  ƒ Age from DOB           ▼   ✎   ✕          │
  │  Password                │  ••••••••  (same every run)   ✎   ✕          │
  │  Country                 │  ＋ Get value from…                          │  ← empty field
  └──────────────────────────┴─────────────────────────────────────────────┘
        the script's fields              a pill = varies per run · plain text = same every run
```

One glance tells you: what varies per run (pills), what's fixed (plain text), and *what kind* each value is (color + icon). No "bind," no "faker."

---

## 2. Clicking `+ Get value from` — the picker

The single menu that replaces drag + bind + palette. Four plain-language categories:

```
  Country   ＋ Get value from…
            ┌──────────────────────────────────────────────┐
            │  🔎 search…                                   │
            ├──────────────────────────────────────────────┤
            │  ▦ FROM YOUR SHEET (columns)                  │
            │     Country      Region      City   …         │
            ├──────────────────────────────────────────────┤
            │  ✦ GENERATED (fake but realistic)             │
            │     Full name   Company   Phone   Address …   │
            ├──────────────────────────────────────────────┤
            │  ⟳ UNIQUE PER RUN (never repeats)             │
            │     Fresh email   Fresh username   Fresh id   │
            ├──────────────────────────────────────────────┤
            │  ƒ COMPUTED (from other fields)  ›            │
            │     Age from a date · Total · Custom formula  │
            ├──────────────────────────────────────────────┤
            │  ⌨  Type a fixed value instead                │
            └──────────────────────────────────────────────┘
```

- Each category answers one of your questions directly: "real column vs fake" is now two labelled sections ("FROM YOUR SHEET" vs "GENERATED").
- "Type a fixed value" makes the literal path explicit — no more accidental confusion between typed text and a token.

---

## 3. Computed values — the Age-from-DOB case

"Computed" opens a small builder, not a pill you have to decode. Live preview shows the real answer against row 1 before you commit.

```
  Age   ƒ Computed value
        ┌─────────────────────────────────────────────────────────┐
        │  Age  =  years between  [ ▦ DOB ▾ ]  and  [ Today ▾ ]     │
        │                                                          │
        │  Preview (row 1):   DOB 04/09/1990  →  Age = 34          │
        │  Input format:      [ DD/MM/YYYY ▾ ]   ← no more 03/04 ambiguity
        │                                                          │
        │            [ Cancel ]                [ Use this value ]  │
        └─────────────────────────────────────────────────────────┘
```

"Previous age" is the same builder with the reference date set to "1 year ago" — you'll see the preview update to 33. Power users get `⌨ Custom formula` with autocomplete + live preview; everyone else uses the plain-English pickers.

---

## 4. Auto-map — the fast start (partial + honest)

On import we match columns to fields by name and fill the confident ones. We never silently fail the rest — we flag them.

```
  ✓ Auto-mapped 5 of 7 fields.  Review the 2 we weren't sure about.

   Email          ⟳ Fresh email        ✓ high
   First name     ▦ FirstName          ✓ exact
   Date of birth  ▦ DOB                ✓ high
   Address        ▦ Addr Line 1        ~ maybe   ← click to confirm or change
   Age            —  needs a value        ✕       ← click + to set
```

Contrast with today (and with tools like Flatfile that abort everything if one column is unsure): we apply what's confident and point at what needs you.

---

## 5. Full screen — before vs after

```
  BEFORE (today)                         AFTER (proposed)
  ┌───────┬──────────┬──────────┐        ┌───────────────┬───────────────────────┐
  │ pick  │ fields   │ palette  │        │ pick script   │  Fields → Values      │
  │ script│ [drag    │ [blue    │        │ (by Test Case │  ┌─────────┬────────┐ │
  │ (folder│  pills   │  pills,  │        │  or tag)      │  │ Email   │⟳ Fresh │ │
  │  tree)│  here??] │  faker,  │        │               │  │ DOB     │▦ DOB   │ │
  │       │ + "Bind▾"│  bind,   │        │  ▶ Runs 12×   │  │ Age     │ƒ 34    │ │
  │       │ + auto   │  automap]│        │    (12 rows)  │  │ …       │＋ add  │ │
  └───────┴──────────┴──────────┘        └───────────────┴───────────────────────┘
   3 competing ways to bind               1 way: click ＋ in the field
   "bind", "faker" jargon                 plain words, color-coded kinds
   no computed values                     computed w/ live preview
```

Note "**▶ Runs 12×**": because a whole row runs together, Country/State/City from the same row stay consistent automatically — the screen says so, so you never worry about it.

---

## 6. Terminology: what you'll stop seeing → what you'll see

| Old (confusing) | New (plain) |
|---|---|
| "Bind" / "Bind ▾" | **Get value from** |
| "faker" pill | **Generated** |
| raw `{{unique.email}}` | **⟳ Fresh email** pill |
| drag a pill onto a row | click **＋** in the field |
| (no such thing) | **ƒ Computed** with live preview |
| blue-only pills | pills **color-coded by kind** |

---

## Does this remove your confusion?

Check it against what you told me:
- "which drag is gonna work" → there's no drag to choose; one `+` per field.
- "what is bind" → gone; it's "Get value from."
- "don't know about the fake" → it's a labelled "Generated" section.
- "real column vs fake" → two separate labelled sections + colors.
- Age from DOB → a builder with a live "= 34" preview.

If any row of this still feels unclear, tell me which — that's the cheapest possible time to change it. If it clicks, I'll (1) fold it into the plan as the Phase-2 interaction model, and (2) start on the data-layer fixes so there are real fields + tags to bind against.
```
