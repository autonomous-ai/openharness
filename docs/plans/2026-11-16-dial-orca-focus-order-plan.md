# The dial follows the pane focused in Orca, and Orca's ring follows Orca's tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit.

**Goal:** Orca's ring on the dial is in Orca's tab order, and where Orca's CLI has `watch-focus` the dial turns to the agent whose pane the person focuses in Orca.

**Architecture:**
- **Three reads of Orca's CLI** sit beside the Orca adapter (`cli/src/cable/hosts/orca.ts`): whether the CLI has `watch-focus`, the terminals' handles in tab order, and a long-lived `watch-focus` child. Each checks and bounds what Orca prints.
- **A ring takes a rank** (`hosts/select.ts`): a map from agent id to place. The ring is put in rank order when its members change or a new rank comes, and holds still otherwise. The host hands Orca's rank to Orca's ring alone (`cableHost.ts` `setRank`).
- **The observed source** answers two lookups (`hosts/observed.ts`): the live agent that holds a pane, and an agent's pane.
- **The devices process** (`cli/src/services/devices.ts`) reads the order once per change of the Orca ring's members, runs one focus watch while a dial is attached, and turns the dials to the focused pane's agent with the tab follow's echo guard.
- Nothing goes through the core. Nothing is stored. No firmware, no Desktop, no backend.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`).

**Spec:** `docs/plans/2026-11-16-dial-orca-focus-order-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`.

**Open questions:** one, under "Open questions". The draft follows the spec's wording for it.

## Base

- `feat/dial-orca-focus-order` at `5840f0786f` (after #4371). Nothing else has to merge first.
- Names at that commit. The tasks name functions, never lines:
  - `cable/hosts/orca.ts`: `OrcaDeps`, `orcaDeps`, `createOrcaActions` (its `orcaBinary`), `ORCA_HANDLE`, `RUN_TIMEOUT_MS`, `MULTIPLEXERS`.
  - `cable/hosts/select.ts`: `DialRing.select`, `AppRings.update`. `cable/cableHost.ts`: `setRegistry`, `appList`, `rings`.
  - `cable/hosts/observed.ts`: `byTab`, `live`, `locate`, `Entry.panes`.
  - `cable/cableSession.ts`: `FollowCause`, `followLocal`, `syncAgentsNow` (it says the dial's agent again after every ring push).
  - `services/devices.ts`: `DevicesDeps.orca`, `apps`, `FOLLOWED`, `TAB_ECHO_MS`, `ECHO_KEPT`, `ATTACH_ECHO_MS`, `noteMove`, `dialMovedAt`, `noting`, `adapters`, the `observed.onChange` turn, `dialAttached`, `appSettled`, `followPrompt`, `claudeSettled`, `followTab`.
  - `services/devices.spec.ts`: `start`, the shared `orca` fake, `orcaRuns`, `fakeListener`, `turnTo`, `calls`, and the describes `a person's prompt in the app in front turns the dial` and `selecting a tab moves the dial` (their `dialWith`, `settle`, `asked`, `unlinked`).
  - `e2e/dialPaneFollow.e2e.ts`: `fresh`, `inOrca`, `listed`, `front`, `said`, `typedUntilMoved`, `turnedToFirst`.
- If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Orca's three reads | `cli/src/cable/hosts/orca.ts`, `orca.spec.ts` | none | xhigh | `orca.spec.ts` |
| 2 A ring takes a rank | `cli/src/cable/hosts/select.ts`, `select.spec.ts` | none | high | `select.spec.ts` |
| 3 The host hands an app's rank to its ring | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | 2 | medium | `cableHost.spec.ts` |
| 4 An agent by its pane | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | none | high | `observed.spec.ts` |
| 5 Pin: a ring sent in another order leaves the dial on its agent | `cli/src/cable/cableSession.spec.ts` | none | medium | none: no behavior (it pins what Tasks 2, 3 and 7 rely on) |
| 6 One fake `orca` for the end-to-end daemons | `cli/e2e/harness/fakeOrca.ts` (new), `cli/e2e/harness/daemon.ts`, `cli/e2e/dialPaneFollow.e2e.ts` | none | high | none: no behavior (test files only) |
| 7 Orca's ring follows Orca's tabs | `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 3, 4 | xhigh | `devices.spec.ts` |
| 8 The dial follows the pane focused in Orca | `cli/src/services/devices.ts`, `devices.spec.ts`, `cli/src/cable/cableSession.ts` | 1, 4, 7 | xhigh | `devices.spec.ts` |
| 9 End to end, on a fake `orca` | `cli/e2e/dialOrcaFocus.e2e.ts` (new) | 6, 7, 8 | high | none: no behavior (the end-to-end test of Tasks 1 to 8) |
| 10 Say it in the docs | `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-14-dial-pane-follow.md`, `docs/specs/2026-11-14-dial-app-filter.md` | none | medium | none: no behavior |

Longest chain: 2 → 3 → 7 → 8 → 9: five tasks.

- Tasks 1, 2, 4, 5, 6 and 10 share no file and start at once.
- `services/devices.ts` and `devices.spec.ts` are shared by Tasks 7 and 8. Task 8 needs what Task 7 adds there: the reads' seam, `dialOn`, the `orca` part and the spec's fakes.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/orca.ts`, `select.ts`, `observed.ts`, `cli/src/cable/cableHost.ts`, `cableSession.ts` | **Devices service process**, and only there | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/e2e/dialOrcaFocus.e2e.ts`, `cli/e2e/harness/fakeOrca.ts`, `cli/e2e/harness/daemon.ts`, `cli/e2e/dialPaneFollow.e2e.ts` | Test: the real daemon, a fake dial, a fake front app, a fake `orca` | Verification 1 and 2 |
| The docs of Task 10 | Repo files, no process | none |

No file under `cli/src/core/` changes, and `cli/src/architecture.coreFiles.txt` gains no line.

## Before starting

- Where `cli/node_modules` is missing (a new worktree): `cd cli && npm ci` once.
- **The help fixture.** Orca 1.4.256's `orca terminal --help`, whole. Tasks 1 and 6 each keep a copy:
  ```
  orca terminal

  Usage: orca terminal <command> [options]

  Commands:
    list               List live Orca-managed terminals
    show               Show terminal metadata and preview
    read               Read bounded terminal output
    send               Send input to a live terminal
    wait               Wait for a terminal condition
    create             Create a terminal session in the current worktree
    switch             Switch to a terminal tab in the UI
    close              Close one terminal, its whole tab, or every terminal in a workspace
    rename             Set or clear the title of a terminal tab
    set-pane-title     Set or clear the title of one terminal pane
    split              Split an existing terminal pane

  Run `orca terminal <command> --help` for command-specific usage.
  ```
  The variant with `watch-focus` adds one line after `switch`'s: `  watch-focus        Print the focused terminal, then each change`. Its words after the command are made up (the upstream text is not known); only the command's own word is read.

## Global Constraints

- **The core does not change** (cli/AGENTS.md, Protect the core, rule 7). No rule, list or record for this goes into `cli/src/core/`.
- **Never the real Orca.** Every session here runs inside the Orca app on this Mac. No test, implementer or tester runs `orca terminal switch`, `send`, `watch-focus` or any other `orca` command against it.
  - A unit spec's `orca` is a recorded `run`, a fake child, or a script in a temp folder. A spec that uses the real `orcaDeps()` overrides `onPath` with its own script and `exists` with `() => false`.
  - An end-to-end daemon finds only the fake `orca` in its own `bin` (Task 6).
- **Fixtures are made up.** Handles are `term_00000000-0000-4000-8000-00000000000N`. Titles and paths are invented. Nothing read from a real Orca goes into a file.
- **The commands**, run with `execFile` or `spawn`, never a shell:
  - `orca terminal --help`: 10 s (`RUN_TIMEOUT_MS`).
  - `orca terminal list --json --include-visual-layouts`: 10 s. Its stdout is bounded by `execFile`'s 1 MiB default, and more fails the read.
  - `orca terminal watch-focus --json`: a child kept until stopped, stdin ignored, stderr drained and never logged.
- **Handles.** Every handle Orca prints is checked against `ORCA_HANDLE` (`/^term_[0-9a-f-]{36}$/`). No handle, title, path, agent id or name is in any log line.
- **Bounds.** A layout read keeps at most 64 worktrees, 256 handles and a depth of 32. A watch line over 512 bytes is dropped. A stopped watch gets SIGKILL 1 s after SIGTERM. At most 8 of the dial's Orca switches are kept, each for 2 s.
- **Order** (decided 1). Inside a worktree by group (`split`: `first`, then `second`), then tab (a group's `tabs`, in order), then pane (`pane-split`: `first`, then `second`). Worktrees in the order `visualLayouts` lists them. A member with no ranked handle comes after the ranked, in its ring order.
- **Only Orca's ring.** The single ring (a dial that does not say `appFilter`) and every other app's ring keep first-entry order. The 16-place rules do not change.
- **The dial keeps its agent.** A reorder moves places only. The agent the dial shows before it is the one it shows after it.
- **Push, not poll.** No timer and no retry in the devices for any of this. One `--help` per Orca binary (its real path and mtime). One read per change of the Orca ring's members, one at a time. One watch, started only at an Orca settle with a dial attached, stopped when the dial detaches. A watch that ends starts again only at Orca's next settle.
- **The log lines**, outcomes only:
  - `[device] focus · moved`, `[device] focus · skipped · echo`, `· unknown agent`, `· no tile`, `· not in front`
  - `[device] orca watch · started`, `· unsupported`, `· ended`
  - `[device] prompt · skipped · focus followed`
  - `[device] orca order · read`, `· failed`
- **Nothing is stored.** In memory only: the latest focused handle, up to 8 switches, the Orca rank (at most 256 ids), the probe's answer for one binary.
- **Nothing upstream.** No pull request or issue on Orca from this branch (decided 6). The pull request's text carries the spec's two follow-ups.
- **Platforms.** macOS: tests and the dial check. Linux X11: the same code, untested on a dial; the pull request says so. Windows: no front app, so no focus follow; the order applies wherever the Orca ring exists.
- **Repo rules.** No fixed sleeps. `src/services` stays at 100% per file. Comments say why. Names follow the Naming System.

## Review Focus

1. **A stdout chunk is not a line.** A watch line split across two chunks, two lines in one chunk, and a line that never ends must each do the right thing, and the buffer must not grow past 512 bytes. Task 1 (`a line split across chunks`, `a line over 512 bytes`).
2. **A stopped watch still has lines on the way, and a watch can die at once.** After a detach a late line moves nothing and is not kept. A child that exits as it starts (Orca closed, the binary gone) is `started`, then `ended`, and nothing starts again until Orca's next settle. Task 1 (`no line is told after stop`), Task 8 (`a late line of the old one moves nothing`, `a watch that ends by itself`).
3. **Two settles, or a detach, while `--help` runs.** At most one watch starts, and none is left running with no dial to stop it. Task 1 (`two asks at once are one run`), Task 8 (`a settle while the probe runs`, `a dial that detaches during the probe`).
4. **A reorder must move nothing.** The reordered ring is pushed and the dial's agent is said again. That focus must not start a rest, or Orca would be switched and print a focus line. Task 5 (`its echo starts no rest`), Task 9 (no `terminal switch` runs after the reorder).
5. **A layout from a large or newer Orca.** 300 terminals, a tree 40 deep, a handle named twice, a handle in another form, a node type this code does not know: bounded, no throw, and the branches it knows are still read. Task 1.
6. **The ring's members change while a read runs, or the dial detaches.** One more read follows, never two at once; none after a detach, and a late landing changes nothing. Task 7.
7. **Two sessions in one Orca terminal** (one ended, another started there). A focus line finds the live one heard from last, never the ended one. Task 4.

## Decided (PM for Diego, 2026-11-16)

The spec's "Decided" section holds each:

1. The order comes from `--include-visual-layouts`: group, then tab, then pane (`first`, then `second`). Worktrees in the layouts' order. Unranked agents after the ranked.
2. The layout is read once per change of the Orca ring's member set, one read at a time; a change during a read asks for one more. Only Orca's ring reorders. The agent the dial shows stays the one it shows, and that has its own test (Tasks 2, 5, 7, 9).
3. Focus watch: `orca terminal --help` lists `watch-focus`, asked once per Orca binary (real path and mtime). The watch starts when Orca settles in front with a dial attached, and is kept until the dial detaches. One that ends starts again only at Orca's next settle. Its first line is followed by the settle rule.
4. While the watch runs, a prompt in an agent with an Orca pane no longer moves the dial. An agent in a multiplexer inside Orca keeps the prompt follow. So does every Orca agent on an Orca without `watch-focus`.
5. The echo guard is the tab follow's: each handle the dial switched Orca to is kept 2 s, at most 8; a focus line for one is skipped and uses up that switch and those before it.
6. The upstream Orca proposal goes in Follow-ups only.

## Answered by the PM (2026-11-16)

1. **A dial that attaches while Orca is already settled in front: yes, the attach starts the watch** (Task 8, rule 1b).
   Was asked as: **A dial that attaches while Orca is already settled in front.** The spec starts the watch "when Orca settles in front" with a dial attached. A front app told again starts no settle (`AppFilter.front` drops a repeat). So a dial that attaches while Orca is already the settled front app (unplugged and plugged back in, say) has no watch until Orca settles again, which takes the person leaving Orca and coming back; until then a prompt still moves the dial. Should the attach itself start the watch when Orca is the settled front app (its first line followed by the settle rule)? The draft follows the spec's wording: only a settle starts it. A yes adds one call in `dialAttached(true)` and one test to Task 8.

## Decided here, where the spec was silent

- **Orca 1.4.256's node types**, read from its bundle on 2026-11-16: a group tree is `{ type: 'group', tabs }` or `{ type: 'split', first, second }`; a tab is `{ tabId, title, activeLeafId, panes }`; a pane tree is `{ type: 'terminal', handle, … }` or `{ type: 'pane-split', first, second }`. Any other `type` ends its branch.
- **`spawn` and `mtime` are typed on `OrcaReadDeps`, which extends `OrcaDeps`.** `orcaDeps()` returns it. The adapters keep `OrcaDeps`, so the five other specs that build one by hand do not change (the spec's words are "`OrcaDeps` gains").
- **The three reads come from one factory, `createOrcaReads(deps)`,** with the spec's names as its members. The probe's kept answer needs a home, and the devices' tests replace the object.
- **The probe keeps one answer,** the latest binary's. Two asks at once are one run. A binary whose stamp cannot be read answers false, runs nothing and keeps nothing.
- **`orcaTabOrder()` answers `[]`** for a run that printed JSON with no layout it knows, and `null` only for a run that failed or printed no JSON. A handle named twice keeps its first place. Depth counts from a layout's `root` (1); `first`, `second` and a tab's `panes` are each one deeper.
- **`watchOrcaFocus` with no binary, or a child that could not start,** answers a watch that has already ended. The devices drop it like any watch that ended.
- **`observed.byPane(adapter, id)` and `observed.paneOf(agentId, adapter)`** are the spec's `byOrcaPane(h)` and `orcaPaneOf(id)` with the adapter's id as a parameter: `observed.ts` holds no rule about any app (cli/src/services/AGENTS.md). `devices.ts` names `orca`.
- **The devices' test seam is the reads object** (`DevicesDeps.orcaReads`). Unset, the reads are built on `deps.orca`, so a spec's fake `orca` can never be passed by.
- **Everything Orca in the devices runs as its own guarded part, `orca`** (`part.call('orca', …)`), as the dial stream does: a throw there costs the dial nothing.
- **The Orca ring's members** are the agents of the registry's merged list whose `app` is `orca`, compared as a set of ids. An empty set asks for no read. A detach forgets the set, so the next attach asks. A read that lands after the detach is dropped.
- **`HARNESS_DEVICE_OBSERVED=off` switches all of it off:** with no observed source there is no Orca agent to rank or follow.
- **Log lines.**
  - `orca watch · unsupported` is said at each Orca settle that finds no `watch-focus`.
  - `orca watch · ended` is said once for every `started`, whether the watch was stopped or ended by itself.
  - A settle set aside because the dial moved within 2 s is `focus · skipped · echo`, as the Claude app's settle says `echo`.
  - `focus · skipped · not in front` is said only with a dial linked.
  - `prompt · skipped · focus followed` is the last check of `followPrompt`: a relayed prompt, the dial's own and one not in front keep their own lines.
- **The echo guard's clock** is the devices' monotonic clock at the moment a line is followed. It reuses `TAB_ECHO_MS` and `ECHO_KEPT`; the settle's window is `ATTACH_ECHO_MS`.
- **A first line that comes when Orca is no longer the settled front app** is kept and moves nothing, as any line.
- **`FollowCause` gains `focus` in Task 8,** with `FOLLOWED.focus`: apart, the type check fails.
- **Task 5 is a pin.** `syncAgentsNow` already says the dial's agent again after every ring push. The test passes before any change and holds the rule the reorder relies on.
- **One fake `orca` for the end-to-end suite** (`e2e/harness/fakeOrca.ts`). `dialPaneFollow.e2e.ts` moves onto it: its own fake notes every run, and the new reads would break its exact run counts.
- **Every end-to-end daemon gets an `orca` stub that exits 1,** beside the `gh`, `security` and `sudo` stubs. On a Mac a daemon with no `orca` on its `PATH` runs the Orca app's own, and from Task 7 on a listed Orca agent asks it for a list.
- **The new end-to-end file joins the nightly run with no workflow change:** the shards take every `e2e/**/*.e2e.ts`, and a file with no timing hint costs the default.
- **The docs task** is not in the spec. `cli/AGENTS.md` lists what the devices process does and keeps, and two older specs state rules this one changes.

---

### Task 1: Orca's three reads

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (outside text, bounded parsing, a child process and its kill).

**Red test:** `cli/src/cable/hosts/orca.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts`
- Test: `cli/src/cable/hosts/orca.spec.ts`

**Interfaces:**
- Produces, in `orca.ts`:
  ```ts
  /** A long-lived child of a read: stdin ignored, stderr drained and never read. */
  export interface OrcaChild {
    /** Its stdout as it comes. */
    onData(listener: (chunk: Buffer) => void): void
    /** Resolves once it has exited or could not start. Never rejects. */
    readonly exited: Promise<void>
    kill(signal: 'SIGTERM' | 'SIGKILL'): void
  }
  export interface OrcaReadDeps extends OrcaDeps {
    spawn(file: string, args: string[]): OrcaChild
    /** The binary's real path and that file's mtime; null when either cannot be read. */
    mtime(path: string): { realPath: string; mtimeMs: number } | null
  }
  export function orcaDeps(): OrcaReadDeps
  export interface OrcaFocusWatch {
    /** SIGTERM, then SIGKILL after 1 s if it has not gone. No line is told after it. */
    stop(): void
    /** Resolves once the child has gone, stopped or by itself. */
    readonly ended: Promise<void>
  }
  export interface OrcaReads {
    orcaWatchesFocus(): Promise<boolean>
    /** The terminals' handles in tab order; null when the read failed. */
    orcaTabOrder(): Promise<string[] | null>
    watchOrcaFocus(onHandle: (handle: string | null) => void): OrcaFocusWatch
  }
  export function createOrcaReads(deps: OrcaReadDeps): OrcaReads
  ```
- Rules:
  - `orcaBinary` moves out of `createOrcaActions` to one function both the actions and the reads use. The adapter does not change.
  - `orcaWatchesFocus`: runs `[orca, ['terminal', '--help'], RUN_TIMEOUT_MS]`. True when a line of the `Commands:` list (the lines after `Commands:` up to the first empty line) has `watch-focus` as its first word. The answer of a run that exited 0 is kept under the binary's `realPath` and `mtimeMs`. Any other run is false and is not kept.
  - `orcaTabOrder`: runs `['terminal', 'list', '--json', '--include-visual-layouts']`. Reads `result.visualLayouts` by the Global Constraints' order and bounds.
  - `watchOrcaFocus`: spawns `['terminal', 'watch-focus', '--json']`. A line is `{"handle":"term_…"}` or `{"handle":null}`; anything else is dropped.
  - The real `spawn` uses `stdio: ['ignore', 'pipe', 'pipe']` and resumes stderr. The real `mtime` is `realpathSync`, then `statSync`.

- [ ] **Step 1: Write the failing tests** in three new describes. Fixtures, at the top of the spec:
  ```ts
  const H = (n: number) => `term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const leaf = (n: number) => ({ type: 'terminal', handle: H(n), tabId: 't', leafId: `l${n}`, title: 'made up', connected: true, active: false })
  const panes = (first: unknown, second: unknown) => ({ type: 'pane-split', direction: 'horizontal', first, second })
  const tab = (tree: unknown) => ({ tabId: 't', title: 'made up', activeLeafId: 'l', panes: tree })
  const group = (...tabs: unknown[]) => ({ type: 'group', groupId: 'g', activeTabId: 't', tabs })
  const split = (first: unknown, second: unknown) => ({ type: 'split', direction: 'vertical', first, second })
  const listed = (...roots: unknown[]) => JSON.stringify({ id: 'x', ok: true, result: { terminals: [],
    visualLayouts: roots.map((root, i) => ({ worktreeId: `w${i}`, worktreePath: `/made/up/${i}`, root })), totalCount: 0, truncated: false } })
  ```
  `HELP` and `HELP_WATCH` are the help fixture and its variant ("Before starting").
  `reads(over)` builds `createOrcaReads` on the file's recording `run`, with `mtime: () => ({ realPath: '/fake/bin/orca', mtimeMs: 1 })` and a `fakeChild()` whose test writes chunks, ends it and reads its kills.
  - `describe('whether Orca watches focus')`:
    - `true when the Commands list names watch-focus, false for 1.4.256's help`: the one run is `['terminal', '--help']`, 10 000 ms.
    - `only a command's own word counts`: `watch-focus` in another command's description, or in the last line outside the list, is false.
    - `kept per binary: asked again it runs nothing; a new mtime, or another real path, runs it again`.
    - `a run that failed or timed out is false and is asked again` (codes 1 and `null`).
    - `two asks at once are one run`.
    - `no orca binary, or one whose stamp cannot be read, is false and runs nothing`.
    - `the real stamp is the file a symlink points at, and its mtime` (a script and a symlink in the temp folder, `utimesSync`).
  - `describe("Orca's tab order")`:
    - `groups, splits of groups, tabs and pane splits, first then second; worktrees as listed`: `listed(split(group(tab(leaf(1)), tab(panes(leaf(2), panes(leaf(3), leaf(4))))), group(tab(leaf(5)))), group(tab(leaf(6))))` answers `[H(1), H(2), H(3), H(4), H(5), H(6)]`, from the one run `['terminal', 'list', '--json', '--include-visual-layouts']`, 10 000 ms.
    - `a node type it does not know, a split with no second, a tab with no panes: that branch has no handles and the rest are read`.
    - `a handle in another form is left out; one named twice keeps its first place`.
    - `no visualLayouts, or one that is no array, is no handles`: `[]`, not `null`.
    - `the bounds`: 70 worktrees keep the first 64; 300 leaves keep 256; a pane tree 40 deep keeps the leaves down to depth 32; nothing throws.
    - `a failed read is null`: a non-zero exit, a timeout, no binary, a stdout that is no JSON.
    - `a stdout over 1 MiB fails the read`: the real `orcaDeps().run` on a script that prints 1.1 MiB.
  - `describe("Orca's focus watch")`:
    - `spawns terminal watch-focus --json and tells each line's handle, null for none`.
    - `a line split across chunks is one line, and two lines in a chunk are two`.
    - `a line over 512 bytes is dropped, whole or still growing, and the next line is told`: 4 KiB with no newline in 100-byte chunks, then `\n{"handle":null}\n`; exactly one `null` is told.
    - `a line that is no JSON, no object, has no handle, or a handle in another form is dropped`.
    - `stop sends SIGTERM, then SIGKILL after 1 s when the child has not gone; a child that went gets no SIGKILL` (fake timers).
    - `no line is told after stop`.
    - `ended resolves when the child exits by itself, and when it could not start; with no binary nothing is spawned and it has ended`.
    - `the real child: a script's lines arrive, its stderr does not stall it, and stop ends it`: a script that writes 200 KiB to stderr, prints two lines, then sleeps.
    - `the real child deaf to SIGTERM is killed` (`trap '' TERM`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/orca.spec.ts`. Expected: FAIL, `createOrcaReads` is not exported; the file's older tests pass.
- [ ] **Step 3: Implement.** The comment over the reads says why each bound is there: Orca's output is outside text, and its stderr can name paths.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck && npx vitest run src/cable/hosts`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: Orca's CLI is read for watch-focus, its tab order and its focused pane`.

### Task 2: A ring takes a rank

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/select.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/select.ts`
- Test: `cli/src/cable/hosts/select.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  /** A place per agent id in its app's own order (Orca's tabs). One object per read that landed: told apart by identity. */
  export type RingRank = ReadonlyMap<string, number>
  class DialRing { select(agents: HostAgent[], rank?: RingRank): { rows: HostAgent[]; total: number } }
  class AppRings { update(agents: HostAgent[], ranks?: ReadonlyMap<string, RingRank>): void }
  ```
- Rules:
  - Who is in the ring is decided as today. The rank only says where.
  - After that, when a rank is given and either the ring's set of ids differs from the last pass's or the rank is another object than the last pass's: the ranked rows by place, equal places in ring order, then the unranked in ring order. The ring keeps that order.
  - Otherwise, and with no rank, the order is today's.
  - `AppRings.update` gives each app's ring `ranks?.get(app)`.

- [ ] **Step 1: Write the failing tests.**
  - In `describe('DialRing')`:
    - `a rank orders the ring when its members change: the ranked by place, the unranked after them in ring order`.
    - `a new rank object orders the ring again; the same object does not, whatever it holds by then` (the same `Map`, changed between two passes, moves nobody).
    - `with the same members and the same rank the ring holds still: states, activity and the registry's order move nobody`.
    - `the agent the dial shows keeps its row through a reorder` (decided 2): every row before is a row after, once, the same object the pass was given, and only its place differs.
    - `equal places keep their ring order`.
    - `a full ring with a rank: the 16-place rules say who is in it, the rank only where`: 16 ranked, then a 17th that needs the person takes the place of the one idle the longest and stands at its own rank's place.
  - In `describe('AppRings')`: `a rank for one app orders that ring only`: with `new Map([['orca', rank]])`, `ring('orca')` is in rank order and `ring('ghostty')` in first-entry order.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/select.spec.ts`. Expected: FAIL in the new tests only.
- [ ] **Step 3: Implement.** Extend the class comment: a fixed ring was first-entry order; with a rank it is the app's own order, still fixed between two ranks.
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS, the older tests unchanged.
- [ ] **Step 5: Commit** `dial: a ring takes a rank, and holds still between two`.

### Task 3: The host hands an app's rank to its ring

**Layer:** devices service process. **Depends on:** Task 2. **Effort:** `medium`.

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts`
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `RingRank`, `AppRings.update(agents, ranks)` (Task 2).
- Produces, on `DaemonCableHost`, beside `setRegistry`:
  ```ts
  /** That app's own order, for its ring alone. It reaches the dial on the session's next list, as any ring change. */
  setRank(app: string, rank: RingRank): void
  ```
  `appList` passes the ranks it holds to `rings.update`. The single ring (`this.ring.select(listed)`) gets none.

- [ ] **Step 1: Write the failing tests** in `describe('the dial that shows one app at a time')`, with its `setup`, `agent` and `ids`, over `[agent('o1', 'orca'), agent('g1', 'ghostty'), agent('o2', 'orca'), agent('o3', 'orca'), agent('g2', 'ghostty')]`:
  - `a rank for Orca orders Orca's ring at the next read; the single ring and another app's ring keep first-entry order`: after `host.setRank('orca', new Map([['o3', 0], ['o1', 1], ['o2', 2]]))`, `ids(await host.listAgentSnapshot({ apps: true }))` is `['o3', 'o1', 'o2']`; `ids(await host.listAgentSnapshot())` is `['o1', 'g1', 'o2', 'o3', 'g2']`; after `host.pickApp('ghostty')` the ring is `['g1', 'g2']`.
  - `the same rank read again moves nobody, and a new rank reorders`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts -t "one app at a time"`. Expected: FAIL, `setRank` is not a function.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the host hands an app's rank to its ring`.

### Task 4: An agent by its pane

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Produces, on `ObservedSource`, beside `byTab`:
  ```ts
  /** The live agent with that adapter's pane of that id: of two, the one heard from last. */
  byPane(adapter: string, id: string): HostAgent | undefined
  /** A live agent's pane id in that adapter; none when it has no pane there, or its session ended. */
  paneOf(agentId: string, adapter: string): string | undefined
  ```
  Both read `Entry.panes` (`pane.adapter`, `pane.id`) and name no app.

- [ ] **Step 1: Write the failing tests** beside the `byTab` test, with the file's `fakeActions`, `setup` and `HANDLE`:
  - `byPane: the live agent whose pane of that adapter has that id, the one heard from last of two, none for another adapter, an ended session or an unknown id`: sessions `a` and `b` both say `ORCA_TERMINAL_HANDLE: HANDLE`, `b` a second later: `byPane('orca', HANDLE)` is `b`; after `a`'s `turn-start` it is `a`; `byPane('tabs', HANDLE)` and `byPane('orca', OTHER)` are undefined; after both `session-end` it is undefined.
  - `a session ended in an Orca terminal and another started there: the pane is the live one's`.
  - `paneOf: a live agent's pane id of that adapter; none for an agent in tmux inside Orca, another adapter, an ended session or an unknown agent`: `paneOf(id, 'orca')` is `HANDLE`; with `{ TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: HANDLE }` it is undefined.
  - `a session resumed in another Orca terminal is found by its new handle alone`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "byPane|paneOf|resumed in another Orca|another started there"`. Expected: FAIL, `byPane` is not a function.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/scannedApp.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: an observed agent is found by its pane, and its pane by the agent`.

### Task 5: Pin: a ring sent in another order leaves the dial on its agent

**Layer:** test. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior. `syncAgentsNow` already says the dial's agent again after every ring push; this test holds that for a reorder (decided 2). It passes at the base.

**Files:**
- Test: `cli/src/cable/cableSession.spec.ts`

- [ ] **Step 1: Write the test** `the shown app's ring sent again in another order: the dial is told its agent again, its echo starts no rest, and the host hears no other agent`, in `describe('the app filter')`, with `appHost`, and the clock faked after the greeting as `resting` does (`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`):
  - The host has `swipeSwitches: () => true`, a `swipeEnded` spy and a `dialShows` spy. The dial says `appFilter` and turns to `g2` by hand; its rest is let run (`swipeEnded` is `[['g2', 'rest']]`).
  - `state.rings.ghostty` becomes `[row('g3', 'ghostty'), row('g1', 'ghostty'), row('g2', 'ghostty')]`, and the list is pushed (`session.syncAgents(true)`).
  - The `agent` frames since are `g3`, `g1`, `g2`, in that order.
  - The `focus` frames since are `['g2']`, sent after `agents.end`.
  - The dial echoes `{ t: 'focus', agentId: 'g2' }`. After `SWIPE_REST_MS` more, `swipeEnded` still has its one call.
  - `dialShows` was told `{ name: 'g2', app: 'Ghostty' }` once, and nothing since.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "sent again in another order"`. Expected: PASS. If it fails, stop and report it: the reorder then needs a change the spec does not have.
- [ ] **Step 3: Commit** `test(dial): a ring sent in another order leaves the dial on its agent`.

### Task 6: One fake `orca` for the end-to-end daemons

**Layer:** test. **Depends on:** none. **Effort:** `high`.

**Red test:** none: no behavior (test files only).

**Files:**
- Create: `cli/e2e/harness/fakeOrca.ts`
- Modify: `cli/e2e/harness/daemon.ts`, `cli/e2e/dialPaneFollow.e2e.ts`

**Interfaces:**
- Produces, in `fakeOrca.ts`:
  ```ts
  export interface OrcaRun { args: string; at: number }
  /** A tab's panes, first to last: one handle is a leaf, more are pane splits (`first`, then `second`). */
  export type FakeTab = string[]
  export class FakeOrca {
    /** Writes `orca` into the daemon's `bin`, first on its PATH, before `d.start()`. `watchFocus` (default false): its
     *  `terminal --help` lists `watch-focus`, and `terminal watch-focus --json` runs. */
    static install(d: IsolatedDaemon, options?: { watchFocus?: boolean }): FakeOrca
    /** The `terminal switch` and `terminal send` runs. */
    runs(): OrcaRun[]
    /** Every run's arguments, the reads' too, in the order they started. */
    asked(): string[]
    /** `terminal switch` and `terminal send` exit 1 from now on. */
    refuse(): void
    /** What `terminal list` prints from now on: one worktree per entry, its tabs in the strip's order. Until then it exits 1. */
    layout(worktrees: FakeTab[][]): void
    /** A line on the watch's stdout: the terminal with focus, or none. A watch prints every line told so far, then each new one. */
    focus(handle: string | null): void
    /** Whether a `watch-focus` of this fake still runs: a process whose command names its focus file. */
    watching(): boolean
  }
  ```
- The script, with `<dir>` as `<d.root>/orca`:
  ```sh
  #!/bin/sh
  printf '%s\n' "$*" >> '<dir>/asked'
  case "$1 $2" in
    'terminal --help') cat '<dir>/help' ;;
    'terminal list') [ -f '<dir>/layout.json' ] || exit 1; cat '<dir>/layout.json' ;;
    'terminal watch-focus') [ -f '<dir>/watches' ] || exit 1; exec tail -n +1 -f '<dir>/focus' ;;
    'terminal switch'|'terminal send')
      printf '%s' "$*" > "$(mktemp '<dir>/runs/run.XXXXXX')"
      code=$(cat '<dir>/exit' 2>/dev/null); exit "${code:-0}" ;;
    *) exit 1 ;;
  esac
  ```
  - `exec tail -n +1 -f` makes the daemon's child the `tail` itself, so its SIGTERM ends it, and a line told before the watch starts is not lost.
  - `help` is the help fixture ("Before starting"), its variant for `watchFocus`.
  - `layout` writes `{ id, ok: true, result: { terminals: [], visualLayouts, totalCount, truncated: false } }` in Orca 1.4.256's shapes (`group`, `terminal`, `pane-split`), with made-up ids, titles and `worktreePath` `/e2e/wt-N`.
- `daemon.ts`: beside the `gh`, `security` and `sudo` stubs, `await writeFile(join(dirs.bin, 'orca'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })`. Its comment: on a Mac a daemon with no `orca` on its `PATH` runs the Orca app's own, and a listed Orca agent asks it for a list.
- `dialPaneFollow.e2e.ts`: its `fakeOrca` string, `runsDir`, `exitFile` and `Run` go. `fresh` calls `FakeOrca.install(d)` before `d.start()` and returns its `runs` and `refuse`. No test's assertions change.

- [ ] **Step 1: Write** `fakeOrca.ts`, the stub line and the change to `dialPaneFollow.e2e.ts`.
- [ ] **Step 2: Run**, on this Mac: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFollow.e2e.ts e2e/dialStream.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS, every test as before.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/testing`. Expected: PASS (the specs that read `e2e/harness/daemon.ts`).
- [ ] **Step 4: Commit** `e2e: one fake orca, and no daemon under test finds the developer's`.

### Task 7: Orca's ring follows Orca's tabs

**Layer:** devices service process. **Depends on:** Tasks 1, 3 and 4. **Effort:** `xhigh` (one read at a time with a change during it; what starts and stops with the dial; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `OrcaReads`, `OrcaReadDeps`, `createOrcaReads` (Task 1); `DaemonCableHost.setRank` (Task 3); `ObservedSource.paneOf` (Task 4).
- Produces, in `devices.ts`:
  - `DevicesDeps.orca?: OrcaReadDeps`, and `DevicesDeps.orcaReads?: OrcaReads` ("For this service's tests: Orca's focus and order reads (cable/hosts/orca.ts); built on `orca` when unset").
  - `const orcaReads = deps.orcaReads ?? createOrcaReads(apps)`.
  - `let dialOn = false`, set first in `dialAttached(on)`.
  - A guarded part `orca`: every entry below runs through `part.call('orca', …)`.
- Rules, all behind `observed` (the kill switch) and `dialOn`:
  1. The members are checked on each `observed.onChange` and as a dial attaches: the ids of `registry.entries()` whose `agent.app` is `'orca'`, as a set.
  2. The same set as the last check: nothing. An empty set: kept, no read. Another set: a read is asked.
  3. A read asked while one runs is noted, once. Otherwise `orcaReads.orcaTabOrder()` runs.
  4. A read lands:
     - The dial detached meanwhile: dropped, and nothing more is asked.
     - `null`: `[device] orca order · failed`, and the rank is kept.
     - Handles: `[device] orca order · read`; a new `Map` gives each member now listed, whose `observed.paneOf(id, 'orca')` is among the handles, that handle's index; `cableHost.setRank('orca', rank)`.
     - Then, when one more was noted, it runs.
  5. A detach forgets the member set and the noted read.
  6. Nothing is pushed: the dials read the reordered ring on their next list.
- Produces, in `devices.spec.ts`, beside the `herdr` fake, for Task 8 too:
  ```ts
  /** Orca's reads for every spec but Orca's own: nothing lands, so no other spec hears of an order or a watch. */
  const inertOrcaReads: OrcaReads
  /** Orca's reads, driven by the spec: the probe's answer and how often it was asked, each order read held until the
   *  spec lands it, and each watch with its lines, its end and whether it was stopped. */
  function fakeOrcaReads(over?: { watches?: boolean }): {
    reads: OrcaReads
    probes: { count: number }
    orders: Array<(handles: string[] | null) => void>
    watches: Array<{ line(handle: string | null): void; end(): void; stopped: boolean }>
  }
  ```
  - `start()` takes `over.orcaReads` and passes `over.orcaReads ?? inertOrcaReads`. The two direct `startDevices` calls that list an Orca agent pass `inertOrcaReads` too.
  - The shared `orca` fake gains an inert `spawn` and `mtime: () => null`, for its type alone.
  - `inertOrcaReads`: `orcaWatchesFocus` and `orcaTabOrder` never settle; `watchOrcaFocus` throws.

- [ ] **Step 1: Write the failing tests** in a new `describe("Orca's ring follows Orca's tabs (docs/plans/2026-11-16-dial-orca-focus-order-design.md)")`. Its `H(n)` is Task 1's. `hook(n, over)` is Claude Code in Orca terminal `n` (`{ ORCA_AGENT_SESSION_ID: 'orca-1', ORCA_TERMINAL_HANDLE: H(n), __CFBundleIdentifier: 'com.stablyai.orca' }`), and `agent(n)` its id. `dialWith(n)` starts with `faults: ['fleet']` and `orcaReads: fake.reads`, lists `n` sessions, attaches the dial with no window, and returns the fake. `ring()` is `(await host().listAgentSnapshot({ apps: true })).agents.map((a) => a.id)`.
  - `with a dial attached, an agent entering Orca's ring asks for one read, and its landing puts the ring in tab order`: three sessions, `fake.orders` has 1; landed with `[H(3), H(1), H(2)]`, `ring()` is `[agent(3), agent(1), agent(2)]` and the log has `[device] orca order · read`.
  - `a change during a read asks for one more after it lands, never two at once`: sessions 2 and 3 arrive while the first read runs: `fake.orders` stays 1 until it lands, then is 2, and stays 2 once that one lands.
  - `the same members ask for nothing: a turn, a prompt, a state change`.
  - `an agent leaving Orca's ring asks for one read` (session 2 says `{ TERM_PROGRAM: 'ghostty' }`).
  - `a failed read keeps the ring as it was and says so; the next change asks again`.
  - `an agent no layout names, and one in tmux inside Orca, come after the ranked, in ring order`.
  - `only Orca's ring: the single ring and another app's ring keep first-entry order`.
  - `the agent the dial shows is still in the ring after the reorder, and nothing is asked of the dial or of Orca`: `turnTo(agent(1))`, land `[H(3), H(1), H(2)]`: `ring()` holds `agent(1)`; `calls('followLocal')`, `calls('followApp')` and `orcaRuns` are as before the landing.
  - `with no dial attached nothing is read; attaching asks for one; detaching and attaching again asks again`.
  - `a read that lands after the dial detached changes nothing and asks for no other`.
  - `no Orca agent: nothing is read`.
  - `HARNESS_DEVICE_OBSERVED=off: nothing is read`.
  - `an orca part that throws costs the dial nothing` (`faults: ['fleet', 'orca']`): the agents are listed, and nothing is read.
  - `the reads are built on the orca given when none is given`: `startDevices` with the shared `orca` and no `orcaReads`, a dial attached and one session: `orcaRuns` holds `['/opt/orca/bin/orca', ['terminal', 'list', '--json', '--include-visual-layouts'], 10_000]`.
  - `no line holds a handle or an agent`: every `[device] orca order` line is `read` or `failed`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new describe only.
- [ ] **Step 3: Implement.** The comment over the order says why it is read at a member change and never polled (decided 2).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, the core's file list unchanged.
- [ ] **Step 5: Commit** `dial: Orca's ring follows Orca's tabs`.

### Task 8: The dial follows the pane focused in Orca

**Layer:** devices service process. **Depends on:** Tasks 1, 4 and 7. **Effort:** `xhigh` (a child process's life, a probe that races a settle and a detach, an echo guard; the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/cable/cableSession.ts` (`FollowCause` and its comment, nothing else)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `orcaReads`, `dialOn`, the `orca` part, `fakeOrcaReads` (Task 7); `watchOrcaFocus`, `orcaWatchesFocus` (Task 1); `ObservedSource.byPane`, `paneOf` (Task 4).
- Produces:
  - `cableSession.ts`: `export type FollowCause = 'prompt' | 'tab' | 'attach' | 'focus'`.
  - `devices.ts`: `FOLLOWED.focus` is `{ moved: '[device] focus · moved', 'no-tile': '[device] focus · skipped · no tile' }`.
  - The Orca adapter in `adapters` is wrapped as the Claude app's is: its `show` and its `focus` keep `pane.id` with the clock's time as they start, then run as before. `noting` still wraps it. Kept: the last `ECHO_KEPT`, each for `TAB_ECHO_MS`.
- Rules, all behind `observed`, each entry through `part.call('orca', …)`:
  1. **Orca settles** (`appSettled('orca')`, guarded on its own beside the Claude app's and the tab's), a dial attached:
     - A watch runs: its latest handle is followed by the settle rule (4).
     - A probe runs: nothing.
     - Otherwise `orcaReads.orcaWatchesFocus()`. When it lands with the dial detached or a watch running: nothing. False: `[device] orca watch · unsupported`. True: the watch starts and `[device] orca watch · started` is said.
  1b. **A dial attaches** (`dialAttached(true)`) while Orca is the settled front app (`cableHost.settledApp() === 'orca'`): the same as rule 1, so the watch's first line is followed by the settle rule.
  2. **A line** of the running watch (a line of any other watch is dropped): the handle is kept as the latest. `null` moves nothing. With another app settled in front: `[device] focus · skipped · not in front` when a dial is linked, and nothing moves. Otherwise it is followed: the watch's first line by the settle rule (4), every later one by rule 3.
  3. **Follow a handle:**
     - No dial linked (`cable.isConnected`): nothing, and no line.
     - A kept switch of that handle within 2 s: `[device] focus · skipped · echo`; that switch and those before it are used up.
     - `observed.byPane('orca', handle)` finds none: `[device] focus · skipped · unknown agent`.
     - Otherwise `cable.followLocal(agent.id, 'focus')`.
  4. **The settle rule:** no latest handle, or `null`: nothing. The dial moved within `ATTACH_ECHO_MS` (`dialMovedAt`): `[device] focus · skipped · echo`. Otherwise rule 3.
  5. **A prompt** (`followPrompt`, its last check): with a watch running and `observed.paneOf(agentId, 'orca')` defined: `[device] prompt · skipped · focus followed`, and nothing is asked.
  6. **The dial detaches** (the devices stopping too): a running watch is stopped and dropped, `[device] orca watch · ended` is said, and the latest handle and the kept switches are dropped.
  7. **The watch ends by itself:** dropped with its latest handle, `[device] orca watch · ended`. Nothing starts until Orca's next settle.

- [ ] **Step 1: Write the failing tests** in a new `describe('the dial follows the pane focused in Orca (docs/plans/2026-11-16-dial-orca-focus-order-design.md)')`, with Task 7's `H`, `hook` and `agent`. `dialWith({ watches, agents })` uses fake timers, a `fakeListener`, `now: () => clock` and `orcaReads: fake.reads`; it lists the sessions and attaches a dial with no window. `settle(app)` and `unlinked(off)` are written as the tab describe's are. `asked()` is `calls('followLocal')`. `focusLines()` are the log's `[device] focus` lines, `watchLines()` its `[device] orca watch` lines.
  - The watch's life:
    - `Orca's settle with a dial attached asks the CLI and starts one watch; a second settle starts no other`: `watchLines()` is `['[device] orca watch · started']`, `fake.watches` has 1, and `fake.probes.count` is 1 after both.
    - `a CLI without watch-focus starts none, says unsupported, and is asked again at the next settle`.
    - `with no dial attached, and for another app's settle, nothing is asked`.
    - `a dial that attaches while Orca is already the settled front app asks the CLI and starts the watch, its first line followed by the settle rule; one that attaches with another app in front starts none`.
    - `a settle while the probe runs starts nothing more; a dial that detaches during the probe gets no watch`.
    - `the dial detaching stops the watch and drops its pane: a late line of the old one moves nothing, and the next settle starts a new one`: `fake.watches[0].stopped` is true; `watchLines()` is `started`, `ended`, `started`.
    - `a watch that ends by itself is dropped and says ended; nothing starts until Orca settles again, and a prompt in Orca moves the dial again meanwhile`.
    - `the devices stopping stops the watch`.
  - Following:
    - `the watch's first line is followed as the settle: the dials are asked to follow that pane's agent, as a focus follow`: `asked()` is `[[agent(2), 'focus']]` and `focusLines()` is `[]`.
    - `a later line with Orca in front asks the dials to follow`.
    - `the dial's answer is counted: focus · moved, and focus · skipped · no tile` (`seen.host.localFollowed!('focus', …)`).
    - `a line with another app in front moves nothing, counted not in front, and Orca's next settle follows it`.
    - `a null line is kept and moves nothing: the settle after it follows nothing`.
    - `a pane no listed agent holds is skipped as unknown agent`.
    - `no dial linked: nothing is followed or counted, in front or not` (`unlinked(true)`).
  - The echo guard:
    - `a rest's switch is the dial's echo: a line for that pane within 2 s is skipped once`: `host().swipeEnded(agent(2), 'rest')`, then `H(2)` at `clock = 1_999` is `[device] focus · skipped · echo` and asks nothing; `H(2)` again asks; a rest and its line at 2 000 ms asks.
    - `a tap's switch is its echo too` (`host().openAgent(agent(2))`).
    - `a line for a pane switched before the latest switch is still an echo, and uses up those before it`.
    - `of nine switches the oldest is forgotten`.
    - `the settle is set aside right after the dial moved, counted echo, and follows 2 s later`: `turnTo(agent(1))`, Orca settles, the first line `H(2)`: `[device] focus · skipped · echo`; at `clock = 2_000` Orca settling again (after another app: a front told again starts no settle) asks `[[agent(2), 'focus']]`.
  - The prompt:
    - `while the watch runs, a prompt in an agent with an Orca pane asks nothing, counted focus followed`.
    - `one in tmux inside Orca still asks` (`{ TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: H(3), __CFBundleIdentifier: 'com.stablyai.orca' }`).
    - `with a CLI without watch-focus a prompt in Orca asks as before`.
    - `a relayed prompt, the dial's own and one not in front keep their own lines while the watch runs`.
  - The rest:
    - `HARNESS_DEVICE_OBSERVED=off: no probe and no watch`.
    - `an orca part that throws costs the dial nothing` (`faults: ['fleet', 'orca']`): a prompt in Orca still asks.
    - `no line holds a handle or an agent`: every `focusLines()` entry matches `/^\[device\] focus · (moved|skipped · (echo|unknown agent|no tile|not in front))$/`, and the log holds no `H(n)`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new describe only.
- [ ] **Step 3: Implement.** The comment over the focus follow says what it replaces (a prompt was the only signal: #4311) and why a prompt is set aside while the watch runs (decided 4).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `dial: the dial follows the pane focused in Orca`.

### Task 9: End to end, on a fake `orca`

**Layer:** test. **Depends on:** Tasks 6, 7 and 8. **Effort:** `high`.

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 1 to 8 built).

**Files:**
- Create: `cli/e2e/dialOrcaFocus.e2e.ts`

**Interfaces:**
- Consumes: `FakeOrca` (Task 6); `IsolatedDaemon`, `until`, `Desk`, `FakeDial`, `InOrca`; the shapes of `fresh`, `inOrca`, `listed`, `front`, `said`, `typedUntilMoved` and `turnedToFirst` in `dialPaneFollow.e2e.ts`.

- [ ] **Step 1: Write the tests.** Each has a daemon of its own (`CABLE_DISABLE: 'false'`), `FakeOrca.install` before it starts, and a dial that says `{ appFilter: 'v1' }`. The app in front is a line on the stdin of the real `harness hardware watch --json`. Every wait is `until`, `said` or `dial.next`.
  - `with watch-focus: Orca settling in front moves the dial to the focused pane, a focus change moves it again, and neither its own switch nor a prompt does`:
    1. `watchFocus: true`. Sessions A and B in Orca terminals, `orca.layout([[[a.handle], [b.handle]]])`, both listed. `orca.focus(b.handle)`, then Orca in front.
    2. The dial hears `focus` for B. The log has `[device] orca watch · started` and one `[device] focus · moved`.
    3. `orca.focus(a.handle)`: the dial hears `focus` for A; two `moved`. The dial reports the tile it centred (`{ t: 'focus', agentId: a.id }`).
    4. The dial turns to B by hand: `[device] swipe · ok`, and `orca.runs()` holds one `terminal switch --terminal <b> --json`. Then `orca.focus(b.handle)`, Orca's echo: `[device] focus · skipped · echo`; still two `moved`.
    5. A's hook `UserPromptSubmit`: `[device] prompt · skipped · focus followed`; the dial hears no `focus` for A since step 4.
    6. `orca.asked()` holds `terminal --help` once and `terminal watch-focus --json` once.
    7. The dial is unplugged: `[device] orca watch · ended`, then `orca.watching()` is false.
    8. Every `[device] focus` line matches Task 8's pattern. The log holds no handle, no session id and no `/e2e/wt-`.
  - `Orca's ring reaches the dial in tab order, and the dial stays on the agent it shows`:
    1. `watchFocus: true`. Handles for A, B and C; `orca.layout([[[c.handle], [a.handle, b.handle]]])`: C's tab first, then a tab split into A and B.
    2. A and B listed. The dial turns to A by hand: `[device] swipe · ok`.
    3. C starts. The dial's latest list (the `agent` frames between its last `agents.begin` and `agents.end`) becomes C, A, B. The log has `[device] orca order · read`.
    4. Every `focus` the dial heard since C started names A, and one comes after that list's `agents.end`.
    5. `orca.runs()` is still A's one switch.
  - `without watch-focus (Orca 1.4.256): no watch runs, and a prompt still moves the dial`:
    1. `watchFocus: false`. A and B listed, the dial turned to A, Orca in front.
    2. `typedUntilMoved(d, dial, b)`: one `[device] prompt · moved`.
    3. The log has `[device] orca watch · unsupported`, no `· started` and no `[device] focus` line. `orca.asked()` holds no `terminal watch-focus`.
- [ ] **Step 2: Run**, on this Mac: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts`. Expected: PASS. Then `pgrep -fl 'tail -n \+1 -f'` names no process under the run's temp folder.
- [ ] **Step 3: Commit** `e2e: the dial follows Orca's focus and tabs, on a fake orca`.

Nothing registers the file: `vitest.e2e.config.ts` finds `e2e/**/*.e2e.ts`, and a file with no hint in `cli/ci-e2e-durations.json` costs the default.

### Task 10: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-14-dial-pane-follow.md`, `docs/specs/2026-11-14-dial-app-filter.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table:
    - what it runs: Orca's ring in Orca's tab order, read from `orca terminal list --include-visual-layouts` at each change of its members; where Orca's CLI has `watch-focus`, one `orca terminal watch-focus` child while a dial is attached, and the dial follows the pane focused in Orca;
    - what it keeps in memory: the pane focused in Orca, its own Orca switches of the last 2 s, and Orca's tab order.
  - `cli/src/services/AGENTS.md`, the devices bullet: an app's own reads (its focused pane, its tab order) live in its adapter's file under `src/cable/hosts/` and are named once in `src/services/devices.ts`; `observed.ts` finds an agent by a pane and names no app.
  - `docs/specs/2026-11-14-dial-pane-follow.md`, at "No loop. Orca reports no pane focus": one sentence that points at `docs/plans/2026-11-16-dial-orca-focus-order-design.md`, where a focus line is followed and the dial's own switch is its echo.
  - `docs/specs/2026-11-14-dial-app-filter.md`, at "each app keeps its own fixed order": one sentence that points at the same design, where Orca's ring takes Orca's tab order.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the dial follows Orca's focused pane and tab order`.

---

## Verification

**Platforms the pull request names:** the daemon on macOS and Linux. Tested: the unit specs on Linux in PR CI and on this Mac; check 1 on this Mac and on Linux runners; the dial check on macOS. Linux X11: the same code, untested on a dial. Windows: no front app, so no focus follow; the order's code runs there and no check here covers it.

**Never touched:** Diego's Orca app (no `orca` command is run against it, and no pane is switched or typed into), his everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial (but for check 5, which he runs himself), any backend, production.

**Temporary workflow:** none. The one long check is the CLI's end-to-end suite, which has its own workflow (`.github/workflows/cli-e2e.yml`). The new file joins its nightly run with no workflow change.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named. It is the one gate the repo requires for these paths (`docs/validation-and-release.md`, "What PR CI does not run").
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`, and `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing: the core is unchanged.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit (it selects `cli-core`). Its fence goes in the pull request's body before the push it describes.
- Not needed: `npm run test:harnessd` and the other coverage gates, the serial and PTY specs (`cable/serial*.ts` is untouched), `cargo test` in `device-app`, Desktop tests, firmware checks.

**1. A fake `orca` with and without `watch-focus`, the real daemon, a fake dial, a fake front app**
- Where: this Mac, at the final head. The same file runs on Linux in check 2.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/dialTerminalFollow.e2e.ts`. `TMPDIR=/tmp` keeps the daemons' socket paths under their limit. `dialTerminalFollow` runs on macOS alone, and shares the settle and the echo code this branch changes.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6):
  - a throwaway home, data folder and Codex home, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal;
  - the app in front is a line on the stdin of the real `harness hardware watch --json`, run under the throwaway daemon's environment;
  - `orca` is the fake in the daemon's own `bin`, first on its `PATH`; a daemon with no fake of a test's own finds the stub that exits 1, never `/Applications/Orca.app`;
  - no backend, no sign-in, no account.
  - After the run, `pgrep -fl 'tail -n \+1 -f'` names no process under the run's temp folder: no fake watch is left.
- A person sees: every test passes. In `dialOrcaFocus`:
  - with `watch-focus`, the dial's `focus` follows each line the fake prints, the echo of the dial's own switch and a typed prompt move nothing, and the unplug ends the fake's watch;
  - the Orca ring arrives as C, A, B with the dial still on A, and no `terminal switch` runs for the reorder;
  - with 1.4.256's help, no `watch-focus` is run and a typed prompt moves the dial.
  - The daemon's logs hold `[device] orca watch · started`, `· ended`, `· unsupported`, `[device] focus · moved`, `· skipped · echo`, `[device] prompt · skipped · focus followed`, `[device] orca order · read`, and no handle.
- On GitHub: check 2 runs it on Linux.

**2. The other dial flows still hold, on Linux**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/dial-orca-focus-order` (`.github/workflows/cli-e2e.yml`). Every shard passes; `dialTerminalFollow` is skipped there. The run's link goes in the pull request.
- Isolation: the suite's own, as above. No account and no secret.
- What it shows: `dialOrcaFocus` and `dialPaneFollow` pass on Linux, and `deviceWithoutApp`, `deviceClaudeOrca`, `deviceCodex`, `deviceHerdr` (skipped where herdr is not installed), `dialClaudeAppFollow`, `dialAppFilter`, `dialAppFilterOnDial`, `dialStream` and `devicesProcess` pass with the `orca` stub and the new reads.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 5, 7 and 8 on Linux; `process-checks` runs for the docs. Nothing is started by hand.

**4. Numbers:** none to take. Nothing polls. The tests hold the cost to one `--help` per Orca binary (Task 1), one read per member change and one at a time (Task 7), one watch and no timer in the devices (Task 8). The watch's own cost between focus changes is Orca's long poll, in Orca's process.

**5. On a dial: Diego himself** (his Mac, his dial, his Orca 1.4.256, his eye). The orchestrator asks him when the pull request is ready. No agent runs this, switches his daemon or touches a pane.
- His daemon runs this branch's build. A dev daemon stays on the commit it was built from, so its version is read first.
- (B) With three or more agents in Orca, over two tabs and one tab split in two panes: swiping the dial through Orca's ring goes tab by tab in the tab strip's order, and inside the split tab first pane, then second. An agent started in a new tab takes that tab's place in the ring, and the dial stays on the agent it showed.
  - A tab dragged in Orca moves nothing on the dial until an agent starts or ends (decided 2).
  - The order across worktrees is Orca's layouts' order, which may differ from the sidebar's (the spec's follow-up).
- (A, as far as 1.4.256 goes) A prompt typed in an Orca pane, with Orca in front, still moves the dial to that agent. The daemon's log has `[device] orca watch · unsupported`, `[device] orca order · read` and `[device] prompt · moved`.
- If a dial that does not say `appFilter` (an older round dial, Harness Pro) is at hand: its ring is in the order it had before.

**Not run in this branch, and what no check here covers:**
- Focus follow against a real Orca. Orca 1.4.256 has no `watch-focus`; it waits for stablyai/orca#42555 to merge and ship (the spec's follow-up). Until then only the fake proves (A).
- Linux X11 and Windows on a dial.
