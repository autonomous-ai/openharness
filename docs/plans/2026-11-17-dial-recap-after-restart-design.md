# Dial: an agent found by the scan shows its last recap and its Claude app name

Branch: `fix/dial-recap-after-restart`. Component: `cli/` (the devices process). Platforms: macOS, Linux, Windows (the
scan runs on each; the Claude app's sessions are macOS and Windows).

## The report (Diego, 2026-11-17)

Daemon `0.6.57-dev.f663d4a54f`, installed about 23:00 the evening before, so the daemon restarted then. The next
morning the dial showed the resting face ("Say the word") instead of the agent's recap, and no session name, until a
new prompt was sent, for agents in the Claude app (3 sessions), Herdr.app and Orca alike. Each showed its name and
recap only after one message.

## Diagnosis

Read in the code and in `~/.harness/cli/data/harness.log` (no conversation, transcript or process environment read).

- The log has the restart at 23:03:49 and the devices' first scan at 23:03:52:
  `[observed] scan · 9 found · 7 app known · 1 named · 132 ms`. Nine sessions listed, one by a name.
- **Recap.** An agent outside Harness (`cable/hosts/observed.ts`, the devices process) has one recap, `lastAnswer`:
  the last message of its last turn, read from the session's own transcript by `readLastAnswer`
  (`cable/hosts/lastAnswer.ts`: only a file inside the engine's own folders, a 256 KiB tail, a 1 s deadline) 1.5 s
  after its Stop hook, and on a Codex turn `checkWorking` ends. It is kept in memory only. After a restart the open
  scan (`scanOnce`) lists the session again as `idle` with no `lastAnswer`, so `CableHost.recentSummaries` returns
  nothing, the dial's restore on attach (`CableSession.pushRestores`) sends nothing, and the firmware draws the
  resting face with a random line from `RESTING` (`habitat/focus.c`), one of which is "Say the word". The next turn's
  Stop reads the answer again, which is why one message brings it back. A Harness agent is not affected: the recaps
  service keeps its recaps in `summaries*.json`.
- **Name.** The scan names a Claude Code session from its own process record, `~/.claude/sessions/<pid>.json`, only
  when `nameSource` is `user` (`cable/hosts/recordName.ts`, decision 5 of
  [the session-name spec](../specs/2026-11-15-dial-session-name.md)). A Claude app session's record
  (`entrypoint: 'claude-desktop'`) holds a `name` with no `nameSource`: the app sets that title itself
  (`rename_session` from the host). It is refused, and the agent reads its folder. Its next prompt's hook carries the
  same title as `session_title`, which is why one message brings it back.
- **Herdr.app.** Herdr's own listing (`cable/hosts/hcSource.ts`) names no session and never carries a recap; only the
  copy a session's hooks made (`observed`) does, and it folds Herdr's row once a hook names the terminal
  (`HC_TERMINAL_ID`). A session the scan found has no hook yet, and Herdr's terminals run under a launchd job, not an
  app, so its copy has no app and no pane, and the Herdr tab shows Herdr's own row.
- **Orca.** Its sessions are found by the scan as any other: the same cause as the recap above.

## Decided (the PM for Diego, 2026-11-17; Diego had not answered after 5 minutes, the PM took the recommendation)

1. **The recap comes from the session's own transcript, read as its Stop hook reads it (option C).** When the scan
   first lists a Claude Code or Codex session that reads idle, it reads that session's last answer with the reader the
   Stop hook uses (`deps.lastAnswer`, same bounds), and stores nothing. Not taken: (A) keeping each session's last recap
   and name in a file of the devices process (a new store of conversation excerpts, which can be stale when a session
   went on while the daemon was down); (B) a neutral idle card in the firmware (no recap, no name fixed, a firmware
   and design change).
2. **A Claude app session's own title names it (N1).** The record's `name` is also taken when `entrypoint` is the
   string `claude-desktop` and the record has no `nameSource`. This widens decision 5 of the session-name spec for the
   Claude app alone: that title is the very string the session's hook sends as `session_title` on its next prompt.
   A `derived` name, and a CLI session's record with no `nameSource`, are still refused.
3. **Herdr's own rows stay as they are.** A Herdr.app session the scan found gets its recap on its own copy (decision
   1); Herdr's row, which has no session id, still shows no recap until the session's next hook folds it. Left as a
   limit (below).
4. **Nothing in the core.** Both changes are in the devices process (`cable/hosts/observed.ts`,
   `cable/hosts/recordName.ts`); `cli/AGENTS.md` rule 7.

## Behavior

### The scan's recap (`observed.ts` `scanOnce`)

- **Every read of the look runs before any entry is added, and nothing is awaited between adding the first entry and
  the look's one `emit()`.** Today the loop adds an entry (`entry()`) and then awaits `openSessions.busy(owner)`; the
  dial reads `list()` every second (`CableSession.tick` → `syncAgents`), so a ring sent in that gap holds the new agent,
  `pushRestores` marks it `restored` before reading its empty `recentSummaries`, and never asks again until the next
  attach (the builder check's finding). So the busy checks and the answer reads move before the loop, as the names'
  reads (`namesOf`) already run, and the loop only sets what they read.
- The reads walk `listing` (the sessions this look is about to list, at most 50, `MAX_SESSIONS`), one at a time, in
  this order: apps (as today), names (as today), then for each Claude Code or Codex session its busy check (moved from
  the loop), then, for each of those that reads idle and has a transcript path, its last answer with
  `deps.lastAnswer(engine, transcriptPath)`. A session found in a turn reads `working`, as today, and gets its answer at
  that turn's end. Each answer read is bounded by the reader's own 1 s deadline and 256 KiB.
- In the loop, the answer is cut as `readAnswer` cuts it (300 code points, `ANSWER_CHARS`, an ellipsis past it; one
  shared helper) and set as the agent's `lastAnswer`. Its state stays `idle` and `unseenDone` stays false: a recap from
  before the dial is history, not news, so no `done` and no `summary` card is told and nothing rings (`devices.ts`
  `outsideTurn` tells a summary only for `done`). The dial gets it from its restore (`summary` with `restore: true`).
- A hook heard while the reads run wins: the loop already skips a session a hook listed meanwhile
  (`this.entries.has(...)`), so what that hook said stands and no read of the scan lands on it.
- A read that fails, times out, finds no file inside the engine's folders or no answer leaves no recap, as today, and
  is counted in the scan's line, never with a path, a name, an error's text or the answer:
  `[observed] scan · 9 found · 7 app known · 1 named · 6 answered · 132 ms`. The line's `ms` now times every read of
  the look (apps, names, busy checks, answers), not only the apps' walk, so a slow look shows in it.
- Read once, as the session is first listed: a listed session is never looked at again by the scan.

### The Claude app's name (`recordName.ts` `readRecordName`)

- Taken when `nameSource === 'user'` (as today), or when `nameSource` is absent and `entrypoint === 'claude-desktop'`.
  Every other check stands: the record's path, its 16 KiB bound, JSON, a string `name`, `sessionId` the listed
  session's, and `observedTitle`'s cleaning and 64-unit cut.
- Still refused: `nameSource: 'derived'`, any other `nameSource`, a record with no `nameSource` and any other or no
  `entrypoint`.
- The hook keeps the last word, as today.
- Checked on Diego's machine, keys and fixed values only (no name read): the Claude app's 3 records carry
  `entrypoint: 'claude-desktop'` and `hostSessionId` and no `nameSource`; the CLI's carry `entrypoint: 'cli'` or
  `'sdk-cli'` and `nameSource: 'derived'`.
- Decision 5 of [the session-name spec](../specs/2026-11-15-dial-session-name.md) said the devices read "those two
  fields of that one record, and nothing else from it". It now reads three (`name`, `nameSource`, `entrypoint`, beside
  `sessionId` from decision 6): that spec's text changes in this branch to say so and to point here.

## Design (docs/feature-design-rules.md)

Reviewed revision: this spec's first commit on `fix/dial-recap-after-restart`  Reviewer: P1 builder-check + PM

1. Growth: nothing is stored. `lastAnswer` already lives on the entry and leaves with it (session end, its process
   gone, eviction past 50, 12 h of silence: `tick`, `evict`). The scan adds no record.
2. Concurrency: the devices process is one event loop. A scan is one look at a time (`scanning`). Every read of a look
   (apps, names, busy checks, answers) runs before its loop, and the loop adds the entries, sets what was read and
   emits with no await between, so no reader of `list()` (the dial's 1 s sync, a restore) sees a session half-read.
   A hook that listed a session during the reads wins: the loop skips it.
3. Read cost: per session first listed, at most 256 KiB of its transcript's tail and one record of at most 16 KiB, each
   under a 1 s deadline, read one at a time; at most 50 per look. The dial gets no new frame: the restore it already
   asks for carries the recap (one `summary` with `restore: true`, at most 300 code points).
4. Scale: at 10x (the 50-session bound reached) a look reads at most 50 tails, worst case 50 s when every read hits its
   deadline, which only delays that look's listing (no entry is listed half-read); typical reads take a few ms. The
   scan's line says how long the look's reads took (`ms`, now every read of the look), which warns first.
5. Compatibility: no frame, field or state is new. Readers of `lastAnswer`: `CableHost.recentSummaries` (restore and the
   full text behind a card), `devices.ts` `outsideTurn` (tells a summary only for `done`, so an idle recap tells
   nothing), `readAnswer` (overwrites it at the next turn's end), `ingest` (clears it at a turn's start). The firmware
   draws a restored summary as it does for a Harness agent. An older daemon shows the resting face, as today.
6. Migration and rollback: none. A rollback shows the resting face again after a restart.
7. Audience: the recap is the person's own answer from their own session on their own computer, shown on their own
   dial, as the Stop hook's read already shows it. It is read only inside the engine's folders (`readLastAnswer`'s
   check). It is never logged or stored: the scan's line counts reads only. The name is the title the person's Claude
   app gave the session, which the hook already sends; never logged (the line counts it).
8. Identity: the devices process runs as this computer's owner and reads the owner's own sessions' files, as today.
9. Failure: a read that fails leaves the resting face until the next turn's end, as today; counted in the scan's line
   (`answered` lower than `found`). Nothing throws out of the scan.
10. Platforms: the scan and the reader run on macOS, Linux and Windows. The Claude app (`claude-desktop`) runs on macOS
    and Windows. Herdr.app is macOS only.

## Limits (not in this branch)

- Herdr.app: Herdr's own row of a session the scan found shows no recap until that session's next hook folds it into
  the session's copy (decision 3). Pairing the two by the terminal's foreground pid, which hc reports, is a follow-up.
- A session first heard of by a hook other than a start keeps its folder until its next prompt (decision 7 of the
  session-name spec).
- A Claude turn stopped with Esc before the restart reads the answer of the last turn its transcript holds, as the Stop
  hook's read would.

## Tests

- `cable/hosts/observed.spec.ts` (red first):
  - a Claude session the scan lists, idle, reads its transcript's last answer as `lastAnswer`, cut at 300 code points;
    a Codex one too;
  - one found in a turn (busy) is not read and reads `working`;
  - one with no transcript path, or of another engine, is not read;
  - a read that fails or finds nothing leaves no recap and the look still lists it;
  - a hook heard while the reads run wins: no recap of the scan lands on that session;
  - nothing is awaited between the first entry added and the emit: `list()` called while any read of the look is
    pending holds none of the look's sessions, and once listed each idle one already holds its recap (the race);
  - nothing is told as done: the state stays `idle`, `unseenDone` false;
  - the scan's line counts the answered ones, with no text, path or name; the existing line assertions
    (`observed.spec.ts` near lines 654, 830, 893, 901; `e2e/deviceWithoutApp.e2e.ts` near 239;
    `e2e/dialAppFilter.e2e.ts` near 463) take the new field.
- `cable/hosts/recordName.spec.ts` (red first): a `claude-desktop` record with no `nameSource` names the session; a
  `cli` (or absent) `entrypoint` with no `nameSource`, a `claude-desktop` record with `nameSource: 'derived'`, and an
  `entrypoint` that is not a string, do not.
- End to end (`e2e/deviceWithoutApp.e2e.ts`, the fake Claude Code): an agent started and answered before the dial
  connects is restored on the dial with its last answer (`summary`, `restore: true`), with no `done`; a Claude app
  record (`entrypoint: 'claude-desktop'`, no `nameSource`) lists it by its name.
  - The fake engine writes its process record as Claude Code does, with `status` (`busy` in a turn, `idle` after it)
    (`e2e/harness/fakeEngine.mjs`, cli/AGENTS.md rule 5). Today it writes none, which the busy reader takes as busy, so
    every session the scan finds in e2e reads `working` and the idle-only read would never run. The e2e files whose
    found agents relied on reading `working` are run again.
  - `Outside.named` (`e2e/harness/outsideAgent.ts`) takes a record with no `nameSource` and an `entrypoint`.
- The check on the real Claude app, Herdr.app and Orca (restart the daemon, the dial shows each idle session's recap
  and the Claude app's names) is done with Diego, not in this branch's checks.
