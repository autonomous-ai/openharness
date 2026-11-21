# Dial on Linux follow-ups (own Orca and herdr pane, herdr inside a terminal, GNOME's tap) Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** The dial's words reach only the pane Orca's terminal host or herdr made for the agent; an agent in herdr whose
client runs in a Linux terminal (or in the person's tmux or Zellij) is on that app's page and is reached there; GNOME's
tap check and raise ask about the same app.

**Architecture:** Devices process only. #4501's own-pane check (the host that made the caller's pty, `scannedApp.ts`)
gains Orca's terminal host and herdr; their adapters mark a pane they did not make as held through a new generic
`Pane.held`, which `observed.ts` ranks last for a tap and never types into, rests on or folds by. herdr's client lookup
(`herdrOuter.ts`) finds its server by the caller's pty maker, reads Linux's socket table, and asks the tmux and Zellij
lookups for a client inside them. Two new tab adapters (WezTerm, kitty) select the tab holding a multiplexer's client on
both OSes. `open.ts`'s tap check asks the raise about the agent's own window app.

**Tech Stack:** TypeScript (Node 24), Vitest unit and e2e suites, recordings in `cli/src/testing/recorded*.ts`, Podman
machine `devcrew-dlf` for recordings, PR CI's `dial-hosts` job for Linux e2e.

**Spec:** `docs/plans/2026-11-21-dial-linux-followups-design.md` (read it with this plan; its "Decided" section is
final).

## Global Constraints

- Devices process only: `cli/src/cable/hosts/`, `cli/src/services/devices.ts`. Nothing in `cli/src/core`, `cli/hook` or
  `cli/src/architecture.coreFiles.txt`.
- `observed.ts` and `open.ts` hold no rule about an app: they read only generic fields (`Pane.held`, `tap`, `canShow`).
- Never read another process's environment or argv: no `/proc/<pid>/environ`, no `/proc/<pid>/cmdline`, no `ps e`, no
  `kitten @ ls`. Process names are matched against fixed tables and dropped.
- Every command runs with no shell, every value from a hook or a tool is checked against its form, each run has
  `RUN_TIMEOUT_MS` (10 s) and bounded output; lookups at most once per pane and caller every `OUTER_EVERY_MS` (5 s), one
  in flight; at most `HERDR_CLIENTS_A_LOOKUP` (16) herdr processes besides the server.
- Process names come from the recordings of Tasks 1-4, never guessed.
- Log lines carry step and outcome words only, never a pid, tty, pane id, handle, path or name. New lines:
  `[device] orca · held`, `[device] herdr · held` (once per caller process).
- Windows: no behaviour change (no maker read there; Orca and herdr keep typing by their hint).
- macOS: the reference. Changes there are only those the spec names (own pane by maker, herdr's server by maker, herdr
  in the person's tmux/Zellij placed by its client, the WezTerm/kitty tab of an outer place).
- Recordings run only on the Podman machine `devcrew-dlf`, always with `podman --connection devcrew-dlf …` (the default
  connection is another machine), in disposable `--rm` containers. Never `harness` or `podman-machine-default`.
- Every behaviour task: a red commit (the failing test), then a green commit (the code). Run only the tests of what
  changed (`cd cli && npx vitest run <spec> -t '<name>'`), plus `npm run typecheck` when a type or signature changed.
  No full local suite until the Verification section.
- Comments say why; copy and docs in English; names per `docs/naming-system.md`. Commit nothing of this plan.

## Review Focus

1. **A maker read that fails or is slow** (`ps` past its timeout, the caller gone mid-walk) for an Orca or herdr caller:
   its pane stays held, no word goes to any other pane by mistake, no `held` line is said for a read that did not land,
   and a later event reads again no sooner than 10 s (`TTY_RETRY_MS`). Test in Task 13.
2. **A held Orca pane in the devices' Orca paths** (ring order, the worktree-on-screen scope, Orca's focus follow,
   placement by folder): a held pane counts as no Orca pane there, so the agent can be placed by folder, and the
   terminal's handle stays free for the agent really in it. Test in Task 13 (`devices.spec.ts`).
3. **Two herdr servers on Linux** (the default session and a named one, each with its `herdr-client.sock`): only the
   server that made the caller's terminal counts, and only peers of its own sockets are its clients. Test in Task 15.
4. **WezTerm's `cli list` out of form** (not JSON, not an array, a `pane_id` out of form, no `tty_name`, more entries than
   the bound): no `activate-pane` runs and the rest answers `failed`. Test in Task 17.
5. **kitty's socket hint for a tab** owned by another account: no command runs; Linux's abstract socket takes the tab's
   focus (a focus, never words), as kitty's own adapter allows a tap there. Test in Task 18.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | Record Orca's terminal hosts | high | - |
| 2 | Record herdr 0.9.5 on Linux | high | - |
| 3 | Record WezTerm's pane list | medium | - |
| 4 | Record kitty's focus by process | medium | - |
| 5 | The pty's maker, and herdr as one | high | 2 |
| 6 | Orca's terminal host as a maker | medium | 1 |
| 7 | WezTerm's mux server names WezTerm's app on Linux | medium | 3 |
| 8 | The first outer lookup keeps its client's process | medium | - |
| 9 | Linux's client tty form, and tmux's lookup gives it | medium | - |
| 10 | GNOME's tap check asks about the agent's own app | high | - |
| 11 | A held pane: generic, last for a tap, no words, rest or key | xhigh | - |
| 12 | The client's process for the raise alone; a tab raised after a tap | high | - |
| 13 | Orca's and herdr's pane is the agent's own only on their pty | xhigh | 2, 11 |
| 14 | herdr's server is the maker of the caller's terminal | high | 5 |
| 15 | herdr's clients on Linux | xhigh | 2, 9 |
| 16 | herdr's client inside tmux or Zellij, or in a terminal with no page | high | 14 |
| 17 | WezTerm's tab of an outer place | high | 3, 9 |
| 18 | kitty's tab of an outer place | high | 4 |
| 19 | The devices list the WezTerm and kitty tabs | high | 17, 18 |
| 20 | e2e harness: Orca's terminal host stand-in | high | 1 |
| 21 | e2e harness: WezTerm mux server with an environment and a command | medium | - |
| 22 | e2e harness: a herdr client from any terminal, on Linux too | high | 2 |
| 23 | e2e: the voice reaches the agent's own pane, Orca | high | 6, 11, 13, 20, 21 |
| 24 | e2e: the voice reaches the agent's own pane, herdr | high | 5, 11, 13, 14, 21, 22 |
| 25 | e2e: herdr's client in WezTerm | high | 7, 13, 14, 15, 17, 19, 21, 22 |
| 26 | e2e: herdr's client in an xterm | high | 8, 12, 13, 14, 15, 16, 22 |
| 27 | e2e: herdr's client in kitty | high | 13, 14, 15, 18, 19, 22 |
| 28 | e2e: herdr's client in Zellij | high | 7, 13, 14, 15, 16, 21, 22 |
| 29 | Docs | medium | 6, 9, 10, 13, 15, 16, 17, 18 |
| 30 | linux-e2e runs the Orca e2e files when the stand-in or Orca's adapter changes | high | 20 |

Files shared by tasks (devcrew runs them one at a time, in any order): `observed.ts` (10, 11, 12, 13), `observed.spec.ts`
(10, 11, 12, 13), `open.spec.ts` (10, 13), `devices.ts` (10, 13, 14, 15, 16, 19), `devices.spec.ts` (10, 13, 19),
`scannedApp.ts` (5, 6), `wezterm.ts` (11, 17), `kitty.ts` (11, 18), `herdrOuter.ts` (14, 15, 16), `scripts/ci-plan.py`
(20, 30).

Longest chain: 2 → 5 → 14 → 16 → 26 (five tasks).

---

## Recordings

Each recording task writes one file of facts, in the style of `cli/src/testing/recordedKitty.ts`: a header saying when,
where (`devcrew-dlf`, image, arch), how (each command), the versions and checksums; then each value as the tool printed
it. User `u` (uid 1000), host `box`, folder `/work`; a path under a person's home is written with `/home/u` or
`/Users/u`; no other personal value. Pids are kept as recorded (they are the container's). One commit, no test: data only.
The four may run at once, each in its own container.

### Task 1: Record Orca's terminal hosts

**Files:** Create `cli/src/testing/recordedOrca.ts`.
**Depends on:** none. **Effort:** high. **Failing test first:** none (data).

**Produces:** `export const RECORDED_ORCA` with, at least:
- `macos: { version: string; chain: ReadonlyArray<{ comm: string; tty: string | null }> }`: from a shell in an Orca
  terminal up to the first process on no tty or another one; the last is the maker (`…/Orca Agents.app/Contents/MacOS/Orca Agents`).
- `linux: Readonly<Record<'deb' | 'appimage' | 'inProcess', { version; source; sha256; arch; how; chain; makerComm: string }>>`
  for each mode recorded (a mode not recorded is absent here and present in `notCovered`).
- `notCovered: ReadonlyArray<{ mode: string; why: string }>`, and `sourceCommit`: the stablyai/orca commit read.

- [ ] **Step 1:** Read stablyai/orca at its newest release ≥ 1.4.267: `src/main/daemon/executable-host/linux/`, its macOS
  sibling, and the code that picks the host or falls back to making the pty in-process. Note each mode, how it is
  triggered, and the host executable's file name per OS.
- [ ] **Step 2 (macOS, this Mac, names only):** Orca's version
  (`plutil -extract CFBundleShortVersionString raw /Applications/Orca.app/Contents/Info.plist`), and for the recorder's
  own shell when it runs in an Orca terminal, `ps -o ppid=,tty=,comm= -p <pid>` up its parents to the maker. Nothing else
  of this Mac is read; Orca is not restarted. A macOS fallback mode, if the source has one, is `notCovered` (it cannot be
  triggered without disturbing this Mac's Orca).
- [ ] **Step 3 (Linux):** `podman --connection devcrew-dlf run --rm ubuntu:24.04` (arm64; `--platform linux/amd64` when
  Orca ships no arm64 Linux build, as `recordedLinuxApps.ts` did). Install the `.deb`; run the app under `xvfb-run -a …
  --no-sandbox` as `u`; open a terminal in a worktree through Orca's own CLI; record `ps -o pid=,ppid=,tty=,comm=` from
  the shell in it up to the maker. Then the AppImage (`--appimage-extract-and-run` when FUSE is absent), the same way.
  If the window cannot start, Orca's own `orca-server` build, said so in `how`.
- [ ] **Step 4:** The in-process fallback, when the source has one: trigger it as the source allows (for example the
  host executable absent) and record the maker's `comm`.
- [ ] **Step 5 (stop rules):** A mode that cannot be recorded goes in `notCovered` with why. **Stop and report** to the
  main session, writing nothing more, when no Linux mode records (the strict rule would take Orca's words away on Linux,
  an anti-goal), or when a maker's `comm` is a generic program's name (`node`, `electron`, `python3`, `sh`, `bash`, `zsh`):
  a table row for it would claim other programs' terminals for Orca.
- [ ] **Step 6:** Write the file; commit it.

### Task 2: Record herdr 0.9.5 on Linux

**Files:** Create `cli/src/testing/recordedHerdr.ts`.
**Depends on:** none. **Effort:** high. **Failing test first:** none (data).

**Produces:** `export const RECORDED_HERDR` with, at least:
- `version` (0.9.5), `source`, `sha256`, `arch`, `iproute2`, `procps`, `paths: { ps: string; ss: string }` (where each is
  on Ubuntu 24.04).
- `table`: `ps -axo pid=,ppid=,comm=` stdout of the scene: the default server, client A and client B (each `herdr` in a
  pty of its own, from `script -qfc herdr /dev/null` or a pty helper), a long-lived `herdr agent …` command, a shell and
  the cc fake agent (`herdrServer.ts` `FAKE_AGENT`, named `claude`) in a pane, and a named session's server
  (`herdr --session other`) with one client.
- `ttys`: `ps -o pid=,tty= -p <the herdr pids>` stdout. `ttyOf`: each scene process's `ps -o tty= -p <pid>` (for the
  maker walk).
- `ss`: `ss -xn` stdout (whole, in a container that holds only the scene), with its byte count and run time; and
  `ssWithProcesses`: `ss -xpn` stdout, to confirm the pairs.
- `fds`: for each herdr pid, the `readlink` of each `/proc/<pid>/fd/<n>` that reads `socket:[<inode>]`.
- `noSession`: `ps` rows and ttys of `herdr --no-session` with an agent in a pane (the panes run under the client).
- `atime`: whether `stat -c %X /dev/pts/<client>` moves after typing into the client, and after how long.
- `nested`: whether herdr's agent listing (`agent.list` on `herdr.sock`, as `herdrSource.ts` asks) names an agent in
  pane P when the agent runs in a terminal started in P (a `script` pty in P running the fake `claude`): by herdr's own
  process detection, and by a report as herdr's own Claude Code integration sends one, if herdr 0.9.5 has one
  (`herdr --help`, its docs): `{ byProcess: { listed: boolean }; byReport: { listed: boolean; agentSession?: string } | 'no integration' }`.

- [ ] **Step 1:** Container as in Task 1 (herdr's arm64 build if released, else amd64 under qemu); `apt-get install
  iproute2 procps gcc`; the release binary, sha256 checked.
- [ ] **Step 2:** Build the scene; record each value above.
- [ ] **Step 3 (stop rule):** **Stop and report** when `ss -xn` shows the server's accepted connections without the
  `…/herdr-client.sock` path or without the peer's inode, or `/proc/<pid>/fd` links of the account's own herdr processes
  cannot be read: Task 15's read rests on these.
- [ ] **Step 4:** Write the file; commit it.

### Task 3: Record WezTerm's pane list

**Files:** Create `cli/src/testing/recordedWezterm.ts`.
**Depends on:** none. **Effort:** medium. **Failing test first:** none (data).

**Produces:** `export const RECORDED_WEZTERM` with `version` (20240203-110809-5046fc22, as `cli-e2e-dial-hosts.yml`),
`muxServerComm` (`ps -o comm=` of `wezterm-mux-server`), `list` (stdout of `wezterm cli --no-auto-start list --format json`
with two tabs, the first with two panes), `activatePane` (the list before and after `activate-pane --pane-id <a pane of
the inactive tab>`: whether that tab became the window's active one), `activateTab` (the same for `activate-tab --tab-id`,
recorded only when `activate-pane` leaves the tab inactive), `missingPane` (exit code for a pane id that is not there).

- [ ] **Step 1:** Container as in Task 1; the release `.deb` (Ubuntu 22.04 build, as CI installs it); a headless
  `wezterm-mux-server` with `weztermMux.ts`'s config, driven by `wezterm cli` as `u`.
- [ ] **Step 2:** Record; write the file; commit it.

### Task 4: Record kitty's focus by process

**Files:** Modify `cli/src/testing/recordedKitty.ts`.
**Depends on:** none. **Effort:** medium. **Failing test first:** none (data).

**Produces:** in `RECORDED_KITTY`: `focusWindowPid` (kitty 0.32.2 under Xvfb as the file's header says; two tabs, window
1 in the inactive one; `kitten @ --to <socket> focus-window --match pid:<pid of window 1's own process, kitty's child>`:
argv, exit code, and whether window 1 and its tab became active, read with the recorder's own `ls`),
`focusWindowPidDescendant` (the same for a process two levels below that one), `focusWindowPidMissing` (a pid no window
holds).

- [ ] **Step 1:** Record as the file's header describes; extend the header.
- [ ] **Step 2 (stop rule):** **Stop and report** when `--match pid:<window's own process>` does not focus that window
  and its tab: Task 18 rests on it.
- [ ] **Step 3:** Commit.

---

## Code

### Task 5: The pty's maker, and herdr as one

**Files:** Modify `cli/src/cable/hosts/scannedApp.ts`; Test `cli/src/cable/hosts/scannedApp.spec.ts`.
**Depends on:** 2. **Effort:** high.

**Interfaces:**
- Consumes: `RECORDED_HERDR.table`, `.ttyOf`, `.noSession`.
- Produces:
  ```ts
  export interface PtyMaker { pid: number; host?: string }   // host: PTY_HOSTS' id, when listed
  export function ptyMaker(pid: number, rows: readonly PtyProcess[]): PtyMaker | undefined
  export async function readPtyMaker(pid: number, rows: readonly ProcessName[],
    tty: (pid: number) => Promise<string | undefined>): Promise<PtyMaker | undefined>
  // ptyOwner and readPtyOwner stay, as ptyMaker(...)?.host and (await readPtyMaker(...))?.host
  ```
  `PTY_HOSTS` gains `herdr: 'herdr'`.

- [ ] **Step 1: Failing tests** in `scannedApp.spec.ts`, `describe('the process that made a pseudo-terminal')`:
  - `ptyMaker over herdr's recorded scene: an agent in a pane is made by the server` →
    `{ pid: <server pid>, host: 'herdr' }`; `--no-session`: `{ pid: <client pid>, host: 'herdr' }`.
  - `a maker no table lists: its pid and no host`; `a process on no terminal, or a walk that ends first: undefined`.
  - `readPtyMaker reads ttys one at a time up to the maker, and rejects as readTtyName does`.
  - `macOS: herdr by its path's last part` (`/Users/u/.local/bin/herdr` → `herdr`).
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/scannedApp.spec.ts` → FAIL (`ptyMaker` not exported).
- [ ] **Step 3:** Implement; `ptyOwner`/`readPtyOwner` delegate. The comment names RECORDED_HERDR for `herdr`'s row.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 6: Orca's terminal host as a maker

**Files:** Modify `cli/src/cable/hosts/scannedApp.ts`; Test `cli/src/cable/hosts/scannedApp.spec.ts`.
**Depends on:** 1. **Effort:** medium.

**Interfaces:** Consumes `RECORDED_ORCA`. Produces `PTY_HOSTS` rows `'Orca Agents': 'orca'` and one per recorded Linux
`makerComm` → `'orca'`.

- [ ] **Step 1: Failing tests:** `ptyOwner over each recorded Orca chain is orca` (the macOS chain and every
  `RECORDED_ORCA.linux` mode, by iterating the record, so a mode added later is tested too); `a renamed terminal host
  (a made-up name) is no host`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/scannedApp.spec.ts` → FAIL.
- [ ] **Step 3:** Add the rows; the comment names `RECORDED_ORCA`, and that Orca from before its terminal host is not
  covered.
- [ ] **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 7: WezTerm's mux server names WezTerm's app on Linux

On macOS the mux server lives in WezTerm.app, so a client under it is in WezTerm by its bundle; on Linux its `comm` names
no app, so herdr's client in a WezTerm mux pane (the spec's e2e, and every mux-domain user) would sit on no page.

**Files:** Modify `cli/src/cable/hosts/frontApp.ts`; Test `cli/src/cable/hosts/frontApp.spec.ts`.
**Depends on:** 3. **Effort:** medium.

**Interfaces:** Consumes `RECORDED_WEZTERM.muxServerComm`. Produces `EXE_APPS` rows `'wezterm-mux-server': 'wezterm'` and
`'<recorded comm>': 'wezterm'`.

- [ ] **Step 1: Failing test:** `frontAppId names WezTerm for its mux server, whole and as Linux cuts it`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/frontApp.spec.ts` → FAIL. **Step 3:** Add the rows, comment citing the
  recording. **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 8: The first outer lookup keeps its client's process

**Files:** Modify `cli/src/cable/hosts/outer.ts`; Test `cli/src/cable/hosts/outer.spec.ts`.
**Depends on:** none. **Effort:** medium.

**Interfaces:** `firstOuter(first, second)` answers: the first's when it names an app; else the second's when that names
one; else the first's (which may hold only `pid`). Signature unchanged.

- [ ] **Step 1: Failing tests:** `a first answer with a client's process and no app is kept when the second names none`
  (`{ pid: 7 }` + `{}` → `{ pid: 7 }`); `the second's answer when it names an app` (`{ pid: 7 }` + `{ app: 'wezterm', pid: 9 }`
  → the second); `the second not nested: the first's` (`{ pid: 7 }` + `undefined` → `{ pid: 7 }`).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/outer.spec.ts` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit red, then green.

### Task 9: Linux's client tty form, and tmux's lookup gives it

**Files:** Modify `cli/src/cable/hosts/tabs.ts`, `cli/src/cable/hosts/tmux.ts`; Test `cli/src/cable/hosts/tabs.spec.ts`,
`cli/src/cable/hosts/tmux.spec.ts`.
**Depends on:** none. **Effort:** medium.

**Interfaces:** Produces in `tabs.ts` (which loads nothing of the daemon):
```ts
export const PTS_TTY = /^\/dev\/pts\/[0-9]{1,6}$/
/** The form of a multiplexer client's tty on [platform]: macOS's TAB_TTY, Linux's PTS_TTY; none elsewhere. */
export function clientTtyForm(platform: NodeJS.Platform): RegExp | undefined
```
`createTmuxOuter` answers the client's tty when it is in `clientTtyForm(deps.platform)`'s form (was `TAB_TTY` alone).

- [ ] **Step 1: Failing tests:** tabs.spec `clientTtyForm: macOS ttys, Linux pts, none on Windows` (`/dev/pts/3` passes
  on linux, fails on darwin; `/dev/ttys004` the reverse; `/dev/pts/../x` fails); tmux.spec `Linux: a client in a WezTerm
  window on /dev/pts/3: its app, tty and process`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/tabs.spec.ts src/cable/hosts/tmux.spec.ts` → FAIL.
- [ ] **Step 3:** Implement. `TAB_TTY` and `tabOf` stay as they are (Harness Device's tabs are macOS's).
- [ ] **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 10: GNOME's tap check asks about the agent's own app

**Files:** Modify `cli/src/cable/hosts/open.ts`, `cli/src/cable/hosts/observed.ts` (`ObservedActions.canOpen` and its two
calls), `cli/src/services/devices.ts` (the `open` wrapper's `opener.can`); Test `cli/src/cable/hosts/open.spec.ts`,
`cli/src/cable/hosts/observed.spec.ts` (its fake `canOpen`), `cli/src/services/devices.spec.ts` only where a test calls `can`.
**Depends on:** none. **Effort:** high.

**Interfaces:**
```ts
// open.ts createOpenActions
can(agentId: string, target: OpenTarget): boolean
// observed.ts ObservedActions
canOpen(agentId: string, target: OpenTarget): boolean
```
The raise's check is `raise.ready({ agent: true, app: deps.windowOf?.(agentId)?.app })`, the app `raiseWindow` uses;
`appOf` goes.

- [ ] **Step 1: Failing tests** in open.spec:
  - `Linux: can() asks the raise about the agent's own window app, the one the raise uses` (windowOf gives `claude`, the
    target's bundle names none or another app → `ready` asked with `{ agent: true, app: 'claude' }`).
  - Contract, `GNOME: the check and the raise ask about the same class` — `createLinuxRaise` over a GNOME desktop with
    `createGnomeRaise` on a fake `gdbus` that answers as `RECORDED_GNOME_SHELL.activateHit`; an agent whose app was
    learnt from its parents (`claude`, no bundle): `can` is true and the tap runs `activateByWmClass` with
    `com.anthropic.Claude`; an agent whose app has no class (`herdr`) with no pane: `can` is false and nothing runs.
  - The existing `can() asks the raise for an agent's window in the app its bundle names` is replaced by the first.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/open.spec.ts` → FAIL.
- [ ] **Step 3:** Implement; update the callers and fakes.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts` → PASS;
  `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 11: A held pane: generic, last for a tap, no words, rest or key

**Files:** Modify `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/wezterm.ts`,
`cli/src/cable/hosts/kitty.ts`, `cli/src/cable/hosts/zellij.ts`; Test `cli/src/cable/hosts/observed.spec.ts`,
`cli/src/cable/hosts/wezterm.spec.ts`, `cli/src/cable/hosts/kitty.spec.ts`, `cli/src/cable/hosts/zellij.spec.ts`.
**Depends on:** none. **Effort:** xhigh.

**Interfaces (produces):**
```ts
// adapter.ts
export interface Pane { adapter: string; id: string
  /** The pane holds the agent's terminal but its host did not make it: a tap alone, after the agent's other panes. */
  held?: true }
// Place.ptyOwner: undefined while not read; null once read and no host the dial types into made it
ptyOwner?: string | null
/** Says [line] once per caller process, at most CALLERS_KEPT (64) kept, the oldest going first. */
export function oncePerCaller(log: (line: string) => void, line: string): (pid: number | undefined) => void
```
`observed.ts`:
- `PTY_HINTS` = `['WEZTERM_PANE', 'KITTY_WINDOW_ID', 'ZELLIJ_PANE_ID', 'HERDR_PANE_ID', 'ORCA_TERMINAL_HANDLE']`.
- `learnPtyOwner`: a read that lands stores `owner ?? null` and places the agent again (its adapters may log), and tells
  the change only when it named a host, as today.
- `words` and `rest` skip a held pane; `paneOf(agentId, adapter)` names no held pane (a held pane is not the agent's: the
  devices' Orca ring, scope and scroll then treat it as none).
- `list()`'s `paneKeys`: a held pane's key is listed as an own pane's while the agent's maker is not read yet
  (`place.ptyOwner === undefined`), so a listing source's row for that pane folds into the hooked agent and the list
  shows no two rows in the first moments after a hook (PM answer 2, 2026-11-21); once the read landed, held panes' keys
  are left out.
- `ObservedSource.holds(key: string, asker: { engine: string; sessionId?: string }): boolean`: whether a live agent
  holds a pane whose adapter's `paneKey` is [key] (`Pane.held`) and the asker's row folds into it: that agent's maker is
  not read yet, or the asker carries that agent's session (the same agent, wherever another source lists it). A source
  that types into panes asks it before typing (Task 13: herdr's), so whatever folds with a held pane takes no words
  there by that source's route either.
- `target()`: the pane of the host that made the agent's pty, as today; else the first tappable pane not held; else the
  first held one.
WezTerm, kitty and Zellij set `held: true` on the panes they already prefix `held:`.

- [ ] **Step 1: Failing tests** in observed.spec (fake adapters named `a`/`b`, no app's name):
  - `a tap takes the maker's pane, then the first that is not held, and a held one last`.
  - `no words and no rest go to a held pane: the next pane whose app types takes them`.
  - `a held pane's key folds no source's row once the maker is read, and paneOf names no held pane`.
  - `a pane held until its maker is read lists its key as an own pane does, and drops it once the read names another
    host` (the agent's `paneKeys`: the fake adapter's key, then none).
  - `holds: a pane held until its maker is read holds any asker; once read, only the asker of that agent's session; an
    own pane, an ended agent or another key holds none`.
  - `an Orca terminal's and a herdr pane's caller has its maker read once, as WezTerm's`.
  - `a read that names no host lands as null and places the agent again, telling no change`.
  And in wezterm.spec, kitty.spec, zellij.spec: `a held pane says so; an own one does not`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/wezterm.spec.ts src/cable/hosts/kitty.spec.ts src/cable/hosts/zellij.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 12: The client's process for the raise alone; a tab raised after a tap

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.
**Depends on:** none. **Effort:** high.

**Interfaces (produces):**
- `Entry.outerPid?: number`: an outer answer with a pid in form and no app sets it; any other answer, and another caller
  or hints (`askOuter`'s `same`), clear it. It is never a page, a tab or a pane: only
  `windowOf(agentId) = { pid: e.outer?.pid ?? e.outerPid ?? e.caller ?? e.pid, app }`.
- `focus()`: after an open that answered true, a nested agent (`e.outer`) raises the first of its panes (`shownOnly`)
  whose adapter has `tap: 'after'` and can focus, without asking `canShow`: a tab whose rest waits for its app in front
  (Tasks 17, 18) would otherwise be skipped while the front report lags the open. A non-nested agent is as today.

- [ ] **Step 1: Failing tests:**
  - `an outer answer with only its client's process: no page, tab or pane moves, and the raise gets that process`.
  - `another caller drops the kept process`.
  - `a tap on a nested agent raises its after-app pane once the open answered, before the front names that app`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/observed.spec.ts -t "client's process|after-app"` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 13: Orca's and herdr's pane is the agent's own only on their pty

**Files:** Modify `cli/src/cable/hosts/orca.ts`, `cli/src/cable/hosts/herdr.ts`, `cli/src/cable/hosts/herdrSource.ts`,
`cli/src/services/devices.ts` (herdr adapter's `log`, herdr source's `held`); only in the no-session branch below,
`cli/src/cable/hosts/observed.ts` and `cli/src/cable/hosts/types.ts`; Test `cli/src/cable/hosts/orca.spec.ts`,
`cli/src/cable/hosts/herdr.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/cable/hosts/open.spec.ts`,
`cli/src/cable/hosts/herdrSource.spec.ts`, `cli/src/services/devices.spec.ts`.
**Depends on:** 2 (the nested-listing branch), 11. **Effort:** xhigh.

**Interfaces:**
- Consumes `Pane.held`, `Place.ptyOwner: string | null`, `oncePerCaller`, `ObservedSource.holds` (Task 11);
  `RECORDED_HERDR.nested` (Task 2).
- Produces:
  - `orca.ts` `paneOf`: as today for a multiplexer host (none) and an id out of form (none); on `win32` the handle as
    today; else `{ id: handle }` when `place.ptyOwner === 'orca'`, else `{ id: 'held:' + handle, held: true }`, and once
    the read landed (`ptyOwner !== undefined`) `oncePerCaller(log, '[device] orca · held')(place.pid)`. `focus` strips
    `held:` (the terminal switch, a tap alone); `show` and `type` refuse a held id.
  - `herdr.ts`: `HerdrAdapterDeps.log(line: string): void`; `paneOf` the same rule with `'herdr'` and
    `[device] herdr · held`; a held id is `held:<bare id>` (no app); `focus` runs `herdr agent focus` on the bare id;
    `show`, `canShow` and `type` refuse a held id.
  - `herdrSource.ts`: `HerdrSourceDeps.held(paneKey: string, asker: { engine: string; sessionId?: string }): boolean`,
    asked with the row's `herdrPaneKey(pane)`, engine and session (when herdr gave one) before `deps.prompt`; true →
    `{ outcome: 'failed', fault: 'not_that_agent' }` and no prompt runs. devices.ts wires it to `observed.holds`.
    Whatever folds with a held herdr pane then takes no words into that pane, by the hooked route (Task 11) or by
    herdr's row (the spec's Design § 1).
  - Only in the no-session branch below: `types.ts` `enginePaneKey(engine: string, key: string): string` (the key a row
    folds by only under its engine); herdrSource lists a row with no session under `enginePaneKey(engine,
    herdrPaneKey(pane))` beside its pane key; `observed.ts` lists a held pane whose maker is read under
    `enginePaneKey(agent.engine, paneKey)`, and `holds` is also true for an asker with no session of that agent's
    engine. A row of another engine keeps its own row and its words.

- [ ] **Step 1: Failing tests:**
  - orca.spec: `an Orca terminal is the agent's own only when Orca's terminal host made its terminal` (`'orca'` → own;
    `undefined`, `null`, `'wezterm'` → held); `Windows: the agent's own, as today`; `a held terminal takes a tap alone:
    the switch runs, a rest and words do nothing`; `held is said once a caller, after the read, naming nothing`.
  - herdr.spec: the same four for herdr, and `--no-session`'s client as maker is own.
  - observed.spec (real Orca adapter, a fake typing adapter after it): `an agent in an editor started from an Orca
    terminal gets its words in the editor, never through orca terminal send` and `the same from a herdr pane, never
    through herdr's socket`.
  - Review Focus 1, observed.spec: `a maker read that fails leaves the Orca terminal held, says no held line, and is read
    again on an event 10 s later`.
  - Review Focus 2, devices.spec: `an agent whose Orca terminal is held takes no rank or scope from it, is placed by its
    folder, and leaves that terminal's handle to place another`.
  - herdrSource.spec: `a row whose pane the observed agents hold takes no words: not_that_agent, and no prompt runs`;
    `a row whose pane is not held is prompted as today`.
  - PM answer 2, devices.spec: `herdr's row of a pane a hooked agent holds until its maker is read folds into it, one
    row, and a voice to either id types nothing into that pane`.
  - Branch on `RECORDED_HERDR.nested` (read it first; the task's report names the branch taken):
    - listed with an `agentSession`: devices.spec `herdr's row of a pane a hooked agent only holds folds into the hooked
      copy by its session, its words go to the agent's own pane, and a voice to herdr's row's id types nothing into the
      herdr pane`;
    - listed with no session (PM answer 1): devices.spec `herdr's row of a pane a hooked agent only holds folds into the
      hooked agent of its engine, and no words go into that pane by either route`; `a row of another engine in that pane
      stays its own and takes its words there`; observed.spec `a held pane whose maker is read lists its engine's key`;
      the trade-off (a real other agent of the same engine in that pane is hidden behind the hooked one) goes in the
      PR copy;
    - not listed: the no-session branch is not built (no `enginePaneKey`, no change to `observed.ts` or `types.ts`);
      the report says so.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/orca.spec.ts src/cable/hosts/herdr.spec.ts src/cable/hosts/herdrSource.spec.ts`
  → FAIL.
- [ ] **Step 3:** Implement. Then make every existing Orca and herdr caller in the six spec files read as made by its host
  (observed.spec and open.spec: `ptyOwner: 'orca'`/`'herdr'` on the place or the fake read; devices.spec: rows for the
  caller and its maker in `readers.processes`/`readers.tty`), so those tests keep testing what they tested.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/orca.spec.ts src/cable/hosts/herdr.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/open.spec.ts src/cable/hosts/herdrSource.spec.ts src/services/devices.spec.ts`
  → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 14: herdr's server is the maker of the caller's terminal

**Files:** Modify `cli/src/cable/hosts/herdrOuter.ts`, `cli/src/services/devices.ts` (the lookup's `tty`); Test
`cli/src/cable/hosts/herdrOuter.spec.ts`.
**Depends on:** 5. **Effort:** high.

**Interfaces:** Consumes `readPtyMaker` (Task 5). Produces `HerdrOuterDeps.tty(pid: number): Promise<string | undefined>`
(`readTtyName` in devices.ts). The server is `readPtyMaker(pid, rows, deps.tty)` when its host is `herdr`; no server
when the maker is anything else. A failed tty read is `not read · processes`, as Zellij's lookup says.

- [ ] **Step 1: Failing tests:** `the server is the herdr that made the caller's terminal`; `a terminal started from a
  herdr pane (made by WezTerm, a herdr among its parents): {} and no socket or tty command runs`; `--no-session: the
  client that made the panes' terminals`; `a terminal that cannot be read: not read · processes`. Update the existing
  cases' tables with each caller's ttys.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL. **Step 3:** Implement; wire `tty`.
- [ ] **Step 4:** PASS; `npm run typecheck` passes. **Step 5:** Commit red, then green.

### Task 15: herdr's clients on Linux

**Files:** Modify `cli/src/cable/hosts/herdrOuter.ts`, `cli/src/services/devices.ts` (`onPath`, `sockets`); Test
`cli/src/cable/hosts/herdrOuter.spec.ts`.
**Depends on:** 2, 9. **Effort:** xhigh.

The read is `ss -xn` plus the socket descriptors of herdr's own processes (the spec's second form): it reads no other
process's descriptors, where `ss -p` walks every process of the account.

**Interfaces:**
- Consumes `RECORDED_HERDR` (`ss`, `fds`, `ttys`, `table`, `atime`), `clientTtyForm` (Task 9).
- Produces:
  ```ts
  export const FDS_A_PROCESS = 1024
  /** The socket inodes among a process's descriptors (/proc/<pid>/fd links that read socket:[<inode>]), at most
   *  FDS_A_PROCESS read; none when the folder cannot be read. Never rejects. */
  export async function procSockets(pid: number): Promise<readonly string[] | undefined>
  // HerdrOuterDeps gains
  onPath: OrcaDeps['onPath']
  sockets(pid: number): Promise<readonly string[] | undefined>
  ```
- The lookup runs on `darwin` and `linux` (`undefined` at once on `win32`). On Linux: `ss` from `onPath('ss')` (none:
  `not read · sockets`), `ss -xn` once; a row's local path ending `/herdr-client.sock` whose local inode is one of the
  server's sockets gives a peer inode; a herdr pid (at most 16 besides the server) holding one of those peers is a
  client. Rows are parsed by a pattern anchored at both ends (a path may hold spaces); a row out of form is passed over.
  ttys from `/bin/ps -o pid=,tty= -p …` in `clientTtyForm('linux')`'s form; the client used last by that tty's access
  time. macOS keeps `lsof`.

- [ ] **Step 1: Failing tests** (platform `linux`, the recorded scene):
  - `Linux: one client in a WezTerm window: wezterm and its /dev/pts tty`.
  - `a herdr agent command is no client`; `two clients: the pts typed into last wins`.
  - Review Focus 3: `a second server's clients are no clients, nor peers of another server's socket`.
  - `no ss: not read · sockets`; `a descriptor folder that cannot be read leaves that process out`; `ss rows out of form
    are passed over`; `Windows: undefined at once and nothing runs`; `its lines name no pane, pid, tty, path or app`.
  - `procSockets reads at most 1024 descriptors and only socket links` (a temp folder of links stands in for /proc).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL. **Step 3:** Implement; wire the deps.
- [ ] **Step 4:** PASS; `npm run typecheck` passes. **Step 5:** Commit red, then green.

### Task 16: herdr's client inside tmux or Zellij, or in a terminal with no page

**Files:** Modify `cli/src/cable/hosts/herdrOuter.ts`, `cli/src/services/devices.ts` (one tmux and one Zellij lookup,
shared); Test `cli/src/cable/hosts/herdrOuter.spec.ts`.
**Depends on:** 14. **Effort:** high.

**Interfaces:**
- Produces `HerdrOuterDeps.inner: OuterLookup`. In devices.ts: `const multiplexers = firstOuter(tmuxOuter, zellijOuter)`,
  given to `createHerdrOuter({ …, inner: multiplexers })`, and the observed source's lookup is
  `firstOuter(herdrOuter, multiplexers)` (the same two instances, so their 5 s answers are shared).
- After the clients' apps: the client used last among those with an app, as today. With none: the client used last among
  the rest is asked of `inner(hints, clientPid)` with the agent's hints (what herdr's server inherited); an answer that
  names an app is the place; else `{ pid: client }` (no page; Linux's raise brings its window). `found` when an app was
  named, `none` otherwise.

- [ ] **Step 1: Failing tests:** `a client whose terminal tmux made: tmux's lookup is asked for the client with the
  agent's hints, and its place is the answer`; `the same through Zellij's`; `a client in a terminal with no page and no
  multiplexer: the client's process alone`; `a client with an app still wins over one inside tmux`. The existing
  `a client whose parents name no listed app answers {}` and `herdr in Herdr's terminal …` now answer `{ pid }`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL. **Step 3:** Implement; wire.
- [ ] **Step 4:** PASS; `npm run typecheck` passes. **Step 5:** Commit red, then green.

### Task 17: WezTerm's tab of an outer place

**Files:** Modify `cli/src/cable/hosts/wezterm.ts`; Test `cli/src/cable/hosts/wezterm.spec.ts`.
**Depends on:** 3, 9. **Effort:** high.

**Interfaces:**
- Consumes `RECORDED_WEZTERM` (`list`, `activatePane`, `activateTab`), `clientTtyForm`.
- Produces:
  ```ts
  export const LISTED_PANES_MAX = 256
  export function createWeztermTabAdapter(deps: OrcaDeps & { front(): string | undefined }):
    HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>   // id 'wezterm-tab', tap 'after'
  ```
  The binary finder becomes module-level, shared with `createWeztermAdapter`.
- `paneOf`: `place.outer?.app === 'wezterm'` and `place.outer.tty` in `clientTtyForm(deps.platform)`'s form → `{ id: tty }`;
  else none. `canFocus`: the id in form. `canShow`: that and `front() === 'wezterm'`. `show`/`focus`: one
  `cli --no-auto-start list --format json`; of at most 256 entries, `pane_id` (`/^[0-9]{1,9}$/`) and `tty_name` alone are
  read; the entry whose `tty_name` is the id → `activate-pane --pane-id <id>` (and, when `RECORDED_WEZTERM.activatePane`
  shows the tab left inactive, `activate-tab --tab-id <its tab_id>` first, `tab_id` in the same form).

- [ ] **Step 1: Failing tests:** `a place in WezTerm's window by its client's tty is a tab that comes after the app`
  (no outer, another app, a tty out of form, Windows → none); `a rest shows it only while WezTerm is in front`; `show
  lists once and activates the pane holding the client's tty` (exact argv from the recording); Review Focus 4: `a list
  out of form activates nothing and fails`; `a list that failed: failed, and wezterm is looked for again`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/wezterm.spec.ts` → FAIL. **Step 3:** Implement.
- [ ] **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 18: kitty's tab of an outer place

**Files:** Modify `cli/src/cable/hosts/kitty.ts`; Test `cli/src/cable/hosts/kitty.spec.ts`.
**Depends on:** 4. **Effort:** high.

**Interfaces:**
- Consumes `RECORDED_KITTY.focusWindowPid`, `parentChain`/`ProcessName` (scannedApp.ts).
- Produces:
  ```ts
  export function createKittyTabAdapter(deps: KittyDeps & {
    front(): string | undefined; processes(): Promise<readonly ProcessName[]> }):
    HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>   // id 'kitty-tab', tap 'after'
  ```
  `socketOf`, `ours` and `remote` become module-level, shared with `createKittyAdapter`.
- `paneOf`: not on `win32`; `place.outer?.app === 'kitty'`, `place.outer.pid` in `PID`'s form, `place.hints.KITTY_LISTEN_ON`
  in form → `{ id: '<pid>@<socket>' }`. `canShow`: in form and `front() === 'kitty'`. `show`/`focus`: `ours(path)`; one
  table read; the window's process is the first of the client's chain whose parent's name is `kitty`; then
  `kitten @ --to <socket> focus-window --match pid:<that pid>`. None found → `failed`/false, nothing runs.

- [ ] **Step 1: Failing tests:** `a place in kitty by its client's process and the hinted socket is a tab after the app`
  (no socket, out of form, Windows → none); `show focuses the window whose own process holds the client` (argv as
  recorded); `no kitty among the client's parents: nothing runs`; Review Focus 5: `a socket at a path not this account's:
  nothing runs; an abstract socket takes the focus`; `a rest only while kitty is in front`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/kitty.spec.ts` → FAIL. **Step 3:** Implement.
- [ ] **Step 4:** PASS. **Step 5:** Commit red, then green.

### Task 19: The devices list the WezTerm and kitty tabs

**Files:** Modify `cli/src/services/devices.ts`; Test `cli/src/services/devices.spec.ts`.
**Depends on:** 17, 18. **Effort:** high.

**Interfaces:** Consumes `createWeztermTabAdapter`, `createKittyTabAdapter`. Both join the adapters beside
`createTabsAdapter`, each through `noting`, with `front: () => cableHost.latestFront()` and, for kitty's,
`processes: readProcessNames` and the kitty deps its own adapter gets.

- [ ] **Step 1: Failing test:** `an agent in the person's tmux whose client is in a WezTerm pane: a rest with WezTerm in
  front lists WezTerm's panes, activates the client's, then selects the tmux pane` (the run log in that order; with
  another app in front, none of them).
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts -t 'client is in a WezTerm pane'` → FAIL.
- [ ] **Step 3:** Wire. **Step 4:** PASS; `npm run typecheck` passes. **Step 5:** Commit red, then green.

---

## End-to-end

Each e2e file is skipped where its host is not installed and fails on a dial-hosts run when one is missing
(`dialHost()`, `e2e/harness/dialHosts.ts`). Every case uses the harness's throwaway home and data folder, a private
server of each host, the fake dial and desk, the fake backend, the fake `open` and the fake `orca`; never this
computer's Orca, herdr, tmux, daemon (port 18473), `~/.claude` or `~/.codex`. Each case's log check: no folder, words,
handle or pane id in the daemon's log. The harness tasks change no product behaviour: one commit each, no red. The e2e
tasks check the behaviour Tasks 5-19 made, whose red tests are theirs: one commit each. `npm run typecheck` reads `src/`
only, so each harness and e2e task is checked by running its files:

- **This Mac:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.dialHosts.config.ts e2e/<file>` (a `dialHost*`
  file) or `--config vitest.e2e.config.ts` (any other).
- **Linux, before the commit** (the run PR CI's `dial-hosts` job repeats): a disposable container on `devcrew-dlf` from
  the local image `localhost/dlf-dial-hosts:1`, which mirrors `.github/workflows/cli-e2e-dial-hosts.yml`'s installs
  (Ubuntu 24.04, Node 24.22.2, herdr 0.9.5, Zellij 0.44.3, WezTerm 20240203-110809-5046fc22, kitty, xvfb, openbox, wmctrl,
  xterm, x11-utils, sway, foot, tmux, gcc, python3; each host's arm64 build where released, else amd64 under qemu). Its
  Containerfile lives in the session scratchpad, never committed; the first task that finds the image missing builds it.
  The branch is copied in (never mounted read-write), `npm ci`, then
  `E2E_DIAL_HOSTS=1 npx vitest run --config vitest.e2e.dialHosts.config.ts e2e/<file>` as user `u`.

### Task 20: e2e harness: Orca's terminal host stand-in

The strict rule makes an Orca pane the agent's own only on a pty Orca's terminal host made, so `InOrca`, which ran its
hooks from the test's own process, would leave every Orca e2e (dialOrcaFocus, dialOrcaFullRing, dialStream,
dialPaneFollow, dialClaudeAppFollow, dialVscodeFollow, deviceHerdrApp) with a held pane.

**Files:** Create `cli/e2e/harness/orcaHost.ts`; Modify `cli/e2e/harness/inOrca.ts`, `scripts/ci-plan.py`
(`DIAL_HOST_PATHS` gains `inOrca`, `orcaHost`, `fakeOrca`, which Task 23's file imports).
**Depends on:** 1. **Effort:** high.

**Interfaces (produces):**
```ts
/** A stand-in for Orca's terminal host: a forkpty helper built with cc under the name Orca's host has on this OS
 *  (RECORDED_ORCA: `Orca Agents` on macOS, the recorded comm on Linux), whose child, on that pty, is one long-lived
 *  runner that starts each command it is sent with pipes. The runner is the caller of every hook run through it. */
export interface OrcaTerminal {
  readonly pid: number
  run(file: string, args: string[], env: NodeJS.ProcessEnv, stdin: string, cwd: string):
    Promise<{ stdout: string; stderr: string; code: number | null; ms: number }>
  close(): Promise<void>
}
export async function orcaTerminal(d: IsolatedDaemon, children: ChildProcess[]): Promise<OrcaTerminal>
```
`InOrca` runs every hook through one `OrcaTerminal` (started at its first run, closed with the test's children) when its
hints carry `ORCA_TERMINAL_HANDLE`; otherwise as today. `orcaTerminal` checks once at start that the runner's parent's
name is the recorded one, and throws naming the difference otherwise.

- [ ] **Step 1:** Implement; skip like `herdrServer.ts` where `cc` is missing (`dialHost('cc', …)`).
- [ ] **Step 2:** On this Mac and in the Linux container (both as the e2e section says, `--config vitest.e2e.config.ts`):
  `e2e/dialOrcaFocus.e2e.ts e2e/dialOrcaFullRing.e2e.ts e2e/dialStream.e2e.ts` → PASS (with or without Task 13 in).
- [ ] **Step 3:** `python3 -m unittest discover -s scripts/tests -p test_ci_plan.py` → OK.
- [ ] **Step 4:** Commit.

### Task 21: e2e harness: WezTerm mux server with an environment and a command

**Files:** Modify `cli/e2e/harness/weztermMux.ts`. **Depends on:** none. **Effort:** medium.

**Interfaces (produces):** `PrivateWezterm.start(d, env?: NodeJS.ProcessEnv)` (variables its panes inherit, as a WezTerm
started from another app's pane keeps them); `run(argv: string[], env?: NodeJS.ProcessEnv): Promise<{ pane: string; tty: string }>`
(a pane running that command; its tty from `cli list`); `activeTab(pane): Promise<boolean>` read back from `cli list`.

- [ ] **Step 1:** Implement. **Step 2:** In the Linux container: `e2e/dialHostWezterm.e2e.ts` → PASS (this Mac has no
  WezTerm). **Step 3:** Commit.

### Task 22: e2e harness: a herdr client from any terminal, on Linux too

**Files:** Modify `cli/e2e/harness/herdrServer.ts`. **Depends on:** 2. **Effort:** high.

**Interfaces (produces):** `PrivateHerdr.start(d, { lettered, env })` (`env`: variables the server inherits, as one
started from a kitty window or a Zellij pane keeps them); `client(start: (argv: string[], env: NodeJS.ProcessEnv) =>
Promise<{ pid: number }>)`: attaches a client from any terminal helper and resolves once the server holds one more
client connection (`tabClient` becomes a use of it); `clientConnections` counts on Linux from `ss -xn` and the server's
own `/proc/<pid>/fd` socket links (RECORDED_HERDR), on macOS from `lsof` as today; `focused(): Promise<string>`
(herdr's focused pane, from its API).

- [ ] **Step 1:** Implement. **Step 2:** On this Mac: `e2e/dialHerdrTerminal.e2e.ts e2e/deviceHerdr.e2e.ts` → PASS; in
  the Linux container: `e2e/deviceHerdr.e2e.ts` → PASS.
- [ ] **Step 3:** Commit.

### Task 23: e2e: the voice reaches the agent's own pane, Orca

**Files:** Create `cli/e2e/dialHostOrcaPane.e2e.ts`. **Depends on:** 6, 11, 13, 20, 21. **Effort:** high.

Cases:
- [ ] `an agent in a terminal Orca's host made takes the dial's words through orca terminal send` (macOS and Linux, needs
  `cc`): `InOrca` with a handle; its row gains the voice cap once the read lands; a voice → the fake `orca` was asked
  `terminal send --terminal <handle>` with the words; `[device] voice · orca`; no `[device] orca · held`.
- [ ] `an agent in a WezTerm pane started from that terminal takes them in WezTerm, and Orca gets none` (needs WezTerm):
  a mux server started with that terminal's `ORCA_TERMINAL_HANDLE` and Orca's own variables (`IN_ORCA`); the suite's
  fake Claude Code in a pane; a voice → the words in the pane's text (`wezterm cli get-text`); the fake `orca` asked no
  `terminal send`; `[device] voice · wezterm`; `[device] orca · held` exactly once.
- [ ] `an agent in a terminal started from that terminal, where no app types, gets no words, and Orca none` (macOS and
  Linux): the fake Claude Code in a fake Terminal tab (`tabUnder`, 'terminal-app') with the same variables; no voice
  cap; the fake `orca` asked no `terminal send`; `[device] orca · held` once.
- [ ] On this Mac → the WezTerm case skips (no WezTerm here), the other two PASS; in the Linux container → all three
  PASS. Commit.

### Task 24: e2e: the voice reaches the agent's own pane, herdr

**Files:** Create `cli/e2e/dialHostHerdrPane.e2e.ts`. **Depends on:** 5, 11, 13, 14, 21, 22. **Effort:** high.

Cases (herdr and WezTerm; skips on this Mac):
- [ ] `an agent in a herdr pane takes the dial's words there` (`PrivateHerdr.hooked`; `[device] voice · herdr`; the
  pane's screen holds them).
- [ ] `an agent in a WezTerm pane started from that herdr pane takes them in WezTerm, none in the herdr pane, and has no
  herdr client place`: a mux server started with that pane's `HERDR_PANE_ID`; a voice → the words in the WezTerm pane,
  not on the herdr pane's screen; `[device] herdr · held` once; no `[device] herdr client · found`.
- [ ] In the Linux container → PASS. Commit.

### Task 25: e2e: herdr's client in WezTerm

**Files:** Create `cli/e2e/dialHostHerdrWezterm.e2e.ts`. **Depends on:** 7, 13, 14, 15, 17, 19, 21, 22. **Effort:** high.

Cases (Linux with WezTerm and herdr; macOS skips without WezTerm):
- [ ] herdr's client in a WezTerm mux pane, a second WezTerm tab active; the hooked agent in a herdr pane → the dial
  lists it on WezTerm's page, one row, no herdr row.
- [ ] `harness hardware watch --json` says WezTerm is in front (as `dialHerdrTerminal.e2e.ts` drives it); a rest on the
  agent → the client's pane and tab are active (`activeTab`), and herdr's focused pane is the agent's.
- [ ] Another app in front: a rest moves neither.
- [ ] In the Linux container → PASS. Commit.

### Task 26: e2e: herdr's client in an xterm

**Files:** Create `cli/e2e/dialHostHerdrX11.e2e.ts`; Modify `cli/e2e/harness/x11Desk.ts` (`terminal` runs a given
command). **Depends on:** 8, 12, 13, 14, 15, 16, 22. **Effort:** high.

- [ ] herdr's client in an xterm on the X11 desk, another xterm active; the hooked agent in a herdr pane → it stays on
  herdr's page; a tap → `_NET_ACTIVE_WINDOW` is the client's xterm and herdr's focused pane is the agent's.
- [ ] In the Linux container → PASS. Commit.

### Task 27: e2e: herdr's client in kitty

**Files:** Create `cli/e2e/dialHostHerdrKitty.e2e.ts`; Modify `cli/e2e/harness/kittyWindow.ts` (a window running a given
command). **Depends on:** 13, 14, 15, 18, 19, 22. **Effort:** high.

- [ ] kitty with remote control under Xvfb; herdr's server started with that kitty's `KITTY_WINDOW_ID` and
  `KITTY_LISTEN_ON`; its client in window 1, window 2 (another tab) active; the hooked agent in a herdr pane → on kitty's
  page; kitty in front, a rest → window 1 active (the test's own `ls`) and herdr's focus on the agent's pane; another app
  in front → nothing moves.
- [ ] In the Linux container → PASS. Commit.

### Task 28: e2e: herdr's client in Zellij

**Files:** Create `cli/e2e/dialHostHerdrZellij.e2e.ts`; Modify `cli/e2e/harness/zellijSession.ts` (a pane running a given
command, and the session's client run in a given terminal). **Depends on:** 7, 13, 14, 15, 16, 21, 22. **Effort:** high.

- [ ] A Zellij session whose one client runs in a WezTerm mux pane; herdr's server started with that Zellij pane's
  variables, its client in that pane; the hooked agent in a herdr pane → on WezTerm's page, one row; a tap → herdr's
  focused pane is the agent's (Zellij names no pane's tty, so no WezTerm tab is selected).
- [ ] In the Linux container → PASS. Commit.

---

### Task 29: Docs

**Files:** Modify `cli/AGENTS.md` (the devices row), `cli/src/services/AGENTS.md` (the person's-herdr rule; Orca's and
herdr's own pane), `docs/cli.md` (the dial-on-Linux section), `docs/plans/2026-11-19-dial-linux-design.md` ("Linux against
macOS" table). **Depends on:** 6, 9, 10, 13, 15, 16, 17, 18. **Effort:** medium. **Failing test first:** none (docs), one
commit.

- [ ] `cli/AGENTS.md` devices row: herdr's lookup on macOS and Linux (server = maker of the caller's terminal; Linux reads
  `ss -xn` and herdr's own processes' socket descriptors; a client in the person's tmux or Zellij placed by their
  lookups, through the variables herdr's server inherited; a client in a terminal with no page keeps herdr's page, and
  a tap raises its window by process, not on GNOME); the WezTerm and kitty tab of a multiplexer's client (`wezterm cli
  list`, `activate-pane`; `kitten @ focus-window --match pid:`), on both OSes; Orca and herdr in the own-pane sentence
  with `[device] orca · held` and `[device] herdr · held`; GNOME's tap check asks about the agent's own app.
- [ ] `cli/src/services/AGENTS.md`: the herdr rule names `ss` and `/proc/<pid>/fd` socket links of herdr's own processes
  beside macOS's `lsof`; the devices type into an Orca terminal or a herdr pane only when Orca's terminal host or herdr
  made the agent's terminal.
- [ ] `docs/cli.md`: herdr inside WezTerm, kitty or Ghostty on Linux is on that app's page; the tab is selected in WezTerm
  and kitty (kitty with remote control on); GNOME Terminal, Ptyxis, Konsole, Ghostty on Linux, Alacritty, foot and xterm
  offer no tab API: there the agent is on the client's app's page when the dial lists it (Ghostty), else herdr's; a swipe
  and a tap focus the herdr pane; a tap raises the client's window where the desktop takes a process; the tab holding
  the client is not selected. The two `held` lines.
- [ ] The design's table: the "Type into a pane" row (Orca and herdr only on their own pty), a row for herdr inside a
  terminal, and a row for the WezTerm/kitty tab of a multiplexer's client.
- [ ] Commit.

---

## CI

### Task 30: linux-e2e runs the Orca e2e files when the stand-in or Orca's adapter changes

Today `linux-e2e` runs only the e2e files a PR adds or modifies, plus its canary for a harness change, so the Orca e2e
files Task 20's stand-in moves under would run on no PR (PM answer 3, 2026-11-21). Read `scripts/ci-plan.py`'s comments
(`LINUX_E2E_NEVER`, `LINUX_E2E_CANARY_PATHS`, `linux_e2e_file`, `select`, `e2e_plan`) and `scripts/tests/test_ci_plan.py`
first; keep within their rules: bounded lists, plain file names (`E2E_FILE`), none of `LINUX_E2E_NEVER` or the dial
hosts' files.

**Files:** Modify `scripts/ci-plan.py`, `docs/validation-and-release.md` (the `linux-e2e` row); Test
`scripts/tests/test_ci_plan.py`.
**Depends on:** 20 (the stand-in file the list names, and `ci-plan.py`). **Effort:** high.

**Interfaces (produces):**
```python
# The e2e files that drive an Orca terminal through Orca's terminal-host stand-in (InOrca with a handle) and run on
# Linux; the macOS-only ones are run locally (the plan's Verification), as no PR CI suite runs macOS.
LINUX_E2E_ORCA_FILES = ("cli/e2e/dialOrcaFocus.e2e.ts", "cli/e2e/dialOrcaFullRing.e2e.ts", "cli/e2e/dialStream.e2e.ts",
                        "cli/e2e/dialPaneFollow.e2e.ts", "cli/e2e/dialClaudeAppFollow.e2e.ts")
# What they cover and no other linux-e2e file does: the stand-in, InOrca, the fake orca CLI and Orca's adapter.
LINUX_E2E_ORCA_PATHS = ("cli/e2e/harness/orcaHost.ts", "cli/e2e/harness/inOrca.ts", "cli/e2e/harness/fakeOrca.ts",
                        "cli/src/cable/hosts/orca.ts")
def linux_e2e_orca_path(path) -> bool
```
- `select`: a `LINUX_E2E_ORCA_PATHS` path selects `linux-e2e`, its deletion too (as a canary path's does).
- `e2e_plan`: with one changed, the five join the PR's own files (beside the canary when a canary path also changed;
  no canary for `orca.ts` alone, as the five are real files). A listed file missing at the head fails the plan naming
  it, as the canary does, so a PR that renames or deletes one updates the list.
- `scannedApp.ts` and the rest of `cli/src/cable/hosts/` stay dial-hosts' alone (`dialHostOrcaPane`, Task 23, covers
  the maker read there).

- [ ] **Step 1: Failing tests** in `test_ci_plan.py`:
  - `test_a_change_to_the_orca_stand_in_or_adapter_runs_the_orca_e2e_files`: `select(["cli/src/cable/hosts/orca.ts"])`
    holds `linux-e2e` and `dial-hosts`; in the temp repo, a change to `orca.ts` alone → `linux_files` the five
    (cli-relative, sorted), no canary; to `orca.ts` and `cli/e2e/a.e2e.ts` → the six; to `orcaHost.ts` → the five and
    the canary; a deleted `orca.ts` still runs them; a head missing one of the five fails the plan naming it.
  - `test_the_orca_e2e_files_are_plain_and_run_on_linux`: each is a `linux_e2e_file` in `E2E_FILE`'s form, none in
    `LINUX_E2E_NEVER` or `dial_hosts_path`.
  - On a full checkout (`full_checkout`), `test_the_orca_e2e_files_are_every_linux_one_through_the_stand_in`: every
    path in both lists exists; every `cli/e2e/*.e2e.ts` that gives `InOrca` an `ORCA_TERMINAL_HANDLE` is one of
    `LINUX_E2E_ORCA_FILES`, a dial host's file, or one of the test's own `MACOS_ONLY_ORCA_E2E` (`dialVscodeFollow`,
    `deviceHerdrApp`, `dialHerdrTerminal`, `dialTmuxTerminal`: each skips off macOS), so a new Orca e2e file is placed.
- [ ] **Step 2:** `python3 -m unittest discover -s scripts/tests -p test_ci_plan.py -k orca` → FAIL.
- [ ] **Step 3:** Implement; the `linux-e2e` row of `docs/validation-and-release.md` names the Orca files and what runs
  them.
- [ ] **Step 4:** `python3 -m unittest discover -s scripts/tests -p test_ci_plan.py` → OK.
- [ ] **Step 5:** Commit red, then green.

---

## Verification

1. **Recordings** (Tasks 1-4) in `devcrew-dlf`: the four files exist with versions, checksums and `notCovered` named.
   The main session stops and removes `devcrew-dlf` after the last recording and measurement.
2. **PR CI `dial-hosts`** (GitHub, selected by `cli/src/cable/hosts/` and the `dialHost*` files, #4526): build the CLI
   bundle and run `vitest.e2e.dialHosts.config.ts` on ubuntu-24.04 with herdr 0.9.5, Zellij 0.44.3, WezTerm
   20240203-110809-5046fc22, kitty 0.32.2, Xvfb/openbox and sway. Seen: every file passes with none skipped
   (dialHostOrcaPane, dialHostHerdrPane, dialHostHerdrWezterm, dialHostHerdrX11, dialHostHerdrKitty, dialHostHerdrZellij,
   the existing seven files and deviceHerdr), and the job's "every case passes without skipping" step green.
3. **PR CI `linux-e2e`** (GitHub, on ubuntu-24.04; Task 30 selects it for `inOrca.ts`, `orcaHost.ts` and `orca.ts`, and
   on later PRs that change them): its canary for the harness change and the five Linux Orca files (dialOrcaFocus,
   dialOrcaFullRing, dialStream, dialPaneFollow, dialClaudeAppFollow) through the Linux stand-in. Seen: the plan's
   `linux_files` names the six; each passes; `linux-e2e-summary` lists none of the five as all skipped (the stand-in
   skips without `cc`); the Orca agents take words and keep their ring order.
4. **The macOS-only Orca files** (no PR CI suite runs macOS), on this Mac at the final head, one file at a time under
   devcrew's machine gate, isolated as the e2e section says:
   `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/<file>` for each of
   `dialVscodeFollow.e2e.ts`, `deviceHerdrApp.e2e.ts` (needs `herdr-core` in `~/.local/bin`; it starts a private Herdr
   Core, never the person's), `dialHerdrTerminal.e2e.ts`, `dialTmuxTerminal.e2e.ts`. Seen: each passes with none
   skipped; a file that skips here is named in the PR as not run.
5. **macOS, on this Mac**, at the final head, one file at a time under the machine gate:
   `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/<file>` for each of `deviceHerdr.e2e.ts`,
   `dialOrcaFocus.e2e.ts`, `dialOrcaFullRing.e2e.ts`, `dialStream.e2e.ts`, `dialPaneFollow.e2e.ts`,
   `dialClaudeAppFollow.e2e.ts` (the macOS stand-in, `Orca Agents`, which linux-e2e does not run), and
   `TMPDIR=/tmp npx vitest run --config vitest.e2e.dialHosts.config.ts e2e/dialHostOrcaPane.e2e.ts`. Seen: all pass;
   dialHostOrcaPane's WezTerm case and the herdr dial-host files skip here (no WezTerm, kitty or X11 desk), said so in
   the PR. Isolation as the e2e section says; this Mac's own Orca and herdr are never read or driven (the herdr lookup's
   table hides herdrs outside the test, `ownHerdrsOnly`). No `cli-e2e.yml` run is dispatched for any of these.
6. **GNOME:** Task 10's contract tests against `RECORDED_GNOME_SHELL` (PR CI `cli-tests`).
7. **Numbers for the PR** (a script in the scratchpad, not committed; medians of 20): the maker read for an Orca caller on
   this Mac (Task 20's stand-in, expected ~4 one-pid `ps` runs, ~10 ms) and in a `devcrew-dlf` container (Linux
   stand-in); herdr's Linux client lookup with 1 and 3 clients in a `devcrew-dlf` container with herdr 0.9.5 (`ss`, the
   descriptors and `ps`), first lookup and within 5 s; one WezTerm `cli list` per rest with 1 and 10 panes. Before: the
   same reads on `main` (no maker read for Orca; herdr's lookup answers nothing on Linux).
8. **Local gate:** from a clean tree at the final head, `python3 scripts/local-checks.py --run` (cli-core and whatever it
   selects); its fence pasted in the PR body before the push.
9. **Not checked by a machine** (named in the PR, needs the user's own desk): a real dial on a Linux desktop (GNOME with
   the extension, KDE, sway) with herdr in WezTerm or kitty. Hyprland: contract tests only (no GPU on runners or
   containers).
10. **Proposal, not in this PR:** a macOS e2e job for the dial files no GitHub workflow runs (dialHerdrTerminal,
    dialTmuxTerminal, dialVscodeFollow, deviceHerdrApp, dialHostOrcaPane's macOS cases, the Orca files' macOS stand-in),
    as #4500 proposed.

**For the pull request** (copy the main session writes): the terminals with no tab API (Task 29's list); herdr inside
tmux inside Terminal, iTerm2 or Ghostty on macOS moves from herdr's page to that app's page; a herdr client that
attached later from another tmux pane or Zellij session is not placed; Orca from before its terminal host, and each
`RECORDED_ORCA.notCovered` mode, is not covered; Windows unchanged; out of scope: two WezTerm GUIs sharing pane ids,
Hyprland beyond contract tests. When Task 13 took the no-session branch: herdr's row of a pane a hooked agent only
holds folds into that agent when their engines match, so a real other agent of the same engine in that pane is hidden
behind it (rare), and no words go into that pane by either route. linux-e2e now runs the five Linux Orca e2e files
whenever the stand-in, InOrca, the fake orca or Orca's adapter changes (Task 30).
