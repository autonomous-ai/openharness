# The dial and the Claude app follow each other, session by session (Diego, 2026-11-15)

On top of [the dial and the apps follow each other, pane by pane](2026-11-14-dial-pane-follow.md) (#4311,
`feat/dial-pane-follow`). A separate pull request stacked on it. `feat/dial-terminal-follow` does Terminal.app, iTerm2
and Ghostty beside it, on the same base (Coordination, below).

## Why

Diego tested #4311 on 2026-11-15 with the Claude desktop app:

1. Swiping the dial does not switch the app's session.
2. Selecting a session in the app does not move the dial; only a prompt does.

#4311 left both out: the first because the app's only way to a session brings the app forward, the second because no
event was known to say which session the app shows. Diego asked for both, as far as the app allows.

## What the app offers (spike D, 2026-11-15)

Claude app 5.11492.5, Claude Code 2.1.325, on Diego's Mac with Diego away. Two throwaway Code sessions in a scratch
folder, a throwaway local-scope plugin whose mod logged only the time and the name of each event, and every switch made
by the app's own deep links from a script. Nothing of any other session was read.

- **The app tells a session's Claude Code when it is shown.** A mod hears `session.attach` (surface `desktop`) on the
  session the app's window shows, and `session.detach` on the one it leaves. Each switch, four of four over two rounds:
  the new session's attach and the old one's detach within 0.3 to 1 s of the link. Their order varies (an attach came
  before the other's detach twice), so only attach is used.
- **The app's new-session screen** detaches the session shown and attaches none.
- **The app going behind another app and coming back** sends nothing: an attach says what the app's window shows, not
  that the app is in front.
- **A session the app has no process for** (just imported) gets one, and its attach, when it is shown.
- **`claude://code/continue?session=<local_…>`** shows that session (the spike's switches). It brings the app
  forward, which changes nothing when the app is already in front.
- **Not checked:** a click on a session in the app's sidebar (it needs a hand). The deep link goes through the same
  route change in the app, so it is expected to attach the same way; the dial check below covers it.

## Decided (PM for Diego, 2026-11-15)

1. **Only attach, and only while the Claude app has settled in front**, the guard a prompt already has (#4311).
2. **The mod sends only its own session's id**: no other session's, no title, no content.
3. **A swipe opens the session through the continue link only while the Claude app is in front.** An attach that the
   dial's own switch caused, within 2 s, is skipped (the echo guard).
4. **Rule 7:** the attach goes from the mod straight to the devices process's own listener
   (`services/devicesListener.ts`), never through the core. The core grows nothing.
5. **Coordinate with `feat/dial-terminal-follow`** on the shared follow code (below).
6. **A click in the app from another app (option A).** With Orca in front, a click on a session in the Claude app's
   sidebar shows that session at once, and its attach comes within about a second, before the app has settled in
   front (`FRONT_SETTLE_MS`, 1 s). So the devices keep the Claude app's last attached session (one value, in memory,
   gone with that agent), and the dial moves to it when the app settles in front. The move still happens only with
   the app settled in front, as (1) says. The same covers Cmd-Tab back to the app: the dial goes to the session on its
   screen. Not chosen (B): dropping that attach, so a click from another app would move nothing.
7. **The swipe checks the front most recently reported**, not the settled one; a link still running for an agent drops
   the next one for it; the swipe's link is covered by unit tests only, never `/usr/bin/open` in an end-to-end test.
8. **A mod that linked while the devices' listener was not there** (no dial attached yet, the daemon restarting) asks
   the launcher again. When it holds a desktop attach and its last link answer had no `devicesSocket`, it runs
   `harness device claude link --json` once more: at most once in 30 s for a session, the run killed after 5 s. Any
   failure is silent: that attach is not sent, and the next attach after the 30 s may ask again. Not chosen: a session
   that sends no attach until it restarts.
9. **A settle of the Claude app in front moves nothing while any continue link of the dial's is younger than 2 s.**
   A swipe that rests on another agent as the app comes in front shows that agent; the settle must not turn the dial
   back to the one kept before.
10. **For the dial check the PM, not Diego, points the `openharness` marketplace at the final combined worktree** when
    preparing Diego's dial session (the released plugin sends no attach), and points it back at GitHub before that
    worktree is removed.

## Design

### 1. The app shows a session: the dial follows

**The mod (`plugins/harness-device/hooks/device.js`).** On `session.attach` with surface `desktop`, the mod sends
`{"type":"attach","sessionId":"<its own session id>"}` to the devices' listener. The id is `$.session.id()`, the one
its inbox poll already sends; nothing else goes. A detach, and an attach on any other surface, send nothing.

- Where: the listener's socket, which `harness device claude link --json` now prints beside the core's
  (`{"socketPath":…,"devicesSocket":…}`), only when it is this account's own (`socketIsPrivate`, as
  `listenerClient.ts` checks before it sends); no listener (Windows, a path too long, none running): no
  `devicesSocket`.
- No `devicesSocket` at an attach (8): the mod runs the launcher that linked once more, from the send's timer: at most
  once in 30 s for a session, killed after 5 s (`link` reads one settings file and checks one socket; `hooks.json`
  gives the launcher the same 5 s). An answer with a `devicesSocket` is kept and the attach is sent, unless the session
  was detached meanwhile. Anything else is silent: that attach is not sent, nothing retries, the polls go on. A mod
  that never linked (Windows, the plugin off) asks nothing.
- When: at once, from a timer, never awaited in the hook. An attach before the mod has linked (the first one comes
  0.1 s after `session.start`, before the launcher answers) is held, the latest only, and sent once it links.
- Failure: a send that fails is dropped; the next attach tries again. No retry loop.

**The listener (`services/devicesListener.ts`).** A new handler, `attach`, beside `front`: a body of at most 96 bytes
with `sessionId` a Claude Code session id (a UUID); 10 a second per connection. Anything else is refused and counted
by the listener's own minute line; the id is never logged.

**The devices (`services/devices.ts`).** An attach names the observed agent `observedAgentId('claude', sessionId)`.
It moves the dial when all of these hold:

- the observed source lists that agent and its app is `claude` (the Claude app's sessions, #4296's mapping);
- it is not the echo of the dial's own switch: a swipe's continue link to that agent within the last 2 s (below);
- the Claude app has settled in front (`cableHost.settledApp() === 'claude'`);
- a dial is linked and its ring holds the agent.

The move goes through the path a prompt takes (`followLocal(agentId, 'attach')`), so it keeps followApp's queue, its list before its focus and its echo guard: the
dial's own report of the move starts no swipe rest. An agent the dial already shows: nothing is sent.

**The app settling in front (6).** The devices keep the last attach that named a listed Claude app agent:
one agent id, replaced by the next attach, cleared when that agent's session ends. The app filter tells the devices
each time an app settles in front (a new `settled(app)` call beside `switched`); when the app is `claude` and an
attached agent is held, the dial moves to it by the same rules (the ring holds it), but not while any continue link
of the dial's own, to that agent or to another, is younger than 2 s (9): it is skipped as an echo. A Cmd-Tab across the
app settles nothing (`FRONT_SETTLE_MS`), so it moves nothing.

### 2. A swipe shows the session in the app

`swipeSwitches` / `swipeEnded` (`cableHost.ts`) and the observed source's `hasPane` / `showPane` (`hosts/observed.ts`)
take a second kind of pane beside Orca's terminal: a Claude app session, `opens.pane` `{ app: 'claude', id:
'local_…' }`, which the observed source already holds for a tap (`hosts/open.ts`).

- `hasPane` is true for it on macOS while the app most recently reported in front is `claude` (`AppFilter`'s last
  `front`, not the settled one: a Cmd-Tab to another app within the second must not have the link bring Claude back).
- After the 400 ms rest (#4311's timer, unchanged), `showPane` checks the front again, then runs
  `/usr/bin/open claude://code/continue?session=<local_…>` (no shell, 10 s timeout, the id checked against
  `CLAUDE_SESSION` as a tap checks it), and records the echo: that agent, for 2 s. Front no longer `claude`: nothing
  runs, outcome `failed`, nothing on the dial.
- One link at a time per agent, as a tap's (`open.ts` `running`); one that is still running for that agent drops the
  new one (outcome `busy`).
- **No loop.** The link's attach comes back as the agent the dial already shows (nothing sent), or within 2 s as the
  echo (skipped): a person who swiped on to another agent meanwhile is not pulled back.
- **Keyboard.** The app is in front, so it already has the keyboard; the composer follows the session shown.
- **Other apps.** Orca keeps #4311's switch; Terminal, iTerm2 and Ghostty are `feat/dial-terminal-follow`'s.

### Measures

Daemon log counts, no content and no identifiers: dial moves by attach (`[device] attach · moved`); attaches skipped
by reason (echo, not in front, unknown agent, no tile); moves on the app settling in front (`[device] settle · moved`,
`· skipped · echo | no tile`); swipe links by outcome (ok, failed, busy, superseded), the last through #4311's swipe
count. A tap's continue link counts as the dial's own link for the echo, as a swipe's does.

### Known limits

- The 2 s echo counts from the link's start. An attach that comes later (a Claude Code process the app has to start,
  or a mod that has to ask the launcher again) is followed as the person's choice.
- A swipe still waiting for its 400 ms rest when the app settles in front is overridden by the settle, as a prompt
  overrides it today.
- Each well-formed attach writes one log line while a dial is linked, as each prompt does: a same-account process that
  posts attaches in a loop is held to the listener's rate (10 a second per connection).

## Coordination with `feat/dial-terminal-follow`

Both branches are stacked on #4311 and change the same follow code. The shared frame is the other branch's first task,
cherry-picked here unchanged (its red and code commits, PM for Diego, 2026-11-15); whichever pull request merges second
drops those two commits in its rebase.

- `cable/cableSession.ts`: `followPrompt` is `followLocal(agentId, cause)`, `cause` one of `'prompt' | 'tab' |
  'attach'`. This branch passes `'attach'` for both an attach and the settle, and tells the two apart in its own
  log lines (`services/devices.ts`), so the shared type stays the same on both branches.
- `cable/hosts/observed.ts`: terminal-follow makes `hasPane` / `showPane` dispatch on the kind of pane (`orca`, `tty`),
  each with its own action in `ObservedActions`. This branch adds the `claude` kind with a `claudeShow` action.
- `services/devicesListener.ts`, `services/devices.ts`: each branch adds its own handler (`attach` here; a stream
  type and `tab`/`tabs` there), registered beside `front`.

## Out of scope

The app's sidebar order or the dial's ring order; a detach clearing the dial; a session shown in a second app window
(the spike used one window); Linux and Windows (no Claude app link there, no listener on Windows); firmware; the core.

## Done when

**Tests**

- Mod: an attach with surface `desktop` sends one `attach` with its own session id and nothing else; a detach and an
  attach on any other surface send nothing; an attach before the link is sent once linked, the latest only; a failed
  send is dropped. Decided (8): an attach with no `devicesSocket` asks the launcher again and is sent once it prints
  one; a second attach within 30 s does not ask again, and one after 30 s may; a launcher that fails or times out sends
  nothing and the polls go on.
- `harness device claude link --json` prints `devicesSocket` when the listener's socket is private, and leaves it out
  when it is missing, not this account's or on Windows.
- Listener: `attach` takes a UUID `sessionId` only, refuses any other body, larger than 96 bytes, or past 10 a second.
- Devices: an attach of a listed Claude app agent with the app settled in front moves the dial through the prompt's
  path; not with another app or none in front; not for an unknown or non-Claude agent; not for an agent with no tile;
  not within 2 s of the dial's own link to it, but again after; the echo of the move starts no swipe rest. Decided (6):
  the app settling in front moves the dial to the last attached agent; a session's end clears it; a Cmd-Tab moves
  nothing. Decided (9): a settle within 2 s of any continue link of the dial's moves nothing, and one after does.
- Swipe: with the Claude app in front, a rest on a Claude app agent runs one continue link after 400 ms; three turns in
  400 ms run one, for the last; another app in front runs none, and a front that changes during the rest runs none;
  a link still running drops the next for that agent; a failed link logs and shows nothing; Orca agents keep their
  switch.
- End to end: the real daemon, a fake dial, a fake front app and a fake mod's post to the devices' socket: an attach
  with the Claude app in front moves the dial; with Orca in front it does not (decided (6): until the app settles in
  front). The continue link runs `/usr/bin/open`, which a test must never reach on a real Mac, so the swipe's link is
  covered by the unit tests above, and the pull request says so.

**On a dial** (Diego's Mac, asked for from the orchestrator first; the CLI from this branch with
`make install-cli`, the release CLI put back afterwards; the stack's debug Harness Device build for the front app;
decided (10): the PM points the `openharness` marketplace at the final combined worktree before the check, and back at
GitHub after it, before that worktree is removed):

1. Two Claude Code sessions in the Claude app, the app in front: clicking either in the sidebar moves the dial to it.
2. Swiping between them on the dial switches the app's session each time the dial rests.
3. With Orca in front, swiping on the Claude page of the dial does not bring the app forward.
4. Decided (6): with Orca in front, clicking a session in the Claude app's sidebar moves the dial to it once the app has
   settled (about a second).

## Design notes

- **Data.** Nothing is stored on disk. The devices hold one attached agent id and, per agent, the time of the dial's
  last link to it (at most one per listed agent, gone after 2 s). The mod sends only its own session id over the
  account's private socket.
- **Cost.** Push only: one message per session switch in the app, one `open` per swipe rest on a Claude app agent.
  Only while the launcher printed no `devicesSocket`: one launcher run at a session switch, at most one in 30 s for a
  session and 5 s long.
- **Security.** The listener checks the id's form; the link's id is checked against `CLAUDE_SESSION` and runs with
  `execFile`, no shell. A local process of the same account can post an attach and move the dial, as it can post a
  front today: the socket is the account's own.
- **The continue link is undocumented** and may change with any app release: a link that opens nothing moves
  nothing, and the attach path keeps working without it.
- **Platforms.** macOS only: tests and the dial check run there. Linux: no Claude app. Windows: no listener and no link.
