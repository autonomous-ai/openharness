# Dial: follow a tmux or herdr pane switch without typing

Date: 2026-11-24. Branch: `feat/dial-tmux-pane-focus-follow`. Size: full.

## Goal

After #4578 tmux and herdr are their own apps on the dial. When the person moves to another tmux pane or window, or
another herdr pane, in the terminal tab in front, the dial stays on the old agent until they type a prompt. The dial
must turn to the agent in the pane they moved to, as it already does for a selected iTerm2 or Terminal tab, an Orca pane,
a WezTerm pane and a kitty window.

Eval: iTerm2 scenarios I10 (tmux) and I11 (herdr), checks `focus.lands` and `focus.latency`, fail in tiers A and B on
`main` (baseline). Done when both pass in both tiers, the iTerm2 score rises, no other app drops and wrong-session sends
stay 0, with `baseline.json` updated in the same pull request.

## Rules this design keeps

- **Never a wrong session.** The dial turns only to a live agent already mapped to the pane that became focused. Two
  candidates, an unknown pane or an unknown client: nothing moves.
- **Nothing written to the person's tmux or herdr** (`cli/src/services/AGENTS.md`, "Do not"): no `set-hook`, no option,
  no control-mode client. Reads only, plus the moves the devices already make (`select-window`, `select-pane`,
  `switch-client`, `herdr agent focus`).
- **No feature in the core.** Everything is in the devices process (`cli/src/services/devices.ts`,
  `cli/src/cable/hosts/`).
- **Push where the program offers it, a bounded poll where it does not; zero calls while the app is not in front.**
- **The dial's own moves are not followed back** (the 2 s echo window the tab, Orca and pane follows use).

## What the programs offer (checked 2026-11-24)

- **tmux:** a focus event needs `set-hook` (a write to the person's server) or a control-mode client (`tmux -C`, a new
  client on their session, which can resize its windows). Both are ruled out. What is left is a read:
  `tmux list-clients -F '#{client_tty}|#{pane_id}'` gives, for each client, its terminal and the active pane of the
  session it shows. Tier A's tmux model already answers that command and both names (`tierA/steps/tmux.ts`
  `clientNames`).
- **herdr 0.9.5:** its socket API (`herdr api schema --json`, protocol 22) has a `pane.focused` subscription whose event
  carries `pane_id` and `workspace_id`. The devices already hold a subscription on herdr's socket while a dial is attached
  (`cable/hosts/herdrSource.ts`), so following it costs no new connection and no poll. The first herdr task probes an
  isolated real herdr server (its own socket, `e2e/harness/herdrServer.ts` `PrivateHerdr`), before the code relies on
  it, for: the event's name on the wire (expected `pane_focused`, as `pane_agent_detected` is sent for
  `pane.agent_detected`) and its fields; whether it fires on the `pane.focus` RPC (tier B's `herdr.focus` step), on
  `herdr agent focus` (the dial's own move) and on a new pane opening. Its findings are written into the plan and the
  pull request.

## Design

### tmux: one more place in the pane focus poll

`devices.ts` already runs one poll (`focusPoll.ts` `startFocusPoll`: a read at once, then 500 ms after each read ends,
stopped after 3 failed reads in a row until the next settle) while WezTerm or kitty is settled in front, a dial is
attached and an agent has a pane of its own there. Each read answers, per place, the agent pane focused there or none;
exactly one place whose focused pane changed since the last answer turns the dials (`paneAnswered`).

tmux becomes one more place in that same poll, not a second poll. The poll today assumes its front app is the adapter
of its panes (`PaneFocus.app: 'wezterm' | 'kitty'`, `readFocus`'s kitty-else branch, `paneAnswered`'s
`latestFront() !== focus.app` and `byPane(focus.app, id)`); that generalizes:

- **The poll's key is the settled front app; its places are what that app holds.** WezTerm in front: WezTerm's place;
  kitty: one place per kitty socket; and in any app, tmux's place when a live agent has a tmux pane whose app (the third
  field of the tmux adapter's pane id, `%3:100:iterm`) is the front app. The poll is wanted while a dial is attached and
  the front app has at least one place; it restarts when the set of places changes. With WezTerm in front and tmux
  inside a WezTerm pane, one read asks both, and the existing "exactly one place changed" rule decides.
- **Each answer names the adapter and the agent's full pane id** (`%3:100:iterm`, not `%3`), so `paneAnswered` checks
  `latestFront()` against the poll's front app and looks the agent up with `byPane(<the place's adapter>, <full id>)`.
- **The read.** A new exported method of the tmux adapter, kept unwrapped in `devices.ts` as kitty and WezTerm are, runs
  one `list-clients -F '#{client_tty}|#{pane_id}'` (same binary as the core, `tmuxFinder`, no shell) with a timeout of
  `FOCUS_READ_MS`, not the adapter's `RUN_TIMEOUT_MS` (`runTmux` takes the timeout, as WezTerm's read passes
  `FOCUS_READ_MS`). It parses at most `PANES_A_LISTING` lines and checks each tty and pane id against its form.
- **Failures are per place.** A place whose read fails keeps its last answer for this read (no change from it); the read
  as a whole fails only when every place's read failed, which is what counts toward the poll's 3 failures. A tmux
  failure never stops WezTerm's or kitty's follow.
- **The front client.** The client whose tty is the tab the front app reported selected last, when that app reports
  tabs (Terminal, iTerm2 and Ghostty on macOS, `tabs.ts`): the devices keep the last reported tab tty per app, in memory,
  set by every tab report, and drop an app's when another app, or none, settles in front (the devices are told no app's
  quit; Harness Device reports the tab again each time the app comes back; PM decision, 2026-11-24). Otherwise the one client whose tty is the tab of a live
  agent placed in the front app; two or more such clients, or none: tmux's place answers none (ambiguity moves nothing).
- **The answer.** tmux's place answers the full pane id of the live agent whose tmux pane id's first field is the front
  client's active pane **and** whose tab (its tty, as `byTab` reads it: the tmux client's tty) is the front client's tty,
  else none. The tty match keeps a second tmux server, whose `%N` ids repeat, from naming another server's agent.
- **Following.** `paneAnswered`'s rules stay: the first answer after the poll starts follows only outside the attach
  echo window; after it, a read is dropped when the dial moved while it ran or the pane is the dial's own move of the
  last 2 s. The tmux adapter's rest and tap moves (`select-window`/`select-pane`, `switch-client`) are noted as the
  dial's own under the agent's full tmux pane id (`paneTaps.note`), as kitty's and WezTerm's focus are. The agent found
  is followed as a selected tab is: `cableHost.followPage(id)`, then `cable.followLocal(id, 'pane')`, so the dials turn
  to tmux's page (the follow filter of #4578). WezTerm's and kitty's follows stay as they are (no `followPage`): their
  agents are on the app's own page.
- **Which agents.** Agents with a tmux pane in the observed source: hooked ones, and scan-found ones once the scan gave
  them a tmux pane. An agent with no tmux pane yet is not followed.

### herdr: the `pane.focused` event

- `herdrClient.ts`'s `HerdrEntry` gains `{ type: 'pane.focused' }`; `herdrSource.ts` adds it to the kinds it
  subscribes to, and tells each focus event's bare pane id (`w1:p2`, checked against `HERDR_PANE`) to a new `onFocus`
  listener its deps give. It keeps no state for it.
- `devices.ts` follows a told pane only when all hold:
  - a dial is linked;
  - one live agent has that herdr pane, not held (its herdr adapter pane id's first two fields are the told id);
  - that pane's app (the third field, `w1:p2:iterm`) is the settled front app;
  - where that app reports tabs, the agent's tab (its tty, the herdr client's) is the app's last reported tab: herdr's
    focus can move while the person is on another tab (a pane closing, another client), and that must not move the dial;
  - the told pane is not the dial's own `herdr agent focus` of the last 2 s: the herdr adapter's rest and tap note the
    bare pane id as the dial's own (`paneTaps.note`) as they start, and the event is checked against it as it arrives.
  Otherwise nothing, with one fixed log line. The follow is `cableHost.followPage(id)`, then
  `cable.followLocal(id, 'pane')`.
- herdr has one focus per server, so there is no client to choose beyond the checks above.

### Tier A's herdr model (PM decision 1, 2026-11-24)

Tier A's model (`cli/src/testing/dialAppEval/tierA/steps/herdr.ts`) tells subscriptions nothing when its focus moves, so
I11 cannot pass there whatever the product does. It is made faithful to herdr 0.9.5, nothing else: each open subscription
to `pane.focused` hears the focus event (the name and fields the real server sends, as confirmed above) exactly where
the probe found the real server sends it: the person's `herdr.focus` step, the devices' `herdr agent focus`, and a new
pane taking the focus as it opens if the real one tells that too. I11's checks, every other scenario and
every check stay as they are. Tier B, on a real herdr, confirms the same behavior. The pull request says so.

### Logs and measures

Fixed words and counts only, never a pane, tty or agent: the existing `[device] pane · skipped · <why>` lines and the
poll's `started`/`stopped · n reads, n failed` lines cover tmux; herdr adds `[device] herdr focus · skipped · <why>`
(`not in front`, `echo`, `unknown agent`). The follow itself is counted where every follow is (`followLocal`'s cause
`pane`).

## Platforms

- **macOS:** tmux and herdr, in Terminal, iTerm2 and every app the tmux and herdr lookups place a client in.
- **Linux:** tmux and herdr; with no tab reports, tmux follows only where one client of the front app shows an agent's
  session.
- **Windows:** not followed. tmux runs only inside WSL, whose processes the Windows daemon does not see. herdr runs
  natively, but the lookup of the app holding its client is macOS and Linux only (`herdrOuter.ts`), so its panes carry
  no app and the front check never passes. Both are stated in the pull request and the docs as gaps.

## Cost

- tmux: one `tmux list-clients` every 500 ms after the last read ends, only while an app holding a tmux client of a live
  agent's session is settled in front with a dial attached; zero calls otherwise. Numbers before and after (devices
  process CPU over 60 s with such an app in front, and one read's time) go in the pull request.
- herdr: no new process, connection or timer; one more subscription kind on the existing connection.

## Testing

Red first, from the failing eval scenarios:

- Unit (`devices.spec.ts`): tmux in front app follows a client's pane change to its agent and turns the page; no move
  with two clients and no tab; no move for an unmapped pane or a same `%N` on another client's tty; the dial's own tmux
  move is not followed back; a failed tmux read keeps WezTerm's follow; no read while no dial, no such agent, or the app
  is not in front; herdr's focus event follows and turns the page; not in front, another tab selected, echo, unknown or
  held pane do nothing.
- Unit (`herdrSource.spec.ts`): the subscription names `pane.focused`; a focus event's pane is told, an out-of-form one
  is not.
- Unit (`tmux.spec.ts`): the client listing's parse and bounds.
- Unit (`tierA/steps/herdr.spec.ts`): the model tells `pane.focused` subscribers on `herdr.focus` and `herdr agent
  focus`.
- Eval: tiers A and B (`caffeinate -i`, `TMPDIR=/tmp`, one run on this Mac at a time, with the PM's turn): I10 and I11
  pass; the iTerm2 score rises; no other app drops beyond tier B's documented timing noise; wrong-session sends 0.
  `baseline.json` regenerated in this pull request.
- `npm run test:core` (devices.ts is under `src/services/`, 100% per file).

## Docs

`cli/AGENTS.md`'s devices row: tmux's and herdr's focus followed as above, the last reported tab tty per app kept in
memory, and the Windows gap. The design system and
the dial's UI are untouched: no new screen or copy on the dial.

## Out of scope

Zellij's focus (still not followed), tmux or herdr inside Orca (Orca's own focus covers Orca), any change to how agents
are placed on pages, and any eval change beyond tier A's herdr focus event and `baseline.json`.
