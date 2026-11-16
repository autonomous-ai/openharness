# The dial follows the pane focused in Orca, and Orca's ring follows Orca's tabs (Diego, 2026-11-16)

On top of [the dial and the apps follow each other, pane by pane](../specs/2026-11-14-dial-pane-follow.md) (#4311), [the dial
follows terminal tabs both ways](../specs/2026-11-15-dial-terminal-follow.md) (#4331) and the per-app rings (`select.ts`
`AppRings`). The last two Orca pieces of Đợt 1.

## Why

Diego's reports (2026-11-16):

- **(A)** "I change pane in Orca, the device does not follow." Today the dial follows Orca only on a prompt the person
  submits (#4311), because Orca's CLI does not say which pane has focus.
- **(B)** "Orca's order is [Terminal 3, harness, round-screens…, Skill, PM], but when I swipe it goes by Back/Forward."
  The Orca ring is in first-entry order (`DialRing`), unrelated to Orca's tabs.

## What Orca offers (research, 2026-11-16, Orca 1.4.256 and upstream `main`)

- **Focus.** Orca 1.4.256 reports no focused pane. Our upstream pull request stablyai/orca#42555 (open, not merged) adds
  `focused` to `orca terminal list --json` and `orca terminal watch-focus [--json]`: it prints the focused terminal's
  handle, then one line per focus change, until killed; with `--json` each line is `{"handle":"term_…"}`, or
  `{"handle":null}` when no terminal has focus (an editor or browser tab, no window). It is a long poll inside the CLI, so
  the process costs nothing between changes.
- **Order.** The flat `terminals` array of `orca terminal list --json` is **not** in tab order: it follows Orca's pane
  registry (`runtime-terminal-list.ts`, `getLeaves()`), then PTYs with no pane. Measured on Diego's Mac: the main
  worktree's rows are Terminal 3, harness root, Skill; its tab strip is Terminal 3, Skill, harness root.
  `--include-visual-layouts` (in 1.4.256) adds `visualLayouts`: per worktree a tree whose groups carry the tab strip's
  `tabOrder` (`runtime-terminal-visual-layout.ts`), each tab its panes as a split tree (`first`, then `second`), each
  leaf a terminal `handle`. Group splits are `type: 'split'` with `first` and `second`; tab groups `type: 'group'` with
  `tabs`. Worktrees come in Orca's internal snapshot order, which is not known to be the sidebar's (the sidebar sorts by
  `sortOrder`, pins and a sort mode Orca does not expose).

## Decided (PM for Diego, 2026-11-16)

1. The order comes from `visualLayouts`: inside a worktree by group, tab, then pane; worktrees in the order the layouts
   list them. An Orca agent whose handle is in no layout (one in a multiplexer inside Orca, a terminal Orca dropped)
   goes after the ordered ones, in its ring order. No guess from `sortOrder`.
2. The layout is read once each time the set of agents on Orca's ring changes (one enters or leaves), one read at a
   time, a change during a read asking for one more after it. The Orca ring is reordered when the read lands. A tab
   dragged in Orca with no agent entering or leaving is seen at the next change: nothing polls. The agent the dial shows
   stays the one it shows; only its place moves. Only Orca's ring: the machine ring (dials that do not say `appFilter`)
   and other apps' rings keep first-entry order.
3. Focus follow runs only where the Orca CLI has `watch-focus`: `orca terminal --help` is read once per Orca binary
   (its real path and mtime, so an Orca update is seen: every file of Orca 1.4.256's bundle, the `bin/orca` shim too,
   carries the release's build time). With a dial attached, when Orca settles in front and the CLI has it,
   the devices process starts `orca terminal watch-focus --json` and keeps it until no dial is attached. A dial that
   attaches while Orca is already the settled front app starts it the same way (PM, 2026-11-16). A watch that
   exits starts again only at Orca's next settle: no retry loop, and nothing runs while Orca is closed. The first line is
   the focus at that moment, so a settle moves the dial to Orca's focused pane, as a tab report does (#4331).
4. While the watch runs, a prompt in an agent with an Orca pane no longer moves the dial (focus already did, and a prompt Orca types
   for an orchestrator, `orca terminal send`, no longer pulls the dial). With an Orca CLI without `watch-focus`, the
   prompt follow stays as it is. An agent in a multiplexer inside Orca has no Orca pane (`MULTIPLEXERS`, `orca.ts`),
   so focus cannot reach it: its prompts still move the dial.
5. The echo guard is the tab follow's: each pane the dial switches Orca to (a rest's `orca terminal switch`, a tap's) is
   kept by handle for 2 s, at most 8; a focus line for a kept handle within that time is the dial's own echo, is
   skipped, and uses up that switch and those before it.
6. The upstream addition (layouts in the sidebar's order) goes in Follow-ups and the final report; no pull request or
   issue on Orca from this branch (Diego decides).
7. After Diego's first dial check (PM, 2026-11-16): an Orca agent the attach scan found has no Orca pane until its first
   hook, and an idle one sends none, so it fell to the end of the ring (the tab "Skill từ SKILL.md", idle since the
   morning, came after "PM"). Orca's list gives no terminal's process or tty, so such an agent is placed by elimination:
   the Orca terminal whose `worktreePath` is the agent's folder, whose `agentIdentity` is its engine, and which no agent
   with a known Orca pane holds. Only when exactly one such terminal matches exactly one such agent; anything ambiguous
   stays after the ordered ones. The match gives order and a tab name, and after Diego's second dial check (PM,
   2026-11-16: a swipe to the placed "Skill từ SKILL.md" did not switch Orca's tab) a rest and a tap switch Orca to the
   placed terminal (`orca terminal switch`, showing only). Never typing: words, voice and `orca terminal send` use only a
   pane the agent's own hook named. Focus follow and prompt follow never map a placed terminal to the agent.
8. A tab the person renamed in Orca names the agent above the session's own name (PM for Diego, 2026-11-16: his tab
   "PM" holds the session he named "harness root", and the dial must say "PM"). Orca marks no custom title, but a tab's
   own title is its active pane's: a tab title that differs from the title of every pane in it is one the person set.
   A tab not renamed keeps the earlier precedence.

## Design

Everything lives in `cli/src/cable/hosts/` and the devices process (`cli/src/services/devices.ts`). Nothing in the core
(cli/AGENTS.md rule 7).

### 1. Reading Orca (`cable/hosts/orca.ts`)

Three reads beside the adapter (no shell), from one factory `createOrcaReads(deps)`. Their deps, `OrcaReadDeps`,
extend `OrcaDeps` with `spawn` (a long-lived child with its stdout) and `mtime(path)` (with the real path), so the
adapters keep `OrcaDeps`; the binary lookup the adapter uses (`orcaBinary`) is shared with these reads. Orca's node
types (1.4.256's bundle): a group tree is `group` or `split`, a pane tree `terminal` or `pane-split`.

- **`orcaWatchesFocus()`**: whether `orca terminal --help` lists `watch-focus` (a word in its Commands list). Kept per
  binary path and mtime; a failed or timed-out run answers false and is not kept, so the next settle asks again.
- **`orcaTabOrder()`**: runs `orca terminal list --json --include-visual-layouts` through `run` (10 s timeout; its
  stdout is bounded by `execFile`'s 1 MiB default, and more fails the read), and returns the handles in tab order (decided 1), each checked against `ORCA_HANDLE`. Any
  shape it does not know (a missing `visualLayouts`, an unknown node type) ends that branch with no handles; a read
  that fails returns null. The walk is bounded: at most 64 worktrees, 256 handles and a depth of 32.
- **`watchOrcaFocus(onHandle)`**: spawns `orca terminal watch-focus --json` with stdin ignored, reads stdout line by
  line (a line over 512 bytes is dropped, as is one that does not parse), and calls `onHandle(handle | null)` with a
  checked handle or null; any other value is dropped. Returns a stop that kills the child (SIGKILL after 1 s of SIGTERM)
  and an `ended` promise. stderr is drained and never logged (it can name paths).
- **A rest's or a tap's switch activates the worktree first** (PM, 2026-11-16, after Diego's dial check on Orca
  1.4.256: `orca terminal switch` exited 0, yet some panes showed only once he pressed Back). `terminal switch` runs
  only Orca's light reveal (`revealWorkspaceSurface`); Back runs the full activation (`activateAndRevealWorkspace`),
  which wakes or reseeds a parked or sleeping session, and so does `orca worktree activate`. So the switch runs
  `orca worktree activate --worktree id:<worktreeId> --json`, then `orca terminal switch --terminal <handle> --json`,
  strictly in that order, a placed terminal's too. The id comes from the same layout read: `orcaTabs()` gives each
  terminal's worktree, its layout's `worktreeId`, else its `terminals` row's, at most 256; an id that is no string,
  empty, past 4160 characters or with a control character is none. It is one argument (`id:` and Orca's own id, a uuid,
  `::` and a folder), never a shell's. The devices keep the latest landed read's and hand the adapter a lookup. No id
  known: the switch alone. An activate that fails, throws or times out still lets the switch run, whose outcome is the
  answer, and logs one line. The per-handle dedupe and the busy-while-typing rule cover the two commands as one; words
  never activate. An activate can take long, and Orca's focus line for the pane follows the switch: the echo guard
  (section 2) keeps the switch from the rest's or the tap's start and again from the switch command's own start.

### 2. Focus follow (devices process)

State: the watch (or none), the latest handle it reported, and the dial's recent Orca switches (decided 5). The Orca
adapter in the devices' `adapters` list is wrapped as the Claude app's is (`devices.ts`, its `show` noting the link):
its `show` and `focus` record `pane.id` (the handle) as they start, then run as before; `noting` still wraps it.

"A dial attached" is the devices' `dialAttached(on)` (a dial watching): it stops the watch on `false`. "A dial linked"
is `cable.isConnected`, the gate on every follow, as in `followPrompt`.

- **Orca settles in front** (`appSettled('orca')`), or a dial attaches while Orca is the settled front app, a dial attached: with no watch, if `orcaWatchesFocus()`, start one;
  its first line is followed by the settle rule below. With one running, follow its latest handle by the settle rule.
- **A line** with handle `h`: kept as the latest. If Orca is the settled front app, follow `h`; otherwise nothing (the
  next settle uses it). Null: kept as the latest, nothing moves.
- **Follow `h`**: no dial linked, nothing. A kept switch of `h` within 2 s: skipped as echo (uses it up). The agent:
  the live observed agent whose Orca pane is `h`: `observed.byPane('orca', h)`, beside `byTab`, scanning each entry's panes
  for that adapter's (`observed.ts` names no app: services/AGENTS.md) (the one heard from last of two); none: skipped as unknown. Then `cable.followLocal(agent.id, 'focus')`, which keeps followLocal's queue, its no-tile answer
  and its nothing-sent for the agent already shown.
- **Settle follow** additionally skips when the dial itself moved within the last 2 s (`dialMovedAt`, as the Claude app's
  settle does): a turn as Orca comes forward must not be turned back.
- **Prompt follow** (`followPrompt`): with a watch running, a `turn-start` of an agent with an Orca pane
  (`observed.paneOf(id, 'orca')`) is skipped as `focus followed`. Every other prompt is unchanged.
- **Dial detached**: the watch is stopped and the latest handle dropped. The devices process stopping stops it too.
- **The watch ends** by itself (Orca quit, an error): dropped; the next settle starts one.

`FollowCause` gains `focus`, with its own log lines.

### 3. Orca's ring order (`select.ts`, `cableHost.ts`, devices)

- **`DialRing`** takes an optional rank: `select(agents, rank?)`, where `rank` is a `ReadonlyMap<agentId, position>`,
  one object per landed read. When the ring's members changed since the last pass, or the rank is another object than
  the last pass's (compared by identity: a new read landed), the members are put in rank order, the unranked after the ranked in their previous order. Otherwise the ring keeps its order. The firmware keeps
  the agent on screen by id, so the agent the dial shows stays shown.
- **`AppRings.update(agents, ranks?)`**: `ranks` maps an app id to its rank; only `orca` is given one.
- **The host** (`cableHost.ts`) gains `setRank(app, rank)` beside `setRegistry`; `appList` passes the ranks it holds to
  `rings.update`.
- **The devices process** keeps the Orca order. Its members: the live registry agents whose app is `orca`, checked on
  each `observed.onChange` (the source's own change signal, `devices.ts`) and on dial attach; a different set of ids
  asks for a read (decided 2). When a read lands, the rank maps each member with an Orca pane
  (`observed.paneOf(id, 'orca')`) to its handle's position, and goes to the host with `setRank('orca', rank)`; the dials get
  the reordered ring on the session's next list, as any ring change. A failed read keeps the previous rank and logs it.
  Reads run only while a dial is attached.

### 4. An Orca agent is named by its tab (PM for Diego, 2026-11-16)

Diego chose earlier that an Orca agent takes the title of its Orca tab. Example on his Mac: a terminal whose pane title
is "harness root" sits in a tab he named "PM"; the dial must say "PM", and today says the folder or the pane title.

- **Source:** the same layout read as the order (section 3): each `visualLayouts` tab's `title`, for every handle in
  that tab's panes. No second read. `orcaTabOrder()` becomes `orcaTabs()`: the handles in tab order, each with its tab's
  title, cleaned and cut as a hook's title is (`observedTitle`: whitespace folded, at most 64 characters, none with a
  control character); a title it refuses is none.
- **Precedence** (decided 8): a tab the person renamed in Orca (its title differs from every pane title in it) > the
  name the person gave the session (the hook's `session_title`, a `user` name in Claude Code's process record, #4333) >
  its Orca tab's title > the folder, as today. A tab whose title Orca made up ("Terminal 3", or a title the program in
  it set) is still the tab's title: the dial says what the tab says.
- **An agent with no pane yet** (decided 7): the same read places it by elimination, for its tab's name as for its
  order, and for the terminal a rest or a tap switches to (never typing); ambiguous, it keeps its folder and switches
  nothing. A list cut short (Orca's `truncated`, past its 200 rows by default, or one past
  256 rows) places nobody: a terminal left out could be the match.
- **When:** each time the layout is read (a change of the Orca ring's members, section 3), the names follow. Renaming a
  tab with no member change is seen at the next change: nothing polls.
- **Where:** `observed.ts` names no app: it gains `setPaneNames(adapter, names, placed)`, which replaces that adapter's
  names by pane id (each with whether the person set it) and the panes agents with none of that adapter's were placed at;
  an agent is called by its pane's name, or its place's, in the precedence above. A place is shown-only: a rest and a
  tap switch to it, where the agent has no pane of that adapter (its own pane wins), but it is never its pane: no words
  reach it, and `paneOf` and `byPane` (prompt and focus follow) never return it. A place that comes or goes tells the
  change, as what a tap reaches changed. The devices process gives it the Orca adapter's names after each read. Only
  Orca agents; nothing in the core.
- **A tap on a placed agent on macOS** (PM, 2026-11-16): it has had no hook, so no app of its own to bring forward. The
  adapter it was placed in declares its app's bundle (Orca's, `com.stablyai.orca`, from `APP_BUNDLES`): the tap switches
  to its placed terminal, then brings Orca forward, in the order the adapter's `tap: 'before'` says. A bundle the agent's
  own hook gave still wins; words still go nowhere.

### Measures

Log lines, outcomes only, never a handle, an agent, a title or a path:

- `[device] focus · moved`, `[device] focus · skipped · echo | unknown agent | no tile | not in front`;
- `[device] orca watch · started | unsupported | ended`;
- `[device] prompt · skipped · focus followed`;
- `[device] orca order · read | failed` (the same read names the agents);
- `[device] orca activate · failed`.

## Out of scope

Windows (no front app there); a watch on a remote Orca (`--environment`); Orca's editor and browser tabs; reordering
on a tab drag with no member change; the Claude app, Terminal and other apps' rings; firmware.

Orca's chat tabs (its agent UI, `agentSession`), found on Diego's Mac (2026-11-16, tab "harness"): Orca 1.4.256 lists
only terminals in `terminal list` and `visualLayouts`, and its public CLI has no command to list or switch to a chat
(`chat rename` only; `terminal switch` takes a terminal handle). A chat's agent therefore has no place in the ring, no
tab name and no switch: if its hook reaches the devices it comes after the ordered ones, and a rest or tap on it does not
change Orca's view. Orca's internal `session.tabs.list` is not a public command and is not used.

## Follow-ups

- **Upstream Orca:** list chat tabs in `visualLayouts` (tab id and chat session id), and add `orca chat switch --session
  <id>` (or let `terminal switch` take a tab id), so a chat's agent gets its place, its tab's name and a rest's switch.
  Note only, no PR or issue (Diego decides).
- **Upstream Orca:** list `visualLayouts` in the sidebar's worktree order (or give each layout the sidebar's index), so
  the ring's order across worktrees matches what the person sees. Diego decides whether to propose it.
- **Upstream Orca:** stablyai/orca#42555 merged and released: the dial check of (A) on a real Orca.
- **Upstream Orca:** `terminal switch` runs only the light reveal (`revealWorkspaceSurface`); it should run the full
  activation, or offer `--reveal`, so one command shows the pane. Note only, no PR/issue.

## Done when

**Tests**

- `orca.ts`: `--help` with and without `watch-focus`; kept per path and mtime; a failed run not kept. Tab order: groups,
  splits of groups, tabs, pane splits in `first`-then-`second` order, unknown shapes, bad handles, the bounds, a failed
  read. Watch: lines parsed, null, an over-long or bad line dropped, stop kills, `ended` resolves.
- `select.ts`: a rank orders the ring when members change and when a new rank comes; not on a pass with the same members
  and the same rank; the unranked after the ranked; the shown agent is still in the ring and still the one the dial
  shows (decided 2); the 16-place rules unchanged.
- Devices: Orca's settle starts one watch only when the CLI has `watch-focus`; a line with Orca in front moves the dial;
  with another app in front it moves nothing and the next settle follows it; a switch's echo is skipped once; the settle
  is skipped right after a dial move; a prompt in Orca is skipped while the watch runs and still followed with an old
  Orca; detach stops the watch; an ended watch starts again at the next settle only. A member change of the Orca ring
  asks for one read; a change during a read asks for one more; the read reorders the Orca ring only.
- End to end: the real daemon, a fake dial, a fake front app and a fake `orca` (two variants: with `watch-focus` and
  layouts, and 1.4.256's help without it). Never the real Orca, and no `orca terminal switch` on a real pane.
  - With `watch-focus`: Orca settles in front, the fake prints a focus line, the dial moves to that agent; the dial's own
    swipe's echo line moves nothing; the Orca ring the dial gets is in the fake layout's tab order.
  - Without: no watch runs; a prompt still moves the dial.

- Naming: `orcaTabs()` gives each handle its tab's title, cleaned, none for a bad one; an Orca agent with no name of its own
  is called by its tab after a read, one with a `user` name or a hook title keeps it, one with no tab title keeps its
  folder; a new read with another title renames it; the end-to-end dial shows the tab's title.
- Diego's layout (decided 7 and 8): a worktree with tabs "Terminal 3" (a shell, no `agentIdentity`), "Skill từ
  SKILL.md" (an idle Claude agent the attach scan found, no hook) and "PM" (pane title "harness root", a hooked Claude
  agent whose session the person named "harness root"): the ring has the Skill agent before PM, and PM is named "PM".
  Two unplaced agents in one folder, or two unclaimed terminals, place neither. With a "harness" agent's tab between
  "Terminal 3" and Skill: a rest and a tap on Skill switch Orca to its placed terminal; words to it run no `orca terminal
  send`; an ambiguous placement switches nothing; once Skill hooks, a rest uses its own handle; a focus line for the
  placed terminal finds no agent.

**On a dial** (Diego's Mac, asked from the orchestrator when the pull request is ready): Orca's ring is in Orca's tab
order (B); an Orca agent in a tab Diego named shows that name; a prompt still moves the dial on Orca 1.4.256 (A cannot run there until Orca ships `watch-focus`).

## Design notes

- **Data.** Nothing stored. In memory: the latest focused handle, up to 8 recent switches, the Orca order (at most 256
  ids) and tab titles (at most 256, 64 characters each), the probe answer per binary. A tab title is the person's own
  text: it reaches the dial as the agent's name, as a session's name does, and never a log.
- **Cost.** No polling. One `orca --help` per Orca binary; one `watch-focus` process while a dial is attached and Orca
  has settled in front once, idle between focus changes; one `terminal list` per member change of Orca's ring.
- **Security.** Orca's output is outside text: every handle is checked against `ORCA_HANDLE`, lines and stdout are
  bounded, the JSON walk is bounded, and `orca` runs with `execFile`/`spawn`, no shell. Handles never reach a log.
- **Platforms.** macOS: tests and the dial check. Linux X11, where the front app is known: the same code, untested on a
  dial (the pull request says so). Windows: no front app, so no focus follow; the order applies wherever the Orca ring
  exists.
