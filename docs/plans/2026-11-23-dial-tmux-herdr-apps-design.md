# Dial: tmux and herdr are their own apps on the Apps screen

Date: 2026-11-23. Branch: `feat/dial-tmux-herdr-apps`. Mockup approved by Diego (2026-11-23):
`devices/harness-device/mockup/apps-tmux-herdr.html` in the main checkout (gitignored).

## What changes for the person

Today an agent in tmux or herdr inside a terminal app (Terminal, iTerm2, Ghostty, VS Code's or Cursor's terminal, …)
sits on that terminal's page. iTerm2 holding one plain Claude Code, one Claude Code in tmux and two herdr panes reads
"iTerm2 · 4". After this change it reads "iTerm2 · 1", "tmux · 1", "herdr · 2".

Decisions (Diego, 2026-11-23):

1. One tmux page and one herdr page, counting their agents across every terminal app.
2. A terminal app left with no agents of its own is not on the Apps screen (it already drops out when its count is 0).
3. tmux in VS Code's or Cursor's terminal moves to the tmux page too. tmux in Orca stays as today.
4. Focusing a terminal tab that runs tmux or herdr turns the dial to the tmux or herdr page. A tap on an agent there
   still brings the right app, window and tab forward and selects the pane, as today.

No firmware change: the round dial's Apps screen is text and knows the names (`host_name`); its grey line under the
agent's name is the shown app's name (`ui_habitat.c face_app`), so it reads "tmux" on the tmux page with no change. The Pro
has the tmux and herdr icons (#4518, `app_icons.c`) and groups an app's room by each row's `host` (`pod_view.c
pod_app_agents`). The work is in the daemon's devices process only (`cli/src/cable/`, `cli/src/services/devices.ts`); the
daemon core is not touched.

## What the code does today

- `HostAgent.host` is the nearest host from the hints (`hostDetect.ts detectHost`: `HERDR_PANE_ID` → `herdr`, then
  `TMUX_PANE` → `tmux`). Those variables are inherited by any program started from a pane (`code .` from a tmux pane
  gives VS Code's terminal agents `host: 'tmux'`; tmux.ts, herdr.ts and orca.ts say so), so `host` alone does not prove
  the agent runs in a multiplexer.
- `HostAgent.app` is the outermost app and also the page (`select.ts pageOf`; the doc on `types.ts HostAgent.app`).
- For an agent that may be nested, `observed.ts askOuter` (hooked) asks the outer lookups (`herdrOuter.ts`,
  `tmux.ts createTmuxOuter`, `zellij.ts`, chained by `outer.ts firstOuter` in `devices.ts`). A lookup answers
  `undefined` at once when the agent's own terminal is not its multiplexer's (tmux checks `readPtyOwner === 'tmux'`),
  else the app holding the client, or `{}` when none was found (detached). `askOuter` sets `agent.app` to that app. The
  same `outer` drives the tap: `entry.bundle`, the client's tab (`tabs.ts paneOf`), kitty's and WezTerm's windows.
- The scan (`placeNested`) places a session found on a terminal a multiplexer made (`Nested.host`, from
  `scannedApp.ts readMadeBy`), sets `outer` and `app`, and leaves `host: 'terminal'`. When the lookup names no app it
  returns before any assignment.
- Pages, counts and the `apps` frame come from `AppRings` (`select.ts`), keyed by `pageOf`; `cableHost.ts` filters the
  shown ring and the Orca and Codex ranks by page too. `AppFilter` (`appFilter.ts`) shows the app in front whenever it
  has agents and no pick holds (`shown()`), a pick, or the most agents.
- Follows (`devices.ts`): a tab selected in Terminal, iTerm2 or Ghostty (`followTab`, run once its app settles:
  `settle()` shows the app first, then `deps.settled` runs the waiting tab report) and a prompt in the app in front
  (`devices.ts:2196`, comparing `agent.app` with the front) call `cable.followLocal`, which moves only a dial whose ring
  holds that agent. VS Code's and Cursor's terminal focus (`followEditor`) matches an agent by its own parent chain, so it
  never finds an agent in tmux or herdr, today or after this change.
- A notice's tap picks the agent's page by `cableHost.appOf`, whose only user it is (`cableSession.ts agent.open`).
- The dial rows carry `host: a.host` (`cableHost.ts`, `cableSession.ts`); the Pro's rooms group by it.

## Design

### Which multiplexer an agent runs in: `HostAgent.nest`

A new optional field `nest?: 'tmux' | 'herdr'` on `HostAgent`, set by `observed.ts` only when the agent's own terminal is
that multiplexer's pane:

- hooked: the multiplexer whose outer lookup answered (not `undefined`) for the agent, whether it found a client or
  not (`{}`, detached). The answer has to say which multiplexer it is (`firstOuter` chains several).
- scanned: `Nested.host` when it is `tmux` or `herdr`, whether or not the lookup names an app.
- otherwise unset. Inherited `TMUX_PANE` or `HERDR_PANE_ID` in a program started from a pane (VS Code's terminal after
  `code .`) leaves it unset, so that agent stays on its own app's page.

The nearest multiplexer wins: tmux inside a herdr pane is `tmux`, herdr inside a tmux pane is `herdr`, the same for the
scan and the hook, so an agent does not change page at its first hook. Zellij and Rex are not part of this request: no
`nest`, page as today.

When `nest` is set, `host` is set to it as well, so the hook and the scan agree and the Pro's room for the page holds
the row (the Pro groups by `host`). For hooked agents this is what `detectHost` already gives in the common case; for
scanned ones it replaces `terminal`. The texts that name `host` then read "tmux" or "herdr" for scanned agents as they
already do for hooked ones: "Waiting for you · X" (`devices.ts`), the notice option "In X" (`notices.ts`), the voice
refusal (`cableSession.ts hostName`), the Orca plugin's shown app (`cableSession.ts`), and `agentPlaceName`.

### One rule for the page

`pageOf(agent)` stays the one function that names an agent's page; every reader of the page goes through it, including
`cableHost.appOf` (renamed or documented as the page) for a notice's pick:

- `nest` set and `app !== 'orca'` → `nest`;
- else as today (`app` when it is in `APP_IDS`, else the unknown app's page).

`HostAgent.app` keeps meaning the outermost app the person sees (the tap, the bundle, the tab, the prompt's "in front"
check, the Claude app's attach); its doc in `types.ts` changes from "the page" to that. tmux or herdr in Orca keeps
Orca's page: Orca's ring is its own tab order and `orcaAgents` (`devices.ts`) takes `app === 'orca'`, which this keeps
equal to Orca's page. tmux inside Herdr.app goes to the tmux page like any other terminal (only Orca is excepted).

Considered and not chosen: setting `agent.app = 'tmux' | 'herdr'`. `app` also names what a tap brings and the app the
prompt follow checks against the front, so each of those would need the outer app from elsewhere.

### A follow turns the page

`cableHost` gets one method, called once in `devices.ts` before `cable.followLocal` for the tab follow and the prompt
follow, so every dial's next read sees the new page. When the followed agent's page differs from its `app` (it is
nested), its `app` is the app settled in front, and the filter is following the front (no pick on the dial holds), the
filter shows the agent's page with a new cause `follow`, and holds it as the front's page: while that app stays in
front, `shown()`'s front rule keeps the followed page instead of turning back to the app's own page. Another app
settling in front, a pick on the dial, or a later follow ends it. A pick on the dial still blocks a follow, as today.

No step through the terminal's page: when a tab report waits for its app to settle and its agent's page differs from
the app's, the settle shows the agent's page directly (iTerm2 with a plain agent of its own, Cmd-Tab back onto the tmux
tab, lands on tmux without showing iTerm2 first). When the terminal has no agents of its own, its settle shows nothing
new and the follow turns the page.

With the Harness window open, a follow's turn does what an app with agents settling in front does today
(`viewOnSettle`): the view goes to `apps`, on the followed page.

### What stays the same

Taps, rests and words: unchanged, they use `outer` and the pane. A pick of the tmux page brings no app (tmux has no
bundle); a pick of the herdr page brings Herdr.app when Herdr.app lists agents, as today. The 16-row limit (`APP_LIMIT`,
`RING_PLACES`) holds; tmux and herdr are already in `APP_IDS`. The Pro's room "Back" returns to the shown page's card.

### Known gaps, not changed here

- VS Code's and Cursor's terminal focus does not follow an agent in tmux or herdr (it matches the agent's own parents,
  which are the multiplexer's server). Decision 3's counting still applies; the follow can be a later proposal.
- tmux or herdr in Orca has `host` `tmux`/`herdr` and Orca's page, so the Pro's Orca room leaves it out, as today.

## Platforms

- macOS: everything above. The tab follow exists only here (Terminal, iTerm2, Ghostty).
- Linux: tmux and herdr run there; `nest`, the page rule, the scan and the prompt follow apply the same.
- Windows: neither tmux nor herdr runs natively, so `nest` is never set and nothing changes; the page rule needs no
  branch.

## Measures

The filter's `switched` gets the cause `follow`, so a follow's turn is told apart from a settle (`front`). The follow's
outcome is the existing `localFollowed(cause, 'moved' | 'no-tile')`: a follow to a nested agent must end `moved`. No
identifiers or content in any line.

## Testing

Unit tests at the layer where each behavior lives, each red first:

- `select.spec.ts`: Diego's case (1 plain + 1 tmux + 2 herdr in iTerm2 → iTerm2 1, tmux 1, herdr 2); tmux in VS Code's
  and Cursor's terminal → tmux; inherited `TMUX_PANE` with no `nest` → its app's page; tmux and herdr in Orca → Orca;
  Ghostty holding only herdr panes → no Ghostty row; the 16-row limit.
- `observed.spec.ts`: `nest` and `host` for a hooked agent in tmux, in herdr, detached tmux, tmux inside herdr and herdr
  inside tmux; `code .` from a tmux pane leaves `nest` unset; a scanned nested agent gets `nest` and `host` with and
  without a client app.
- `appFilter.spec.ts` / `cableHost.spec.ts`: a follow to a nested agent turns the page and the next reads keep it while
  the terminal stays in front; a pick blocks it; another app settling ends it; a waiting tab report makes the settle show
  the agent's page directly (one `switched`, no step through the terminal's page); the window's view turns to `apps`; a
  notice's pick of a nested agent picks its tmux or herdr page.
- `devices` follow tests: a tab report and a prompt for an agent in tmux inside iTerm2 turn the dial to the tmux page
  and end `moved`.

The dial eval (`cli/src/testing/dialAppEval/`): `feat/dial-eval-iterm2` adds iTerm2 + tmux/herdr scenarios. This branch
starts its code only after that branch has merged, rebases on it, and updates those scenarios' expected pages to the new
grouping (tmux and herdr pages, the terminal hidden when empty), without weakening any check. Both eval tiers run before
the merge; it merges only if no app's score drops and wrong-session sends stay 0.

Fakes only: no real terminal, tmux, herdr or Orca of Diego's is touched, and `harness device notify` is never run.
