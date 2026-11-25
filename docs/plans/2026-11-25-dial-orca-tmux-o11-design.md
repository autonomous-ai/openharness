# Dial: Claude Code under tmux in an Orca pane (eval O11): a proposal

Date: 2026-11-25. Branch: `chore/dial-orca-tmux-o11-proposal`. No product code in this branch.

**Decided (PM, 2026-11-25): option A**, as Diego's rule "inside Orca it stays as today". This branch also does A's eval
change: O11 grades today's behavior with a tap and a voice check, and the Orca world has the tmux model on all three
platforms. B goes to the backlog.

## The question

Two decisions disagree:

- The Orca eval's decision 2 (PM, 2026-11-21, `docs/plans/2026-11-22-dial-eval-orca-design.md`): "tmux inside Orca
  stays off the ring. An agent under tmux in an Orca pane is not an Orca row." O11 grades it.
- Diego's decision 3 for tmux's own page (2026-11-23, `docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md`, #4578):
  "tmux in VS Code's or Cursor's terminal moves to the tmux page too. tmux in Orca stays as today."

The product follows Diego's (`select.ts:99` `pageOf`: `nest && app !== 'orca'`). O11 follows the PM's, so it fails on
macOS. Which one should win, and what should the person see?

## 1. What the person sees today

The setup: Orca, one worktree, two tabs with plain Claude Code (`a`, `b`), a third tab with `tmux` in it and Claude Code
(`c`) in a tmux pane. tmux is installed, as it is for anyone who runs it.

How the code places `c`:

- Its hook's hints: `TMUX_PANE`, `TERM_PROGRAM=tmux`, Orca's `ORCA_AGENT_SESSION_ID` and `ORCA_TERMINAL_HANDLE` (inherited
  from the terminal the tmux server started in), and on macOS `__CFBundleIdentifier=com.stablyai.orca`.
- tmux's lookup (`tmux.ts:321` `createTmuxOuter`) proves tmux made the agent's terminal and finds the app holding the
  session's last used client: Orca (on Linux by Orca's main process `orca-ide`). So `nest = 'tmux'`, `host = 'tmux'`,
  `app = 'orca'` (`observed.ts:963` `landOuter`, `placeApp`), on every platform where the lookup runs. On macOS the
  bundle id alone already gives `app = 'orca'` (`hostDetect.ts:163` `detectApp`).
- `pageOf` keeps it on Orca's page (`select.ts:100`), and `orcaAgents` (`devices.ts:2107`, `app === 'orca'`) puts it in
  Orca's ring.
- Orca's adapter gives it no Orca pane (`orca.ts:238`, `MULTIPLEXERS`): the handle names the terminal tmux started in,
  not where the agent is. `placeInOrca` (`devices.ts:2118`) places it by elimination at the Orca terminal where Orca saw
  its engine start, in its folder, when it is the only such agent and terminal. Orca does see it: Orca's own hook server
  names the agent tmux shows in that pane (stablyai/orca `src/main/agent-hooks/server/server-tmux-status.ts`,
  `publishTmuxSelectedStatus`), so its terminal list gives that tab `agentIdentity: claude`.

What the person gets:

| | Today |
|---|---|
| Page | Orca's. "Orca · 3". No tmux page for it. |
| Row | An Orca row, in Orca's tab order at the tmux tab, named by that tab. Unplaced (two tmux agents in one folder, or an Orca that named no engine), it sits after the placed rows, named by its session's title. |
| Worktree scope | In scope when placed in the worktree on screen. Unplaced, it drops out whenever the Orca plugin names a worktree, so it is off the ring while Orca is in front. |
| Pro | The Orca room leaves it out: the Pro groups by `host`, which is `tmux` (#4578 known gap). |
| Tap | Orca switches to its placed tab, tmux shows its pane on its own session (`tmux.ts:188`: it selects the window and pane, or on macOS may switch the client to it), Orca comes forward. Unplaced: tmux shows the pane, Orca comes forward on whatever tab it shows. |
| Rest (swipe) | The same switch and select, with no raise, while Orca is in front (`tmux.ts:210` `canShow`). |
| Voice | Never typed into the Orca handle or into tmux (the devices never type into the person's tmux, `services/AGENTS.md`). Claude Code takes the words through its mod, Codex through `codex queue` in Harness's Codex home; otherwise "did not answer". No wrong-session path. |
| Focus follow: Orca tab | Not followed. Orca's focus line looks up an own Orca pane only (`devices.ts:2446` `byPane`); a placed agent has none: `focus · skipped · unknown agent`. |
| Focus follow: tmux pane switch | Not followed. The tmux pane poll takes only agents on tmux's page (`devices.ts:2539`). |
| Focus follow: prompt | Followed while Orca is in front: an agent with no own Orca pane is not skipped. |

So today it is an Orca row that taps and speaks right, but the dial does not follow you to it.

## 2. What O11 expects and why it scores low

`cli/src/testing/dialAppEval/orcaScenarios.ts:214`: sessions `a`, `b`, and `c` with `tmux: true` in worktree `w1`. It
waits for Orca's ring to be `[a, b]` (`listed`) and checks `ring([a, b])`: `c` must not be on Orca's ring. D1 only.

Baseline (`baseline.json`):

| | darwin | linux | win32 |
|---|---|---|---|
| tier A | precision 0.67, wait 0 | 1 | 1 |
| tier B | precision 0.67, wait 0 | (not run) | (not run) |

Why:

- **macOS fails** because the product does what Diego decided: `c` is on Orca's ring, so the ring is `[a, b, c]` and
  the wait for `[a, b]` times out.
- **Linux and Windows pass only because of the model, not the product.** The eval's Orca world installs no tmux
  (`tierA/world.ts:470`: tmux and herdr only on iTerm2's machine), so tmux's lookup never runs. Without the bundle id,
  `TERM_PROGRAM=tmux` names the tmux app and `c` lands on tmux's page. On a real Linux with tmux, the lookup finds Orca
  holding the client and `c` is on Orca's page, as on macOS. (On Windows tmux runs only inside WSL; not verified there.)
- So O11 grades a rule the product dropped on purpose two days later, and on two of three platforms it grades a world
  without the lookup that decides the answer.

## 3. Options

### A. Keep today; O11 grades today's behavior

- **Product:** no change.
- **Eval only** (`cli/src/testing/`): O11 expects `c` on Orca's ring at its tab, `[a, b, c]`; adds a tap on `c` (Orca
  switches to its tab, tmux selects its pane, Orca comes forward) and a voice step on `c` that must not type into any
  Orca handle (the gate). The Orca world installs the tmux model for a scenario with a `tmux: true` session, so all
  three platforms run the real lookup. The eval spec's decision 2 is replaced by Diego's 2026-11-23 rule.
- **Person:** nothing changes.
- **Tap / voice:** as today, correct; graded now.
- **Wrong-session risk:** none new.
- **Left open:** the dial does not follow a focus to that tab or a tmux pane switch inside it; the Pro's Orca room
  leaves it out.

### B. Orca's page, and the dial follows it

A on the eval, plus three changes in the devices process (`services/devices.ts`, `cable/`; not the core):

1. Orca's focus line on a tab with no own Orca pane turns the dial to the agent placed there.
2. The tmux pane poll also takes tmux agents on Orca's page whose client is in Orca, and the follow stays on Orca's
   page.
3. A row on Orca's page carries `host: 'orca'` to the dial, so the Pro's Orca room holds it.

- **Person:** focusing the tmux tab, or switching tmux panes in it, moves the dial, as with plain Orca tabs.
- **Tap / voice:** unchanged.
- **Wrong-session risk:** low but real. The placement is a guess by elimination: a client switched to another tmux
  session in that tab would turn the dial to an agent the tab no longer shows, and the next voice goes to that agent
  (through its mod, into its own session). Mitigated by tmux's existing rule (one client of that app showing an
  agent's session, none of two) and the placement's uniqueness. Needs new O-scenarios for both follows and the
  switched-session case.
- About 2-3 files plus tests and scenarios: a feature, so it needs its own go.

### C. Move it to tmux's page

- **Product:** `pageOf` drops the Orca exception. Orca's ring and placement must stay keyed to `app === 'orca'`, not
  the page, or the tap stops switching Orca's tab (a regression).
- **Eval:** O11 passes as written, once the Orca world has the tmux model.
- **Person:** "Orca · 2", "tmux · 1". The tmux page is not scoped to Orca's worktree and mixes tmux agents from every
  app. Orca with only tmux agents drops off the Apps screen. The tmux pane follow works as in iTerm2.
- **Tap / voice:** unchanged if placement stays; voice still through the mod.
- **Wrong-session risk:** none new for voice; the tap regresses if placement is not kept.
- **Against:** it reverses Diego's 2026-11-23 rule, and Orca's own UI shows that agent on its tab (Orca's
  `server-tmux-status.ts`): the dial would disagree with what the person sees in Orca.

## Recommendation

**A.** It keeps Diego's rule and matches what Orca itself shows. It changes nothing for the person and adds no risk.
It also fixes the eval's model, so O11 grades real behavior on all three platforms instead of failing on one and
passing on two by accident. If Diego wants the dial to follow focus into tmux tabs in Orca, B's follow is a separate
proposal after A.

## Not done here

- No eval run: none was needed to explain the baseline, and none ran without the PM's Mac turn.
- Not checked against a real Orca: the placement relies on Orca's terminal list naming the engine for a tab running a
  tmux client. Orca's public source says it does; a real check needs Diego's Orca.
