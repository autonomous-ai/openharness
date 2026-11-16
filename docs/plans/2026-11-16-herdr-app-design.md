# The dial lists, follows, talks to and switches Herdr's agents through Herdr Core (PM for Diego, 2026-11-16)

**Scope change.** This branch (`fix/herdr-socket-path`) started as "find the socket the running herdr serves". On
Diego's Mac the running herdr is not herdr 0.8.0: it is the Herdr desktop app over Herdr Core, a different program with
a different API. A socket-path fix cannot make the dial follow it, so Diego chose (2026-11-16) to turn this item into a
Herdr Core adapter, with a small fix for herdr 0.8.0's stale socket kept in it.

## What Diego's Mac runs (2026-11-16, read-only look: help, schema, file listings)

- **herdr 0.8.0** (`~/.local/bin/herdr`, the terminal multiplexer #4366 speaks to) is installed but not running. Its
  server log stops on Aug 24, and `~/.config/herdr/herdr.sock` is a socket file from Aug 20 that nothing listens on.
  The devices connect to it, get `refused`, and retry 1 s → 60 s.
- **Herdr** (`/Applications/Herdr.app`, `dev.herdr.app` 0.1.16) is the window. Its terminals run in **Herdr Core**
  (`hc`, `herdr-core` 0.1.21, `~/.local/share/herdr-core/active/Herdr Core.app`, links `~/.local/bin/hc` and
  `~/.local/bin/herdr-core`). hc's manual says: "It is not `herdr`, the older terminal multiplexer."
- **hc's socket:** JSON-RPC 2.0, one message per line (`hc schema`, protocol generation 1). It is found the way hc's
  manual names: `HC_SOCKET`, else the session's state folder,
  `<XDG_STATE_HOME or ~/.local/state>/herdr-core/<HC_SESSION or default>/<session>.sock`. On this Mac that is
  `~/.local/state/herdr-core/default/default.sock`.
- **hc's API** has terminals (`t7`, `t1b`), not herdr's panes (`w1:p1`). The methods used here are `hello`,
  `events.subscribe` (a snapshot, then every change, a heartbeat every 15 s, and `missed` with a fresh snapshot),
  `terminal.get` and `terminal.send` (paste, then Enter. It waits for a person's unfinished draft, up to 60 s, then about
  3 s of quiet, and refuses a `blocked` program unless `force`). It has no `agent.list`, `agent.prompt` or pane focus.
- **Agents** are terminals whose program reports a status (OSC 7501): `idle`, `working`, `done`, `blocked`, `error`,
  with the reporting `app` (`claude-code`, `codex`, `pi`). Plain programs report none. A terminal the window shows
  carries the label `herdr.space=<id>`, and terminals without it stay out of Herdr's screens (Herdr.app's guide).
- **Focus is supported:** `herdr-app --skill` (Herdr's own agent guide) names `herdr-app do agent.focus --terminal t7`.
  hc's manual: "It does not arrange windows; use `herdr-app --skill` for that." Herdr.app keeps its layout in an hc doc
  of its own (`herdr-app`), which nothing here reads or writes.
- **The hook sees Herdr.app as Ghostty.** hc gives its programs `TERM_PROGRAM=ghostty` (hc's manual), so today a hooked
  agent in Herdr is on Ghostty's page, and a tap raises Ghostty.

### Why the #4366 end to end passed

It started herdr 0.8.0's own server on its own socket and checked the dial against that. Nothing checked which herdr a
person actually runs, and the herdr people install now is Herdr.app over hc. The checks below add the one that would
have caught it: an end to end against the installed hc, and a log line that says which herdr socket answered.

## Goal

With Herdr open on this Mac:
- every agent Herdr's window shows is on the dial with its live state, hook or no hook;
- a tap, and a swipe while Herdr is in front, switch Herdr's window to that agent's terminal;
- the dial's words reach it as its next prompt, only while it is idle or done.

And with a stale herdr 0.8.0 socket, the log says so once and nothing retries.

## Design

Everything is in the devices process (`cli/src/cable/hosts/`, `cli/src/services/devices.ts`) and the hook
(`cli/hook/notify.mjs`). Nothing changes in the core: `core/observedHook.ts` takes any hint name within its count and
length bounds.

### One hc client (`hcClient.ts`)

- **Socket:** `HC_SOCKET` when it is absolute; else `<XDG_STATE_HOME>/herdr-core/<HC_SESSION>/<HC_SESSION>.sock`, with a
  relative or unset `XDG_STATE_HOME` read as `~/.local/state` and an unset or invalid `HC_SESSION` read as `default`.
  This reads the devices process's own environment only, as `herdrSocketPath` does. The socket must be a socket of this
  user's (`lstat`, uid) before each connection, as herdr's is. The rule comes from hc's manual (the session paths it
  names: HOME, XDG, `HC_SESSION`, `HC_SOCKET`), its binary's own messages, and the socket on this Mac. Task 1 confirms it
  against a private core: where the socket lands with `XDG_STATE_HOME` and `HC_SESSION` set. A `socket` set in hc's own
  `config.toml` is not read (follow-up).
- **Framing:** the line connection of `herdrClient.ts` (`connect`) is shared, not copied: it moves to a file both
  clients import, with its line bound as a parameter. An answer counts only under its own id, and a JSON-RPC error counts
  by its `data.kind` in `[a-z_]{1,64}`, never by its message. A request is one connection; the subscription's connection
  writes its two lines together, `hello` then `events.subscribe`, each answer matched by its id.
- **`hello`** with `generation: 1`. A core that answers `unsupported_generation`, or any other generation, is
  `bad_answer`: nothing is listed.
- **Subscribe:** `events.subscribe` with no filter (hc filters only by label value or terminal). Its snapshot, the events
  after it, `missed` with its new snapshot (events whose `seq` is not above it are dropped) and the heartbeat. A
  subscription that hears nothing for 45 s, three heartbeats, is ended (`timeout`). Task 1 records the event lines' exact
  shape from a private hc 0.1.21 into the fake server's fixture before the client is written, `doc` and `size` events
  included. A `doc` event that carries the document (hc allows 1 MiB, Herdr writes its layout there) sets the
  subscription's line bound: 8 MiB, above a 1 MiB value escaped in JSON, so a layout save never ends the subscription.
  Lines of a kind the source does not read are dropped as soon as they are parsed.
- **Kinds:** hc's `app` word goes through one closed table, here, for both the source and the prompt (`claude-code` →
  `claude`, `codex` → `codex`). An app not in the table keeps its own word when it fits `HERDR_KIND`. So a hooked copy's
  words, which come with the engine id (`claude`), match a terminal whose app is `claude-code`.
- **Prompt:** `terminal.get` first. The terminal must be live, its status `idle` or `done`, and its app's kind the kind
  the caller named. Then `terminal.send` with `if: "idle"` when it was idle (hc then refuses one that started meanwhile:
  `status_mismatch` is `busy`), and with no `if` when it was `done`, which hc's `if` cannot name. Never `force`. Control
  characters become spaces, and a blank text or one over `MAX_TEXT` is not sent, as herdr's prompt does. The send's
  deadline is 75 s (hc's default 60 s draft wait, its quiet pause and a margin; a person who set `draft_wait` above 60 s
  gets `no-answer` on a long draft). A send that times out is `no-answer` and is never sent again: hc's manual says it may
  still have arrived.
- It never throws and never logs. hc's answers name people's folders and agents.

### The hc source (`hcSource.ts`)

Built as `HerdrSource` is: it runs while a dial is attached, pushed and never polled, with the same retries
(`1, 2, 4, 8, 16, 32, 60` s), the same wait on a watched folder when there is no socket, and at most 64 agents.

- **Listed:** a live terminal of this machine (an address `t` then digits and lower-case letters, never `machine/t7`)
  whose labels hold `herdr.space`, whose status word is one of hc's five, and whose `app` gives a kind (the client's
  table). Other terminals (hidden workers, other apps' terminals, an unknown word, no `app`) are not.
- **Row:** a `uuid()` id as herdr's rows have, the pane key `herdr-app:<address>`, host and app `herdr`. The name is the
  terminal's `name`, else its folder's name, else the kind. State: `idle` → idle, `working` → working, `blocked` →
  needs-you, `done` → done with `unseenDone`, `error` → error (the dial's error card, as for other agents). A turn that
  leaves `working` or `blocked` for `idle` is a done card with nothing unseen, as herdr's Q10.
- **Its tap** is the Herdr adapter's `focus` (which brings Herdr itself, below). **Its swipe:** the source has `hasPane`
  (Herdr's adapter can show it now) and `showPane` (the adapter's `show`), which `cableHost.ts` reads for a rest; herdr's
  source has neither. Its words go through the adapter's `prompt`.
- **Which terminals the window shows** (`shows(address)`) is the source's to answer, for the adapter.
- **Stale socket:** the same rule as herdr's below.
- **hc keeps running when Herdr is closed** (a launchd job, hc's manual). Its agents are then still listed and take
  words, since they are alive. A tap opens Herdr.

### The Herdr adapter (`herdrApp.ts`)

- `id: 'herdr-app'`, `tap: 'instead'` (it brings Herdr itself, as the Claude app's link does), macOS only.
- `paneOf`: the hook's `HC_TERMINAL_ID`, held to `/^t[0-9][0-9a-z]{0,15}$/`.
- `focus`: `open -b dev.herdr.app` (opens Herdr when it is closed, raises it when not), then
  `herdr-app do agent.focus --terminal <address>`, both run with no shell, each with the 10 s run timeout. The address
  is checked again before the command. True once Herdr came forward; an `agent.focus` that fails logs
  `[herdr-app] focus · failed`. `herdr-app` is found on `PATH`, else at `/Applications/Herdr.app/Contents/MacOS/Herdr`
  (the binary `~/.local/bin/herdr-app` links to), as Orca's is; that path is a dependency, so no unit test reaches it.
  The hc source's tap calls this same `focus`, so an agent no hook told of brings Herdr too.
- `canShow`: Herdr is the app in front. `show`: `agent.focus` alone. One run per terminal: a second focus or show is
  the same run.
- `canFocus` and `canShow` answer true only for a terminal the hc source lists (`shows`). Every hc terminal has
  `HC_TERMINAL_ID`, hidden `hc run` workers too, and the window shows those not: their hook's copy has the pane for words
  only.
- `type`, `canType` (hc's socket is there) and `paneKey` (`herdr-app:<address>`), as `herdr.ts` has them. A focus does
  not wait for words under way: hc types by address, whatever the window shows. A second prompt to one terminal while one
  is under way is `busy`.
- Order in `devices.ts` `adapters`: after tmux (a tmux inside an hc terminal is the nearer host), wrapped by `noting` as
  the others are, so a hooked agent in Herdr never reaches Ghostty's tab adapter. Its client is injected as
  `deps.herdr` is.

### The hook and the app (`notify.mjs`, `hostDetect.ts`)

- `HC_TERMINAL_ID` joins `HOST_HINTS`, next to `HERDR_PANE_ID`, and counts toward `MAX_HINTS` as every hint does.
- The hook leaves `HC_TERMINAL_ID` out when its terminal is not the default session's. The exact variables hc sets in a
  terminal of a named session (`HC_SESSION`, `HC_SOCKET`) are read from a private hc's own terminal in the first task,
  never from another process.
- The hook sends `HC_TERMINAL_ID` on macOS only (Q5), so Linux and Windows stay as they are.
- `detectHost` and `detectApp`: `HC_TERMINAL_ID` → `herdr`, ahead of the bundle check and `TERM_PROGRAM` (hc's
  terminals say `ghostty`, and hc's own bundle is `dev.herdr.core`). The app id stays `herdr`, whose bundle is already
  `dev.herdr.app`: no seventeenth app (`CABLE_MAX_APPS` is 16).
- The copy of `HOST_HINTS` in `hookNotify.spec.ts` changes with it.

### herdr 0.8.0's stale socket (`herdrSource.ts`)

A socket refused on the first connection of an attempt, with nothing subscribed on that socket's stamp since it was
taken, has no server behind it. The source logs `[herdr] socket · stale` once, gives up on that stamp at once (no retry
timer), and waits on the watch, as it does today after the last retry. A server that starts again makes another socket,
which the watch tells. A refusal after a subscription has started on that stamp keeps today's retries. The hc source
follows the same rule, from one shared file (Q6).

A socket younger than 2 s (its ctime) may be bound before its server listens, so its first refusal gets one retry after
1 s before it counts as stale (Q8).

### Which herdr answered (logs)

- `[herdr] socket · none|stale|live` and `[herdr-app] socket · none|stale|live`, each said when it changes, never
  repeated.
- `[herdr-app] listed · <n> agents`, `list · <kind>`, `closed · <reason>`, `retry · <seconds>`, `over · <n> left out`,
  as herdr's lines are. No ids, names, paths or text.
- Voice outcomes through the existing counter, with `herdr-app` beside `herdr`.

### Wiring (`services/devices.ts`)

The hc source joins the registry after the herdr source, behind `HARNESS_DEVICE_OBSERVED`, on macOS only. It starts at
a dial's attach when Herdr is installed (the adapter's `herdr-app` lookup), and stops with the last dial. Its `onChange`
runs the same turn as the other outside sources.

## Platforms

- **macOS:** everything above, and tested there.
- **Linux and Windows:** no change. hc runs there too, but Herdr's window on Linux, and hc's socket on Windows, are not
  tried here. This is a follow-up.

## Data

Nothing is stored or synced. For each Herdr agent the dial gets the fields it gets for a herdr one (name, state, kind,
folder), over the same local link. hc's socket is read as this user only, from the devices process. Herdr's own layout
doc is never read or written.

## Testing

- **A fake hc server** (`cli/src/testing/fakeHc.ts`), a Unix socket in the test's temp folder, replays lines recorded
  from a private hc 0.1.21 (with paths and names removed). Specs for the client cover the socket rule, framing, the
  handshake, snapshot, events, `missed`, the heartbeat deadline, each error kind, a stale socket, an oversize line, and
  the prompt's get-then-send rules with the 75 s deadline. Specs for the source, the adapter, the hook and `hostDetect`
  cover the rows, the kinds, the states, the merge with a hooked copy, focus and show, and the hint.
- **herdrSource spec:** a stale socket logs once and starts no timer (red first).
- **Task 1, the recording (a spike, its code thrown away but its fixture kept):** a private Herdr Core from the
  installed `hc`, its own `HC_SESSION` (`harness-<random>`), `HOME` and `XDG_*` in a scratch folder, and a short
  `HC_SOCKET` under `/tmp` (under `sun_path`). It records:
  - where the socket lands with and without `HC_SOCKET`;
  - how hc starts it on macOS: hc's desktop start is a one-shot launchd job. The job's label must name the private
    session, never Diego's (`dev.herdr.core.*` labels are compared before and after, nothing else in `launchctl list`),
    and must be gone after the private `hc server stop`. **If the label does not name the session, or the job outlives
    the stop, the task stops and asks the orchestrator:** no e2e then starts a core;
  - the lines of `hello`, `events.subscribe` (snapshot, every event kind it sees, `doc` included), `terminal.get` and
    `terminal.send`, from a fake agent run directly (not through a shell, whose return clears status) that reports OSC
    7501 status and echoes its input;
  - the variables hc sets in its own terminal (`HC_TERMINAL_ID`, `HC_SESSION`, `HC_SOCKET`), read by that fake agent
    from its own environment, for the hook's named-session rule.
- **End to end, macOS:** the same private core, started as task 1 found safe, and stopped through its own session only.
  The dial lists the fake agent with its state, a status change arrives as a card, the words arrive as a submitted line,
  and a swipe runs a fake `herdr-app` that records its arguments. A tap is in the e2e only once `HARNESS_OPEN_BIN` (a
  fake `open`, #4373) is on `main` when the e2e task starts; until then the tap's two commands and their order are held
  by specs (Q4). The test checks the fake is the one the daemon
  resolves before any tap, so Herdr's real window is never driven. The file is skipped where `hc` is not installed.
  A hooked agent's merge (done-when 4) is covered by specs: the private session's own `HC_SESSION` makes the hook leave
  its id out.
- Nothing touches Diego's own Herdr, hc session, `~/.config/herdr` or herdr server.

## Out of scope

- Herdr's sub-agents (terminals an agent started with `hc run`, which have no pane), other machines' terminals, and
  named hc sessions.
- Answering a blocked agent from the dial.
- Installing or starting Herdr or hc.
- Removing the herdr 0.8.0 adapter: herdr 0.8.0 is still a released program.

## Follow-ups

- Linux, once Herdr's window there is tried.
- A permanent workflow that runs the hc end to end on a macOS runner with hc installed.

## Done when

1. With Herdr open and no hook, each agent its window shows is on the dial, on the herdr page, with its state. A status
   change reaches the dial as a card within a second.
2. A tap brings Herdr forward (opening it when it is closed) and switches its window to that terminal. A swipe with
   Herdr in front switches it.
3. The dial's words reach an idle or done Herdr agent as one submitted line. Nothing is typed when it is working,
   blocked, errored or finished, or when the text is empty or too long.
4. A hooked agent in Herdr is listed once, from its hook's copy, on the herdr page, never Ghostty's.
5. With hc not running (no socket, or a stale one), nothing is listed and no timer runs. When it starts, its agents
   appear with no daemon restart.
6. A stale herdr 0.8.0 socket gives one `[herdr] socket · stale` line and no retries.
7. The specs and the end to end above pass.

## Decided (PM for Diego, 2026-11-16)

- **Scope:** Herdr Core adapter on this branch; the stale-socket fix for herdr 0.8.0 is kept in it.
- **Q1.** Tap and swipe are `herdr-app do agent.focus --terminal <t>`, with `open -b dev.herdr.app` for a tap. The
  command runs with no shell, and its argument is checked against the terminal form first. (Builder check: the tap
  opens Herdr before the focus, since hc outlives a closed window and the window must be up to switch.)
- **Q2.** Only terminals labeled `herdr.space` that report an agent status are listed.
- **Q3.** Words only while idle or done. The send's deadline is 75 s; a timeout is "no answer" and is never sent again.
- `HC_TERMINAL_ID` counts toward the hook's hint cap.
- Herdr.app's private layout doc is never written.

Answered after the draft plan (PM for Diego, 2026-11-16):

- **Q4.** The e2e never runs the real `open`: it swipes through the fake `herdr-app`, and taps too only through
  `HARNESS_OPEN_BIN` (#4373) when that is on `main`. A real tap, with Herdr open and closed, is Diego's own check before
  the merge.
- **Q5.** The hook sends `HC_TERMINAL_ID` on macOS only.
- **Q6.** The wait, retries and stale rule live in one file both sources use.
- **Q7.** Words to an errored agent are refused with `<name> did not answer.`, counted `no-answer`. No new copy.
- **Q8.** A socket younger than 2 s gets one retry after 1 s before it counts as stale, with a test.
