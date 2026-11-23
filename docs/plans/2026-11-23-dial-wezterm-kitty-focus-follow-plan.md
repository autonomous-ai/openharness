# The dial follows the focused pane in WezTerm and kitty: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While WezTerm or kitty is settled in front and a dial is attached, focusing a pane, tab or window there that
runs a Claude Code or Codex agent turns the dial to that agent, with no typing; the dial's own tap there never pulls it
back; nothing runs otherwise.

**Architecture:** Each adapter gets one read of its app's focus (`HO/wezterm.ts` `focusedPane`, `HO/kitty.ts`
`focusedWindows`). A small generic unit, `HO/focusPoll.ts`, runs one read at a time, 500 ms after the last one ended,
and stops itself after 3 failed reads in a row. `services/devices.ts` runs at most one poll, for the settled app, while
a dial is attached and an agent has an own pane there, and turns the dial (`cable.followLocal(agent, 'pane')`) when one
focused agent pane changed, with the Orca and tab follows' echo guards. A kitty socket that refused a read or timed out
is not asked again until that kitty restarts (kept in the kitty adapter, in memory), so kitty never prompts the person
twice. The core is not touched.

**Tech Stack:** TypeScript (Node 24), Vitest with injected fakes and fake timers, the CLI's e2e harness (real daemon,
fake dial on the desk, `orcaTerminal` forkpty stand-in under another maker's name, fake `wezterm` and `kitten` in the
daemon's `bin`, `harness hardware watch --json` for the front), Docker for the recording only.

**Spec:** `docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md` (approved; the orchestrator's decisions are in
it: the follow has no Windows rule of its own, as #4566 makes a Windows WezTerm pane the agent's own; the prompt follow
is unchanged; two kittys follow only the kitty whose focused window changed). Base: `feat/dial-wezterm-kitty-focus-follow`
at `ea93110980`. The spec and this plan are not committed yet: Task 1's commit adds both as they are, so Task 8's edit
of the spec is its own diff.

Paths: `HO/` is `cli/src/cable/hosts/`; `SV/` is `cli/src/services/`; commands run in `cli/`.

**Rebase onto #4566.** The orchestrator rebases this branch onto `main` once #4566 (`fix/dial-orca-windows-held-pane`)
merges, between any two tasks. #4566 edits `HO/orca.ts` lines ~233-240, `SV/devices.ts` lines ~71 and ~838,
`SV/devices.spec.ts` lines ~206-228, ~583 and ~3124, `HO/scannedApp.ts`, `HO/observed.ts` and the `devices` row of
`cli/AGENTS.md`. The tasks keep clear of those hunks: Task 4 edits `orcaDeps().run` (~79-95) and `orca.spec.ts` (~270);
Tasks 5-6 append their `devices.spec.ts` cases at the end of the file and touch none of #4566's `devices.ts` lines;
Task 8 edits the same one-line `devices` row, so it runs after the rebase when #4566 has merged by then (else its
conflict is that line: keep #4566's line and add the phrase again).

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | Record WezTerm's `list-clients` and kitty's `get-colors --match` | `cli/src/testing/recordedWezterm.ts`, `cli/src/testing/recordedKitty.ts` (+ the spec and this plan, added as they are) | none | high | none: recorded data, one commit |
| 2 | The focus poll | `HO/focusPoll.ts` (new), `HO/focusPoll.spec.ts` (new) | none | xhigh | `focusPoll.spec.ts` (module missing) |
| 3 | WezTerm's focused pane | `HO/wezterm.ts`, `HO/wezterm.spec.ts` | 1, 2 | high | `wezterm.spec.ts` `focusedPane` cases |
| 4 | kitty's focused windows, and stderr on the run | `HO/kitty.ts`, `HO/kitty.spec.ts`, `HO/orca.ts`, `HO/orca.spec.ts` | 1, 2 | high | `kitty.spec.ts` `focusedWindows` cases; `orca.spec.ts` stderr cases |
| 5 | The devices run the poll | `SV/devices.ts`, `SV/devices.spec.ts` | 2, 3, 4 | xhigh | `devices.spec.ts` new describe, "its life" |
| 6 | An answer turns the dial | `SV/devices.ts`, `SV/devices.spec.ts`, `cli/src/cable/cableSession.ts` | 5 | xhigh | `devices.spec.ts` new describe, "following" |
| 7 | End to end | `cli/e2e/dialPaneFocusFollow.e2e.ts` (new), `cli/e2e/harness/inOrca.ts` | 6 | high | none: test tooling, one commit |
| 8 | The devices row and the spec's recorded facts | `cli/AGENTS.md`, `docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md` | 1, 6 | medium | none: docs, one commit |

**Longest chain:** 1 → 3 → 5 → 6 → 7 (five tasks; 1 → 4 → 5 → 6 → 7 is as long). Tasks 1 and 2 start at once; 3 and
4 run side by side; 7 and 8 run side by side after 6.

## Global Constraints

- Nothing in `cli/src/core/` or `cli/src/architecture.coreFiles.txt`: `git diff --stat ea93110980 -- cli/src/core
  cli/src/architecture.coreFiles.txt` prints nothing. `src/architecture*.spec.ts` stay green.
- Values, exact: `FOCUS_POLL_MS = 500`, `FOCUS_READ_MS = 2_000`, `FOCUS_FAILS_MAX = 3` (all in `HO/focusPoll.ts`);
  at most 16 WezTerm clients read (`FOCUS_CLIENTS_MAX`, `HO/wezterm.ts`); at most 16 kitty panes asked a read
  (`FOCUS_PANES_MAX`, `HO/kitty.ts`), so at most 16 calls; the existing `ATTACH_ECHO_MS` (2 s), `TAB_ECHO_MS` (2 s),
  `ECHO_KEPT` and `FRONT_SETTLE_MS` (1 s) unchanged.
- Log lines, exact, and no others for this feature: `[device] pane · moved`, `[device] pane · skipped · no tile`,
  `[device] pane · skipped · echo`, `[device] pane · skipped · unknown agent`, `[device] pane · skipped · not in front`,
  `[device] focus poll · started`, `[device] focus poll · stopped · <n> reads, <m> failed`, and the same with
  ` · failing` at its end when the poll stopped itself, and `[device] kitty · focus refused` (through `KittyDeps.log`,
  once per refusal). Never a pane id, window id, socket, title or agent.
- kitty's refusals: at most `FOCUS_PANES_MAX` (16) refused sockets kept, the oldest dropped first; a daemon restart
  forgets them all.
- Reads: `wezterm cli --no-auto-start list-clients --format json` (only `focused_pane_id` and `idle_time` read) and
  `kitten @ --to <socket> get-colors --match <expr>` (only the exit code and, on exit 1, whether stderr starts with
  `Error: No matching windows`; stdout discarded). Never `kitten @ ls`, `wezterm cli list` for this, a title, a cwd or
  an environment. No shell.
- Platforms: WezTerm on macOS, Linux, Windows; kitty on macOS and Linux. No `win32` branch in the poll or its glue
  (decision 1, superseded by #4566).
- The prompt follow (`followPrompt`) is unchanged (decision 2).
- Tests: fakes and throwaway homes only; never the developer's WezTerm or kitty (none is installed here), never a real
  dial. The recording runs in disposable `ubuntu:24.04` arm64 Docker containers only.
- `cli/src/services/` is held at 100% per file (`npm run test:core`): every new line of `devices.ts` has its case.
- Comments say why, naming the recording or the incident. No switch, option or setting.

## Review Focus

1. **The person turns the dial by hand to another agent while WezTerm's focus stays put:** the next reads are unchanged
   and move nothing; the dial is not pulled back to the focused pane. Test: Task 6.
2. **A failed read between two equal answers** (WezTerm busy, a kitty call timing out once): nothing moves, and the
   next good answer is compared with the last good one, so it does not look changed. Test: Task 6.
3. **A read in flight when its poll stops or the front switches from WezTerm to kitty:** its answer is dropped, and
   kitty's poll's first answer is its own settle. Tests: Task 2 (late answer), Task 5 (switch).
4. **The person focuses a shell pane, then the same agent's pane again:** the null in between is a change, so the
   second focus turns the dial again. Test: Task 6.
5. **A tap on B followed fast by a hand turn to C before a read sees B:** the answer naming B is the dial's own move
   (`dialMoves` changed during the read, or B's tap note) and does not pull the dial back from C. Test: Task 6.

---

### Task 1: Record WezTerm's `list-clients` and kitty's `get-colors --match`

**Files:**
- Modify: `cli/src/testing/recordedWezterm.ts`, `cli/src/testing/recordedKitty.ts`
- Add as they are (untracked now): `docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md`, this plan

**Interfaces:**
- Produces (`RECORDED_WEZTERM`, beside its other values; the header comment gains a paragraph "How the GUI's clients
  were read", as its existing one):
  ```ts
  download.arm64: { url: string; sha256: string }      // the Ubuntu 22.04 arm64 .deb the recording installed
  listClients: {
    argv: ['wezterm', 'cli', '--no-auto-start', 'list-clients', '--format', 'json']
    guiSocketLink: string                               // 'x11-:99-org.wezfurlong.wezterm', under $XDG_RUNTIME_DIR/wezterm/
    gui: { exitCode: 0; stdout: string; stderr: '' }    // as the GUI started, no WEZTERM_UNIX_SOCKET: pane 0 focused
    afterSpawn: { stdout: string }                      // `spawn` made tab 1: focused_pane_id 1
    afterSplit: { stdout: string }                      // `split-pane` from the CLI: still 1
    afterActivate: { stdout: string }                   // `activate-pane --pane-id 0`: 0
    afterKey: { stdout: string }                        // ctrl+Tab pressed in the GUI (xdotool): its new pane, idle_time reset
    afterNewWindow: { stdout: string }                  // `spawn --new-window`: the new window's pane
    noGui: { exitCode: 1; stdout: ''; stderr: string }  // the GUI killed
    noRuntimeDir: { exitCode: 1; stdout: ''; stderr: string }  // GUI running, XDG_RUNTIME_DIR unset for the call
    callMs: number                                      // mean of 20 calls
  }
  ```
- Produces (`RECORDED_KITTY.focusedMatch`; the header gains a paragraph for it, as the earlier ones):
  ```ts
  focusedMatch: {
    focused:    { args: [...'get-colors', '--match', 'id:1 and state:focused']; code: 0; stderr: ''; stdoutFirstLine: string }
    notFocused: { args: [... 'id:2 and state:focused']; code: 1; stderr: 'Error: No matching windows for expression: id:2 and state:focused\n' }
    orFocused:  { args: [... 'state:focused and (id:2 or id:1)']; code: 0; stderr: '' }
    orNone:     { args: [... 'state:focused and (id:2 or id:3)']; code: 1; stderr: string }
    followed:   { focusWindow: boolean; newTab: boolean; newOsWindow: boolean }   // state:focused moved with each
    activeOfEveryTab: boolean                            // 'id:1 and state:active' matched with window 2 focused
    twoKittys:  { bothFocused: boolean; focusedOsWindow: boolean }               // two processes under openbox
    password:   { args: string[]; code: number | null; stderr: string; ms: number; askedThePerson: boolean }
    passwordSet: { args: string[]; code: number | null; stderr: string; ms: number; askedThePerson: boolean }
    callMs: number
  }
  ```
  Each value is the exact argv (`kitten`, `@`, `--to`, `unix:/tmp/kitty`, …), exit code and output, as the file's
  other values.

- [ ] **Step 1: Re-run the spike's containers.** Scripts in this session's scratchpad (never committed), as
  `spike/spike.sh`, `wez3.sh` and `kitty2.sh` there: `docker run --rm --platform linux/arm64 ubuntu:24.04`, user `u`,
  `Xvfb :99`, `openbox`, `LIBGL_ALWAYS_SOFTWARE=1`. WezTerm `20240203-110809-5046fc22` from the release's Ubuntu 22.04
  arm64 `.deb` (sha256 recorded), `front_end = 'Software'`, `wezterm start` with no `--always-new-process`,
  `XDG_RUNTIME_DIR=/tmp/xdg` (0700); every call from outside the GUI with no `WEZTERM_UNIX_SOCKET`. kitty 0.32.2 from the
  archive, `-o allow_remote_control=socket-only --listen-on unix:/tmp/kitty`. Add what the spike lacked:
  - the `or` form with parentheses, matching and not;
  - `list-clients` with `XDG_RUNTIME_DIR` unset while the GUI runs;
  - `password`: a kitty `-o allow_remote_control=password --listen-on unix:/tmp/kitty-pw` with no
    `remote_control_password`, and `passwordSet`: the same with `-o 'remote_control_password=pw get-colors'`, each
    asked `get-colors --match 'id:1 and state:focused'` with no password, under `timeout 10`, timing it: an exit within
    a second is a refusal; one that waits to the timeout asked the person (a prompt in kitty's window).
  Keep each raw output in the scratchpad.
- [ ] **Step 2: Stop on a recording that breaks the design.** If kitty 0.32.2 takes no parentheses in `--match`, or
  `list-clients`' `focused_pane_id` did not follow `activate-pane` or the key, stop here and report it with the raw
  output: the reads' designs (Tasks 3, 4) assume each. A password case that asks the person is no stop: the header
  paragraph says so and that one prompt can still show once per kitty start (the first call cannot know the mode;
  Task 4 then asks that socket no more), which is accepted. Anything else that differs from the spec's "What the apps
  offer" (a timing, a field) is recorded as it is and fixed in the spec by Task 8.
- [ ] **Step 3: Write the values** into the two files in the shapes above, in their style: exact argv, exit code, output,
  and how each was made in the header. `npm run typecheck`: PASS.
- [ ] **Step 4: Commit** (one commit, no behavior) the two files, the spec and this plan:
  `test(cli): record WezTerm's list-clients and kitty's get-colors --match for the dial's focus follow`.

---

### Task 2: The focus poll

**Files:**
- Create: `HO/focusPoll.ts`, `HO/focusPoll.spec.ts`

**Interfaces:**
- Produces (`HO/focusPoll.ts`):
  ```ts
  /** 500 ms after each read ends: the Terminal and iTerm2 tab poll's interval (#4331). */
  export const FOCUS_POLL_MS = 500
  /** How long one read of an app's focus may take, all its calls together (wezterm.ts focusedPane, kitty.ts focusedWindows). */
  export const FOCUS_READ_MS = 2_000
  export const FOCUS_FAILS_MAX = 3
  export interface FocusPollDeps<T> {
    /** One read: its answer, or undefined for one that failed. A rejection is a failed read. */
    read(): Promise<T | undefined>
    /** Each answer of a read that ended before the stop, in order. */
    answered(answer: T): void
    /** Told once, when the poll stopped itself after FOCUS_FAILS_MAX failed reads in a row. */
    failing(): void
    /** A timer and its cancel, as devices.ts timerIn gives one. */
    after(ms: number, run: () => void): () => void
    log(line: string): void
  }
  export interface FocusPoll { stop(): void }
  export function startFocusPoll<T>(deps: FocusPollDeps<T>): FocusPoll
  ```

- [ ] **Step 1: Write the failing tests** in `focusPoll.spec.ts` (a `after` on `vi.useFakeTimers` `setTimeout`, each
  read held until the spec answers it):
  - `'reads at once, then FOCUS_POLL_MS after each read ends, never two at once'`: one read started at start; none
    more while it runs (advance 5_000); answered after 300 ms, the next starts at 800 ms, not before.
  - `'each answer is told in order; a failed read and a rejected one tell nothing'`.
  - `'a stop starts no read, drops the answer of the read under way, and says its counts once'`: lines
    `['[device] focus poll · started', '[device] focus poll · stopped · 2 reads, 1 failed']` (the dropped read not
    counted); a second `stop()` adds nothing; advancing past FOCUS_POLL_MS starts nothing.
  - `'three failed reads in a row stop it as failing, told once'`: last line `'[device] focus poll · stopped · 3 reads,
    3 failed · failing'`, `failing` called once, no read after, a later `stop()` adds nothing.
  - `'a good read between failures starts the count again'`: fail, fail, answer, fail, fail → still reading.
  - `'an answered that throws still leaves the next read on time'`.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/focusPoll.spec.ts`. Expected: FAIL (no module). Commit the red
  test: `test(cli): the dial's focus poll, one read at a time and stopping itself (red)`.
- [ ] **Step 3: Implement** `startFocusPoll`. The next read is scheduled in a `finally` around `answered`; a `stopped`
  flag drops a late answer; the counts are kept in the closure only. Header comment: why a poll (no WezTerm or kitty
  command subscribes to focus, and Harness edits neither `wezterm.lua` nor `kitty.conf`, spec "What the apps offer"),
  and why it stops itself (a WezTerm whose GUI is gone would be asked twice a second while in front; a kitty that
  refuses is kept by its adapter, Task 4).
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): a focus poll for the dial, one read at a time, stopping after three failures`.

---

### Task 3: WezTerm's focused pane

**Files:**
- Modify: `HO/wezterm.ts`, `HO/wezterm.spec.ts`

**Interfaces:**
- Consumes: `FOCUS_READ_MS` (`HO/focusPoll.ts`); `RECORDED_WEZTERM.listClients` (Task 1).
- Produces (`HO/wezterm.ts`):
  ```ts
  export const FOCUS_CLIENTS_MAX = 16
  export function createWeztermAdapter(deps: OrcaDeps): HostAdapter & {
    /** The focused pane's id (`<n>`, as paneOf builds it) of the client idle least; null when no client is listed;
     *  undefined when the call failed or its answer is out of form anywhere. */
    focusedPane(): Promise<string | null | undefined>
  }
  ```
  `weztermCli(deps).run` gains `timeoutMs = RUN_TIMEOUT_MS` as its third parameter.

- [ ] **Step 1: Write the failing tests** in a new describe `"WezTerm's focused pane (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md)"`,
  with a recorder whose `run` answers the recorded `stdout` and code:
  - `'one list-clients, with the binary the verbs use, within FOCUS_READ_MS'`: calls `[{ file: FAKE_PATH_WEZTERM, args:
    ['cli', '--no-auto-start', 'list-clients', '--format', 'json'], timeoutMs: 2_000 }]`; answers `'0'` for
    `listClients.gui`, `'2'` (or the recorded id) for `afterKey`, `afterActivate`'s for it.
  - `'of several clients, the one idle least; of equals, the first'`: two entries made from the recorded client, idle
    `{secs: 8, nanos: 0}` and `{secs: 2, nanos: 5}` → the second's id; equal idles → the first's.
  - `'no client listed is null'`: `[]` → `null`.
  - `it.each` out of form → `undefined`: `noGui` (exit 1), exit `null` (a timeout), not JSON, `{}`, 17 clients, an
    entry `null`, `focused_pane_id` `'1'`, `-1`, `1.5`, `1e10`, missing; `idle_time` missing, `{secs: '2', nanos: 0}`,
    `{secs: 2}`.
  - `'reads only focused_pane_id and idle_time'`: the recorded client with `username`, `hostname`, `pid` and
    `workspace` removed, or of other types, still answers its id.
  - `'a failed call looks for the binary again at the next read, as the verbs do'`: `onPath` asked twice over two reads
    after an exit 1.
  - `'no wezterm found runs nothing and is undefined'`.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/wezterm.spec.ts`. Expected: the new cases FAIL (`focusedPane` is
  not a function). Commit: `test(cli): WezTerm's focused pane from list-clients (red)`.
- [ ] **Step 3: Implement** `focusedPane` in `createWeztermAdapter`, on the adapter's own `cli`. Parse as `paneOnTty`
  does: any entry out of form makes the whole answer `undefined`; `focused_pane_id` must be a number in `WEZTERM_PANE`'s
  form; `idle_time` `{secs, nanos}` both finite numbers, compared secs first. Comment why `idle_time` (the client typed or
  clicked in last; only the GUI's one client was recorded) and why `list`'s `is_active` is no use (spec).
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): WezTerm's adapter reads the focused pane from list-clients`.

---

### Task 4: kitty's focused windows, and stderr on the run

**Files:**
- Modify: `HO/kitty.ts`, `HO/kitty.spec.ts`, `HO/orca.ts` (`OrcaDeps.run`, `orcaDeps().run` only), `HO/orca.spec.ts`

**Interfaces:**
- Consumes: `FOCUS_READ_MS` (`HO/focusPoll.ts`); `RECORDED_KITTY.focusedMatch`, `remoteControlOff`, `noSocket` (Task 1).
- Produces:
  ```ts
  // HO/orca.ts
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr?: string }>
  // HO/kitty.ts
  export const FOCUS_PANES_MAX = 16
  export interface KittyDeps {
    /* as now, and: */
    now(): number                          // the devices' monotonic clock
    /** The identity (`<dev>:<ino>`) of the socket at [path]; null when none is there, it is no socket, or on any error. */
    socketId(path: string): string | null
  }
  export function createKittyAdapter(deps: KittyDeps): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>> & {
    /** Per socket (`listenOn`), which of [panes] on it is that kitty's focused window (its Pane.id), or null for none of
     *  them; undefined when any call failed. A refused socket has no entry and is not asked. */
    focusedWindows(panes: readonly Pane[]): Promise<Map<string, string | null> | undefined>
  }
  ```
  The adapter keeps, in memory, its refused sockets: `listenOn` → the `socketId` at the refusal (null for an abstract
  socket), at most `FOCUS_PANES_MAX`, the oldest dropped first.

- [ ] **Step 1: Write the failing tests.**
  - `orca.spec.ts`: `'a non-zero exit is false'` expects `{ code: 3, stdout: '', stderr: '' }`; a new case `'a run's
    stderr is in its answer'`: a fake that prints `nope` to stderr and exits 1 → `{ code: 1, stdout: '', stderr:
    'nope\n' }`. Other `toEqual`s on `orcaDeps().run` that the callback answers gain `stderr` as it printed.
  - `kitty.spec.ts`: the `recorder` gains `now` (a spec clock, 0 by default), `socketId` (a spec map, `'1:1'` for
    `/tmp/kitty` by default) and answers `get-colors` from
    `RECORDED_KITTY.focusedMatch` by the window the spec says is focused (exit 0, or exit 1 with the recorded `No
    matching windows` stderr). A new describe `"kitty's focused windows (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md)"`:
    - `'one call while focus stays on the pane asked first'`: panes `[1@/tmp/kitty]`, window 1 focused → calls
      `[ran(focusedMatch.focused.args)]` with `timeoutMs: 2_000`; `Map { 'unix:/tmp/kitty' => '1@unix:/tmp/kitty' }`.
    - `'the first pane alone, then the rest in one or with parentheses, narrowed one id at a time'`: panes 1, 2, 3, window
      3 focused → `--match` values `['id:1 and state:focused', 'state:focused and (id:2 or id:3)', 'id:2 and
      state:focused']` and no fourth call (the last left is the one the `or` matched); answer `'3@unix:/tmp/kitty'`.
    - `'focus on another window: two calls and null'`; `'one pane, not focused: one call and null'`.
    - `'the caller's order: the pane it puts first is asked alone'`: `[3, 1, 2]` asks `id:3 and state:focused` first.
    - `'each socket its own entry, asked in the order its panes first come'` (two sockets of this account's).
    - `'at most 16 panes and 16 calls'`: 17 panes → the 17th never asked; 16 on one socket, the last focused → exactly
      16 calls.
    - `'one deadline for the read'`: each call's `timeoutMs` is `2_000` minus the time the read has taken by the spec
      clock; with the clock at the deadline before a call, that call is not started and the read is `undefined`.
    - `'only panes in form, of its own window and on a socket of this account's are asked'`: a held pane, a pane id out
      of form and a pane on a socket another uid owns are not asked (no call); Linux's abstract socket is (`ours`).
    - `it.each` refusals → `undefined`: `remoteControlOff`'s exit and stderr, `focusedMatch.password`'s,
      `noSocket`'s, exit `null` (a timeout), exit 2, exit 1 with no stderr.
    - A sub-describe `"a refused socket is asked once a kitty start"` (so kitty shows a password prompt once at most):
      - `'a refusal: that read is undefined, the next asks that socket nothing and answers no entry for it'`
        (`focusedMatch.password`'s answer; second read: no call, an empty map, not `undefined`).
      - `'a timeout (exit null) alike'`.
      - `'the same path with a new socket identity is asked again'`: `socketId` turns `'1:2'` → one call in the next read.
      - `'an abstract socket refused, a read with no pane on it, then a pane on it again: asked again'` (platform linux,
        `unix:@kitty`: no call in the read with its pane, none in the one without, one in the third).
      - `'another socket keeps being asked'`: two sockets, one refused → the other's calls in every later read.
      - `'the line once per refusal'`: `logs` holds `'[device] kitty · focus refused'` once over three reads; once more
        after the new identity's call is refused again; the line names no socket.
      - `'a read that ran out of time marks nothing'`: the deadline passed before a call → `undefined`, the next read asks
        that socket.
      - `'at most 16 refused sockets kept'`: 17 sockets refused over two reads → the first refused is asked again.
    - `'stdout is never read'`: exit 0 with any stdout matches.
    - `'no kitty found runs nothing and is undefined'`; `'no panes: an empty map, no call'`.
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/kitty.spec.ts src/cable/hosts/orca.spec.ts`. Expected: the new
  cases FAIL. Commit: `test(cli): kitty's focused windows by get-colors --match, and a run's stderr (red)`.
- [ ] **Step 3: Implement.**
  - `orca.ts`: `orcaDeps().run` passes execFile's `stderr` with every answer from its callback; the deadline and the
    refused-before-start answers carry none. Comment: kitty's focus read tells no match from a refusal by it
    (`RECORDED_KITTY.focusedMatch`, `remoteControlOff`: both exit 1); it is compared, never kept or logged.
  - `kitty.ts`: `focusedWindows` with a local `ask(listenOn, expr, deadline): Promise<'match' | 'none' | 'failed'>`
    running `['@', '--to', listenOn, 'get-colors', '--match', expr]` with the time left, `'failed'` when none is left.
    Panes taken in the caller's order: `windowOf` in form, own (not `held:`), `ours`; the first 16. Per socket: the
    first alone; unless matched, the rest in `state:focused and (id:a or id:b …)`; on a match each asked alone in
    order but the last, which the `or` already named (so a read's calls never pass its panes, the 16 bound). Comments:
    `get-colors` because its output is the colour table, not `ls`, which holds the windows' environment (#4227);
    `state:active` and `state:focused_os_window` are no use (`focusedMatch.activeOfEveryTab`, `twoKittys`).
  - The refusals, in `focusedWindows` alone: at a read's start, an abstract entry with no given pane in form on its
    socket is dropped; a path entry is dropped when `socketId(path)` differs from the one kept (a new kitty there); a
    socket still kept gets no entry and no call. An `ask` whose call ran and answered `'failed'` (any exit but 0 or 1
    with `No matching windows`, `null` included) keeps its socket with `socketId(path)` (null when abstract) and logs
    `[device] kitty · focus refused`; a call not started for lack of time keeps nothing. Comment: kitty in password
    mode with no password may ask the person on each call (`focusedMatch.password`), so a socket is asked once a kitty
    start; the poll's own FOCUS_FAILS_MAX then counts only that one read (later reads with only refused sockets answer
    an empty map, a good read).
  - `kitty.spec.ts`' other describes take `now` and `socketId` in their deps.
- [ ] **Step 4: Run** the two specs and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): kitty's adapter reads each kitty's focused window by get-colors --match`.

---

### Task 5: The devices run the poll

**Files:**
- Modify: `SV/devices.ts`, `SV/devices.spec.ts` (a new describe at the end of the file)

**Interfaces:**
- Consumes: `startFocusPoll`, `FOCUS_POLL_MS`, `type FocusPoll` (Task 2); `focusedPane` (Task 3); `focusedWindows`,
  `KittyDeps.now`, `KittyDeps.socketId` (Task 4).
- Produces, inside `startDevices` (Task 6 relies on these names):
  ```ts
  const wezterm = createWeztermAdapter(apps)              // typed references: their reads stay reachable
  const kitty = createKittyAdapter(kittyDeps)             // kittyDeps gains `now: monotonic` and `socketId`
  function socketId(path: string): string | null          // beside socketOwner: `${dev}:${ino}` of a socket, else null
  /** The WezTerm panes and kitty windows the dial focused lately (a tap): a read naming one is its echo. */
  const paneFocuses = dialMovesTo()
  type PaneAnswer = { focused: ReadonlyMap<string, string | null>; moves: number; at: number }
  type PaneFocus = { app: 'wezterm' | 'kitty'; poll: FocusPoll; first: boolean; last?: ReadonlyMap<string, string | null> }
  let paneFocus: PaneFocus | undefined
  /** Set as a poll stops itself; cleared at the next settle of any app: only a settle starts it again (spec). */
  let paneFocusFailing = false
  const paneAnswered = (focus: PaneFocus, answer: PaneAnswer): Promise<void> | undefined  // Task 5: keeps `last` only
  const checkPaneFocus = (): void                         // starts or stops by the three conditions
  const dropPaneFocus = (): void                          // stops the poll, clears paneFocuses
  ```

- [ ] **Step 1: Write the failing tests** in `describe('the dial follows the pane focused in WezTerm and kitty
  (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md)')`, sub-describe `"its life"`. Setup as the Orca
  focus describe's `dialWith`: fake timers (`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`), `now: () =>
  clock`, `fakeListener()` for the front, `faults: ['fleet']`; `WEZTERM_CALLERS` / `KITTY_CALLERS` as `ORCA_CALLERS` with
  maker `wezterm-gui` / `kitty`; hooks with `{ WEZTERM_PANE: '<n>', TERM_PROGRAM: 'WezTerm' }` or `{ KITTY_WINDOW_ID:
  '<n>', KITTY_LISTEN_ON }` (a socket of this account's made as `kittyAt()` does); `orca.run` answering `list-clients`
  with `RECORDED_WEZTERM.listClients.gui` (its id set by the spec) and `get-colors` as Task 4's recorder. `polls()` = the
  `[device] focus poll` lines; `reads()` = the `list-clients` / `get-colors` runs.
  - `'WezTerm settled with a dial attached and an agent in a WezTerm pane of its own starts one poll'`: one run at the
    settle, one more each FOCUS_POLL_MS after; `polls()` `['[device] focus poll · started']`.
  - `'nothing runs with no dial attached, another app settled, or only held WezTerm panes'` (maker `zsh` → held).
  - `'another app or none settling stops it with its counts; so do the last dial going and the devices stopping'`:
    `'[device] focus poll · stopped · 3 reads, 0 failed'`, no run after.
  - `'the last WezTerm agent going stops it, and one starting while WezTerm is settled with a dial starts it'`
    (`session-end` then the end's drop; a new `session-start`).
  - `'a dial attaching with WezTerm settled starts it'`.
  - `'a settle of the app whose poll runs keeps that poll'` (front Ghostty and back within FRONT_SETTLE_MS: one
    `started`).
  - `'one poll at most: kitty settling stops WezTerm's and starts kitty's, on the agent's socket'`; a WezTerm read in
    flight at the switch lands on nothing (Review Focus 3).
  - `'three failed reads stop it as failing; an agents' change or an attach does not start it again; the next settle of
    WezTerm does'`.
  - `'kitty: the pane found focused last is asked first'`: two agents, window 7 focused; the second read's first
    `--match` is `id:7 and state:focused`.
  - `'a read's panes are the live agents' own as it starts'`: an agent started between reads is asked in the next.
  - `'a kitty that refuses is asked once: no poll stop, one line'` (the `kittyAt()` socket, `get-colors` answering
    `focusedMatch.password`'s exit and stderr): one `get-colors` over five reads, `[device] kitty · focus refused` once,
    no `· failing`; the socket closed and listening anew at the same path (a new identity) → asked once more.
  - `'with the observed agents off, nothing runs'` (`env.HARNESS_DEVICE_OBSERVED = false`, as the
    `HARNESS_DEVICE_OBSERVED=off` case sets it).
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t "WezTerm and kitty"`. Expected: FAIL (no runs, no
  lines). Commit: `test(cli): the devices poll WezTerm's or kitty's focus while it is settled with a dial (red)`.
- [ ] **Step 3: Implement** in `devices.ts`:
  - `socketId` beside `socketOwner`, both from one stat helper of theirs (one try/catch, so the existing cases cover
    its catch at 100%); `kittyDeps` gains `now: monotonic, socketId`.
  - The adapters block: `wezterm` and `kitty` built once above it; in the array that `.map(noting)` takes, each as
    `{ ...kitty, focus: (pane) => { paneFocuses.note(pane.id); return kitty.focus(pane) } }` (and WezTerm's alike), as
    Orca's is wrapped; comment: a tap's activate is the dial's own move, and the read that sees it is its echo.
  - A section `// ── the pane focused in WezTerm and kitty ──` after Orca's focus section, with its comment block (the
    spec's why: no app offers a focus event Harness may subscribe to; one poll, only while settled, a dial on and an
    agent there; zero calls otherwise). `checkPaneFocus`: wanted when `dialOn && observed`, `cableHost.settledApp()` is
    `'wezterm'` or `'kitty'`, `!paneFocusFailing` and some `observed.list()` agent has `observed.paneOf(id, app)`; a poll
    for another app, or one no longer wanted, goes through `dropPaneFocus` (which also clears `paneFocuses`: the spec's
    "both dropped when it stops"); starts with `startFocusPoll` (`after: timerIn('pane')`, `log`, `failing`: clears
    `paneFocus` and `paneFocuses` and sets `paneFocusFailing`, `answered`: `part.call('pane', () => paneAnswered(focus,
    a))`).
    The read: `moves = dialMoves`, `at = monotonic()` at its start; the panes the live agents' own of that adapter at
    its start, for kitty those in `last`'s values first; WezTerm's id kept only when it is one of those panes' ids,
    else null, under key `'wezterm'`.
  - Wiring: `appSettled` gains `part.call('pane', () => { paneFocusFailing = false; checkPaneFocus() })`; `dialAttached`
    calls `part.call('pane', checkPaneFocus)` when on and `part.call('pane', dropPaneFocus)` when off (the stop's
    detach covers the devices stopping); `observed?.onChange(() => part.call('pane', checkPaneFocus))`.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts`, `npm run typecheck`, `npm run test:core`.
  Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 5: Commit** `feat(cli): the devices poll the focused pane of WezTerm or kitty while it is settled in front`.

---

### Task 6: An answer turns the dial

**Files:**
- Modify: `SV/devices.ts`, `SV/devices.spec.ts` (the same describe, sub-describe `"following"`),
  `cli/src/cable/cableSession.ts` (`FollowCause` gains `'pane'`)

**Interfaces:**
- Consumes: Task 5's names; `ATTACH_ECHO_MS`, `dialMoves`, `dialMovedAt`, `cableHost.latestFront()`,
  `observed.byPane(adapter, id)`, `cable.followLocal`.
- Produces: `export type FollowCause = 'prompt' | 'tab' | 'attach' | 'focus' | 'thread' | 'vscode' | 'pane'`;
  `FOLLOWED.pane = { moved: '[device] pane · moved', 'no-tile': '[device] pane · skipped · no tile' }`.

- [ ] **Step 1: Write the failing tests** (`asked()` = `calls('followLocal')`; `paneLines()` = lines starting
  `[device] pane`):
  - `'the first answer is the settle's: the focused agent's pane turns the dial'`: WezTerm settles with pane 2 focused
    → `[[agent(2), 'pane']]`; `seen.host.localFollowed!('pane', 'moved')` and `('pane', 'no-tile')` log the two FOLLOWED
    lines.
  - `'a dial move within ATTACH_ECHO_MS before the first answer sets it aside as echo'`: `turnTo(agent(1))`, clock
    1_999 → `[device] pane · skipped · echo`, nothing asked; at 2_000 it follows.
  - `'a poll started at an agents' change, WezTerm already settled, takes its first answer as the settle'`: the first
    agent's `session-start` with WezTerm settled and a dial attached → `[[agent(1), 'pane']]`; and one a dial's attach
    started alike.
  - `'with no dial linked nothing is followed, and the first answer stays the first until one is read linked'`
    (`unlinked(true)` as the Orca describe): reads go on, no line; linked again, the next answer follows as the settle.
  - `'a focus change turns the dial; an unchanged answer, a failed read and a pane no agent runs in turn nothing'`;
    Review Focus 2: `'a failed read between two equal answers turns nothing'`.
  - Review Focus 4: `'a shell focused, then the same agent's pane again, turns the dial again'`.
  - Review Focus 1: `'a hand turn while the focus stays: no read pulls the dial back'`.
  - `'two kittys'`: both focused on agents at the settle → nothing; window changed in one → its agent; focus moved
    between the two (neither's focused window changes) → nothing.
  - `'not the latest in front: skipped as not in front'` (`listener.front('ghostty')` told, not yet settled).
  - `'the dial's tap on a pane: the read that sees it is its echo within TAB_ECHO_MS; the person focusing it again later
    turns the dial'` (`host().openAgent(agent(2))` runs `activate-pane`, the fake moves its focus); kitty alike with
    `focus-window`.
  - Review Focus 5: `'a dial move while the read ran sets its answer aside as echo'` (the read held, `turnTo` meanwhile).
  - `'an agent gone during the read: skipped as unknown agent'`.
  - `'a prompt typed in a WezTerm pane still turns the dial while the poll runs'`: `[device] prompt · moved`.
  - `'its lines name no pane, socket or agent'`: every `paneLines()` and `polls()` line matches
    `/^\[device\] (pane · (moved|skipped · (no tile|echo|unknown agent|not in front))|focus poll · (started|stopped · \d+ reads, \d+ failed( · failing)?))$/`.
- [ ] **Step 2: Run** `npx vitest run src/services/devices.spec.ts -t "WezTerm and kitty"`. Expected: the new cases
  FAIL. Commit: `test(cli): a focus change in WezTerm or kitty turns the dial, with the echo guards (red)`.
- [ ] **Step 3: Implement** `paneAnswered`, in this order: drop an answer of a poll that is no longer `paneFocus`; with
  `!cable.isConnected` drop it whole (`first` and `last` unchanged); candidates = the entries with a non-null value
  that, on the first answer, are all of them, else whose value differs from `last`'s for that key; then `first = false`,
  `last = answer.focused`; nothing unless exactly one candidate; `cableHost.latestFront() !== focus.app` → `not in
  front`; first answer: `dialMovedAt` within `ATTACH_ECHO_MS` → `echo`; later: `answer.moves !== dialMoves ||
  paneFocuses.echo(id, answer.at)` → `echo`; `observed.byPane(focus.app, id)` none → `unknown agent`; else
  `cable.followLocal(agent.id, 'pane')`. `FollowCause` and `FOLLOWED` gain `pane`. Comments name the guards' sources
  (Orca's settle rule #4311, the tab report's moves, the Claude app's settle).
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts src/cable/cableSession.spec.ts`,
  `npm run typecheck`, `npm run test:core`. Expected: PASS, `SV/devices.ts` at 100%.
- [ ] **Step 5: Commit** `feat(cli): a focus change in WezTerm or kitty turns the dial to its agent`.

---

### Task 7: End to end

**Files:**
- Create: `cli/e2e/dialPaneFocusFollow.e2e.ts`
- Modify: `cli/e2e/harness/inOrca.ts` (export the hook lookup `InOrca.hook` uses, as `installedHook(d, event):
  Promise<string>`, and use it there; no behavior change)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `Desk`, `orcaTerminal(d, children, { name })` (`e2e/harness/orcaHost.ts`),
  `installedHook`, `harnessdProcesses`/`d.servicePids('devices')`, `RECORDED_WEZTERM.listClients.gui`,
  `RECORDED_KITTY.focusedMatch`.

- [ ] **Step 1: Write the file.** Header comment as `dialOrcaFocus.e2e.ts`'s (what is real, what is fake, that the real
  WezTerm and kitty never run). In it:
  - An agent in a terminal app: a session id, its terminal `orcaTerminal(d, children, { name: 'wezterm-gui' | 'kitty' })`
    (one each, so each has its own pty and its pane is its own), and `hook(event, fields)` running
    `installedHook(d, event)` through `/bin/sh -c` on it with `{ ...d.env, ...hints }` alone: WezTerm `{ WEZTERM_PANE:
    '<n>', TERM_PROGRAM: 'WezTerm' }`, kitty `{ KITTY_WINDOW_ID: '<n>', KITTY_LISTEN_ON }`, no Orca variable.
  - kitty's socket: a real `net.createServer()` listening at `mkdtempSync('/tmp/hk-')` + `/s` (short, this account's,
    as `devices.spec.ts` `kittyAt`), closed after.
  - Fakes in `d.binDir` before `d.start()`, each noting every run as a file in its own log folder (its mtime the time,
    as `fakeOrca.ts`): `wezterm`, which for `cli --no-auto-start list-clients --format json` prints
    `RECORDED_WEZTERM.listClients.gui`'s JSON with `focused_pane_id` from its focus file, for `activate-pane --pane-id
    <n>` writes `<n>` there, exit 1 else; `kitten`, which for `@ --to <s> get-colors --match <expr>` exits 0 printing
    `focusedMatch.focused.stdoutFirstLine` when `<expr>` holds `state:focused` and an `id:<n>` of its focus file's
    window, else exits 1 with `Error: No matching windows for expression: <expr>` on stderr, and for `focus-window
    --match id:<n>` writes `<n>` there.
  - `it.each(['wezterm', 'kitty'])` `"<app>: the settle follows the focused agent, a focus change turns the dial, the
    dial's tap is not pulled back, and another app in front stops the calls"`: two agents A, B listed on the dial (with
    `fresh` and `listed` helpers of its own, as `dialOrcaFocus.e2e.ts`'s); B focused, then the front (`com.github.wez.wezterm` or
    `net.kovidgoyal.kitty`) on `harness hardware watch --json`'s stdin → the dial's `focus` frame for B, `[device] focus
    poll · started`, one `[device] pane · moved`; the fake's focus set to A → `focus` for A, two moves; the dial turned
    to B and tapped (`{ t: 'focus', agentId: B }`, `{ t: 'agent.open', agentId: B }`) → the fake's activate or
    focus-window ran, `[device] pane · skipped · echo`, still two moves, no `focus` frame for A after; the front
    `com.mitchellh.ghostty` → `[device] focus poll · stopped · …`; then the app's front again: no fake call between when
    the test saw `stopped` and 900 ms after it told the front again (the settle is `FRONT_SETTLE_MS`), then `started`
    again. Every `[device] pane` and `focus poll` line matches Task 6's pattern; the log holds no session id, pane id or
    socket path.
  - `describe.runIf(process.env.PANE_FOCUS_CPU === '1')` with `it.each(['wezterm', 'kitty'])` `"<app>: the devices' CPU
    over a minute with the poll running and with another app in front"`: two agents, the app settled 60 s, then Ghostty 60 s; the
    devices process's CPU time (`ps -o time= -p <pid>`, `d.servicePids('devices')`) at each end; prints one JSON line
    `{ app, platform, arch, pollCpuPercent, awayCpuPercent, reads }` and expects `reads` within 60 s / FOCUS_POLL_MS and
    no call while away. Opt-in as `e2e/perf.e2e.ts`'s `PERF=1` (cli/AGENTS.md rule 8).
- [ ] **Step 2: Run** `npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFocusFollow.e2e.ts` on this Mac, and
  `e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts` (they use `inOrca.ts`). Expected: PASS (the CPU cases skipped).
  `npm run typecheck`: PASS.
- [ ] **Step 3: Commit** (one commit: test tooling) `test(cli): end to end, the dial follows the focused pane in WezTerm and kitty`.

---

### Task 8: The devices row and the spec's recorded facts

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row only), `docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md`
  ("What the apps offer" only)

- [ ] **Step 1:** In the `devices` row, after `WezTerm's panes typed into by \`wezterm cli send-text --no-paste\`, then
  Enter on its own (\`cable/hosts/wezterm.ts\`);`, add one short phrase in the row's words (Naming System): `focusing a
  WezTerm pane or a kitty window moves the dial while its app is settled in front, one read every 500 ms
  (\`list-clients\`, \`get-colors --match\`, \`cable/hosts/focusPoll.ts\`);`. After the rebase onto #4566 when it has
  merged (see the header).
- [ ] **Step 2:** Compare the spec's "What the apps offer" with Task 1's values (call times, the fields, the password
  answer, the `or` form, `XDG_RUNTIME_DIR`); fix any sentence that differs, nothing else.
- [ ] **Step 3: Commit** (one commit, docs) `docs(cli): the devices follow WezTerm's and kitty's focused pane`.

---

## Verification

1. **Unit and coverage, on this Mac (macOS, arm64).** Each task's own spec files as its steps name; then, on the final
   head: `npm run typecheck`; `npx vitest run src/cable/hosts/focusPoll.spec.ts src/cable/hosts/wezterm.spec.ts
   src/cable/hosts/kitty.spec.ts src/cable/hosts/orca.spec.ts src/cable/cableSession.spec.ts
   src/services/devices.spec.ts`; `npm run test:core` (the required local gate for `src/services/`, every file at
   100%; PR CI does not run it). Record the `test:core` result in the PR body before the push (`process-checks` reads it
   from the push event).
2. **End to end on this Mac.** `npx vitest run --config vitest.e2e.config.ts e2e/dialPaneFocusFollow.e2e.ts
   e2e/dialOrcaFocus.e2e.ts e2e/dialPaneFollow.e2e.ts`. Isolation is the harness's own (cli/AGENTS.md rules 5-6): each
   case's `IsolatedDaemon` has a throwaway home, data folder and port, the fake dial is a file on the desk
   (`HARNESSD_TEST_DIAL_PORT`), `open -b` is the harness's fake (`HARNESS_OPEN_BIN`), `wezterm` and `kitten` are the
   file's fakes in `d.binDir`, kitty's socket is the test's under `/tmp/hk-*`, the front is the test's own `harness
   hardware watch --json`. No real WezTerm, kitty, dial or backend. A person sees nothing; the evidence is the PASS and
   the daemon's lines.
3. **End to end on Linux, by PR CI.** `linux-e2e` (ubuntu-24.04) picks up `dialPaneFocusFollow.e2e.ts` as an added
   e2e file, and by this diff's paths also runs the Orca files (`HO/orca.ts`, `inOrca.ts`), the canary
   (`cli/e2e/harness/`) and the dial app eval's six (`HO/`, `SV/devices.ts`); `dial-hosts` (`cli-e2e-dial-hosts.yml`:
   real herdr, WezTerm, Zellij, kitty) runs because `HO/` changed; `windows-e2e` (x64) because `cli/src/cable/` changed.
   None is started by hand. Should one need a rerun alone: Actions → CI → Run workflow, scope `linux-e2e`, `e2e_files`
   `cli/e2e/dialPaneFocusFollow.e2e.ts`, on the branch.
4. **CPU, on this Mac and on Linux** (the spec's "Limits and cost"). Mac: `PANE_FOCUS_CPU=1 E2E_BUNDLE=1 npx vitest run
   --config vitest.e2e.config.ts e2e/dialPaneFocusFollow.e2e.ts -t CPU`, alone on an idle machine. Linux: the same in a
   disposable `ubuntu:24.04` arm64 Docker container on this Mac (no CI run can set `PANE_FOCUS_CPU`, and no workflow is
   added for it): Node 24.22.2, `tmux zsh lsof tcsh dash build-essential procps` (the e2e setup action's packages, `cc`
   for the pty stand-in), the compaudit fix the action runs, a user of its own, `LANG=C.UTF-8 SHELL=/bin/zsh`, the
   branch's `cli/` copied in (`git archive`), `npm ci`. The PR lists both JSON lines beside `RECORDED_WEZTERM.listClients
   .callMs` and `RECORDED_KITTY.focusedMatch.callMs`.
5. **Dial eval: none.** The dial-apps eval has no WezTerm or kitty app (`App` in `src/testing/dialAppEval/types.ts` is
   `claude | chatgpt | vscode | cursor | orca`; `wezterm`/`kitty` appear there only in the voice step's comments and the
   spec's `kittyFinder` mock). PR CI runs its tier B files by path anyway (item 3).
6. **The person: none.** No check needs anh Dee's login, dial or eye: never the person's own WezTerm or kitty.
7. **Proposal (not in this branch):** a `dialHostPaneFocus.e2e.ts` on the existing `cli-e2e-dial-hosts.yml` job with
   the real kitty under its X11 desk (`kittyWindow.ts`) and a WezTerm GUI under it (the job's WezTerm is a mux server
   now, which lists no GUI client), so later pull requests check the real `get-colors --match` and `list-clients`.
8. **For the final report, not fixed here** (spec, "Same reach as the tap"): a daemon whose environment has no
   `XDG_RUNTIME_DIR` on Linux finds no WezTerm GUI, for the tap and the poll alike
   (`RECORDED_WEZTERM.listClients.noRuntimeDir`); WezTerm mux-domain panes are not covered.
