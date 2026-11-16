# One adapter per app for the agents outside Harness (Diego, 2026-11-15)

Device integration, wave 0 (foundation), the last three items: one adapter interface per agent source, de-duplication,
and a dial that shows only what the host can do. Roadmap: `2026-11-13-device-integration-priority.md` section 3 and
`2026-11-13-device-integration-roadmap.md` 1.2 (Diego's Downloads). Built on #4290, #4289, #4296, #4309 and the three in
review when this was written: #4311 (Orca pane follow), #4326 (Claude app follow), #4331 (Terminal, iTerm2, Ghostty tab
follow). It is coded only once all three are on `main`.

## Why

Wave 1 adds Orca's CLI, herdr, Codex and a full tmux check. Each should cost one adapter file. Today each app the dial
reaches is spread over five places:

- a member of the `ShownPane` union in `cable/hosts/observed.ts`;
- a branch of `shownPane`, and a case of `showPane` or `focus`, in the same file;
- members of `ObservedActions`;
- a case of `paneOf` and `focus` in `cable/hosts/open.ts`;
- the wiring in `services/devices.ts`.

#4326 and #4331 say so in their own comment: "a later kind is one member here, one line in shownPane, one case in
showPane and its ObservedActions members". Those two pull requests also conflict in exactly these lines.

## What exists (checked on `main` 978cb61 and the three branches, 2026-11-15)

| Item | State | Evidence |
|---|---|---|
| Source interface | `HostSource`: `list`, `capabilities`, `send?`, `focus?`, `markSeen?`; `hasPane?`, `showPane?` from #4311 | `cable/hosts/types.ts:57-68` |
| Sources | `HarnessSource` (Harness agents, tmux and pty panes included: a pane's hook registers with the core, `hook/notify.mjs` paneless branch) and `ObservedSource` (every agent outside a pane, from its hooks and the open-session scan) | `hosts/harness.ts:28`, `hosts/observed.ts:106`, `services/devices.ts:352` |
| Apps inside `ObservedSource` | Orca terminal (type, switch), Claude app session (link), terminal tab by tty (watch select), WezTerm and herdr pane (focus), any app by bundle id (`open -b`), Claude Code mod (words) | `observed.ts:148-201`, `open.ts:34-110`, `orca.ts`, #4326 `claudeShow`, #4331 `tabs.ts` |
| De-duplication | Merged list keyed by engine + session id, else by caller pid; Harness beats a host adapter beats observed. A Harness agent carries its bound session id, and the scan skips Harness's own sessions. Now Harness, then observed, then a listing source ([herdr](2026-11-16-device-herdr.md#one-agent-one-row-the-merge-key-4341-left-to-this-pull-request)) | `hosts/registry.ts:4-42` and its spec; `cableHost.ts:690-698`; `observed.ts:386` |
| Capabilities to the dial | Per agent, not through `cable_features`: `caps` letters `svfa` on each machine-view row. The daemon refuses what an agent lacks; firmware parses them and hides or refuses voice and focus | `types.ts:70`, `cableHost.ts:562,698`, `cableSession.ts:1431,1470,1616`, firmware `cable_client.c:951,993`, `ui_habitat.c:1188,1400,2347,2625,3045` |
| Answer on the dial | Firmware never reads `CABLE_CAP_A`. A shown-only prompt of an outside agent offers [choices], "In Orca", [send]; the daemon then refuses with "Answer it in Orca." | `ui_habitat.c:1400-1418,2232`; `cableSession.ts:1616-1623`; `services/devices.ts` `showWaits` |

## Decided (PM for Diego, 2026-11-15)

- Scope A: reshape what exists so that each app is one adapter. No change a person can see, except the answer button
  below. Nothing goes into the core.
- The firmware honours `CABLE_CAP_A` in this pull request. Flashing a dial needs its own go: Diego is using his.
- Keep only what wave 1 needs. No option, no setting, no member that nobody calls yet.

## Design

### Two layers, as the roadmap names them

- **Sources** (`HostSource`, unchanged): who lists agents. Today these are `HarnessSource` and `ObservedSource`.
- **Adapters** (`HostAdapter`, new): the apps an outside agent runs in. Each one finds its own pane of an agent from
  the agent's latest event, and acts on that pane. `ObservedSource` holds the agents and every rule about their state;
  the adapters hold every rule about their app.

The roadmap's `list/events/send/focus/capabilities` maps like this:

| Roadmap | Where |
|---|---|
| `list` / `events` | the source: `HostSource.list`, `ObservedSource.onChange` |
| `send` | the source decides whether the agent may take words now (live, not waiting, not busy); the adapter types them (`type`); the Claude Code mod and `codex queue` stay the source's agent-layer routes |
| `focus` | the adapter's `focus`, then the app by bundle id (`open.ts`) |
| `capabilities` | the source from its adapters: `canType`, `canFocus`, `canShow` |

A wave 1 app that lists its own agents (Orca `worktree ps`, herdr `agent.list`) adds `list` and events to its adapter
in that wave's pull request. Here it would be a member nobody calls.

### The interface (`cli/src/cable/hosts/adapter.ts`)

```ts
/** Where an outside agent runs, from its latest hook event and what was learnt of its process. */
export interface Place {
  host: string                                  // detectHost
  app: string                                   // detectApp
  hints: Readonly<Record<string, string>>       // that event's host hints, as the core checked them
  tty?: string                                  // its process's tty, read for a tab app (observed.ts learnTty)
}

/** One adapter's own handle on one agent: an Orca terminal, a Claude app session, a tab's tty, a pane id. */
export interface Pane {
  adapter: string
  id: string
}

/** One app the dial reaches an outside agent through. */
export interface HostAdapter {
  readonly id: string
  /** Its pane of the agent at that place, every value checked against its own form; none when the agent is not in it. */
  paneOf(place: Place): Pane | undefined
  /** Whether a tap can bring that pane forward on this computer. */
  canFocus(pane: Pane): boolean
  focus(pane: Pane): Promise<boolean>
  /** Whether a rest can show the pane inside its app now (the app in front, a watch open): asked at each look. */
  canShow?(pane: Pane): boolean
  show?(pane: Pane, agentId: string): Promise<PaneSwitch>
  /** Types a line at the agent's prompt and submits it. Only the source decides that the prompt is free. */
  type?(pane: Pane, text: string): Promise<boolean>
  /** A tap's order with the app's own `open -b`: the pane first (Orca, WezTerm, herdr), the pane alone (the Claude
   *  app's link brings the app itself), or the app first (a tab is selected once its app is in front). */
  readonly tap: 'before' | 'instead' | 'after'
}
```

The adapter id is the name today's log lines use (`[device] open · claude · fallback`), so the Claude app's is `claude`
(PM, 2026-11-15).

`ObservedSource` keeps every pane an adapter recognises for an entry, in a fixed order: herdr, WezTerm, Orca, the
Claude app, then a tab by tty. That is today's precedence: `open.ts` `paneOf` for a tap, then `shownPane`'s tab.

Each verb uses the first pane in that order whose adapter can do it:
- words: the first with `type` (Orca);
- a rest: the first whose `canShow` says yes;
- a tap: the first whose `canFocus` says yes.

So an agent seen by two hosts keeps every route its hosts give it. Three examples:
- WezTerm inside an Orca terminal still takes words and rests through Orca;
- herdr inside an Orca terminal takes words over herdr's socket on macOS and Linux
  ([herdr](2026-11-16-device-herdr.md#the-herdr-adapter-hostsherdrts)), and no rest: a multiplexer's agent has no Orca
  pane ([wave 1 checks](2026-11-15-device-wave1-checks.md));
- herdr inside Terminal, iTerm2 or Ghostty writes no tab select: its tty is herdr's pane's, which no tab holds (the same
  spec).

Every event computes the panes afresh, as `handle` and `opens` are today, so a session resumed elsewhere never keeps a
pane it left (PM, 2026-11-15).

### The adapters

| Adapter | File | `paneOf` | `type` | `focus` | `show` |
|---|---|---|---|---|---|
| `orca` | `hosts/orca.ts` (the Orca adapter) | `ORCA_TERMINAL_HANDLE` matching `ORCA_HANDLE` | `orca terminal send` | `orca terminal switch` | `orca terminal switch` |
| `claude` | `hosts/claudeApp.ts` (new, from `open.ts` and #4326) | the Claude app's bundle id and a `local_…` session | none | the `claude://code/continue` link through `hosts/appLink.ts`, macOS only | the link through `hosts/appLink.ts`, while the Claude app is in front |
| `codex` | `hosts/codexApp.ts` | the app `codex`, the engine `codex` and a thread id (`CODEX_THREAD`); no hint read | none | the `codex://threads/<id>` link through `hosts/appLink.ts`, macOS only; `open -b com.openai.codex` when the link fails | the link through `hosts/appLink.ts`, while the Codex app is in front |
| `tabs` | `hosts/tabs.ts` (#4331's file) | a tab app and a learnt tty | none | the watch's select with raise | the watch's select, while a watch is open |
| `wezterm` | `hosts/wezterm.ts` (new, from `open.ts`) | `WEZTERM_PANE` | none | `wezterm cli activate-pane` | none |
| `herdr` | `hosts/herdr.ts` (new, from `open.ts`) | `HERDR_PANE_ID` | none | `herdr agent focus` | none |

herdr's adapter now types, over herdr's socket, and its focus is still `herdr agent focus` ([herdr](2026-11-16-device-herdr.md#the-herdr-adapter-hostsherdrts)).

`open.ts` keeps only what every app shares:

- the bundle id a tap brings forward (`openTarget`'s bundle part);
- `open -b`;
- the one tap at a time per agent;
- the fallback line when a pane's own focus fails.

`ObservedActions` shrinks to the adapters, the mod's two members, the Codex queue's, the bundle opener and `count`. The `ShownPane` union,
`paneHandle`/`shownPane` and the per-app `switch` statements go.

Every command line, argument, timeout, one-at-a-time guard, refusal sentence and log line stays byte for byte as it is.
The existing specs (`observed.spec.ts`, `open.spec.ts`, `orca.spec.ts`, `tabs.spec.ts`) and the e2e suites
(`deviceClaudeOrca`, `deviceWithoutApp`, `dialPaneFollow`, `dialClaudeAppFollow`, `dialTerminalFollow`,
`dialAppFilter*`) are the guard. A test that has to change in what it expects means the reshaping changed behaviour,
and that is a finding.

### De-duplication

The rule stays as it is (`registry.ts`):

- one agent per engine and session id, else per caller pid;
- Harness first, then an adapter's own list, then observed.

The herdr spec reverses the last two: the hook's copy wins ([one agent, one row](2026-11-16-device-herdr.md#one-agent-one-row-the-merge-key-4341-left-to-this-pull-request)).

Before herdr ([2026-11-16 spec](2026-11-16-device-herdr.md)), no agent could reach the merged list twice:

- a pane's hook goes to the core, and only a paneless hook reaches the devices;
- the open scan skips Harness's own sessions;
- a Harness agent carries its bound session id.

`registry.spec.ts` covers the merge, and `observed.spec.ts` covers a scanned session that a hook then names. One test is
added to `observed.spec.ts` for the other order, the path the roadmap names: a Claude Code session in Orca that its hook
told of first, then the open scan found, is listed once and keeps its Orca pane.

The first wave 1 adapter that lists its own agents joins a sighting to an observed agent by session id when the app
reports one, else by its pane (`Pane.adapter` + `Pane.id`, the same key its `paneOf` gives a hooked agent). It adds
that key to the merge in its own pull request, with its recorded data.

### The dial: answer only where the host can

Firmware, `devices/harness-device` (the round dial). For an agent whose row lacks `CABLE_CAP_A`:

- the question screen shows the prompt and [later] only: no [choices], [say] or [next];
- `A_QUESTION_CHOICES`, `A_CHOICE`, `A_QUESTION_REVIEW` and `A_ANSWER` for it do nothing.

The prompt's own line already ends "· answer in <app>" (`observed.ts` `askedLine`). Rows with all four letters, and
rows without `caps` (a window's tiles, an older daemon), stay as they are. Voice on a question keeps its `CABLE_CAP_V`
check. The daemon's refusal in `cableSession.ts` stays, for dials not flashed yet. The Harness Pro firmware does not
read `caps` and is out of scope.

### Added from #4331's review (PM, 2026-11-15)

These two changes are behaviour fixes. They are coded after #4331 is on `main`.

**F2. One record of what the dial just showed, for every kind of pane.**

On `main` with #4326, and on #4331, each app keeps its own record of the dial's own moves, in
`services/devices.ts`:
- the Claude app side: `dialLinks`, `noteLink` and `linkedByDial`, for a continue link;
- the tab side: `written` and `selects`, for a tab select.

A settle checks only its own app's record. So a rest or a tap the dial made on another kind of pane, inside the settle
of the app in front, is not seen, and the settle turns the dial back. Two cases:
- Terminal has just come to the front and its tab report waits for the settle. The person swipes to an Orca agent: the
  dial rests and Orca switches. The settle then follows the Terminal tab and pulls the dial back.
- The same happens with the Claude app's settle and a tab select or an Orca switch.

The fix is one record in the devices process: "the dial just moved". It is noted as each move of the dial starts:
- a hand's turn to any agent (the cable session's dial `focus`, never a follow's echo);
- a tap, before `open -b`;
- every adapter's `show` and `focus` (Orca switch, Claude link, tab select, a tap's raise), which a rest runs 400 ms after
  its turn and a tab's raise runs after `open -b`.

- A settle is set aside after a dial move of any kind of pane:
  - a tab app's settle, when the dial moved since the tab report it waits on came;
  - the Claude app's settle, while the dial's latest move is younger than `ATTACH_ECHO_MS`. Its report is the app's
    last attach, which can be minutes old after a Cmd-Tab away and back; this is today's rule for a link, widened to
    every kind of pane.
- An app's own echo of the dial's move (a tab report for the tty the dial selected, an attach for the session the dial
  linked) is still matched per agent and per tty, as today, within the same echo windows: `ATTACH_ECHO_MS` and
  `ECHO_MS`.

Red tests in `devices.spec.ts`, one for each case above: today they fail, because the dial is turned back.

**F3. One form for the follow log lines.**

The tab's skip lines take the form the prompt, attach and settle lines already use, `[device] <cause> · skipped ·
<why>`:

| Today | After |
|---|---|
| `[device] tab · no-tile` | `[device] tab · skipped · no tile` |
| `[device] tab · echo` | `[device] tab · skipped · echo` |
| `[device] tab · no-agent` | `[device] tab · skipped · unknown agent` |
| `[device] tab · not-in-front` | `[device] tab · skipped · not in front` |

`[device] tab · moved` stays. The terminal-follow spec (`docs/specs/2026-11-15-dial-terminal-follow.md`), the unit
specs and the e2e that read these lines change with them. This is the one exception to "every log line stays byte for
byte" above.

### Core, platforms, measures

- **Core:** nothing in `src/core/` changes; every file is in the devices process or the firmware.
  `architecture.coreFiles.txt` is unchanged.
- **Platforms:**
  - macOS, where every adapter runs;
  - Linux and Windows, where only a pane's own command focuses (Orca, WezTerm, herdr) and the Claude app link and
    bundle opener are off, as today;
  - the round dial's firmware.
- **Measures:** no new path, so no new measure. The `[device] open · <app> · fallback` and `[observed]` lines stay as
  they are.
- **Data:** nothing is stored, synced or exposed that was not before.

## Out of scope

- Any wave 1 adapter: Orca `worktree ps` listing, herdr's socket, `codex://`, the tmux check.
- An agent-route interface. `codex queue` (#4334, merged while this was built) is the second agent-layer route beside
  the Claude Code mod. Both stay checks inside `ObservedSource`, asked before any pane, as `main` has them. The
  interface comes with a third route, or when another source needs them (PM, 2026-11-15).
- `cable_features`: capabilities stay per agent.
- Harness Pro firmware; flashing any dial; a release.
- The tmux pane a person opened outside Harness, which the core does not adopt: its hooks reach neither the core's
  agents nor the devices. It is wave 1's "tmux, check it all with the app closed".

## Done when

1. `hosts/adapter.ts` holds `Place`, `Pane` and `HostAdapter`. Orca, the Claude app, tabs, WezTerm and herdr each
   implement it in their own file, each with a contract test on recorded hint sets:
   - its `paneOf` accepts the real hints and refuses forged ones;
   - its commands run with the same arguments as before.
2. `observed.ts` has no app-specific branch: no `ShownPane`, no per-app `switch`. It asks its adapters. `open.ts` has
   no per-app case.
3. Every spec and e2e named under the adapters table passes with its expectations unchanged.
4. The `observed.spec.ts` test for one Orca session told of by its hook, then found by the scan, passes.
5. Firmware: `test_touch_ui.py` shows an agent with `caps` `s` (and with `sv`) on a shown-only prompt with no [choices],
   and the answer actions ignored. Rows with `svfa`, and rows without `caps`, render as before. The firmware build passes.
6. F2: a settle, the Claude app's or a tab app's, no longer turns the dial back after the dial showed another kind of
   pane within it. A red-then-green test covers each case.
7. F3: every tab skip line reads `[device] tab · skipped · <why>`, in code, specs, e2e and the terminal-follow spec.
8. `npm run test:core` is green (100% per file under `src/services/`), and the PR records it.
