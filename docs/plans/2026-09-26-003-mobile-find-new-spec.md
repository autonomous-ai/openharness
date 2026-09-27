# Mobile: Find and New (the room, round 2)

2026-09-26. Panel: iOS, consumer, voice and dev-tools seats; the product lead (the Jobs seat) decides.

## Calls
1. **Keyboard down on open.** The list is usually the answer; the field is one tap away.
2. **No chips.** Plain typing finds every kind, in sections; `#` `@` `:` `>` (models included) stay as hidden shortcuts.
3. **Mic in the field**, turning into `✕` once there is text; the floating mic is Focus's alone.
4. **Current harness shown, last**, marked `current`, so search never misses one.
5. **Rows on top, task docked above Start.** The task is optional (first place looks required); it's the iMessage composer, in thumb reach.
6. **`Start`.** The rows above it say who and where.
7. **Plain rows, hidden when they don't apply.** No Options, More or Model row (`:` switches models). Worktree moves into the Branch picker.
8. **Command text cut.** Even a faint line reads as tappable.
9. **Full-height sheets that slide up.** Sideways is navigation.
10. **17 and 13 only.** 17 for what you decide on or tap, 13 for the rest; the terminal keeps its size.
11. **Voice-parsed New and the countdown are out.** The mic fills the task verbatim; starting takes a tap.
12. **Zero states:** below.

Mockups: one 13pt cell per character; 17pt lines fit ~34, then `…`.

## Find
Opened:
```
╭──────────────────────────────────╮
│ Search harnesses             mic │  Cancel
╰──────────────────────────────────╯
needs you
api-fix                               asking
"Run the migration on the test db?"
pr-review                             asking
"Push the branch to origin?"

recent
tests                                   idle
mini:api · main · 3h
hn                                   working
M2:autonomous-harness · main · current

+ New Harness
```
Typing "ap": Return opens the first row (#262626 ground); matches green.
```
╭──────────────────────────────────╮
│ ap▏                            ✕ │  Cancel
╰──────────────────────────────────╯
api-fix                               asking
"Run the migration on the test db?"
tests                                   idle
mini:api · main · 3h

+ New Harness in api
mini:api
──────────────── keyboard ──────────────────
```
- **Field:** 44pt, #262626, 6pt radius; `Cancel` 17pt cyan.
- **Rows:** 60pt; 17pt name, 13pt state word on the right, 13pt faint line 2. An asking row's question is white.
- **States:** `asking` yellow, `working` green, `idle`/`done` faint, `exited` red.
- **Order:** `needs you` (newest first), `recent` (last opened), current, `+ New Harness`. Headers show only on an empty query with someone asking.
- **Typing** filters in place across name, place, branch and question, adds `commands` and `models` sections, and ends on `+ New Harness in <best project>`.
- **Navigation:** tap opens Focus; Cancel or swipe left goes back.

## New
Default:
```
New Harness                           Cancel

agent        Claude Code                   ›
project      M2:autonomous-harness         ›
branch       main                          ›
approvals    Auto-approve                  ›


task (optional)
╭──────────────────────────────────────────╮
│ What should it do?                       │
│                                      mic │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│                  Start                   │
╰──────────────────────────────────────────╯
```
Task filled:
```
New Harness                           Cancel
agent        Claude Code                   ›
project      mini:api                      ›
branch       main                          ›
approvals    Auto-approve                  ›
task (optional)
╭──────────────────────────────────────────╮
│ Fix the login test that fails on CI,     │
│ then run the whole suite.▏           mic │
╰──────────────────────────────────────────╯
╭──────────────────────────────────────────╮
│                  Start                   │
╰──────────────────────────────────────────╯
──────────────── keyboard ──────────────────
```
Picking a project:
```
New Harness  (dimmed)
────────────────────────────────────────────
Project                               Cancel
╭──────────────────────────────────────────╮
│ Search projects                      mic │
╰──────────────────────────────────────────╯
recent
autonomous-harness                         ✓
M2:~/code/autonomous-harness
api
mini:~/code/api

all
blog
M2:~/code/blog

+ Open Folder
+ Clone Repository
+ New Folder
```
- **Rows:** 56pt, prefilled from the last Start. `branch` only for git projects, `approvals` only for agents with modes, `profile` only for Codex profiles. First time: a cyan `Choose a project`, and Start dimmed.
- **Task:** 3–6 lines; `1840/2000` past 1800. Task and Start ride 8pt above the keyboard.
- **Start:** full width, 52pt, green fill, black 17pt bold.
- **Pressing Start:** `Starting…`, `agent_create` with `prompt` (none if empty), then the new harness's Focus. On failure or 15s silence: red `✗ Couldn't start: M2 is offline.`, the button becomes `Try Again`, values stay. A task survives Cancel.
- **Pickers:** search on top, `✓` on current, `+` rows last. Agent: `Claude Code`, `Codex`, then `more` A–Z; faint `not on M2` if missing. Branch: `main · this folder`, `+ New Worktree`, branches. Approvals: a description line each, risky ones red.

## Zero states
- **No computer:** `No computer linked`, then `Harness runs your agents on your own computer. Open Harness on your Mac and sign in; it shows up here.`
- **Can't reach it:** `Couldn't reach your computers.` with `Try Again`.
- **Nothing running:** the app opens on New, subtitled `Nothing running yet. Start your first harness.` Find: `No harnesses running.` above `+ New Harness`.

## Terminal, but consumer-clear
- SF Mono, 17/13, regular and bold; flat, no blur or shadow.
- Colour only for meaning: yellow needs you, green working/go/match, red failed/risky, cyan tappable, faint secondary.
- Glyphs only `+ ✓ › ✕ …`; no sigils, counts or keyboard words.
- Actions Title Case, descriptions lowercase.
- Lists grow down from their search field.
- One filled button per screen; targets ≥44pt.
- Instant except page and sheet motion (200ms, no spring).

## Cut
Find: `3/3 ─── +new esc`, the legend, the scope bar, the red bar, `*`, bottom-anchored lists. New: `$ harness new …`, `⏎ tap to run`, the `options` and `worktree` rows.

## Build order
1. **Find:** top field with mic/`✕`, keyboard down, 17/13 type, rows, order, `+ New Harness in`, sections, zero state.
2. **New:** form and dock, conditional rows, Start → Focus, failure line, sheet pickers, app zero states.

Each deletes its cuts.
