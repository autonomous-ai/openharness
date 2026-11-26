# Dial: a tmux or herdr agent is on its terminal app's page and on the multiplexer's page

Date: 2026-11-26. Branch: `feat/dial-mux-host-pages`. Replaces Diego's 2026-11-23 rule that an agent inside tmux or
herdr is only on the multiplexer's page (`docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md`, #4578) and the page
turn on a follow that came with it (#4591, `AppFilter.follow`, `CableHost.followPage`).

## Diego's request (2026-11-26, his words)

> "gom tmux/herdr gặp nhiều issue quá, xử lý theo logic này:
> 1. iTerm2/Terminal… vẫn show những session tmux/herdr; khi swipe qua lại trên app/device thì device/app vẫn swipe theo.
> 2. Khi chọn app tmux, session đó đang nằm trên app nào thì focus app đó; nếu có nhiều app đang mở thì chọn 1 cái.
>    Hiện tại khi chọn tmux, vì tmux không phải là app nên trên laptop không focus app nào.
> 3. Khi chọn app herdr, nếu session herdr đang nằm trên app khác thì focus app đó. Trên máy Diego app herdr chỉ có 3
>    session, 2 session còn lại mở ở herdr terminal; khi swipe qua 2 session này thì cần mở đúng app đang mở herdr
>    terminal đó; nếu có nhiều app đang mở thì chọn 1 cái."

In English: (1) the terminal app (iTerm2, Terminal, …) still lists its tmux and herdr sessions, and swiping on the dial
and switching on the computer follow each other there. (2) Picking tmux brings forward the app that holds that session;
with several, pick one. Today picking tmux brings nothing, as tmux is no app. (3) Picking herdr brings forward the app
that holds the herdr session; Diego's Herdr app holds 3 sessions and 2 more run in a herdr terminal inside another app:
swiping onto those 2 must bring that app forward; with several, pick one.

## What changes for the person

Diego's iTerm2 holding one plain Claude Code (a), one Claude Code in tmux (b) and two in herdr panes (c, d):

| | Before (23/11 rule) | After |
|---|---|---|
| Apps screen | iTerm2 · 1, tmux · 1, herdr · 2 | iTerm2 · 4, tmux · 1, herdr · 2 |
| iTerm2's page | a | a, b, c, d (in the order they entered, as every ring) |
| tmux's page | b | b |
| herdr's page | c, d (plus Herdr.app's own) | c, d (plus Herdr.app's own) |
| Selecting b's tab in iTerm2 | the dial turns to tmux's page, on b | the dial stays on iTerm2's page and moves to b |
| Moving to another tmux or herdr pane in iTerm2 | the dial turns to tmux's or herdr's page, on its agent | the dial moves to its agent on iTerm2's page |
| A swipe on iTerm2's page resting on b | selects b's tab, then b's tmux pane (iTerm2 in front) | the same |
| Picking tmux's page with another app in front | nothing comes forward | iTerm2 comes forward on b's tab and pane |
| A swipe on tmux's or herdr's page resting on an agent whose app is not in front | nothing | that app comes forward on the agent's tab and pane; the dial stays on tmux's or herdr's page |
| A tap on b, c or d (any page) | brings iTerm2, its tab, its pane | the same |

One agent, two pages, one row on each: the agent keeps one id, and each page lists it once. The Apps screen counts it
on both pages, so the counts on the Apps screen add up to more than the number of agents.

### Per page

- **A terminal app's page** (Terminal, iTerm2, Ghostty, WezTerm, kitty, VS Code, Cursor, Warp, Orca, Rex, …): its own
  agents and every agent in a tmux or herdr pane whose client (the one the lookup chose, below) runs in that app. Follow
  works both ways, as for its own agents: a swipe that rests shows the tab, then the pane (today's rest, unchanged); a tab
  selected, a prompt submitted, or a tmux or herdr pane switched to in the app settled in front moves the dial to that
  agent on this page. A terminal app that holds only tmux or herdr clients is on the Apps screen again (it dropped out
  under the 23/11 rule).
- **tmux's page**: every agent in a pane of the person's tmux, across every app, and a detached session's too.
- **herdr's page**: every agent in a herdr pane (herdr's own list and the hooked or scanned agents in it, across every
  app) and Herdr.app's terminals, as today.
- On tmux's and herdr's pages, which have no app of their own, **a pick, a rest and a tap bring forward the app that
  holds the agent's client**, then its tab, then its pane. No words are typed by any of these.

### Which app, when there are several (Diego: "chọn 1 cái")

Each agent has one app at a time: the app holding the client its lookup chose. The lookups already choose the client
used last (tmux: `client_activity`, a tie going to the one listed later, which attached later, `tmux.ts`; herdr: the
client's tty access time, `herdrOuter.ts`; Windows: the newest herdr client in a listed app, #4629). That rule stays;
a tap and a rest read it afresh (#4592), so the app is the one the person used last. A Herdr.app terminal's app is
Herdr.app. Never none while a client runs in a listed app: an agent with no such client (detached, or its client in a
terminal with no page) is only on the multiplexer's page, and a pick, rest or tap there does what a tap does today: it
focuses its pane, and on macOS also brings the app whose bundle id its hints carry (the terminal that started the
multiplexer's server), as #4629's decision 2 keeps (PM, 2026-11-26: kept as today). Such a rest reports `ok`, not
`opened`, as the agent has no client app.

### A pick of tmux's or herdr's page

The pick brings forward the app of the agent the dial lands on (the agent it showed before, when the picked page lists
it, else the page's first row), as a rest on it would, and selects its tab and pane there, also when that app is in
front already. When that agent has no client app, the app of the page's agent heard from last that has one. When no
agent there has one, nothing comes forward, as today, and `[device] app filter: bring · none` is logged.

Herdr.app agents and herdr agents in another app share herdr's page: picking it with the face on a Herdr.app terminal
brings Herdr.app (today's pick); with the face on c, it brings iTerm2.

### The page holds while the dial brings apps forward

The app a pick, a rest or a tap on tmux's or herdr's page brings forward settles in front a second later. Today a settle
of another app ends the pick and shows that app's page, which would turn the dial from tmux's page to iTerm2's under the
person's finger after every rest. So: **the first app that comes to the front within 2 s of the dial bringing one
forward is the dial's, and its settle keeps tmux's or herdr's page shown.** An app the person brings forward (Cmd-Tab, a
click) later turns the page, as today. On the terminal's
own page nothing changes: the app the dial brings is the one in front already.

A tapped notice of a nested agent turns the dial to its terminal app's page (the app the tap brings forward, so the
settle that follows does not flip the page), else to the multiplexer's page.

## What the code does today (where the change lands)

All in the daemon's devices process (`cli/src/cable/`, `cli/src/services/devices.ts`); the core is not touched; no
firmware change (below).

- `select.ts pageOf(agent)` is the one page of an agent: `nest` when set and the app is not Orca, else the app (or the
  unknown app's page). Read by `AppRings.update`/`counts` (rings, Apps screen counts, the filter's counts),
  `cableHost.appRing` (Orca's scope), `cableHost.appOf` (a notice's pick), `cableHost.followPage`, `devices.ts` (the
  page an agent with no window would get, `usageAgent`; Rex's agents and panes, `rexAgents`/`rexPanes`; tmux's pane
  poll, `tmuxPanes`; herdr's focus follow, `herdrFocused`, which skips herdr inside Orca).
- `AppFilter.follow`, its `followed` hold, `settling`, `SwitchCause 'follow'` and `CableHost.followPage`, called from the
  tab, prompt, tmux pane, herdr focus, WezTerm and kitty follows in `devices.ts`: they turn the page to tmux's or herdr's
  on a follow. The `settling` dep also carries the tab judgement made at a settle (`appSettling` → `tabSettling`,
  `tabJudged`, `devices.ts`).
- After a pick the round dial lands on its new ring's first row (`ui_habitat.c` `app_landing`); the daemon steers it to
  the agent it last recorded when that agent is in the new ring (`cableSession.ts`).
- The round dial draws the row's `host` under the agent's name and in "See it in <host>" (`ui_habitat.c` `face_app`,
  `host_name`).
- `cableSession.restOn` arms a rest only when `host.swipeSwitches(agent)` (`observed.hasPane`: a pane its app can show
  now, i.e. its app is in front); `cableHost.swipeEnded` then runs `source.showPane`, which never brings an app.
- `cableHost.pickApp` → `wiring.appBrought(app)` → `open.ts bring(app)`: an app by its bundle; tmux has none, herdr's is
  Herdr.app only while Herdr.app lists agents.
- `AppFilter.settle`: another app settling ends `pickedOnDial` and shows that app's page.
- The rows sent to a dial carry `host: a.host` (`cableHost.ts machineSnapshot`): `tmux` or `herdr` for a nested agent.
  The Pro lists in an app's room only the rows whose `host` is that app (`pod_view.c pod_app_agents`), so on iTerm2's
  page it would hide b, c and d.

## Design

### 1. Pages: `pagesOf(agent)` replaces `pageOf`

`select.ts pagesOf(agent): string[]`, the one rule every reader of the page goes through:

- the app's page: `app` when it is in `APP_IDS`, else the unknown app's page; except that a nested agent (`nest` set)
  whose app is not a listed app (none, `appPending` with no app, or the unknown app) has no app page;
- and, when `nest` is set and differs from that page, `nest`'s page.

So: a plain agent has one page, as today; b has `['iterm', 'tmux']`; a detached tmux agent `['tmux']`; a Herdr.app
terminal `['herdr']`; tmux inside Orca `['orca', 'tmux']` (Orca's ring keeps its tab order; `orcaAgents` still takes
`app === 'orca'`); tmux inside Rex `['rex', 'tmux']`. The Orca exception goes: it existed only because an agent could
be on one page.

Readers:

- `AppRings.update` puts the agent in each of its pages' lists; `apps()` counts and `waiting`/`working` are per page.
  `AppRings.counts` (the filter's `all`, `known`, `inFront`) counts it on each page, so an app in front holding only
  tmux clients has agents in front and shows its page (Diego's point 1).
- `cableHost.appRing` (a scope while its app is in front): `pagesOf(a).includes(app)`.
- `devices.ts`: `rexAgents`/`rexPanes` read `pagesOf(..).includes('rex')`; tmux's pane poll (`tmuxPanes`) runs for a
  live agent with `nest === 'tmux'` whose app is not Orca, and herdr's focus follow (`herdrFocused`) keeps skipping herdr
  inside Orca: Orca's own focus watch follows its panes, and a second follow there would fight it; `usageAgent`'s page
  is the first page. tmux inside Rex is not polled (`focusAdapters` returns early for Rex), as today.
- `cableHost.appOf` (a notice's pick): the first page, i.e. the terminal app's when it has one (above).
- `DialRing` keeps one ring per page; an agent in two rings has a place in each.

### 2. A row's `host` is the page it is shown on

For a nested agent the row sent to a dial carries `host` = the page shown when that page is its app's page, else its
`host` as today (`tmux`/`herdr`). On iTerm2's page b reads `host: 'iterm'` (the round dial draws "iTerm2" under its
name); on tmux's page `host: 'tmux'` (it draws "tmux", and a voice refusal there says "See it in tmux", which is where
it runs). The Pro's room, which lists the rows whose `host` is the shown app, holds it on both, with no firmware change.
Only the rows of a page's ring change; `HostAgent.host` itself, which voice refusals and notices read, is unchanged. The
`dial` stream's shown app (`cableSession.reportShown`, read by Orca's plugin) follows the row, so it names the page
shown.

### 3. Follows stay on the page shown; the page turn goes

`AppFilter.follow`, `followed`, `held`, `SwitchCause 'follow'` and `CableHost.followPage` are removed with every call
(the replacement removes the old). The `settling` dep goes too once nothing needs the page before the settle: the tab
judgement it carries (`tabSettling`, `tabJudged`) moves into `tabSettled`, judged once at the settle as today. A tab,
prompt, tmux pane, herdr focus, WezTerm or kitty follow
calls `cable.followLocal` alone, which moves every dial whose ring holds the agent: with the app settled in front, the
dial shows that app's page, which now holds the nested agent. A dial a pick holds on tmux's or herdr's page also holds
the agent and moves to it there, as today.

### 4. On tmux's and herdr's pages a rest brings the app

Only for a dial that shows one app's ring (`appFilter`) in the apps view: not the window's tab, not the single ring of
a dial without `appFilter`.

- `cableSession.restOn` passes the dial's own options (`asItself`) to `swipeSwitches(agentId, opts)`. The host reads the
  page shown from a new read-only `AppFilter.showing()` (never `shown()`, which can switch the filter). On `tmux` or
  `herdr` it answers true when the agent is on that page and either its pane can be shown now (`hasPane`, today's rest)
  or it can be opened (`open.can`: its app, its window or its pane). On any other page it answers as today.
- `swipeEnded(agentId, 'rest')` checks the page again at the rest. On `tmux` or `herdr`: when `hasPane` holds (its app
  is in front), today's `showPane` (tab, then pane); else the source's open, `outside.source.focus(agent, latest)`, the
  tap's own path (fresh client read, `placedTab`, the app or window, `raiseAfter`), with a rest counter in the host as
  its `latest`, so a later rest or pick wins. Never `openAgent`, which counts a tap. On any other page: today's
  `showPane`, unchanged.
- A Herdr.app terminal on herdr's page: with Herdr in front a rest switches Herdr's terminal (today); with it not, the
  open brings Herdr.app and switches it. herdr's own rows that no hook or scan placed (no client app) focus their herdr
  pane only.
- The outcome is told as a rest's (`wiring.swiped`), with `opened` beside `ok`/`busy`/`failed`/`superseded`.

Cost: a rest is a 400 ms pause (`SWIPE_REST_MS`), so browsing tmux's page brings an app at each pause, with a fresh
client read (at most one a second per agent, up to 700 ms) before it. That is Diego's point 3; the open of a superseded
rest stops at its `latest` check.

### 5. A pick of tmux's or herdr's page brings the landed agent's app

- `pickApp` skips `appBrought` for `tmux` and `herdr`; their pick brings by the landed agent instead.
- `cableSession`'s `app.pick`, after `syncAgents` for a pick answered `switched`, calls `host.pickLanded(app, agentId)`
  with the agent the dial landed on: the one it last recorded when it is in the new ring (the session steers the dial
  there), else the ring's first row (where the round dial and the Pro land after a pick).
- The host runs §4's open on it, or, when it has no client app, on the page's agent heard from last that has one, with
  a pick counter as `latest`, so the last pick or rest wins. None: nothing comes forward, `[device] app filter: bring ·
  none`.
- With the agent's app already in front, the pick still selects its tab and pane there: the app that holds that session
  is focused on it (Diego's point 2).
- `open.ts bringFor('herdr')`'s Herdr.app case and the `herdrApp` dep go: Herdr.app comes when the landed agent is a
  Herdr.app terminal, by that agent's open.

### 6. An app the dial brought holds the page

The app a pick, rest or tap brings settles a second later, and today a settle of another app ends the pick and its
front rule then shows that app's page; for tmux's page shown by the default, the front rule turns it as well.

- `open.ts` gets one dep, `bringing()`, called just before it runs `open -b`, a Linux raise or a Windows raise (`forward`,
  `raiseWindow`, `ownerWindow`, and `bring` for other picks). The devices wire it to `cableHost.dialBrings()`, which
  tells the filter `AppFilter.dialBrings(now)`.
- `AppFilter.front(app)`: the first front report within 2 s of `dialBrings` is the dial's (any app: on Windows a raised
  Windows Terminal has no page, so the app cannot be named before). Its settle still sets `settledFront` (the tab,
  prompt and pane follows read `settledApp()`), and, when the page shown then is `tmux` or `herdr`, holds that page as a
  pick does (`pickedOnDial = true`), logged `[device] app filter: front · dial`. Any other front report behaves as
  today, so the person's own Cmd-Tab or click turns the page.
- On a terminal app's own page nothing changes: the app the dial brings is the one in front already, or the one whose
  page the settle would show anyway.
- A person who brings an app forward themselves within those 2 s is taken for the dial's: that settle holds the page
  once, and their next switch turns it.

### 7. VS Code's and Cursor's terminal focus follows a multiplexer client

Today focusing an integrated terminal matches agents by their own parents (`followEditor`), which never finds an agent
in tmux or herdr (the 23/11 known gap), and tmux's pane poll reads "the one client of that app showing an agent's
session, none of two". With b's tmux client in VS Code's terminal 1 and another client in terminal 2, switching
terminals must move the dial (Diego's point 1, VS Code named in the request).

- When the focused terminal's shell is among a tmux or herdr client's parents (the client chain `vscodeTerminals.ts`
  already keeps for `vscode-tab`), the dial follows the agent in the pane that client shows.
- tmux: that client's pane from `clientPanes` (one `list-clients` read), and tmux's pane poll reads that client while
  VS Code or Cursor is in front, so a pane switch inside it is followed too.
- herdr: the pane herdr last said took the focus, kept by herdr's source in memory, one pane id per herdr server, from
  the `pane.focused` events it already subscribes to, cleared when its attempt ends.
- No words go anywhere; the dial's own shows of the last 2 s are not followed back, as for the other follows.

### What stays the same

- Never type into tmux from a rest, pick or tap; words go only where they go today, and wrong-session sends stay 0.
- Taps: unchanged (they already bring the client's app, tab and pane).
- The client choice per agent (used last), the lookups and their bounds (one a pane and agent every 5 s, one more at a
  tap or rest, at most one a second).
- `RING_PLACES` 16 per page, `APP_LIMIT` 16 rows; tmux and herdr are already in `APP_IDS`.
- Zellij: no `nest`, its app's page only, as today.
- The dial's default page (the app with the most known agents, when nothing is in front or picked) counts a nested agent
  on each of its pages, so it leans to a terminal app over tmux's or herdr's page. Accepted: the terminal's page holds
  every agent the multiplexer's would there.

### Firmware

None. The round dial's Apps screen draws the names and counts it is sent, and its face draws the row's `host`; the Pro's
room lists the rows whose `host` is the shown app. §2 sets that `host` to the page shown.

## Platforms

- **macOS**: all of the above. Tab follow exists here only (Terminal, iTerm2, Ghostty).
- **Linux**: pages, counts, follows (prompt, tmux pane, herdr focus, WezTerm, kitty, VS Code/Cursor terminal); a rest or
  pick on tmux's or herdr's page raises the client's window by its process (`linuxRaise`, as a tap does: X11, sway,
  KDE, Hyprland; GNOME by class). Where nothing reports the app in front, §6 has nothing to hold.
- **Windows**: tmux runs only inside WSL, so no agent has `nest: 'tmux'`; herdr agents whose client is in VS Code or
  Cursor get that page too; a client in Windows Terminal or Alacritty (no page) stays on herdr's page only, and a rest
  or pick there raises that window by its process (`harness-pty raise --pid`, #4629). Follows on Windows: as today
  (neither tmux nor herdr pane focus is followed there).

## Measures

- `swiped` gains `opened` (a rest on tmux's or herdr's page that brought an app).
- `[device] app filter: bring · ok | failed | none` for a pick of tmux's or herdr's page (the existing line, `none` new).
- `[device] app filter: front · dial` when a settle of an app the dial brought keeps the page.
- `SwitchCause 'follow'` goes; `localFollowed(cause, 'moved' | 'no-tile')` stays, and a follow to a nested agent in
  the app in front must end `moved`. No identifiers or content in any line.

## Testing

Red first, at the layer of each behavior:

- `select.spec.ts`: Diego's case (iTerm2 4, tmux 1, herdr 2); detached tmux → tmux only; tmux in VS Code → vscode +
  tmux; inherited `TMUX_PANE` with no `nest` → its app only; tmux in Orca → orca + tmux; Ghostty with only herdr panes →
  a Ghostty row; one row per page; the 16 limits.
- `appFilter.spec.ts`: the first front report within 2 s of `dialBrings` settles and keeps tmux's page (picked, or shown
  by the default); one after 2 s, or the second report, turns it; `settledApp()` is the new app either way; the front
  rule shows an app holding only tmux clients; no `follow` cause is left.
- `cableHost.spec.ts`: rows carry the shown page as `host`; `swipeSwitches` on tmux's page for an agent whose app is not
  in front, and not on the window's tab; a rest there opens, a rest with its app in front shows its pane; a later rest
  or pick supersedes an open still reading; a pick of tmux's page opens the landed agent (the recorded one in the ring,
  else the first row; the one heard from last with an app when that has none); a notice picks the terminal's page.
- `cableSession.spec.ts`: `restOn` passes the dial's options; `app.pick` switched calls `pickLanded` with the landed
  agent.
- `devices.spec.ts`: tab, prompt, tmux pane and herdr focus follows move the dial on the terminal's page (no page turn);
  the tab judgement made at a settle is unchanged; tmux's poll runs for a `nest === 'tmux'` agent outside Orca and not
  for one in Orca; the VS Code terminal focus of a tmux or herdr client follows its pane's agent.
- `open.spec.ts`: `bringing` is called before each `open -b` and raise; no Herdr.app special case in a pick.

The dial eval (`cli/src/testing/dialAppEval/`), public scenarios only; held-out definitions are not opened or changed,
and the baseline is regenerated by `npm run eval:dial-apps -- --update-baseline`, never edited by hand:

- The grader reads an agent's pages by the new rule: `types.ts sessionPage` becomes `sessionPages` (an agent in tmux or
  herdr: its terminal app's page and the multiplexer's), a ring or state check passes on any of them
  (`checks.ts stateParts`), and `apart` grades the agents a page must not list, counted on the pages they are on
  (`checks.ts apartPart`). This code grades held-out scenarios too: a held-out check that encodes one page per nested
  agent may score lower, and the PR lists each such drop by app and dimension, read from the report, never from the
  held-out definitions.
- Public scenarios updated to Diego's new rule (each comment names this spec):
  - I2, I3, I15: iTerm2's page lists a, b, c, d, the Apps screen counts `iterm: 4, tmux: 1, herdr: 2`; selecting b's tab
    keeps iTerm2's page and moves the dial to b; tmux's and herdr's pages graded after a pick.
  - I6, I7, I13, I14, I17, I19, I21: their `listed` steps and `apart` lists (a nested agent is listed on iTerm2's page
    too).
  - I10, I11: the dial follows the pane switch on iTerm2's page.
  - V12: the row is on VS Code's page and on tmux's.
  - O11: the Orca row stays; tmux's page lists it too.
  - Any other public scenario whose `listed`, `counted` or `ring` steps encode one page per nested agent.
- New:
  - I22: tmux's page picked with another app in front: iTerm2 comes forward on b's tab and pane; the eval world then
    reports iTerm2 in front within 2 s (tier A's world records an open but moves no front app, so the step is the
    scenario's), and the dial stays on tmux's page.
  - I23: herdr's page, another app in front, a swipe resting on d: iTerm2 comes forward on d's tab and pane, the front
    moves to iTerm2 as in I22, the dial stays on herdr's page, and a rest on c then shows c's pane.
  - I24: the same tmux session attached from two iTerm2 tabs, the second used last: a pick of tmux's page brings the
    second tab.
  - V16: two VS Code terminals each holding a tmux client: focusing the other terminal moves the dial to its agent on
    VS Code's page.
- Merge only when no app's score drops except where a scenario now grades the new rule (named in the PR), and
  wrong-session sends stay 0. Evals run on the PM's Mac turns, one at a time, `TMPDIR=/tmp`.

Fakes only: no real terminal, tmux, herdr, Orca, VS Code, Cursor or engine of Diego's is touched, and
`harness device notify` is never run.

## Docs

`cli/AGENTS.md`'s devices row and `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md` (a line at its top pointing
here) say the new rule; the devices row's "turns the dial to tmux's or herdr's page and holds that page" goes.
