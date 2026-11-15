# The dial names a session as the person named it (Diego, 2026-11-15)

Diego names his Claude app sessions "Tho", "ga" and "Math". The round dial shows the same sessions as their folders
(`scratch-2016…`). This spec makes the dial show the name the person gave the session, sent by the session's own hook,
and fall back to the folder only when the session has no name.

## Why

The folder is not the name a person knows a session by. The Claude app's scratch sessions all sit in look-alike
folders, so on the dial they cannot be told apart. The app's list and the dial should agree.

## Today

- The dial's label of an agent outside a pane is its folder: `cli/src/cable/hosts/observed.ts` sets
  `a.name = basename(e.cwd)` on every hook event, and the same when a session is first listed by a hook or by the open
  scan (`entry()`, from `row.cwd`). There is no other source of a name.
- The hook's body for such a session (`cli/hook/notify.mjs` `observedBody`) carries the engine, the session id, the
  event, the folder, the caller's pid, the transcript path and the host hints. No name.
- The core checks and bounds that body and hands it on (`cli/src/core/observedHook.ts` `parseObservedHook`); it keeps
  nothing of it.
- Claude Code (2.1.325, read in its binary on 2026-11-15) puts the session's title in the hook input as
  `session_title` on `SessionStart` and `UserPromptSubmit`. That title is the person's own (`currentSessionTitle`),
  not the one Claude Code generates (`aiTitle`). A rename in the app reaches the session as the control request
  `rename_session` (`source: 'host'`), which saves it as the session's title, so every later hook carries the new name.
- Harness already reads `session_title` for its own panes' sessions (`notify.mjs`, the registry rows' `title`). Only
  the path for sessions outside a pane drops it.
- The harness-device mod cannot say the name: its `$.session` offers `id`, `surfaces`, `usage` and `version`, no title.
- Harness's hook is installed for `SessionStart` and `UserPromptSubmit` already (`engines/claude/hookContract.ts`).

## Decided (Diego through the PM, 2026-11-15)

1. **The session's own hook says its name.** Nothing reads the Claude app's stores, another session's files, or any
   conversation content. The open scan does not read a transcript's title lines either.
2. **Folder as the fallback.** A session with no name shows its folder, as today.
3. **The name rides the observed body (option A).** One optional, bounded field, `title`, on the body the hook already
   posts. The core checks it and keeps nothing, as it does for `relayed` (#4331). This adds one field to the core's
   observed path. It moves out of the core with the rest of that path in the follow-up to cli/AGENTS.md rule 7 (the
   devices' routes move to `devicesListener`). The PR says so.
4. **The check on the real Claude app** (rename a session in the app, the dial follows) is done in the joint test
   session with Diego, not in this PR's checks.

## Design

### The hook (`cli/hook/notify.mjs` `observedBody`)

- When the input has a string `session_title`, the body carries it as `title`: whitespace runs folded to one space,
  trimmed, cut to 64 UTF-16 units (`MAX_TITLE`, the unit the core's `bounded` counts) without splitting a surrogate
  pair, then trimmed again. An empty result, or one with a control character left, is left out. Any engine whose hook
  sends `session_title` gets it; today that is Claude Code.
- Only on `session-start` and `turn-start`. Claude Code puts `session_title` in every `SessionStart` (startup, resume,
  clear, compact: one function builds that input, read in the 2.1.325 binary) and every `UserPromptSubmit` while the
  session has a name, and leaves it out when it has none. For Claude Code, `turn-start` is `UserPromptSubmit` alone.
- The body's 4096-byte bound: `transcriptPath` is dropped first, then `cwd`, as today. The title is never dropped: at
  most 64 units (≤ 192 bytes), it fits beside the hints and ids once both paths are gone, so a missing title always
  means the hook sent none.

### The core (`cli/src/core/observedHook.ts`)

- `title` is optional on the hook event. A `title` that is not a non-empty bounded string (64 UTF-16 units, no control
  character, the same `bounded` check as the folder's), or one on any event but `session-start` and `turn-start`
  (`asked` included, checked before its early return, as #4331 checks `relayed`), refuses the whole event, as a bad
  hint does: an honest hook never sends one.
- The core keeps nothing, logs nothing of it, and hands it on with the event.

### The devices process (`cli/src/cable/hosts/observed.ts`)

- An agent's name: its title when it has one, else the name of its last known folder (`a.cwd`), else the engine (as
  today).
- A `session-start` or `turn-start` with `title` sets the title, a new one renaming the agent.
- A Claude Code `session-start` or `turn-start` with no `title` clears the title (the person removed the name), and
  the name is the folder's again. Only Claude Code: its hook says the name on each of these events. Another engine's
  event with no title leaves the name as it is (Command Code's `turn-start` is every tool call).
- Every other event leaves the name as it is. A folder in an event still updates `a.cwd`, and sets the name only while
  the agent has no title.
- A session first listed by the open scan shows its folder until its first `session-start` or `turn-start`.
- The name reaches the dial as a Harness agent's does. The firmware holds 40 bytes of it (`CABLE_NAME_MAX`), as for
  any agent's name; nothing new is cut here.

### What the person sees

- A Claude app session named "Tho" reads "Tho" on the dial from its next `SessionStart` (start, resume) or prompt.
- A rename in the app shows on the dial at the session's next prompt. While the session is idle, the dial keeps the
  old name.
- A session found open by the scan, with no hook since, reads its folder until its next prompt.
- A session with no name reads its folder, as today.

## Design (docs/feature-design-rules.md)

Reviewed revision: this spec's first commit on `fix/dial-session-name`  Reviewer: P1 builder-check + PM

1. Growth: the name is one field of an agent the observed source already holds in memory (at most 50). It goes when
   the agent goes (session end, dead pid, 12 h silent). Nothing new is stored.
2. Concurrency: the devices process is one event loop. Events for one session arrive in the order the hooks posted
   them; the last `session-start` or `turn-start` wins.
3. Read cost: at most 64 UTF-16 units (≤ 192 bytes) more on two hook events per prompt, inside the existing 4096-byte
   body. No new read path, no file read.
4. Scale: 10x sessions hits the existing 50-session bound first. No new list or fan-out.
5. Compatibility: the hook and the core ship in the same build. An older core's parser ignores a field it does not
   know, so a newer hook with an older daemon shows folders. A newer core with an older hook gets no `title` and shows
   folders. Readers of `HostAgent.name` (the dial's list, the voice refusals "<name> did not answer.", `describe`) get
   the title instead of the folder, which is the intent.
6. Migration and rollback: none. Rolling back shows folders again.
7. Audience: the title is the person's own label for their own session on their own computer. It goes from the hook
   to the core (checked, not kept), to the devices process (memory), and to the dial over USB. An agent outside a pane
   is only in this computer's registry, never in the fleet router (`cableHost.ts` `describe`), so it does not reach
   another machine, the backend or the phone. It is never logged, put in an error, or counted.
8. Identity: N/A. Nothing runs as anyone; the hook runs as the session's own user, as today.
9. Failure: a title the core refuses loses that one event, as a bad hint does today, and is counted in the core's
   minute line (`refused`). The hook cuts and checks the title with the core's own bounds, so an honest hook's event
   is never refused for it. The size bound never drops the title. Nothing fails silently beyond what the existing
   counters show.
10. Platforms: the hook runs on macOS, Linux and Windows alike; the change is plain JavaScript in the hook and
    TypeScript in the core and the devices process, with no platform branch. PR CI runs the three unit specs on
    Linux, and the end-to-end check runs on this Mac and on Linux CI. Windows is not run: the by-hand Windows workflow
    runs a fixed list of files without these, and the change is the same code there (decided by the PM, 2026-11-15).

## Data

- **What:** the session's title, as the person gave it in the engine (`session_title`).
- **Where:** the hook's body to the daemon's local hook route, the devices process's memory, the dial over USB.
- **Kept:** in memory only, while the agent is listed. Never written to disk, a log, an error, a measure, the backend,
  the phone or the gateway.
- **Bounded:** 64 UTF-16 units, no control characters, two events per prompt.

## Measures

None new. The title has no target to measure against; the existing counters (the core's refused and dropped hook
events, the observed source's scan line) already show a refused event. No count carries the title or the session.

## Out of scope (follow-ups)

- Moving the observed path, `title` included, out of the core to `devicesListener` (the rule 7 follow-up).
- A name for a session the scan found before its first hook (it would need a transcript read, which decision 1 rules
  out).
- A rename while the session is idle reaching the dial before the next prompt (Claude Code sends no hook for it).
- Names of other engines' sessions whose hooks carry no title.
- The firmware cutting a 40-byte name inside a multi-byte letter (true of every agent's name today).

## Done when

**Tests (red first)**

- `observed.spec.ts`:
  - a Claude `turn-start` with `title: 'Tho'` and `cwd: '/…/scratch-2016…'` lists the agent as "Tho";
  - a later `turn-start` with `title: 'Math'` renames it "Math";
  - a later `turn-stop` with a folder keeps "Math";
  - a later Claude `turn-start` with no title reads the last known folder again, also when that event has no `cwd`;
  - a `session-start` with a title on a session the scan listed renames it;
  - another engine's `turn-start` with no title keeps its title.
- `observedHook.spec.ts`: `title` is passed on for `session-start` and `turn-start`; a title over 64 UTF-16 units,
  empty, with a control character, not a string, or on another event (`asked` and `turn-stop` among them) refuses the
  event.
- `hookNotify.spec.ts`:
  - a Claude `UserPromptSubmit` and a `SessionStart` with `session_title` post `title`;
  - whitespace runs are folded and trimmed;
  - a longer title is cut at 64 UTF-16 units, never inside a surrogate pair (an emoji title at the limit), and trimmed
    after the cut;
  - an empty title, or one with a control character, is left out;
  - no `title` on `Stop`;
  - with an oversized body, `transcriptPath` goes, then `cwd`, and `title` stays.

**End to end**

- Beside the Orca-session checks that drive the installed hook with chosen fields (`cli/e2e/harness/inOrca.ts`
  `InOrca.hook(event, fields)`, from #4331, e.g. in `cli/e2e/deviceClaudeOrca.e2e.ts`): a session outside a pane reads
  its folder on the fake dial after a `SessionStart` with no `session_title`, then "Tho" after a `UserPromptSubmit`
  with `session_title: 'Tho'`. The fake engine itself sends no `session_title`, so this drives the hook directly.

**With Diego (joint test session, not this PR)**

- A Claude app session renamed in the app reads its new name on the dial after the next prompt.

## Order of work

Code waits for #4311, #4326 and #4331 to merge (they touch the same files); the orchestrator says when.
