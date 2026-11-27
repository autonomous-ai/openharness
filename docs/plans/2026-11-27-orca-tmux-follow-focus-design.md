# Dial: follow focus into tmux inside an Orca tab (O11 option B, follow only)

Date: 2026-11-27. Branch: `feat/orca-tmux-follow-focus`. Builds on #4591 (tmux pane focus poll), #4628 (a tap on an
agent under tmux in Orca switches Orca to its tab) and the O11 proposal
(`docs/plans/2026-11-25-dial-orca-tmux-o11-design.md`, option B).

## Goal

When Claude Code (or another engine) runs under tmux in an Orca tab, the dial follows the person without a prompt
being typed:

- they focus that Orca tab: the dial turns to the agent tmux shows there;
- they move to another tmux pane in that tab: the dial turns to that pane's agent.

Today neither moves the dial (App → dial ⚠️ for Orca). A tap already switches Orca to the right tab (#4628).

## Decisions (PM, 2026-11-27)

1. Follow only. Option B's item 3 (`host: 'orca'` for the Pro's Orca room) stays out, in the backlog.
2. Two tmux tabs in one worktree that cannot be told apart (same engine) are not followed. The dial never guesses a
   session.
3. Several agents under one tmux in one Orca tab are all placed at that tab, and each keeps its session's name.
4. The eval grades the new behavior in tier A: O24, O25, O26 (below).
5. Tier B with a real tmux client in the Orca stand-in is a backlog item of its own; this branch is tier A only.

## Why the dial does not follow today

- **Orca tab.** Orca's focus watch (`orca terminal watch-focus`) names the Orca terminal in focus.
  `services/devices.ts` `followFocus` looks up an agent with its own Orca pane there (`byPane('orca', …)`). An agent
  under tmux has no own Orca pane (`cable/hosts/orca.ts` `MULTIPLEXERS`): `focus · skipped · unknown agent`.
- **tmux pane.** The tmux pane poll (`tmuxPanes`) skips every agent with `app === 'orca'`, left to Orca's focus watch.
  That watch sees no tmux pane move: the Orca terminal in focus stays the same.
- **Which tmux client is in which Orca tab.** Orca's terminal list names no tty or process of a terminal (Orca's
  `RuntimeTerminalSummary`: `handle`, `ptyId`, worktree, tab, title, `agentIdentity`, …; `ptyId` is Orca's own id).
  The only link is elimination, as `placeInOrca` does today: the terminal Orca saw an engine start in, in the agent's
  folder. Today it places an agent only when it is the one agent of that folder and engine with no Orca pane, and
  the terminal the one free terminal of that folder and engine. Two tmux panes running Claude Code in one Orca tab
  place neither, and an agent not placed is off Orca's ring while Orca is in front (worktree scope), so no follow may
  land on it.

## Design

All in the devices process (`services/devices.ts`, `cable/hosts/`). Nothing in the core. Nothing is written to the
person's tmux or Orca: the reads are the ones the product already runs (`orca terminal watch-focus`,
`orca terminal list`, `tmux list-clients`).

### 1. Placement by the tmux client

`placeInOrca` places agents in two steps, at each Orca order read, as now:

1. **The tmux client of each free Orca terminal.** For a free Orca terminal (no agent's own Orca pane holds it) of
   folder F and engine E (Orca's `agentIdentity`), the candidates are every agent on Orca's ring with no Orca pane in
   folder F and engine E, nested or not, as today. When the terminal is the only free one of F and E, and every
   candidate is nested in tmux with one and the same client tty T (`tabTty`), client T is placed at that terminal.
   A candidate that is not nested, or has no client tty, or another one, blocks it: a plain unhooked Claude Code in
   another tab of F is then never mistaken for the tmux tab. The map is built terminal → T for every free terminal
   first; a T two terminals would take is dropped from both. Today's single agent is the case of one candidate.
2. **Every agent of that client in that folder.** Each agent on Orca's ring with no Orca pane, nested in tmux, in
   folder F, whose client tty is the client placed at F's terminal, is placed there, whatever its engine (a Codex pane
   beside the Claude Code pane Orca names). An agent of that client in another folder (cd'd elsewhere, or a stale
   client from the lookup's 5 s cache naming another worktree's session) is not placed, so it never enters this
   worktree's scope or rank. Agents placed today with no client stay placed as today.
3. **A tmux tab whose selected pane runs a shell.** Orca names no engine there, so its terminal is no candidate at that
   read (`orca.ts` `agentTerminals`) and its client is placed nowhere until a read finds an engine again: nothing is
   followed meanwhile, never a wrong one.

What a place gives is unchanged: the tab's rank, the worktree scope, and the terminal a rest or a tap switches to
(`observed.ts` `placedTab`, #4628). It never gives a pane words are typed into.

- **Names (decision 3).** A terminal with one placed agent names it by its tab, as today. A terminal with two or more
  names none of them: each keeps its session's name as an unplaced agent does today (`observed.ts` `nameOf`: its
  session title, else its folder's name), so the tab's name is not given to several rows. The devices leave that
  terminal out of the names they hand `setPaneNames`.
- **Order.** Agents at one terminal share its rank; the ring's sort is stable (`select.ts`), so they keep the order
  they entered the ring in among themselves (not tmux's pane order).
- **Not placed (decision 2).** Two free terminals of F and E, candidates on two clients, or a client that is another
  terminal's too: none is placed, as today, and nothing below follows them.

### 2. Orca's focus tells the tmux client in front

Orca reports no tabs to the tmux poll. Its focus watch takes that role, as VS Code's terminal focus does
(`editorClients`, docs/plans/2026-11-26-dial-mux-host-pages-design.md §7):

- Orca's told client is its own variable (`orcaClient`), not `editorClients`: an editor's focus clears that one, and
  there "none told" means every client. `toldClients('orca', …)` returns Orca's told client alone; with none told,
  none.
- It is worked out from the terminal Orca's watch told last (`focusWatch.pane`): the client placed at that terminal
  (step 1), else none (an agent's own Orca pane, a shell, a client not placed). It is worked out again at each focus
  line, at each Orca settle (`orcaSettled`: Orca's watch prints only on change, so coming back to Orca brings no line),
  and after each placement (`setPaneNames('orca')`, which can land after the focus line).
- A focus line that names a terminal with a placed client drops tmux's place from the poll's last answer, as
  `tmuxShows` does for an editor's terminal: the next read is a change even when the person was away from that tab for
  less than one read.
- The line itself goes on as today: an agent's own Orca pane is followed by `followFocus`. A terminal with a placed
  client moves the dial only through the poll (below), which reads where that client is.
- It is dropped when Orca's watch ends or the dial goes. Another app settling in front stops Orca's poll, as today.

### 3. The tmux pane poll reads Orca's told client

`tmuxPanes` takes agents with `app === 'orca'` too, when they are placed (step 1). `focusAdapters` then gives Orca's
poll the tmux place while Orca is settled in front, a dial is attached and such an agent is live. Each read:

- with no told client: answers null and runs nothing (no tmux call);
- else one `tmux list-clients -F '#{client_tty}|#{pane_id}'` (as #4591): the one live agent at the pane the told
  client shows, else null.

`paneAnswered` follows it as for any other app, with one more check before the move, as `onTabInFront` does for a tab
app: the agent's client tty is still Orca's told client, and the agent is still placed at the terminal in focus. So:

- **Orca tab switch.** Focus on H (client T, tmux shows pane p): the poll's tmux place goes from null (or another
  pane) to p, and the dial turns to p's agent. Back from a plain tab, the place went null in between, so p is a change
  again.
- **tmux pane switch.** Same terminal, the client shows pane q: the place changes from p to q, and the dial turns to
  q's agent.
- **The dial's own moves.** A tap's or a rest's tmux select is noted (`paneTaps`) and a move of the dial during the
  read changes `dialMoves`: the poll's read that sees either is skipped as its echo, as for iTerm2 today. Orca's own
  switch echo (`orcaSwitches`) stays the focus line's, which takes it: the poll names tmux panes, not Orca terminals.
  A first answer as Orca settles is skipped when the dial moved within `ATTACH_ECHO_MS`, as today. O11's tap now also
  starts this poll; its echo is skipped by `paneTaps` within `TAB_ECHO_MS`.
- **A client switched to another tmux session.** `list-clients` names the pane it shows now. The dial follows the
  agent there only when it is a live agent placed at the terminal in focus, else nothing moves. The pane is matched
  with the client's tty too (`tmuxFocused`), so a stale client from the lookup's cache moves nothing.

### Wrong-session risk

The pane the dial follows is the pane `tmux list-clients` says the told client shows: never a guess. The one inference
is which client is in which Orca tab (step 1), accepted only when it is the only answer. When it is not, nothing is
placed and nothing is followed (decision 2). Words still go by the agent's mod or `codex queue`, never typed into Orca
or tmux (unchanged). The eval's gate holds wrong-session sends at 0.

### Cost

- No new process, no new subscription. The poll is the one #4591 runs, one place more.
- tmux is asked only while Orca is settled in front, a dial is attached and Orca's focused terminal holds a placed
  client: one `list-clients` 500 ms after each read ends. Zero calls otherwise (a plain Orca tab, Orca behind, no
  dial).
- Measured as #4591 did (the devices' CPU over a minute, before and after), with Orca in front on a tmux tab.

### Platforms

- **macOS and Linux:** as above. tmux's lookup names Orca by the client's parents (on Linux by Orca's main
  process, `orca-ide`).
- **Windows:** not affected. tmux runs only inside WSL there, and a WSL agent's hooks never reach the Windows daemon.

## The eval (tier A, macOS and Linux)

New Orca scenarios in `cli/src/testing/dialAppEval/orcaScenarios.ts`, `platforms: ['darwin', 'linux']`,
`tiers: ['a']`:

- **O24, Orca tab switch.** `a` in its own pane (tab 0), `c` under tmux (tab 1). Focus `a`, then focus `c`'s tab:
  `focus` → `c`. Then focus `a` and, within one poll read, `c`'s tab again: `focus` → `c` (the dropped last answer).
- **O25, tmux pane switch.** `c` and `d` under one tmux in one Orca tab (tab 1), `a` in its own pane (tab 0); `c`
  starts first, so its pane is the one selected. Focus that tab, then `tmux.selectPane` `d`: `focus` → `d`. The ring
  is `[a, c, d]` (c and d in the order they entered), each by its session's name.
- **O26, two tmux tabs that cannot be told apart.** `a` in its own pane (tab 0), `c` (tab 1) and `d` (tab 2), each
  under its own tmux, same engine and folder. Focus `a`, then `d`'s tab: `still` (the dial does not move). A guard:
  it passes on `main` too (nothing follows there), so it is not a red check; it must hold after the fix. The gate: no
  wrong-session send.

Tier A's model change, for Orca sessions with `tmux: true` in the same worktree and tab:

- one Orca handle a worktree and tab (not a session), one Orca pane shell and tty that ends with its last session,
  and that handle listed once in `orcaLayout` and `orcaFront`;
- one tmux session, `eval-orca-<worktree>-<tab>` (iTerm2's are `eval-<window>-<tab>`), its panes in `split` order and
  the first started selected, as tmux selects it;
- Orca lists that terminal with the engine of the tmux pane selected in it as its `agentIdentity`, as Orca's own tmux
  status does (stablyai/orca `server-tmux-status.ts`): `orcaListing` takes that engine from the tier (tier A's tmux
  model); tier B keeps each session's own engine, as its sessions under tmux share nothing.

O11 has one such session and keeps its listing.

Hill-climb rules: O24's and O25's checks fail on `main` first (red), then the fix; O26 holds on both. One eval run on
the PM's Mac turn (`TMPDIR=/tmp`), `--update-baseline` by the eval tool only. Merge only when Orca's score rises or
holds with the new checks, no other app drops, and wrong-session sends stay 0.

## Not in this branch

- The Pro's Orca room for these agents (`host: 'orca'`, option B item 3): backlog.
- Tier B with a real tmux client in the Orca stand-in: backlog (PM).
- Two tmux tabs of one engine in one worktree: not followed by design.
- Not checked against a real Orca: the placement relies on Orca's terminal list naming the engine tmux shows in a
  tab, which Orca's public source says it does.
