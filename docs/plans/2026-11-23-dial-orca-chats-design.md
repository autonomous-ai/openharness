# The dial controls Orca's chats and terminals, and follows them (Tony, 2026-11-23)

On top of [the dial follows Orca's tabs](2026-11-16-dial-orca-focus-order-design.md) (#4363, #4381),
[the swipe stays in the worktree on screen](2026-11-18-dial-orca-tab-scope-design.md) (#4434),
[the Orca plugin set up by default](2026-11-19-device-orca-default-on-design.md) and
[a ring that replaces a full one](2026-11-20-dial-orca-pick-choose-pane-design.md) (#4522). The round dial only.
The Harness Pro and the Harness Max come later (Tony, 2026-11-23).

## Why

Tony (2026-11-23): Orca's sidebar lists 17 agents across six worktrees. The dial's APPS page says "Orca · 2 agents",
and a tap on it opens "Choose a pane". The goal: the dial controls Orca's terminals **and its chats**, and Orca moves the
dial back.

## What we found (read only, 2026-11-23: Orca 1.4.271, CLI 0.6.83-dev.f15107c0b9, round dial firmware 0.1.5)

- **Every agent in Tony's Orca is a chat, none is a terminal.** `orca agent list --json` gives 17 rows, all
  `kind: "chat"` (16 Claude, 1 Codex). `orca terminal list --json` gives 0 terminals and no `visualLayouts`.
- **A chat is a process Orca drives, with no terminal.** `claude --output-format stream-json --input-format stream-json`
  (and Codex likewise), a child of `orca-provider-exec` under `Orca Agents`, on no tty. Its environment has
  `ORCA_AGENT_SESSION_ID`, equal to the chat's `orcaSessionId` in `orca agent list`, and `ORCA_STRUCTURED_SESSION=1`.
  It has no `ORCA_TERMINAL_HANDLE`.
- **The devices know Orca only by its terminals.** The adapter, the order, the names, the scope and the focus follow
  all read terminal handles (`cable/hosts/orca.ts`, `services/devices.ts`). A chat's hook already sends
  `ORCA_AGENT_SESSION_ID` (`cli/hook/notify.mjs`), and `hostDetect.ts` puts it on Orca's page, so a chat whose process
  ran a hook since the devices started is on that page with no pane. That is the "2 agents".
- **Why the tap shows "Choose a pane".** With Orca settled in front, Orca's ring is the agents whose Orca terminal is in
  the worktree on screen (#4434). The plugin says `orca front · set · 0 terminals`, so the ring is empty
  (`agents → 0 of 0`) and the firmware draws its no-agent caption (`ui_habitat.c`, `"Choose a pane"`). A prompt in a
  chat logs `prompt · skipped · no tile`.
- **The Max branch already reads Orca's chats.** `feat/harness-max-v4` (`6decff7e69`, not on `main`) adds
  `cable/hosts/orcaChatSource.ts`: `orca agent list --json` every 5 s while a Max is attached, the newest 16 chats as
  resting rows, a chat a hook named folded into the hooked copy by `ORCA_AGENT_SESSION_ID` (`observed.ts`
  `orcaSessions`). Its `3a87f4b48a` keeps the dial and the Pro on the worktree on screen.
- **A live Claude chat may already take words through Harness's mod.** The chat's Claude Code loads Harness's
  `harness-device` plugin (its hooks fire), whose mod polls the devices' inbox and submits what it gets with
  `$.prompt.submit({ text, asUser: true })` (`plugins/harness-device/hooks/device.js`, `cable/hosts/inbox.ts`). The
  devices' `observed.send` tries that mod before any pane (`observed.ts`), as the Claude app's sessions do. Nothing
  checks the surface on poll, and nothing has tried it in a chat Orca drives over stream-json: whether Orca's chat shows
  the words, in order, as the person's own is not known.
- **The hint arrives, under a cap.** `ORCA_AGENT_SESSION_ID` is in the hook's `HOST_HINTS` (`notify.mjs`), cut to 64
  characters (a UUID is 36), but `MAX_HINTS` is 10 and the Orca names are near the end of the list: a caller with ten
  other hints set loses it.
- **The plugin's worktree id is Orca's own.** Orca gives `workspaceId` in `workspace.changed` as `identity:<key>` when
  the worktree has an identity, else as the worktree's `id` itself (its bundle, `plugin-host-api` `Ve`; at most 1024
  characters). `orca worktree list --json` gives each worktree's `identity.key` (`wt2:local:<uuid>`) beside its `id`
  (`<repo uuid>::<folder>`, the `worktreeId` of `orca agent list`).
- **Task 0 (2026-11-23, Tony's Mac).** `orca agent list --json`: 17 chats, all `hostId: local`, ids of 36 and 43
  characters, 0.26 s and 14 KB. `orca worktree list --json`: 14 worktrees, 0.21 s and 28 KB; 12 have an identity, every
  key `wt2:local:<uuid>`; the 2 without hold 6 of the 17 chats, so the plugin names them by their `id`. Every chat's
  `worktreeId` is a worktree's `id`. The devices' log holds 229 `prompt · skipped · no tile`: chats' hooks reach them.

### What Orca 1.4.271 offers

| Need | CLI | Plugin API (trusted worker) | Orca's own runtime (not offered) |
|---|---|---|---|
| List chats and terminal agents | `orca agent list --json`: `orcaSessionId`, `kind`, `agent`, `state` (working, blocked, waiting, done), `worktreeId`, `workspace`, `repo`, `hostId`, `paneKey`, `title`, `lastAssistantMessage`, `updatedAt`. About 0.2 s and 14 KB for 17 rows | `agents.list` (one workspace: `terminalId` null for a chat, `agent`, `state`, provider `sessionId`, task title) | |
| The worktree on screen | none (`--worktree active` reads the caller's folder) | `workspace.changed`: `workspaceId`, `branch`, `displayName`, `terminals` (at most 50). No chats, no focused tab | |
| Bring a terminal up | `orca terminal switch`, `orca worktree activate` | `terminal.focus`, `workspace.open` | |
| Bring a chat up | none | none | `agentSession.reveal`, `session.tabs.activate` |
| Words into a terminal | `orca terminal send --enter` | `terminal.sendText` | |
| Words into a chat | none | none | `agentSession.send` |
| Which pane has focus | `orca terminal watch-focus`: not in 1.4.271 (stablyai/orca#42555, open since 2026-11-15) | none | |
| Chat state pushed | none | `agent.status.changed` (`paneKey`, `workspaceId`, `state`) | `agentSession.subscribeStatus` |
| Order of chat tabs | none (`visualLayouts` holds terminals only) | none | `session.tabs.list` |
| Answer a chat's question or approval | none | none | `agentSession.respondToQuestion`, `respondToApproval` |

So with Orca as it ships, the dial can **list** chats, **scope** them to the worktree on screen, **bring up their
worktree**, and **follow a prompt** typed in one. It cannot open the exact chat tab, put words in a chat, or follow a
click on a tab. Those three need Orca to offer them (Part 2).

## Goal

While Orca is the settled front app and the dial says `appFilter`:

1. Orca's ring is every agent of the worktree on Orca's screen, its terminals and its chats.
2. A rest or a tap on one brings it up in Orca: a terminal's tab today; a chat's worktree today and its exact tab once
   Orca offers it.
3. The dial's words reach it: a terminal today; a chat once Orca offers it.
4. Orca moves the dial back: a change of worktree changes the ring, a prompt moves the dial to its agent, and (once Orca
   offers it) a click on a tab or chat moves the dial to it.
5. Once Orca offers it, the dial answers a chat's question or approval.

The APPS page's Orca count is every Orca agent, chats included, as today for terminals.

## Decided (Tony, 2026-11-23)

1. **Two parts.** Part 1 ships with Orca 1.4.271 and needs no change in Orca. Part 2 is the three commands Orca lacks,
   proposed upstream as #42555 was. Harness finds each by `orca <group> --help`, read once per Orca binary (its real path
   and mtime, as `orcaWatchesFocus` does), and turns it on by itself: no setting, no Harness release tied to Orca's.
2. **Orca's own list is the source of chats.** `orca agent list --json`, never Orca's files or its runtime's private
   calls. Rows with `hostId` other than `local` are left out.
3. **Push, not poll.** The list is read at a dial's attach, when Orca settles in front, when the plugin reports a new
   worktree on screen, and after a hook of an Orca chat (one carrying `ORCA_AGENT_SESSION_ID`). One read at a time, a
   request during a read asks one more after it. No timer (the Max branch's 5 s poll is not taken).
4. **One row per chat.** A chat with a live process is the hooked copy (its engine's own session id), folded with Orca's
   row by `ORCA_AGENT_SESSION_ID`, as the Max branch does. A chat with no process is a resting row named by its Orca
   title.
5. **The worktree on screen is told by the plugin as Orca names it.** The plugin adds the focused workspace's id, as
   Orca gives it, to its `orcaFront` message. An `identity:<key>` is matched to a chat's `worktreeId` through
   `orca worktree list --json` (`identity.key` to `id`), read with the chats; any other is the worktree's `id`, the
   `worktreeId` itself (Task 0: 6 of Tony's 17 chats are in such worktrees). It holds the worktree's folder, as the
   `worktreeId` the devices already read from Orca's CLI does. Only the devices see it, in memory, never in a log.
   Without it (an older plugin), chats are not scoped and Orca's ring is as today.
6. **Order inside a worktree.** Terminals in tab order (as today), then chats in `orca agent list`'s order. Orca does
   not expose the order of chat tabs. Part 2 asks for it.
7. **A chat without Orca's reveal.** A rest or a tap runs `orca worktree activate` for the chat's worktree and brings
   Orca forward: the person sees the worktree, not yet the exact chat.
8. **Words for a chat without Orca's send.** A live chat may already be reachable by the routes Harness has for any
   live session: the mod's `prompt.submit` for Claude Code, `codex queue` for Codex (`observed.ts` `send`). Task 0
   tries each, by hand on Tony's Mac, in an Orca chat. A route whose words Orca's chat shows as the person's own
   message, in order, with its queue and history right, is kept for Orca's chats in Part 1. A route that does not is
   turned off for them, and the dial says `Type in Orca for chats.` (a voice refusal, as Cursor's agent has); so does a
   chat with no process. Either way it is decided, never left to whichever route `observed.send` happens to try. Once
   Orca offers `orca agent send` (Part 2), every chat takes words through it. Tony (2026-11-23): a route that passes
   is used at once; one that does not waits for `orca agent send`. The repo has no test of either route in a chat
   (`deviceClaudeOrca.e2e.ts` holds the mod's poll in an Orca terminal only), so Task 0 is by hand and Tasks 2 and 7
   lock in what it finds.
9. **Nothing in the core** (cli/AGENTS.md rule 7). Everything is in the devices process and the plugin; the hook's
   existing hints already carry what is needed.

## Part 1: with Orca 1.4.271

### Orca's chats (`cable/hosts/orcaChatSource.ts`, from the Max branch)

- **Taken from `6decff7e69`** with three changes: it runs for every dial that says `appFilter` (no Max gate); it reads
  on the pushes of decided 3, not every 5 s; and it keeps each chat's `worktreeId`, so the scope can use it.
- **What it reads.** `orca agent list --json`, 5 s timeout, stdout bounded by `execFile`'s 1 MiB, at most 256 rows
  parsed. A row is held to the shape it knows: `kind: "chat"`, an `orcaSessionId` of at most 128 characters with no
  control character, an `agent` that matches `^[a-z][a-z0-9-]{0,31}$`, a finite `updatedAt`, a `worktreeId` of at most
  4160 characters with no control character. Any other row is skipped. A whole answer of another shape is a failed read.
- **What it keeps.** At most 64 chats, newest first, in memory: `orcaId`, `engine`, `name` (Orca's title, else the
  workspace, else the CLI), `worktreeId`, `state` (`working`; `blocked` and `waiting` as needs-you; else idle), `at`,
  and Orca's preview of the last answer, cut as a card cuts it (`cutAnswer`). Cleared when no dial is attached, when a
  read fails, and when the process stops.
- **Which Orca it can read.** `orca agent --help` lists `list`. An older Orca has no chats on the dial, as today.
- **Log.** Counts and fixed words only: `[orca-chat] listed · <n> chats · <m> heard`, once per change of counts, and
  `[orca-chat] read · failed · exit|no answer|unreadable`, once per run of failures. Never a title, folder or id.

### The hooked copy (`cable/hosts/observed.ts`)

- `orcaSessions()` from the Max branch: the session each hooked agent runs, by the `ORCA_AGENT_SESSION_ID` its hints
  named. A hook of an Orca chat also asks `orcaChatSource` for a read (decided 3), so a new chat joins the ring at its
  first hook, not at the next attach.
- **The hook does not change.** A chat runs on no tty and in no multiplexer, so of the hints before Orca's it can only
  have the app's two names and whatever Orca's own environment passed on: far under the cap of 10. Task 0 checks it on
  Tony's Mac. An id cut at 64 characters would match no chat and leave two rows, not a wrong one; Orca's are 36.

### The worktree on screen (`plugins/harness-device-orca`, `services/devicesListener.ts`)

- **The plugin** adds `workspace` to `orcaFront`: the `workspaceId` of `workspace.changed`'s context as Orca gives it,
  when it is 1 to 1024 characters with no control character, else `null`. It needs no new capability or event:
  `workspace:read` and `workspace.changed` are what it has.
- **The listener** takes `workspace` when it is absent, `null` or a string of 1 to 1024 characters (Orca's own limit)
  with no control character. Anything else refuses the message, counted as the other refusals are. Nothing of it is
  logged.
- **The match.** An `identity:` id goes through `orca worktree list --json`, read with the chats when the map lacks it
  (same pushes, same bounds), which maps `identity.key` to `id`. Any other id is compared with `worktreeId` as it is. An
  id that matches nothing scopes no chat.

### The ring (`services/devices.ts`)

- **The scope** (`cableHost.setScope('orca', …)`, #4434) gains the chats: an agent is in scope when its Orca terminal is
  in the plugin's terminals (today), **or** it is a chat whose `worktreeId` is the plugin's `workspace`.
- **The order** is decided 6: the rank the devices give `cableHost.setRank('orca', …)` gains the chats, after the
  terminals' places. `cableHost.ts` and `select.ts` do not change.
- **The APPS count** is every Orca agent, chats included.
- A worktree on screen with neither terminals nor chats is still an empty ring (#4434 decided 3).

### Dial to Orca (`cable/hosts/orcaChat.ts`, new adapter)

- **One adapter for both copies.** A hooked chat's pane is its Orca session id, from `ORCA_AGENT_SESSION_ID` in hints
  that have no `ORCA_TERMINAL_HANDLE` (an agent in an Orca terminal keeps today's adapter); the observed source uses it
  as any adapter. A chat with no process reaches the same verbs through `orcaChatSource.focus`.
- **Rest and tap:** `orca worktree activate --worktree id:<worktreeId> --json`, then Orca comes forward as every app does
  (`open.ts`). The `worktreeId` is the chat source's, looked up by the Orca session id. The id is one argument, never a
  shell's, held to the bounds above. One run at a time per chat; a second is that same run. A chat the last read did
  not list has no worktree: the tap brings Orca forward alone.
- **Words:** decided 8. A route Task 0 kept: `observed.send` as today. Otherwise `voiceRefusal` says
  `Type in Orca for chats.`. Answering a question: not in Part 1; the dial shows it, as today (Part 2 answers it).
- **Terminals:** unchanged (`cable/hosts/orca.ts`).

### Orca to the dial

- **Worktree:** the plugin's `orcaFront` changes the ring (today, now with chats).
- **Prompt:** a chat's turn-start hook moves the dial to it while Orca is in front (`followLocal`), now that the chat is
  a tile in scope. The log says `prompt · moved` where it said `no tile`.
- **State:** a chat's working, done and needs-you come from its hooks while its process runs, and from Orca's list
  otherwise.
- **A click on a tab or chat:** not followed until Part 2.

## Part 2: what Orca needs to offer (upstream, stablyai/orca)

One pull request to Orca, in the shape of #42555, each command thin over what Orca's runtime already has. Harness turns
each on when `--help` lists it (decided 1).

| Command | Over Orca's | Turns on in Harness |
|---|---|---|
| `orca agent reveal <orca_session_id> [--json]` | `agentSession.reveal` | A rest or a tap opens that very chat |
| `orca agent send <orca_session_id> --text <t> [--wait-submit <s>] [--json]` | `agentSession.send` | The dial's words go into the chat, as `orca terminal send` for a terminal |
| `orca agent watch-focus --json`: one line per focus change, `{"kind":"chat","orcaSessionId":…}`, `{"kind":"terminal","handle":…}` or `{"kind":null}` | the tab and pane focus `session.tabs` tracks | A click on a chat or a terminal moves the dial; replaces `orca terminal watch-focus` (#42555) for Harness |
| `orca terminal list --include-visual-layouts` with chat leaves (`type: "chat"`, `orcaSessionId`) | `session.tabs.list` | Chats in tab order beside the terminals |
| `orca agent respond <orca_session_id> --question <id> --answer <choice>` and `--approval <id> --allow\|--deny` [--json] | `agentSession.respondToQuestion`, `respondToApproval` | The dial answers a chat's question or approval, as it answers a Harness agent's (Tony, 2026-11-23: in Part 2) |

Harness's side of Part 2: `orcaChat.ts` gains `reveal`, `send` and `respond` (the same bounds and one-at-a-time rules
as the terminal adapter); `devices.ts` gains a focus watch that prefers `orca agent watch-focus`, with today's terminal
watch where only that exists, and the echo guard of #4381 decided 5 keyed by handle or Orca session id; the order read
takes chat leaves; a chat's question reaches the dial with its choices (from the chat's hook while its process runs,
from `orca agent list`'s `blocked` and `waiting` otherwise) and the answer goes back by `orca agent respond`.

## Data

- **What is read.** Orca's list of its chats: ids, CLI, state, worktree id (which holds the worktree's folder), title,
  a preview of the last answer and a time. Orca's list of worktrees: each one's `id` and `identity.key` alone. The
  focused workspace's id from the plugin (an identity key, or the worktree id with its folder).
- **Where it goes.** The devices process's memory only. Titles and the answer preview reach the dial over USB, as the
  other apps' names and recaps do. Nothing is written to disk or logs, nothing leaves the computer, and nothing reaches
  the core.
- **Trust.** Both are outside text from another program: held to the bounds above before use, and each id that reaches
  a command line is one argument with no shell.

## Design (docs/feature-design-rules.md)

1. Growth: in memory only. A chat row goes at the next read without it, when no dial is attached, at a failed read and
   at the process's end. At most 64 chats and one workspace id. [x]
2. Concurrency: one read at a time in the devices' event loop; a request during a read asks for one more after it.
   The ring reads the last finished read. [x]
3. Read cost: one `orca agent list --json` per push, about 0.2 s and 14 KB for 17 chats (measured 2026-11-23); no read
   while no dial is attached. [x]
4. Scale: at 10x (170 chats) about 140 KB a read, still under the 1 MiB bound; 64 kept, 16 on the ring. The warning
   is the read's time, logged in buckets with the counts. [ ]
5. Compatibility: an Orca without `orca agent list` lists no chats (today). An older plugin sends no `workspace`:
   chats are not scoped (decided 5). An older dial firmware draws a chat as any agent. [x]
6. Migration and rollback: nothing stored. The plugin rides with the CLI (#4446): a rollback of the CLI takes both. [x]
7. Audience: this computer's person only; the listener socket is 0600 in a folder that is theirs. [x]
8. Identity: every `orca` command runs as the person, against this computer's Orca (`hostId: local`), never
   `--environment` or a pairing code. [x]
9. Failure: a failed read logs one line and the Orca page keeps its terminals; a failed activate logs
   `[device] orca activate · failed` (today's line); a refused word says `Type in Orca for chats.` on the dial. [x]
10. Platforms: below. [x]

## Measures

Counts only: `[orca-chat] listed`, `read · failed`, the read's time in buckets (under 0.5 s, under 2 s, over), and the
existing `orca front`, `prompt · moved|skipped` and `orca activate` lines. No title, folder or id.

## Testing

- **Unit** (`orcaChatSource.spec.ts`, `observed.spec.ts`, `devicesListener.spec.ts`, `devices.spec.ts`,
  `cableHost.spec.ts`, `orcaChat.spec.ts`, the plugin's `dial.test.ts` and `worker.test.ts`): each rule above, with a
  recorded `orca agent list` answer (`testing/recordedOrca.ts` gains it, titles and folders replaced).
- **End to end** (`e2e/`, the real daemon, a fake dial, the fake `orca`, the plugin's real loop through
  `e2e/harness/pluginDial.ts`): two worktrees with chats and a terminal; Orca in front with one worktree on screen gives
  its terminal and chats in order; the other worktree switches the ring; a tap on a chat runs `worktree activate` with
  its id; a prompt hook with `ORCA_AGENT_SESSION_ID` moves the dial; words to a chat get the refusal.
- **Dial eval for Orca** (#4551): new tier A scenarios for chats (list, scope, tap, prompt follow, refusal).
- **By hand, on Tony's Mac** (Orca 1.4.271, the round dial): APPS says Orca with every chat; the tap shows the worktree
  on screen's chats; a swipe and a tap bring their worktree up; a prompt in a chat moves the dial.

## Platforms

macOS and Linux, where Orca's CLI and the devices' listener run. Windows: the plugin talks over the devices' pipe
(`devices/listenerPipe.ts`) and `orca.exe` runs through `lib/windows/program.ts`, as today's Orca paths; tested by the
Windows end to end leg.

Linux, known gap: a tap or a rest on a resting chat brings its worktree up but not Orca's window. Linux raises a
window by its class, and no Orca class is confirmed (`cable/hosts/frontApp.ts` `WINDOW_CLASSES`; a bare `orca` is
GNOME's screen reader), or by the agent's process, which a resting chat has none of (eval O20 on Linux).

## Answered (Tony, 2026-11-23)

1. Decided 1 to 9: as proposed.
2. Decided 8: a route Task 0 passes is used in Part 1; otherwise chats wait for `orca agent send`.
3. Answering a chat's question from the dial: in Part 2 (`orca agent respond`, in Part 2's table).
4. Part 2's pull requests on stablyai/orca: small, one command each, written for Tony and opened under his GitHub
   account (`tony496s`). #42555 (Diego's `orca terminal watch-focus`) stays as it is.

## Follow-ups

- stablyai/orca#42555 is still open; Part 2's `orca agent watch-focus` would cover its terminals too.
- The Harness Pro and Max take the same source once this lands (the Max branch drops its own poll).
