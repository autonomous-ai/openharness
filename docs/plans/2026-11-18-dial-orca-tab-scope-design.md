# The dial's swipe in Orca stays in the worktree on screen (Diego, 2026-11-18)

On top of [the dial follows Orca's tabs](2026-11-16-dial-orca-focus-order-design.md) (#4363, #4381), the per-app rings
(`select.ts` `AppRings`), the app in front (#4373), Orca's account homes (#4421) and
[the Harness Device plugin for Orca](../specs/2026-11-16-orca-device-plugin.md).

## Why

Diego (2026-11-18 10:26), after updating Orca to 1.4.262: swiping on the dial in Orca is "very messy". He wants a swipe to
move only between the tabs of the Orca worktree he is looking at. For example, in a worktree whose tab bar is "harness",
"Skill từ SKILL.md", "PM", "Sản phẩm trên Orange Pi 4 Pro" and "Terminal 4", a swipe goes back and forth among those
tabs' agents only. It never goes to another worktree's agents or another app's.

## What we found (read only, 2026-11-18, Orca 1.4.262)

- **Focus was never followed on Diego's Mac.** `orca terminal watch-focus` is in our upstream pull request
  stablyai/orca#42555, which is still open. 1.4.262 does not have it (`orca terminal --help` does not list it, and the
  command says `Unknown command`). The devices' log says `orca watch · unsupported` 96 times since 2026-11-17 and never
  `started`.
- **Orca's ring is every Orca agent in every worktree.** That is 8 worktree layouts and 10 terminals with an agent at
  the time of reading, and #4421 brought the sessions in Orca's own account homes onto the ring too. The ring is in tab
  order inside each worktree, and worktrees follow Orca's internal snapshot order, not the sidebar's. A swipe that rests
  on another worktree's agent runs `orca worktree activate` and then `orca terminal switch`, so Orca's window jumps
  between worktrees as the person swipes. This is the "messy".
- **The prompt follow moves the dial across worktrees.** With no focus watch, a prompt submitted in any Orca agent
  turns the dial to it while Orca is in front (#4311). That includes a prompt Orca types for an orchestrator
  (`orca terminal send`) into another worktree's agent. Today's log has 61 `prompt · moved`.
- **The layout's shape is unchanged.** `orca terminal list --json --include-visual-layouts` still gives, per worktree,
  `worktreeId`, `worktreePath` and `root` (a `group` with `activeTabId` and `tabs[]`, each tab with `panes` as before).
  The flat `terminals[]` rows carry `handle`, `worktreeId`, `worktreePath`, `agentIdentity` and more, as #4381 read them.
- **Orca's CLI cannot say which worktree is on screen.** `--worktree active` resolves from the caller's current folder,
  not from Orca's window (from `/tmp` it answers `selector_not_found`).
- **Orca's plugin API can.** A `trusted-worker` plugin with the `workspace:read` capability and `workspace.changed` in
  `contributes.events` is told each time the focused workspace changes, or when its terminals are opened, closed or
  renamed: `{ context: { workspaceId?, branch, displayName, terminals: { id, title? }[] } | null }`. The first event is
  the current context, `null` when no workspace is focused, and it lists at most 50 terminals (Orca's
  `PLUGIN_WORKSPACE_TERMINAL_LIMIT`). The event exists since Orca 1.4.246. A terminal's `id` is its handle
  (`term_<uuid>`), the same one the CLI and our hooks use (upstream `plugin-workspace-projection.ts`: "The terminal
  handle plugins call `terminalId`").

## Decided (PM for Diego, 2026-11-18)

1. **The worktree on screen comes from the Harness Device plugin for Orca** (`plugins/harness-device-orca`). It asks
   for `workspace:read`, listens to `workspace.changed`, and tells the devices the handles of the focused worktree's
   terminals. The pull request says how Diego installs the plugin and approves the new access (Rollout, below). With
   no new plugin (an old one, none, or Windows), the dial behaves as it does today. There is no second way to find the
   worktree on screen.
2. **A change of worktree does not move the dial.** The swipe list becomes the new worktree's, and the agent on the dial
   leaves the list the way any agent does when it leaves today.
3. **A worktree on screen with no agent gives an empty swipe list.** The dial does not fall back to other worktrees.
4. **Unchanged:** the APPS page and its Orca count (every Orca agent); Orca's ring while Orca is not the settled front
   app; dials that do not say `appFilter` (the machine ring); recaps; a tap.
5. **`watch-focus` stays as it is.** Its code still runs where the CLI has it; this branch does not touch it.

## Design

### The plugin (`plugins/harness-device-orca`)

- **Manifest.** `capabilities: ["workspace:read"]` and `contributes.events: ["workspace.changed"]`. `engines.orca`
  stays `>=1.4.248`, since the event is from 1.4.246. `version` goes to `0.2.0`. The README's "What it never does" and
  "The access Orca asks for" sections say what it now reads and sends.
- **What it sends.** `{"type":"orcaFront","terminals":["term_…", …]}` to the devices' socket, as one `POST /` on a
  connection of its own: the answer's status is read and its body is drained and dropped. This is the plugin's first
  one-shot message (until now it only held the `dial` stream), so `DialInputs` gains `post(socket, body, signal)`,
  which answers the status or null. `terminals` holds the focused worktree's terminal ids that match
  `^term_[0-9a-f-]{36}$`, in Orca's order, at most 50. `null` is sent when Orca focuses no worktree. Only the ids go:
  no titles, branch, name or `workspaceId` (the last can hold a path).
- **Where the logic lives.** In `dial.ts`, beside the stream it depends on, so the end-to-end harness
  (`cli/e2e/harness/pluginDial.ts`) runs the real loop. `startDial`'s `Dial` gains `front(terminals)`, which takes the
  latest focused worktree's ids (or `null`). `worker.ts` subscribes to `workspace.changed` and hands each context's
  ids to it. The harness hands it what the test writes on its stdin, one JSON line per context.
- **When.** Only while its `dial` stream is open (the devices answered 200, so it is the Orca that shows the dial). It
  sends the latest ids each time that stream opens, so a restarted devices process hears them, and again on each
  `front()` whose ids differ from the last sent on that stream. A title-only rename sends nothing. A send that fails
  is sent once more after 1 s, if it is still the latest and the stream is still open. While the stream is closed
  nothing is sent, and the latest ids are kept for the next open.
- **Logs.** One line per failure that is not retried (`dial: front not sent`), never the ids.

### The devices' listener (`cli/src/services/devicesListener.ts`)

- **A new handler, `orcaFrontHandler`, for the type `orcaFront`.** The body is refused unless `terminals` is `null` or
  an array of at most 50 strings, each matching `ORCA_HANDLE`. The largest body is 4096 bytes (50 handles are about
  2.3 KB). The rate is 10 a second per connection. Nothing of the body is logged, and a refusal is counted as the other
  types' refusals are.
- **The worktree on screen lives only while a `dial` stream is open.** `dialStream` gains `isOpen()`, as `tabsStream`
  has, and an `ended()` callback, run when its open stream ends for any reason. The `orcaFront` handler refuses a
  message while no `dial` stream is open, so a late retry cannot leave a scope nobody clears. The devices drop the
  worktree on screen when the stream ends: Orca quit, the plugin was turned off, or it lost the stream, so stale
  handles never scope the ring.

### The devices (`cli/src/services/devices.ts`)

- **What they keep.** `orcaFront: ReadonlySet<string> | undefined`, the handles of the worktree on screen, in memory
  only. It is set by `orcaFront`, set to undefined by `null` or by the `dial` stream's end, and gone when the process
  restarts. It changes nothing by itself: nothing is pushed, and the dials read it on their next list (every second, as
  any change of the ring reaches them).
- **Which agents are on screen.** An Orca agent is on screen when its Orca terminal is in `orcaFront`. Its terminal is
  its Orca pane (`source.paneOf(id, 'orca')`) or, for one with no pane yet, the place the last order read gave it by
  elimination (`placeInOrca`, #4381). `ObservedSource` already holds that place (`setPaneNames`' `placed`), so it gains
  a read of it (`placedAt(agentId, adapter)`) rather than a second copy in `devices.ts`. An agent in a multiplexer
  inside Orca has no Orca pane and is never on screen. A swipe could not show its pane anyway.
- **The scope given to the dial host.** `cableHost.setScope('orca', scope | undefined)`, where `scope` is
  `{ inScope(agentId): boolean }`, computed when asked from `orcaFront` and the panes at that moment. A new object is
  given for each new set of handles, and undefined while `orcaFront` is.
- **Each change of scope is logged once**, when a message's set of handles differs from the last:
  `[device] orca front · set · <n> terminals` (n is the message's count) or `[device] orca front · cleared`. It is a
  count only, never a name, handle or worktree.
- **The prompt and focus follows need no change.** `followLocal` reads the dial's own list and stops with `no-tile`
  when the agent is not in it (`cableSession.ts`). With the scoped list, a prompt in another worktree's agent, including
  one an orchestrator types with `orca terminal send`, no longer moves the dial while Orca is in front, and is logged
  `[device] prompt · skipped · no tile` as today.

### The dial host (`cli/src/cable/cableHost.ts`)

- `setScope(app, inScope?)` holds one scope per app id. In memory only, as the ranks.
- In `machineSnapshot` the scope applies when all of these hold: the dial says `appFilter`, the shown app is that app,
  the app is the settled front app (`filter.settledApp()`), and a scope is set. Then the rows are the shown app's
  agents for which `inScope` is true, in a `DialRing` of their own (a second ring per scoped app, so the APPS page's
  rings and counts are untouched) with the app's rank, so they are in Orca's tab order, at most 16 (`RING_PLACES`).
  That ring is made anew for each new scope object, so nothing of one worktree's ring carries into the next. `total`
  is the number of those agents. Otherwise everything is as today.
- **Worktrees with more than 50 terminals.** Orca's event lists at most 50, so an agent past the 50th is not on screen
  for the dial. This is accepted as Orca's bound; the ring holds 16 anyway.
- A swipe, a rest and a tap go through the same paths as today. A rest on an agent of the worktree on screen runs
  `orca terminal switch`, and `worktree activate` only when the layout names a worktree (as today).

### What does not change

The core: nothing (cli/AGENTS.md rule 7). `orca.ts`'s reads, `watch-focus`, the tab names, the tab order, the APPS
page, recaps, a tap, notices, and the other apps' rings.

## Data

- **What is stored, synced or exposed.** The handles of the terminals in the worktree on Orca's screen. They are opaque
  ids with no names, paths or contents. They go from Orca's plugin worker to the devices process over the devices'
  private listener socket (0600, in a folder that is this account's alone). They are held in that process's memory
  only, are never written to disk or logs, and never leave the computer or reach the core.
- **What the plugin can now read.** `workspace:read` lets it read the focused workspace's name, branch and terminal
  titles, and list workspaces. It uses only the terminal ids of the focused one. Orca shows the person the new access
  and asks them to approve it at install.
- **Trust.** The body is outside text from another program: the listener holds it to `ORCA_HANDLE` and the bounds
  above before the devices see it. A handle that names no agent scopes nothing.
- **Lifetime.** It is cleared when the `dial` stream ends and when the process restarts, and replaced at the next open.

## Measures

The scope's change lines above (counts only). The listener's existing per-type drop counts cover refusals. Cost: one
local `POST` per worktree change in Orca, no polling, no new process, and a set lookup per Orca agent per list read
(at most 16 rows a second).

## Testing

- **Plugin** (`plugins/harness-device-orca`, its own tests): `front()` while the stream is open sends the ids; nothing
  while it is closed; sent again on each open; ids filtered and bounded to 50; `null` for no workspace; the same ids
  again send nothing; a failed send is retried once only if still the latest and the stream still open; `worker.ts`
  hands `workspace.changed` contexts to `front()`; the manifest declares `workspace:read` and the event.
- **Listener** (`devicesListener.spec.ts`): `orcaFront` takes `null` and up to 50 valid handles while a `dial` stream is
  open; it refuses one with no stream open, 51 handles, a non-handle, a non-array and an oversized body; `isOpen()`
  follows the stream; the stream's end runs `ended`.
- **Dial host** (`cableHost.spec.ts`): with Orca settled in front and a scope, the list is the in-scope agents in rank
  order and `total` is their count; an empty scope gives an empty list; Orca not in front, another app shown, a dial
  without `appFilter` or no scope give today's list; the APPS page's counts are unchanged.
- **Devices** (`devices.spec.ts`): `orcaFront` sets the scope through panes and elimination places; `null` and the
  stream's end clear it; the change lines are logged once per change.
- **End to end** (`e2e/`, the real daemon, a fake dial, a fake front app, the fake `orca`, and the plugin's real loop
  through `e2e/harness/pluginDial.ts`): two worktrees' layouts, agents in both. With Orca in front, the plugin is
  handed one worktree's ids, and the dial's list becomes that worktree's agents in tab order. Handing it the other
  worktree's ids switches the list. An empty worktree gives an empty list. A prompt in the other worktree's agent
  does not move the dial. Another app in front, or the plugin stopped (its stream closed), gives the whole ring.

## Platforms

macOS and Linux, where the devices' listener and the plugin run. On Windows there is no listener, the plugin shows "Not
on Windows yet", and nothing changes.

## Rollout (in the pull request)

Harness installs, updates and approves nothing (PM, 2026-11-18). The plugin's README and the pull request give the
commands, and the person runs them. Diego's Orca has no Harness Device plugin installed today (read only, 2026-11-18),
so his steps, once the release that carries this is installed, are a first install:

1. Install the plugin: `orca plugin install <repo>/plugins/harness-device-orca`. It stops with `approval_required`.
2. Approve the access Orca shows, in its own words: "Read your projects and workspaces (names, branches, paths and
   agent status) and the terminals in them, and get notified when they change" (`workspace:read`). Run the command Orca
   prints, with `--approve <fingerprint>`, or approve as Orca shows.
3. Check: with Orca in front, a swipe on the dial goes only through the tabs of the worktree on screen.

Later versions: `orca plugin update <plugin-key>`. An update that adds access asks again.

## Follow-ups

- stablyai/orca#42555 (`watch-focus`) is still open. If it ships, the focus follow starts working by itself.
