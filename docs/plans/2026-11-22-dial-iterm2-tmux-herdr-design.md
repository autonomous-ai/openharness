# Dial: agents in tmux and herdr inside iTerm2 are on iTerm2's page

Date: 2026-11-22. Branch: `fix/dial-iterm2-tmux-herdr`. Part 1 of the item "Dial + iTerm2"; Part 2 (iTerm2 in the dial
eval) is its own branch and spec.

## The report

Diego, 2026-11-22, macOS, CLI 0.6.80, herdr 0.9.5: four agents in iTerm2. One is a plain Claude Code in a tab, one runs
in tmux in a second tab, and two are panes of a herdr in a third tab. The dial's iTerm2 page lists only the plain one.
Expected: all four rows on iTerm2's page. A swipe or rest on each selects its tab and its tmux or herdr pane, and a tap
brings iTerm2 forward on that tab and pane. #4331 (tabs), #4491 and #4497 (tmux in Terminal) and #4500 (herdr in a
terminal app's tab) cover the hooked path for these hosts.

## What the code does (root cause)

Two gaps, each enough to leave a nested agent off iTerm2's page. Only the `[daemon]` lines of the dial log were read
(counts only: the iTerm2 page reads `agents → 1 of 1`). Diego's check settled it: after he typed one prompt into the tmux
agent and one into a herdr pane, both showed on iTerm2's page. So their hooks place them, and **Gap 1 is the cause he
hit**: the agents were idle, known only from the scan, after the devices started again. Both gaps are fixed here (PM,
2026-11-22). Gap 1 comes first, and its main red test is that exact case: the devices start again while the tmux and
herdr agents are idle.

**Gap 1: a session the open scan found is never placed through its multiplexer's client.** All terminals.
`observed.ts askOuter` is the only caller of the outer lookups (`herdrOuter.ts`, `tmux.ts createTmuxOuter`,
`zellij.ts`), and it runs on a hook event alone. After the devices process starts again (a CLI update, a daemon
restart), every idle session is known only from the scan (`scanOnce`) until its next hook. The scan learns the app from
the session's parent processes (`scannedApp.ts scannedApps`):
- plain tab: `claude → shell → login → iTermServer → iTerm2` names iTerm2;
- tmux: `claude → shell → tmux server`, whose parent is launchd, names nothing, so the agent stays on Other's page with
  `appPending` until it is next hooked;
- herdr: `claude → shell → herdr server → first herdr client → …` names the first client's app, which is not
  necessarily the client the person uses, and names nothing once that first client has gone.

**Gap 2: iTerm2 runs its shells under `iTermServer-<version>`, outside any `.app`.** iTerm2's multi-server (the default)
copies its server out of the bundle to `iTermServer-<CFBundleVersion>` in its Application Support folder (or
`~/.iterm2/`) and forks every shell from it (iTerm2 source: `sources/Tasks/iTermServerDeleter.swift`,
`iTermFileDescriptorMultiClient.m`, `iTermFileDescriptorMultiServer.c`). The server is iTerm2's child, but it outlives
iTerm2: after iTerm2 relaunches with its sessions kept (an update, a crash), the old server's parent is launchd. The walk
passes over a process with no `.app` and stops at launchd, so it names nothing:
- for the scan (Gap 1's walk), and
- for the hooked path: `createTmuxOuter` and `createHerdrOuter` find the client and then call `scannedApps` on it, which
  names no app. The agent then falls back to whatever its hints name (`TERM_PROGRAM=tmux`, or the bundle id the tmux or
  herdr server started with), and has no tab.

The 2026-11-14 app-filter plan names Gap 2 as unmeasured (item 4, option B: "a new row for iTerm2's server").

## Goals

1. **Scan, nested (the cause Diego hit).** A session the scan found whose terminal tmux or herdr made, with that
   multiplexer's client in a tab of Terminal, iTerm2 or Ghostty, is on that app's page as soon as the scan lists it, not
   at its next hook. It counts as known (no `appPending`).
   - A rest selects the client's tab. In tmux it also selects the agent's pane.
   - In herdr it also focuses the agent's pane when herdr's own list gives that pane a session id. herdr gives one for
     Claude Code only once the person ran `herdr integration install claude` (`recordedHerdr.ts`); without it, a rest
     reaches the tab only.
   - A tap brings the app forward on that tab and pane.
   - Words before its first hook are unchanged: no pane is typed into on the scan's word.
2. **iTerm2's server.** The walk (`scannedApps`, used by the scan, by the hooked walk `learnApp` and by the tmux, herdr
   and Zellij client lookups) reads iTerm2's server process as iTerm2. Then a plain tab, a tmux client and a herdr client
   in iTerm2 name iTerm2 whether or not the server's parent is still iTerm2.
3. **The exact case.** iTerm2 with a plain Claude Code tab, a tab running tmux with Claude Code, and a tab running herdr
   with two Claude Code panes gives four rows on iTerm2's page, each swipe-reachable to its own tab, and to its tmux or
   herdr pane (herdr's pane as Goal 1 says). This holds:
   - when each agent is hooked, and when each was found by the scan after a devices restart while idle (the main red
     test);
   - when iTermServer's parent is iTerm2, and when it is launchd.
4. Nothing changes for Terminal, Ghostty, Herdr.app, cmux, Orca, kitty, WezTerm, Linux or Windows except Goal 1, which
   applies to the same hosts the hooked lookups cover.

## Non-goals

- Zellij in Goal 1: its lookup needs the session name from `ZELLIJ_SESSION_NAME`, which only a hook carries. Its hooked
  path is unchanged and gains Goal 2's row.
- A scan-found herdr agent whose herdr row has no session id: its herdr row stays a second row on herdr's page until
  its first hook, as it is today (`registry.ts` folds by session or pane key, and the scan's copy has neither).
- Named herdr sessions, herdr `--remote`, the dial following herdr's or tmux's own pane changes inside one tab: as
  before.
- Words typed into a scan-found nested agent before its first hook.
- Any reading of another process's environment or argv.

## Design

All in the devices process: `cli/src/cable/hosts/` and the wiring in `cli/src/services/devices.ts`. Nothing in the
daemon core or the hook (`cli/AGENTS.md`).

### Gap 1: the scan asks the lookups by process

- **A process form for each lookup that can take one.** `OuterLookup` (`outer.ts`) is `(hints, pid)`, and `firstOuter`
  chains only that form. tmux's and herdr's lookups each also export a process form for a process whose terminal that
  multiplexer made. It answers the same `ClientPlace` the hooked form does, and shares an answer in flight for 5 s as the
  hooked form does.
  - **tmux.** The pane is the person's pane whose `#{pane_tty}` is the process's own tty. That tty was read for the
    maker, so no second read is needed.
    - It is read with one `tmux list-panes -a -F '#{pane_id}|#{pane_tty}|…'`, held to the same owner rule `paneFacts`
      holds (no daemon's tag, no Harness session).
    - Its output is bounded: at most a fixed number of lines read, the rest counted and passed over.
    - From that pane id on, the lookup is the hooked one (`list-clients -t <pane>`, client used last, its app).
    - The answer also names the pane id, which a rest and a tap need.
  - **herdr.** `placeOf(pid)` already takes the process alone; the hint only gates it. The process form exposes it.
- **A new `ObservedDeps` entry** (`nested(host, pid, rows)`, or the plan's name for it), wired in `devices.ts` beside
  `firstOuter`. It sends `tmux` and `herdr` to their process forms and answers `undefined` for any other host.
- **The scan asks it, once per listed session.**
  - `scanOnce` reads the process table once for the look. It reads each listed session's terminal maker from that table
    (`readPtyMaker` with the tty reads it already does), not with one table read per session. Numbers before and after
    for a look over the bound of 50 sessions go in the plan's verification (code standard 4).
  - Only a maker of `tmux` or `herdr` asks the entry.
  - A nested session never has its own tty read for a tab: that is the multiplexer pane's pty, which on macOS has a
    tab's form (`askOuter` avoids it the same way).
- **The answer lands** only while the session is live and no hook has told of it (`entry.caller === undefined`).
  - One that names an app sets the entry's `outer` (app, client tty, client pid), its app and bundle, then `locate` and
    `emit`, as `askOuter`'s answer does.
  - One that names no app leaves the scan's walk as it was.
  - A session paired with a Herdr.app terminal (`pair`) is not asked: its maker is Herdr.app's, never `herdr`'s.
- **The first hook after it.** `askOuter` drops `outer` when the last ask was not for this caller and these hints. A
  scan's place counts as an ask kept until the hook's own answer lands, so the row does not leave the page meanwhile.
  The hook's answer then wins.
- **Panes, for a rest and a tap only, never for words.** A held pane gives no rest (`rest` drops `pane.held`), so both
  use the "placed" form that `placeIn` reads.
  - tmux: the answer's pane goes in a field of the entry that `placeIn` reads for tmux, as
    `%<n>:<process>:<app>`, the form tmux's `paneParts`, pane check and `canShow` take. Not
    `setPaneNames('tmux', …)`: that replaces the adapter's whole map.
  - herdr: in `devices.ts`, the same shape as `placeInCmux`: from the herdr source's rows that carry a session id, a
    place for each observed agent of that engine and session that has no herdr pane of its own, as
    `<pane id>:<app>` (herdr's `canShow` needs the app). herdr's adapter has `type`; a placed pane never takes words,
    which a test proves.
  - The tab comes from `outer` through the tabs adapter, as for a hooked agent.

### Gap 2: iTerm2's server in the walk

- One fixed row in `scannedApp.ts`, macOS only: a process whose executable is `iTermServer-<version>` counts as iTerm2's
  app (`iterm`). `<version>` matches `[0-9][0-9A-Za-z.-]{0,31}`, which takes a nightly's `-`. Either form counts:
  - the full path `<home>/Library/Application Support/iTerm2/iTermServer-<version>` or
    `<home>/.iterm2/iTermServer-<version>`;
  - the bare name `iTermServer-<version>` exactly.
- It sits in the same nearest-first order `nearestApp` reads, so a nearer app still wins. It reads no bundle and so takes
  none of `BUNDLES_A_PASS`.
- It is matched and dropped like every other name. Nothing of it is kept, logged or sent.
- **Risk (in the PR body).** The row was not measured: nobody has run `ps -axo comm=` against a live iTermServer, on
  Diego's Mac (forbidden here) or on any other. The form comes from iTerm2's source. A process outside iTerm2 named
  exactly `iTermServer-<version>` would put its children's agents on iTerm2's page. That is a wrong page, never words
  typed into a wrong place: rest and tap still go through the tabs adapter's tty check. If the measured form turns out to
  differ, the row changes in a follow-up.

### Failures and measures

- The scan's line gains a count: `[observed] scan · … · <n> nested placed`. It holds counts only, no host and no pid.
- tmux's process form says its own lines, in fixed words: `[device] tmux client · …`, and `over` when the pane listing
  passed its bound.
- A lookup that cannot read leaves the agent where the scan put it, as today.

## Testing

Fakes only (process tables, tmux and herdr runs, iTermServer tables), at the layer where each behaviour lives. Each test
is red before its fix.
- `observed.spec.ts` (Gap 1, the main red tests):
  - the devices start again with the tmux and herdr agents idle; the scan finds them; each is placed on its client's
    app with a tab and pane, not on Other's page;
  - a scan-found nested session never has its pane's tty read;
  - an answer after a hook, or for an ended session, is dropped;
  - the first hook after a scan placement keeps the row on its page until the hook's answer lands;
  - a maker that is neither tmux nor herdr asks nothing, and a Herdr.app pairing is not asked;
  - a placed herdr or tmux pane takes no words.
- `tmux.spec.ts`:
  - the process form finds the pane by its tty and skips a daemon's or Harness's pane;
  - it answers `{}` for a process in no pane, says `over` past the bound, and shares an answer in flight.
- `herdrOuter.spec.ts`: the process form gives the hooked form's answer and shares one in flight.
- `scannedApp.spec.ts` (Gap 2):
  - iTermServer's row in both forms and a nightly version, with iTerm2 as its parent and with launchd as its parent;
  - near misses that name nothing: `iTermServer`, `iTermServer-` with no version, a path in another folder, Linux;
  - a nearer `.app` still wins.
- `devices.spec.ts` (the wiring): the exact case, four rows on iTerm2's page, hooked and scan-found, with iTermServer
  under iTerm2 and under launchd.
  - A herdr row with a session id folds into one row with its pane.
  - One with none gives the tab only, plus the herdr page's row as today.
- Unchanged suites for Terminal, Ghostty, Linux and Windows stay green.

Platforms: macOS (both gaps); Linux (Gap 1 for tmux and herdr); Windows: no change (no scan walk, no `ps`).
