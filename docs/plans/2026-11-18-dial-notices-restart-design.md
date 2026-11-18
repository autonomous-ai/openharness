# Dial: an agent's notice outlives a restart of the devices process

Branch: `fix/dial-notices-restart`. Component: `cli/` (the devices process only). Platforms: macOS first; the code is
the same wherever the devices' listener runs (macOS, Linux).

## The bug

Found by the dial-notice-loss session (2026-11-18). An agent's notice (`harness device notify "<line>"`, the
[notify design](2026-11-16-dial-agent-notify-design.md)) is a card the dial pins until that agent's next turn starts,
a tap opens it, or the agent leaves. The cards live only in memory, in `Notices.cards`
(`cli/src/cable/notices.ts`). When the devices process restarts (a crash, a CLI update) the map is empty: the attach
that follows replaces the dial's drawer (`notif.replace` from `CableHost.listUnread`, which reads
`Notices.rows`) with no row for the card, and nothing asks the card again. The person never learns the agent needs
them.

Out of scope: question rows dropped on a drawer replace (`cableSession.replaceNotifications`, firmware `notice_add`)
are fixed by a separate pull request from dial-notice-loss; this branch does not touch them. The drawer replaces
this branch adds (a restored row shown or back) are accepted with that bug until then (harness-pm): this pull request
merges on its own, and whichever of the two merges second rebases and keeps both fixes.

## Intent

A notice is the agent's own "I need you". It must survive the devices process restarting, as long as it is still true:
its agent is still there and has not started another turn. It must not come back stale for long.

## Goals, non-goals, anti-goals

- Goal: a pending notice's row is back in the dial's drawer after the devices process restarts, under the same card
  id, silently.
- Goal: a restored card never rings again (harness-pm): it rang before the restart, so it comes back as a silent
  drawer row only. Opening that row reads the notice's line, never "No readable question. Check the terminal."
  (harness-pm). A restored card whose agent is gone or has started another turn is not shown at all.
- Goal: it works for every host a notice can come from: Harness, observed sessions, herdr, Herdr, cmux, opencode.
- Goal: no restored card is older than 24 hours.
- Non-goal: the core changes nothing (AGENTS.md, the daemon core: it grows no rule or record for this).
- Non-goal: the firmware, Desktop, the phone and the Device app change nothing, and no new frame is added.
- Non-goal: the per-agent and per-computer limits (`NoticeLimits`) are not kept across a restart; they start fresh.
- Anti-goal: a write storm, or a devices process that fails to start because of this file.

## Approaches (decided by harness-pm, 2026-11-18)

- **A. Rebuild from the agent's transcript.** In the agent's last turn, find `harness device notify "<text>"` that
  answered `shown` with no prompt after it. Stores nothing, sees a new turn on its own. Not taken: it parses shell
  quoting of outside text in two transcript formats (Claude Code, Codex), the devices process reads no transcript of a
  Harness pane agent, and a tap is lost.
- **B. A small file of the pending cards, written by the devices process (chosen).** The core never hears a notice
  (it comes over the devices' own listener by design), so the client API cannot rebuild its line; the devices process
  is the one owner of it, and its file is the only right place.
- C. The core keeps notices. Ruled out by AGENTS.md.

## Behavior

### The file: `dial-notices.json` in the daemon's data dir

- One writer: the devices process. Same pattern as `dial-notify.json` (`cli/src/cable/notifyMode.ts`): written whole
  to a temporary file (`0600`) and renamed into place.
- Contents: `{ "v": 1, "cards": [ { agentId, keys, id, line, host, who?, at } ] }`, oldest first, at most
  `NOTICES_PENDING_MAX` (20) cards. `at` is the wall-clock time (ms) the notice was shown; `line` is the drawn line
  (at most 239 bytes); `who` only for a caller no list holds, as in memory. The card's `questions` are rebuilt from
  `line` and `host`, never stored.
- `keys` (my call, from the builder check): what finds the agent again after a restart, because herdr, Herdr
  (`hc`), cmux and opencode give an agent a new random id each time the devices process lists it. The keys are the
  agent's `<engine>:<sessionId>` when it has a session id, and its `paneKeys` (`herdr:<pane>`, `herdr-app:<address>`,
  cmux's surface key), as its list entry held them when the notice was shown; none for a `who` card. A Harness agent's
  id and an observed agent's id (`observedAgentId`) are already stable; their keys are stored the same way.
- Written after every change of the pending set: a card added or replaced, and a card ended by any path (next turn,
  tap, agent gone, the last dial going for a Harness agent, the age cap). An empty set writes an empty `cards` list
  (or removes the file; the builder's call).
- **A stop is not an ending** (my call, from the builder check): when the devices process stops, its detach
  (`port.stop()` calls `dialAttached(false)`, which ends every Harness agent's card) changes memory only; the file
  keeps what was pending before the stop began. Otherwise every CLI update would save an empty set for Harness agents,
  the cards people use most.
- **Coalesced (harness-pm):** changes that come close together give one write: a write is scheduled on the first
  change and carries every change made until it runs (a short window, the builder's call, about 1 s). Pending
  changes are written when the devices process stops normally.
- **Read once, at the devices' start, bounded (harness-pm):** at most 32 KiB read (one byte more tells a longer file).
  A missing file starts empty with no log. A file that is longer, not JSON, not `v: 1`, or has a card that fails its
  shape is dropped whole: start empty, one log line (`[device] notices · file dropped · <reason>`, the reason a fixed
  word, never the path or the content), and the next write replaces it. Nothing in it can stop the devices process
  from starting.

### Restored cards

At the start, each card in the file:
- older than 24 hours (by `at` and the wall clock) is dropped, never asked;
- otherwise is pending again under its own id, marked **restored**.

A restored card differs from a live one in three ways:
0. **Silent, for good (harness-pm).** A restored card is never asked as a question (`cable.question`), so it never
   beeps, wakes or lights the dial: it is only a row of the dial's drawer (`Notices.rows`, carried by the drawer
   replace `cable.replaceNotifications(cableHost.listUnread())`). That holds for its whole life: a later attach, or
   another question of its agent closing (`reask`), puts the row back, never a question. Its endings close it as a
   live card's do (the row goes with the next drawer replace; the builder checks what the dial needs to drop it). Only
   a new notice from that agent rings again, and it replaces the restored card as any new notice replaces a card.
   **Its question view (harness-pm).** Opening the row on the dial sends `question.read`, which the dial's cable
   session answers from its inbox (`QuestionInbox.read`). So each dial's cable session holds a shown restored card's
   question (the line and "In <app>", as a live card's) without asking it (`CableSession.hold`): it sends no frame, is
   never asked later (not at a greeting, a drawer replace or a resync, not by `ask`), and a dial plugged in later holds
   it too (the fleet gives it what its sibling holds, as held). It is held where the card would otherwise be asked: on
   an attach, when its agent is found, and when a question that covered it closes. A later question of that agent
   replaces it in the session as any question does, and the card's `question.close` removes it.
1. **Held until its agent is listed.** It is not a drawer row until its agent is on one of the lists the devices
   hold: a Harness agent among the core's advertised agents, an outside agent on any outside source's list
   (`outsideEntries()`), found by its id or by one of its `keys`: an agent that names a session is found by its
   session alone, and a pane key finds only an agent that names none (harness-pm), so a card never moves to another
   session in the same pane. Found by a key, the card takes the agent's new id (in memory and in the file). The moment it is first seen there (a list change, an attach), its row is put on the
   dial (a drawer replace). An agent that never comes back is never shown, and its card goes at the 24-hour cap. A
   card with `who` (its caller was on no list when it asked) is not held: its row is shown at once. Held cards count
   toward the 20 (my call): the oldest card, held or not, is ended to make room, and held cards are usually the oldest.
2. **Dropped when its agent is first seen in a turn.** When its agent is first seen after the start in a running turn
   (an observed agent the scan lists as working, a listing source's agent listed busy), the card ends instead of being
   shown: that is most likely a turn after the notice. A Harness agent's turn state is not known at the start (the
   devices learn it only from the cards that follow, and `RegisteredSession` carries none), so its restored row is
   shown once the agent is advertised and ends at the first card of a running turn heard after the start: a turn
   already running at the restart can show the silent row for the seconds until its next card, never a ring. The
   existing endings keep working unchanged and now also update the file: `turn_started` (Harness
   agent), the observed hook's `turn-start`, a listing source's agent going busy, a tap, `agent_deleted`, an outside
   agent leaving its lists, and a Harness agent's card on the last dial going (but not during a stop, above).

The age cap is checked on restore only: a live card in memory still waits for its agent's next turn however long that
takes (the notify design, unchanged).

### Known gap (accepted by harness-pm)

A turn that both starts and ends while the devices process is down is not seen: its card comes back and stays until
the agent's next turn, a tap, or the 24-hour cap. Likewise, a notice whose own turn is still running when the devices
process comes back is dropped by rule 2; the agent's answer still carries the ask (the dial skill tells it to). A
Harness agent's turns are told to the devices only while a dial listens (`services/recaps.ts`): a Harness card
restored while no dial is attached waits for the next attach, and a turn in between is not seen (the same gap, bounded
by the cap). A Harness agent already in a turn at the restart can show its restored row, silently, until the turn's
next card ends it (rule 2).

### Logs and measures

- One line at the start when the file held cards: `[device] notices · restored <n> · aged out <m>` (counts only).
- A write that fails: `[device] notices · not saved · <code>` (the error code only, as `notifyMode.ts` does); memory
  stays the truth and the next change tries again.
- No line carries the text, an agent id, a session id or a path.

## Constraints

- The core gains nothing: no request in `cli/src/core/api.ts`, no record. The file and every rule are in the devices
  process (`cli/src/cable/notices.ts` and its wiring in `cli/src/services/devices.ts`).
- Do not touch `cableSession.replaceNotifications` or the firmware's `notice_add`. The cable session gains only the
  silent hold (`cable/questionInbox.ts`, `cableSession.ts`, `cableFleet.ts`), in the devices process too.
- Tests at the layer where the behavior lives: `cable/notices.spec.ts` for the desk's rules (restore, hold, drop,
  cap, silence, coalesced writes, a bad file), `cable/questionInbox.spec.ts`, `cableSession.spec.ts` and
  `cableFleet.spec.ts` for the hold (read, never asked, on every dial), `services/devices.spec.ts` for the wiring (a
  restart with a pending card puts its row back on attach, with no question and no alert, and holds the question its
  row opens to (harness-pm); a restored card of a working observed agent is not shown), and end to end that opening
  the restored row reads its line. Each red first.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer: ______

1. **Growth.** One record kind, a pending card; at most 20 in the file and in memory (the oldest is ended to make
   room, as today).

   | Event | File |
   |---|---|
   | Notice shown (create) | card added, or its agent's card replaced |
   | Next turn starts, tap, agent deleted, outside agent leaves its lists, last dial goes (Harness agent) | card removed |
   | 21st card | oldest removed |
   | Devices stop | unchanged (the stop's detach is not written) |
   | Devices restart (lost) | cards read back; over 24 h removed |
   | Agent listed again under a new id | card takes the new id |
   | Agent never listed again | held, removed at the 24 h cap (next start) |
   | First seen in a turn after restart | removed |
   | Bad file | dropped whole, rewritten on the next change |
   | Recreated under the same agent | replaces that agent's card (one card an agent) |

   Size where it stops working without this: none; bounded at 20 × ~0.5 KB.
2. **Concurrency.** One writer, one process, one event loop: the in-memory map is the truth and the file a copy
   written whole and renamed. Two devices processes at once do not happen (the daemon runs one); if they did, the last
   rename wins and each keeps its own memory.
3. **Read cost.** Read once at start, at most 32 KiB; written at most once a coalescing window, ≤ ~10 KB. No poll.
4. **Scale.** 10× agents does not grow it: the cap is 20 cards. Notices are limited to 20 an hour per computer, so
   writes stay well under one a minute on average. Warning metric: the `restored`/`aged out` counts in the log.
5. **Compatibility.** A new file; no reader but this code (searched: `dial-notices` appears nowhere else). An older
   CLI ignores it; a newer one that changes the shape bumps `v`, and this one drops a file with another `v`.
6. **Migration and rollback.** None needed: no existing data. A rollback leaves an unread file of at most 20 small
   cards in the data dir; the next upgrade reads it, the 24 h cap clears it.
7. **Audience.** The line is the agent's text, which can be the person's own words: the file is `0600` in the
   daemon's data dir, the same folder and mode as the daemon's other state; it never leaves the computer, is never
   synced, logged or sent anywhere but the attached dial, as before.
8. **Identity.** N/A: the devices process runs as the person who runs the daemon; nothing runs as anyone else.
9. **Failure.** A failed write: one log line, memory stays right, the next change retries; a crash before the
   coalesced write loses only the changes of that window. A bad file: one log line, start empty. A card restored for a
   gone agent: never shown, cleared by the cap.
10. **Platforms.** macOS first (tested there); the same code on Linux. Windows: the devices' listener does not run
    (notify answers `no dial`), so no card is ever made or stored.

## Left to the builder

- The coalescing window and whether an empty set removes the file or writes `cards: []`.
- Where "first seen on a list" and "first seen in a turn" are hooked in `services/devices.ts` (the outside lists'
  change handler, the scan, the Harness frames), so long as the behavior above holds.
