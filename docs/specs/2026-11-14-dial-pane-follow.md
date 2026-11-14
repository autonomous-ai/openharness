# The dial and the apps follow each other, pane by pane (Diego, 2026-11-14)

On top of three branches that land first: [the dial shows and talks to agents outside Harness](2026-11-13-device-claude-orca.md)
(#4296), [the dial follows the app in front](2026-11-14-dial-app-filter.md) (`feat/dial-app-filter`) and the fixed
16-place ring (`fix/dial-swipe-order`). This branch is stacked on them, or written after they merge.

## Why

Diego's scenarios (2026-11-14):

1. Focus a pane in Orca: the dial goes to that agent. Voice at the dial goes into that pane.
2. Swipe on the dial: the app goes to that agent's pane.
3. Open a notification on the dial and tap it: the dial shows that agent and the app focuses its pane.
4. Focus a session in the Claude app: the dial goes to that agent.

Voice to the dial's agent (1, second half) and tap-to-open from a notification (3) are #4296's. This branch adds the app
moving the dial (1, 4) and the dial moving Orca (2).

## What the apps offer (research, 2026-11-14)

- **Orca 1.4.256** reports no focused pane to anyone outside it: `orca terminal list --json` has no focused field, the
  CLI has no event stream, and `--worktree active` means the caller's own folder. Its open issue stablyai/orca#39254
  says the same ("CLI cannot report the focused terminal"). Orca keeps the focused worktree, tab and pane inside
  (`activeWorktreeId`, `activeTabId`, `activeLeafId`), but only behind its internal runtime RPC
  (`session.tabs.subscribeAll`), which is undocumented and needs Orca's runtime token: not used. Orca plugins hear only
  the focused worktree (`workspace.changed`), not the pane. Reading the pane through macOS Accessibility needs Orca's
  Chromium accessibility tree on and the Accessibility permission, and the focused node carries no terminal handle:
  not used.
- **`orca terminal switch`** only asks Orca's window to show that pane (`ui:focusTerminal` to its renderer). It does not
  bring Orca forward, so it takes no keyboard focus from another app. #4296 adds `open -b` after it for that reason.
- **The Claude app** (5.11492.5) keeps the focused Code session inside (`focusedSessionId`), and exposes it to nothing
  documented: its window title is "Claude", and no hook event or mod API names focus. It does send `ui_attach` and
  `ui_detach` to a session's Claude Code, which a mod hears as `session.attach` and `session.detach`. Whether the app
  sends them when the person switches sessions is unchecked: it needs the app's own window (see Open).
- **What can be known instead:** the person submitting a prompt. Claude Code's `UserPromptSubmit` hook (wave 0 posts it
  as `turn-start`) fires for a prompt typed in Orca, in any terminal and in the Claude app. It also fires for a message
  another Claude session sends (checked in a throwaway session on 2.1.325): that prompt starts with
  `<cross-session-message `. It fires the same for text Orca types into a terminal (`orca terminal send`,
  orchestration), which nothing can tell from typing.

## Decided (PM for Diego, 2026-11-14)

- **The app moves the dial on a prompt the person submits** (option B), only while that agent's app is in front.
  Prompts from another agent are left out where the hook data can tell; where it cannot, the spec says so (below).
- **A swipe switches Orca's pane without bringing Orca forward** (`orca terminal switch`, never `open -b`), 400 ms after
  the last turn of the dial.
- **A swipe does nothing in the Claude app.** Its only way to a session is `claude://code/continue`, which is
  undocumented and brings the app forward, taking the keyboard from what the person is typing in.
- **An upstream Orca change** (a focused field and a focus stream, option A) is outside this repository and waits for
  Diego. Not in this branch.

## Design

### 1. A prompt the person submits moves the dial

**The hook (`cli/hook/notify.mjs`).** On `UserPromptSubmit` outside a Harness pane, the hook reads the input's `prompt`
only to test whether it starts with `<cross-session-message ` (after leading whitespace). If it does, the
`turn-start` it posts carries `relayed: true`. The prompt itself is still never sent, and nothing else about it is.
Other engines' prompt events (`beforeSubmitPrompt`, `userPromptSubmitted`) carry no `relayed`.

**The core (`core/observedHook.ts`).** `turn-start` takes an optional boolean `relayed`; any other type is refused, and
it is refused on any other event. Bounded and forwarded like the other fields; the core keeps nothing.

**Changed for the core's rule 7 (PM for Diego, 2026-11-15).** Main's `cli/AGENTS.md` now says the core grows nothing for
one component, not even a generic field only it would use. `relayed` is such a field, and so is #4296's observed-hook
route itself. Decided (option B): the devices' hook path goes straight to the devices process's own listener, which
`feat/dial-app-filter` is building for the front app; `relayed` moves with it, checked there with the same rule (a
boolean, on `turn-start` only), and `core/observedHook.ts` loses it. When #4296's route moves (before or after it
merges) is Diego's call. Until then the field stays in the core on this branch, and the pull request says so.
Not chosen: the devices reading the transcript instead. Checked on Claude Code 2.1.325, a prompt is not yet in the
transcript when `UserPromptSubmit` runs (the first prompt's file does not exist yet; the second finds the first as
the last user entry).

**The devices process.** A `turn-start` moves the dial to its agent when all of these hold:

- it is not `relayed`;
- it is not the turn of a prompt the dial itself delivered: when the dial's voice reaches an outside agent (the mod's
  inbox or Orca's `terminal send`), its session records one pending dial prompt, and that session's next `turn-start`
  consumes it instead of moving the dial. A pending dial prompt expires after 10 minutes (the mod queues a prompt for
  after a long turn);
- the agent's app is the app in front, as `feat/dial-app-filter` settles it (`agent.app` equals the settled front app).
  No front known (no Harness Device app, not macOS): the dial does not move;
- the dial is linked and its ring holds the agent (a working agent outside a full ring has no tile; the dial stays).

The move goes through the path that follows the Harness window today (`CableSession.followApp` with the local machine),
so it keeps that path's queue, its list-before-focus order and its echo guard: the dial's own report of the move is
consumed and never reaches the swipe handling below. An agent the dial already shows: nothing is sent.

**The Claude app's sessions** need `agent.app` to be `claude` (bundle `com.anthropic.claudefordesktop` in the hook's
`__CFBundleIdentifier`). `feat/dial-app-filter` maps it (its task 23); this branch reuses that mapping and adds none.

**Not told apart:** text Orca types into a terminal for an orchestrator or a script looks like typing. With Orca in
front, such a prompt moves the dial to that agent.

### 2. A swipe switches Orca's pane

When a hand turns the dial (`{t:'focus', agentId}` that no echo guard drops), the host already marks an outside agent
seen. Now, for an agent with an Orca terminal handle, it also starts a 400 ms timer; a later turn of the dial restarts
it, and one timer runs per dial. When it fires and the dial still shows that agent, the host runs
`orca terminal switch --terminal <handle> --json` through the Orca adapter (`cli/src/cable/hosts/orca.ts`: no shell,
10 s timeout, one command per handle; a switch refused because one is running is dropped, not queued). It never runs
`open -b`. A tap (`agent.open`) keeps #4296's behavior: switch, then Orca comes forward.

- **No loop.** Orca reports no pane focus, so a switch never comes back as a prompt or a focus.
- **Keyboard.** Orca stays where it is among the windows. If the person types in Orca, Orca's own focus moves to the new
  pane with the switch, so the next keys go there.
- **Failure.** A switch that fails (Orca not running, the terminal gone) logs one line with the outcome and no handle,
  and shows nothing on the dial: a swipe is not a request to open anything.
- **Other apps.** Agents in the Claude app, WezTerm, herdr or any other host: a swipe only marks seen, as today.

### Measures

Daemon log counts, no content and no identifiers: dial moves by prompt; prompts skipped by reason (relayed, dial
prompt, app not in front, no tile); swipe switches by outcome (ok, failed, busy, superseded).

## Out of scope

Following a pane focused without a prompt; the Claude app's `session.attach` (see Open); a swipe in any app but Orca;
the upstream Orca change; Windows; firmware.

## Open, not in this branch

- **The Claude app's session switch.** The app sends `ui_attach` and `ui_detach` to a session's Claude Code. If it does
  so when the person switches sessions, the `harness-device` mod could report it and the dial could follow a session
  the person only looks at. Checking needs the Claude app's window and a temporary session in its list, so it waits
  for Diego.
- **A focused field and a focus stream in Orca**, upstream (stablyai/orca#39254), waits for Diego.

## Done when

**Tests**

- Hook: a `UserPromptSubmit` starting with `<cross-session-message ` posts `turn-start` with `relayed: true`; a typed
  prompt posts no `relayed`; the posted body never carries the prompt.
- Core: `relayed` taken on `turn-start` only, boolean only; 100% per file (`npm run test:core`).
- Devices: a person's `turn-start` with the agent's app in front moves the dial through `followApp`; not when relayed,
  not for the turn of a dial prompt (mod and Orca routes), but again for the next one; a dial prompt expires after
  10 minutes; not when another app or no app is in front; not for an agent with no tile; the move's echo starts no
  Orca switch.
- Swipe: a hand's focus on an Orca agent runs one `orca terminal switch` after 400 ms with no `open -b`; three turns
  within 400 ms run one switch, for the last agent; a turn away before 400 ms runs none for the first; a Claude app or
  WezTerm agent runs nothing; a failed switch logs and shows nothing; a tap still switches and brings Orca forward.
- End to end: the real daemon, a fake dial, a fake `orca` and a fake front app: a hook `turn-start` with Orca in front
  moves the dial; a relayed one does not; the dial's turn to an Orca agent runs the fake switch once after 400 ms.

**On a dial** (Diego's Mac; asked for from the orchestrator first; the CLI from this branch with `make install-cli`,
the release CLI put back afterwards; the stack's debug Harness Device build runs for the check, so the front app is
known, and is quit after. No spoken prompt: speech to text runs only on production, so "a prompt the dial delivered
does not move the dial" is covered end to end with a fake speech to text, and the pull request says so):

1. Two Claude Code agents in two Orca panes, Orca in front: typing a prompt in either pane moves the dial to it.
2. Swiping between them switches Orca's pane each time the dial rests; Orca does not come forward over another app.
3. A notification on the dial, tapped: the dial shows the agent, Orca shows its pane and comes forward (#4296).
4. Two sessions in the Claude app, the app in front: a prompt sent in either moves the dial to it.
5. A message from another Claude session to an agent in Orca does not move the dial.

## Design notes

- **Data.** Nothing is stored on disk. The devices process holds one pending-dial-prompt count per session, for up to
  10 minutes. The hook reads the start of the prompt in its own process and sends only a boolean.
- **Cost.** No polling: the dial moves on hook events that already arrive, and a swipe runs at most one `orca` command
  per 400 ms of rest.
- **Security.** The hook sends no text of the prompt; the core takes one bounded boolean. `orca terminal switch` runs
  with `execFile` and a checked handle, as in #4296.
- **Platforms.** macOS: tests and the dial check run there. Linux X11, where `feat/dial-app-filter` also reports the
  front app: the same code follows prompts and switches Orca, untested on a dial (the pull request says "Linux X11
  untested"). Windows: neither (#4296 has no Windows support).
- **Engines with no prompt event** (Command Code, agy post `turn-start` on each tool or model call): their
  `turn-start` never moves the dial. **A relayed `turn-start`** does not consume a pending dial prompt.
