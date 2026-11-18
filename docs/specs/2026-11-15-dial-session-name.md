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

## Decided late (the PM, 2026-11-15)

5. **A session the open scan finds is named from its own process record.** Claude Code keeps
   `~/.claude/sessions/<pid>.json` for each running session, and the scan already reads it to find the session's owner.
   That record holds the session's name (`name`) and where the name came from (`nameSource`: `user` for a name the
   person gave, `derived` for one Claude Code made up). The devices read `name`, `nameSource`, `entrypoint` and
   `hostSessionId` of that one record (beside `sessionId`, decision 6), by `cli/src/cable/hosts/record.ts`, and nothing
   else from it. `hostSessionId`, the Claude app's own id of the session, is taken only from a `claude-desktop` record
   and used only in the Claude app's link; it is never shown, logged, sent or stored. (Widened 2026-11-18 for a swipe
   before the first hook, [design](../plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md).) A `user` name is shown, and, for the Claude
   app alone, a name with no `nameSource` when `entrypoint` is `claude-desktop`: the app sets that title itself, and its
   hook sends the same string as `session_title` on the next prompt. A `derived` name, and a CLI record with no
   `nameSource`, are still refused: a `derived` name can come from what was first asked, and the hook never sends one
   either. (Widened 2026-11-17 for the Claude app,
   [the recap after a restart, decision 2](../plans/2026-11-17-dial-recap-after-restart-design.md).) This narrows decision 1 for the scan alone: the session's own record, written by the session
   itself, is read; still nothing from the Claude app's stores, another session's files, or any conversation. Found while
   diagnosing Diego's report that two idle Claude app sessions were missing from the dial (the scan's miss is its own
   fix, `fix/process-table-full-comm`).

6. **The record must still name the session.** The scan's owners can be a few seconds old: a session that `/clear`s or
   `/resume`s in that time leaves `<pid>.json` naming another session. The record's `sessionId` is read too, and its
   name is taken only when that id is the listed session's (as `confirmOwner` in `engines/kit/adoption.ts` checks).
   It is an id, not content. (The PM's recommendation, taken after 3 minutes, 2026-11-15, from the final review.)
7. **A session first heard of by a hook other than a start keeps its folder until its next prompt** (after a daemon
   restart, a busy session's first hook can be its Stop, and the scan does not list a session already known). Left as
   a follow-up, not in this PR.

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
- A session first listed by the open scan takes the name in its own process record (below), else its folder, until its
  first `session-start` or `turn-start`, whose title (or none, for Claude Code) wins from then on.
- The name reaches the dial as a Harness agent's does. The firmware holds 40 bytes of it (`CABLE_NAME_MAX`), as for
  any agent's name; nothing new is cut here.

### The open scan's name (`observed.ts` `scanOnce`, read in the devices process)

- Claude Code only. For each session the scan lists, the owner's `record` path names the process record it was found
  by. It is read only when that path is `<a sessions folder>/<owner pid>.json`, the shape `recordOwners`
  (`engines/kit/adoption.ts`) claims from: an owner claimed from its arguments has no record, and a transcript is never
  opened here.
- One read of at most 16 KiB (a record is about 1–2 KiB): a larger file, one that is not JSON, or one whose `name` is not
  a string gives no name. `nameSource` must be the string `user`, or absent with `entrypoint` `claude-desktop`, and `sessionId` the listed session's (decision 6). The name is cleaned and cut as the hook's title is
  (whitespace folded, trimmed, 64 UTF-16 units without splitting a surrogate pair, none with a control character).
- Read in the devices process, by the scan's own reader, for the sessions it lists in that look (at most 50), after the
  rows and apps are read and under the same look: a session a hook told of meanwhile keeps what the hook said.
- A read that fails leaves the folder. It is counted in the scan's line (`n named`), never with the name or a path.
- Read once, as a session is first listed. Later names come from its hooks.
- Nothing in the core changes for it: the record path is already on the scan's `SessionOwner`.

### What the person sees

- A Claude app session named "Tho" reads "Tho" on the dial from its next `SessionStart` (start, resume) or prompt.
- A rename in the app shows on the dial at the session's next prompt. While the session is idle, the dial keeps the
  old name.
- A session found open by the scan, with no hook since, reads the name the person gave it (from its own record), else
  its folder.
- A session with no name reads its folder, as today.

## Design (docs/feature-design-rules.md)

Reviewed revision: this spec's first commit on `fix/dial-session-name`, and decision 5 at `61b5dcc40d`  Reviewer: P1 builder-check + PM

1. Growth: the name is one field of an agent the observed source already holds in memory (at most 50). It goes when
   the agent goes (session end, dead pid, 12 h silent). Nothing new is stored.
2. Concurrency: the devices process is one event loop. Events for one session arrive in the order the hooks posted
   them; the last `session-start` or `turn-start` wins.
3. Read cost: at most 64 UTF-16 units (≤ 192 bytes) more on two hook events per prompt, inside the existing 4096-byte
   body. One new read: the scan reads at most 16 KiB of each session's own process record it lists, once, at most 50
   a look, beside the reads of the same folder it already makes to find owners.
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

- **What:** the session's title, as the person gave it in the engine (`session_title` in its hook, `name` with
  `nameSource: user`, or with no `nameSource` and `entrypoint: claude-desktop`, in its own process record).
- **Where:** the hook's body to the daemon's local hook route; the session's process record, read by the devices process;
  the devices process's memory; the dial over USB.
- **Kept:** in memory only, while the agent is listed. Never written to disk, a log, an error, a measure, the backend,
  the phone or the gateway.
- **Bounded:** 64 UTF-16 units, no control characters, two events per prompt; one record read of at most 16 KiB per
  session the scan lists, at most 50 a look.

## Measures

The scan's existing line gains a count: `[observed] scan · 7 found · 7 app known · 3 named · 57 ms`. Nothing else new:
the core's refused and dropped counts already show a refused hook event. No count carries a title, a session or a path.

## Out of scope (follow-ups)

- Moving the observed path, `title` included, out of the core to `devicesListener` (the rule 7 follow-up).
- The scan missing Claude app sessions altogether (`ps` cuts their path, so their owner is never claimed): its own
  item, `fix/process-table-full-comm`. Until it lands, decision 5 names only the sessions the scan finds.
- Engines other than Claude Code in the scan.
- A session first heard of by a hook other than `session-start` or `turn-start` reading its record's name (decision 7).
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
  - a Claude session the scan lists whose record says `name: 'Tho', nameSource: 'user'` reads "Tho"; `derived`, a
    missing or non-string name, a record over 16 KiB, a read that fails, or a record path not shaped
    `<sessions>/<pid>.json`, or a record whose `sessionId` is another session's, read the folder; a hook that came while the scan read keeps its own name; a later Claude
    `turn-start` with no title reads the folder; the scan's line counts the named ones;
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
- After `fix/process-table-full-comm` lands: with a named, idle Claude app session open, a dial plugged in (or a daemon
  restarted) reads that name before any prompt.

## Order of work

Code waits for #4311, #4326 and #4331 to merge (they touch the same files); the orchestrator says when.
