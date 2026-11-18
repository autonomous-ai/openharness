# The dial reaches Claude Code and Codex in VS Code's integrated terminal (PR A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** ready for phase 3. The PM answered the draft's three questions on 2026-11-17 (recorded in "Decisions of 2026-11-17", before Verification).

**Goal:** With Harness's own VS Code extension on, a tap on the dial opens the session's own terminal in VS Code, a swipe that rests on a session switches VS Code to it, and the dial's scroll scrolls it; one menu item in Harness Device turns the extension on.

**Architecture:**
- **A VS Code extension** (`plugins/harness-device-vscode/`) runs in each local window. It asks `harness device vscode link` where the devices' socket is, holds one `vscode` stream open on it, reports the window's shells' pids (`vscode-state`), and does what the stream's lines say (`show`, `scroll`). It types nothing and reads nothing from a terminal.
- **The devices process** keeps one stream per window (a keyed stream type in its listener, at most 8), matches each VS Code agent to its terminal by the process tree (one `ps` read), and gives the existing `vscode` adapter (`tap: 'instead'` since #4407) a second pane kind, `term:<agent pid>`, whose tap and rest write `{"show":<shell pid>}` to that window; the tap then runs `open -b com.microsoft.VSCode` itself on macOS.
- **Install** is `harness device vscode enable`: the extension, bundled into `cli.js` at build time, is packed to a `.vsix` at run time with `lib/zipWriter.ts` and handed to VS Code's own `code --install-extension`. Harness Device's menu offers it once, as **Turn on VS Code**. The devices process brings an installed extension current after a CLI update, never installs one that is off.
- **Nothing in the daemon core.** Every file is the devices process's, the `harness` command's, the extension's or Harness Device's.

**Tech Stack:** TypeScript (Node 22, vitest 4, esbuild) in `cli/` and `plugins/harness-device-vscode/`; Rust and Tauri 2 in `device-app/src-tauri`; Python unittest for `scripts/ci-plan.py`; `@vscode/test-electron` for one local gate.

**Spec:** [docs/plans/2026-11-17-dial-vscode-extension-design.md](2026-11-17-dial-vscode-extension-design.md). Its "Decided" and the PM's six decisions of 2026-11-17 are not reopened here. PR B (VS Code moving the dial, the panel followed by its tab name) is not in this plan.

## Base

- Branch `feat/dial-vscode-extension`, from `main` at `1e17b388ce`. Phase 3 starts from `main`. No release.
- **#4407 first** (`feat/dial-vscode-follow`, open at this base, head `725ccd4498`; PM, 2026-11-17). It makes `cli/src/cable/hosts/vscode.ts` `tap: 'instead'`, gives the extension panel a rest through `appLink.ts`, passes `inFront` to the adapter in `services/devices.ts`, and changes `vscode.spec.ts`, `observed.spec.ts`, `devices.spec.ts` and `cli/AGENTS.md`'s devices row. Task 5, and every task that touches `vscode.ts` or `appLink.ts` (Tasks 5, 10 and 19), starts only from a head that contains #4407. Task 5 depends on no task, so it is ready at the start: before any task starts, if #4407 has merged, the main session rebases the feature branch onto `main`; if it has not, onto #4407's head (`origin/feat/dial-vscode-follow`), and then once more onto `main` after #4407 merges (between tasks, none running), before this pull request is opened.
- Before the first task: `cd cli && npm ci`; `cd device-app/ui && npm ci && npm run build` (the app's binary embeds `ui/dist`). One `CARGO_TARGET_DIR` outside the repository compiles Tauri's dependencies once.
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- A task that names failing tests is two commits: the tests, red, then the change. The message given is the second's. A task marked "one commit" changes no behavior and has no red test.

## Shipping without scroll (PM, 2026-11-17)

Tap and swipe come before scroll. **Tasks 20 to 25 are scroll and nothing else.** If scroll is not done by the cut-off, **2026-11-22**, drop exactly Tasks 20, 21, 22, 23, 24 and 25 and ship Tasks 1 to 19: no task from 1 to 19 names a file, a type or a test that 20 to 25 add, the extension skips a `scroll` line as any line it does not know (Task 8), and the dial's scroll keeps going to Harness's windows as today. Nothing has to be reverted. Tasks 20 to 25 then become the first tasks of the next pull request, unchanged.

## Layers

| Files | Process | Gate |
|---|---|---|
| `plugins/harness-device-vscode/src/*` | VS Code's extension host, one per window | its `*.test.ts` in the CLI's vitest (PR CI, `cli-tests`); the typecheck spec; the real-VS Code gate (local) |
| `cli/src/services/devicesListener.ts`, `cli/src/services/devices.ts` | the devices process | their specs; `npm run test:core`, 100% per file (local gate) |
| `cli/src/cable/hosts/vscodeTerminals.ts`, `vscode.ts`, `observed.ts`, `scrollLines.ts`, `cli/src/cable/vscodeExtensionUpdate.ts`, `cli/src/cable/cableHost.ts`, `cableSession.ts` | the devices process | their specs (PR CI) |
| `cli/src/devices/vscodeExtension.ts` | shared by the `harness` command and the devices process | its spec |
| `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts` | the `harness` command's own process | `command.spec.ts` |
| `cli/build.mjs`, `cli/build-bundle.mjs`, `cli/scripts/lib/vscodeExtensionBundle.mjs` | build time | `vscodeExtensionBundle.spec.ts` |
| `device-app/src-tauri/src/*.rs` | Harness Device | `cargo test --locked` (PR CI on Linux, a Mac by hand) |
| `scripts/ci-plan.py` | CI's planner | `scripts/tests/test_ci_plan.py` (process-checks); two independent security reviews before merge (docs/validation-and-release.md) |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes, and `cli/src/architecture.coreFiles.txt` gains no line. `src/architecture.spec.ts`, `src/architecture.environment.spec.ts` and `src/leanEntry.spec.ts` stay green.

## File structure

| File | Is |
|---|---|
| `plugins/harness-device-vscode/package.json` (new) | the extension's manifest: `autonomous-ai.harness-device`, no contribution; `version` is a placeholder the build replaces |
| `plugins/harness-device-vscode/tsconfig.json` (new) | its typecheck, on the CLI's installed types |
| `plugins/harness-device-vscode/src/window.ts` (new) | the window as the loop sees it: `WindowState`, `WindowFacade`, `windowState()` |
| `plugins/harness-device-vscode/src/vscodeApi.ts`, `facade.ts` (new) | the shape of VS Code's API the extension reads, and the facade made from it |
| `plugins/harness-device-vscode/src/inputs.ts`, `loop.ts` (new) | what the loop reads of the world, and the loop: link, stream, state reports, lines |
| `plugins/harness-device-vscode/src/wire.ts`, `extension.ts` (new) | the loop wired to an API and an output channel; `activate` and `deactivate` |
| `plugins/harness-device-vscode/src/testing/fakeVscode.ts`, `fakeWindow.ts` (new) | the fake VS Code API and the fake window the unit and end-to-end tests drive |
| `plugins/harness-device-vscode/gate/*` (new) | the local gate: a throwaway VS Code, the built `.vsix`, a driver inside it |
| `plugins/harness-device-vscode/README.md` (new) | what it does and never does, how it is turned on and off |
| `cli/src/services/devicesListener.ts` | gains a keyed stream type beside one-per-type |
| `cli/src/cable/hosts/vscodeTerminals.ts` (new) | the open windows, their states, the agents' chains, the match, a window's writer; the two listener handlers |
| `cli/src/cable/hosts/vscode.ts` | one adapter, two pane kinds: the panel's session id, and `term:<agent pid>` |
| `cli/src/cable/hosts/observed.ts` | a scanned session's place has its own pid; a tap takes its pane's adapter's bundle |
| `cli/src/cable/hosts/scrollLines.ts` (new, Task 21) | a stroke's travel as whole lines, by `tui/src/dial.rs`'s numbers |
| `cli/src/devices/vscodeExtension.ts` (new) | status, enable, disable, the `.vsix`, VS Code's record |
| `cli/src/cable/vscodeExtensionUpdate.ts` (new) | the extension brought current at the devices' start |
| `cli/scripts/lib/vscodeExtensionBundle.mjs` (new) | the extension bundled to one file and its manifest, for both CLI builds |
| `device-app/src-tauri/src/vscode.rs` (new) | the two CLI calls the menu item makes, and their answers |
| `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/harness/vscodeWindow.ts` (new) | the end-to-end proof and the extension's loop as a process of its own |

## Global Constraints

- **Extension id** `autonomous-ai.harness-device` (publisher `autonomous-ai`, name `harness-device`), display name `Harness Device`, `engines.vscode` `^1.75.0`, activation `onStartupFinished` alone, no contributed commands, views or settings, no runtime dependency: Node's built-in modules and the `vscode` API only, built to one JavaScript file.
- **The extension shows nothing of its own:** no panel, no status bar item, no notification, no palette command. Its output channel `Harness Device` names its state (`noHarness`, `notRunning`, `unplugged`, `connected`) and counts, nothing else. It does nothing on Windows or in a remote window (`vscode.env.remoteName` set). It starts nothing but `harness device vscode link`.
- **Wire, exact.** Stream open: `{"type":"vscode","window":"<id>"}`, `<id>` matching `[A-Za-z0-9-]{8,36}`, at most 96 bytes, 1 a second a connection; one stream per window, at most 8, a ninth window answered 409. State: `{"type":"vscode-state","window":"<id>","terminals":[<pid>,…],"active":<pid>|null,"focused":<bool>}`, at most 1 KiB, 8 a second a connection, at most 32 distinct integers in 2..2^31-1, `active` one of them or null. Lines: `{"show":<pid>}`, `{"scroll":<n>,"pid":<pid>}` (|n| at most 100), `{"replaced":true}`. A field either side does not know is ignored.
- **The extension's timings:** `link` 5 s and 4 KiB; the stream's head 2 s; backoff 1 s, 2 s, 4 s … 30 s, reset by a stream open over 30 s; the socket's folder watched at most once a second, plus a look every 5 min; state reports coalesced to the latest, at most 4 a second, each a `POST /` on a connection of its own with `Connection: close`; a line over 1 KiB ends the stream.
- **The match is the process tree, exact:** one `ps -axo pid=,ppid=` read (`vscodeTerminals.ts` `readProcessParents`, `scannedApp.ts` `parentChain`, 16 parents at most), at most one in flight and one queued, at most once per 5 s per agent after a failure. Only pids and parents are read: never another process's environment (cli/AGENTS.md rule 4).
- **Connections** stay at `LISTENER_MAX_CONNECTIONS = 16`.
- **Install:** `--install-extension <file> --force` and `--uninstall-extension autonomous-ai.harness-device`, 60 s each, no shell, VS Code's own CLI (`<app>/Contents/Resources/app/bin/code` on macOS, `code` on Linux). VS Code's default profile only (`~/.vscode/extensions/extensions.json`). No `@vscode/vsce`, no Marketplace, no Open VSX, no outside service, no secret.
- **Never installed when off:** the devices process runs `enable` only when the extension is on at another version than this build's. A failed update retries after 1 h.
- **Menu copy, exact:** `Turn on VS Code`. The item's click runs `harness device vscode enable` with a 90 s deadline.
- **Logs and measures:** counts and fixed words. Never a pid, a window id, a path, a name or a label, in the daemon's log, the extension's channel or Harness Device's log.
- **Never the developer's own VS Code.** No task, test or check runs `harness device vscode enable` or `disable` with the real dependencies, runs an installed VS Code's `code`, runs `open -b com.microsoft.VSCode`, opens a `vscode://` link, or reads or writes `~/.vscode` or VS Code's settings. Unit tests pass a fake `code` and a fake record; `services/devices.spec.ts`'s `start()` always passes a fake `vscodeExtension` and a fake `processParents`; end-to-end daemons run under a throwaway home with the harness's fake `open`; the one real VS Code is the gate's and the spike's throwaway, downloaded into a temporary folder and run with its own `--user-data-dir`, `--extensions-dir` and `HOME`. The first real `enable` is the person's check after merge.
- **Repo rules:** a test that fails first, at the layer where the behavior lives; no fixed sleeps (clocks and timers are passed in); comments say why; copy short; 100% per file for `cli/src/services/`.
- **Platforms:** macOS and Linux. Windows: the listener has no Windows path, so the extension stops, `status` says `absent` and the menu item never shows.

## Design

The spec's Design section (its ten lines) stands. The plan adds no stored data. Two rules the plan fixes where the spec says only what must hold:

- **No `ps` read while no window is connected.** A read is asked only while some window holds a state and some VS Code agent has no chain. With the extension off, a VS Code agent costs no read (PM, 2026-11-17).
- **A stroke keeps the route its `down` chose** (Task 23): Harness's window must never be left holding a drag whose `up` went to VS Code.

## Review Focus

1. **A window reloads**: for a moment the old activation's stream and the new one's both list the same shells. The shell belongs to the window that reported last. Task 3 (`two windows listing one shell`).
2. **A terminal whose own process is the agent** (a terminal profile that starts `claude` with no shell): the agent's pid is the pid VS Code reports. It is matched. Task 3 (`an agent that is its terminal's own process`).
3. **The daemon restarts (a CLI update) with windows open**: each extension reopens within 30 s and sends its state again, and agents listed before any window came back get their terminals from one read. Task 3 (`a window that opens after the agents were listed`), Task 8 (`after the stream ends, the next one sends the state again`).
4. **VS Code rewrites its record while `status` reads it**, or the record is large: a record cut short, over the bound or not an array reads as `off`, never a throw; the devices' update then does nothing. Task 13.
5. **The app in front changes in the middle of a stroke on the glass**: the stroke's moves and its `up` follow its `down`. Task 23.

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | Spike: raising the window that holds a terminal | none | high |
| 2 | Listener: a stream type keyed by window, with a limit | none | xhigh |
| 3 | The devices' half: windows, states, the match, the show | 2 | xhigh |
| 4 | Observed: a scanned session's pid, and the adapter's bundle | none | high |
| 5 | Adapter: the terminal pane | none (on a head with #4407: Base) | high |
| 6 | Extension: its folder, in the CLI's checks | none | xhigh |
| 7 | Extension: the window from VS Code's API | 6 | high |
| 8 | Extension: the loop | 6 | xhigh |
| 9 | `harness device vscode link` | none | medium |
| 10 | Devices: VS Code's terminals wired in | 3, 5 | xhigh |
| 11 | End to end: a tap and a swipe | 4, 8, 9, 10 | high |
| 12 | Extension: activate, and its README | 7, 8 | high |
| 13 | The extension's install: status, enable, disable, the `.vsix` | none | xhigh |
| 14 | Build: the extension inside `cli.js` | 12, 13 | high |
| 15 | `harness device vscode status`, `enable`, `disable` | 9, 13 | high |
| 16 | Devices: the extension brought current | 10, 13 | high |
| 17 | Harness Device: Turn on VS Code | none | high |
| 18 | Local gate: the extension in a real, throwaway VS Code | 3, 12, 14 | high |
| 19 | The tap raises the window (only if the spike found a way) | 1, 3, 5, 7, 8, 11, 12, 18 | high |
| 20 | Scroll: the shown agent's id reaches the host | 11 (PM's order) | high |
| 21 | Scroll: travel into lines, and a window's scroll | 3, 11 (PM's order) | high |
| 22 | Scroll: the extension runs a scroll line | 7, 8, 12, 11 (PM's order) | high |
| 23 | Scroll: the dial's scroll goes to the terminal | 10, 20, 21 | xhigh |
| 24 | Scroll: end to end | 11, 22, 23 | high |
| 25 | Scroll: the gate counts a line's scroll commands | 18, 21, 22 | medium |

**The path to tap and swipe:** 2 → 3 → 10 → 11 (four tasks), beside 6 → 8 → 11. Tasks 1, 2, 4, 5, 6, 9, 13 and 17 start at once.

**Longest chain:** 2 → 3 → 10 → 11 → 21 → 23 → 24 (seven).

**"PM's order"** on Tasks 20 to 22 is the PM's ordering of 2026-11-17, not a code dependency: scroll starts only once tap and swipe are proven end to end. Task 16's dependency on 10 is a shared file put in the order that keeps the path to tap and swipe free.

**Tasks 5, 10 and 19** start only on a head that contains #4407 (Base).

**Tasks that share files** (never run two of a group at once):
- `cli/src/services/devices.ts`: 5, 10, 16, 23. `devices.spec.ts`: 10, 16, 23. `cli/AGENTS.md`: 10, 16, 23.
- `cli/src/cable/hosts/observed.spec.ts`: 4, 5.
- `cli/src/cable/hosts/vscodeTerminals.ts` and its spec: 3, 19, 21.
- `cli/src/deviceClaude/command.ts` and its spec: 9, 15.
- `cli/package.json`: 6, 18. `cli/vitest.config.ts`, `cli/package-lock.json`, `scripts/ci-plan.py`: 6 alone.
- `plugins/harness-device-vscode/src/loop.ts`, `loop.test.ts`, `testing/fakeWindow.ts`: 8, 19, 22. `src/window.ts`: 6, 19, 22. `src/facade.ts`, `vscodeApi.ts`, `testing/fakeVscode.ts`: 7, 19, 22. `README.md`: 12, 19, 22.
- `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/harness/vscodeWindow.ts`: 11, 19, 24.
- `plugins/harness-device-vscode/gate/*`: 18, 19, 25.
- `cli/src/cable/hosts/vscode.ts`: 5, 10, 19; its spec: 5, 19.
- This plan's "Spike findings": 1 alone.

---

### Task 1: Spike: raising the window that holds a terminal

**Depends on:** none. **Effort:** high. No red test; the spike's code is thrown away and never committed. One commit: the findings, written into this plan's "Spike findings" section, and copied into the pull request.

**Files:**
- Modify: `docs/plans/2026-11-17-dial-vscode-extension-plan.md` (the "Spike findings" section only)

**Question.** With two or more VS Code windows open, `open -b` raises the last active window, so a terminal shown in another window stays behind it (spec, "Tap with two or more windows"). What raises the window that holds the terminal, from the extension or from outside, with no new permission?

**Rules (PM, 2026-11-17).** The spike never runs `open -b com.microsoft.VSCode`, never opens a `vscode://` link, never touches the person's own VS Code, its settings or `~/.vscode`. It may run the throwaway's own executable by its path.

- [ ] **Step 1: A throwaway VS Code.** In a new folder outside the repository (`SPIKE=$(mktemp -d)`): `npm install --prefix "$SPIKE" @vscode/test-electron`; with it, `downloadAndUnzipVSCode({ cachePath: "$SPIKE/vscode" })`. Every launch passes `--user-data-dir "$SPIKE/user-data" --extensions-dir "$SPIKE/extensions"` and runs with `HOME="$SPIKE/home"`. Check before the first launch that the executable's path is under `$SPIKE`.
- [ ] **Step 2: Two windows and a probe.** Open two folders (`$SPIKE/w1`, `$SPIKE/w2`) as two windows of that one instance. A throwaway extension (loaded with `--extensionDevelopmentPath`) makes one terminal per window and takes commands on a Unix socket under `$SPIKE`. Which window is in front is read from each window's own `vscode.window.state.focused`, and whether the throwaway is the app in front from `lsappinfo front` against its pid: no Accessibility or Automation permission is asked for.
- [ ] **Step 3: Try, in this order,** each from the window behind, each three times, noting raised or not:
  1. `Terminal.show(false)` alone.
  2. `Terminal.show(false)`, then `workbench.action.terminal.focus`.
  3. Each built-in command whose id names a window's focus (`vscode.commands.getCommands(true)`, filtered by `focusWindow|window\.focus`), after `Terminal.show(false)`.
  4. From outside, the throwaway's own CLI with the same two directories and `--reuse-window <that window's folder>`.
  5. From the extension host, the same CLI (`vscode.env.appRoot`) with the window's own folder.
- [ ] **Step 4: Decide by the spec's rule:** the first that works with no new permission. A way that sends a folder's path off the window (4), or makes the extension start a program other than `link` (5), changes the spec's wire or its Identity line: report it to the PM and write no code for it. If none of 1 to 3 works, the answer is "none": a tap on a terminal in a window behind shows it there without raising it, and the pull request says so.
- [ ] **Step 5: Clean up.** Quit the throwaway; `pgrep -f "$SPIKE"` prints nothing; `rm -rf "$SPIKE"`.
- [ ] **Step 6: Write "Spike findings"**: the date, the VS Code and macOS versions, a row per candidate (raised: yes or no, 3 of 3 or fewer; what it needs), the decision, and whether Task 19 runs. Commit `Dial: what raises a VS Code window that holds a terminal (spike)`.

### Task 2: Listener: a stream type keyed by window, with a limit

**Depends on:** none. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/services/devicesListener.ts`, `cli/src/services/AGENTS.md`
- Test: `cli/src/services/devicesListener.spec.ts`

**Interfaces — Produces:**

```ts
export interface ListenerStreamHandler {
  maxBytes: number
  perSecond: number
  /** A keyed type keeps one stream per key instead of one of its type: `key` is an opening message's key, or REFUSED
   *  for a message that has none; `limit` is the most streams of the type open at once. */
  keyed?: { key(message: Record<string, unknown>): string | typeof REFUSED; limit: number }
  open(message: Record<string, unknown>, stream: ListenerStream): typeof REFUSED | void
}
```

In `openStream`, in this order: the `standby` form check as today; `keyed.key(message)`, REFUSED answered 400 and counted `refused`; the slot is the type alone, or the type and the key; `standby` with the slot open is 409, uncounted, as today; for a keyed type, a slot not open while `limit` slots of the type are open is 409, uncounted, before `handler.open`; then `open`, the replace of the slot's older stream with `{"replaced":true}`, and the rest as today. An ended stream frees its slot. Unkeyed types (`tabs`, `dial`) behave exactly as before.

- [ ] **Step 1: Write the failing tests,** inside `describe('a stream')`:

```ts
/** A keyed type for these tests: its key is `k`, three at once. */
const keyed = (opened: Array<{ key: string; stream: ListenerStream }> = []): ListenerStreamHandler => ({
  maxBytes: 64, perSecond: 100,
  keyed: { key: ({ k }) => typeof k === 'string' && k !== '' ? k : REFUSED, limit: 3 },
  open: (message, stream) => { opened.push({ key: message.k as string, stream }) },
})
it('a keyed type keeps one stream per key, each written on its own', …)          // a and b both 200; a line on a's stream reaches a's client only
it('a second open with the same key replaces the older, and only it', …)         // the first a reads {"replaced":true} and ends 'replaced'; b stays open
it('a new key past the limit is 409 before the handler opens it, and is no drop', …) // a, b, c open; d: 409, opened.length 3, the minute's line counts nothing
it('at the limit the same key still replaces', …)                                 // a, b, c open; c again: 200
it('a key that ended frees its place', …)                                         // b's client goes ('gone'); d: 200
it('a message with no key is 400 and counted refused, and nothing is opened', …)
it('a standby open of an open key is 409; of a free key it opens', …)
it('closing the listener ends every keyed stream as closed', …)
it('eight keyed streams and the two unkeyed ones leave six connections for messages', …) // LISTENER_MAX_CONNECTIONS is 16
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL in the new cases (`keyed` is not read: the second key replaces the first).
- [ ] **Step 3: Implement** as above. The file's header says a stream type is one of its type, or, keyed, one per key up to its limit. `cli/src/services/AGENTS.md`, in the devices' paragraph, after "one of its type across every connection": a keyed type keeps one per key up to its limit, a new key past it answered 409.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts && npm run test:core -- --maxWorkers=4`. Expected: PASS, `devicesListener.ts` at 100%.
- [ ] **Step 5: Commit** `Devices listener: a stream type may keep one stream per key, up to a limit`.

### Task 3: The devices' half: windows, states, the match, the show

**Depends on:** 2. **Effort:** xhigh.

**Files:**
- Create: `cli/src/cable/hosts/vscodeTerminals.ts`
- Test: `cli/src/cable/hosts/vscodeTerminals.spec.ts`

**Interfaces — Consumes:** `ListenerHandler`, `ListenerStreamHandler`, `ListenerStream`, `REFUSED` (`services/devicesListener.ts`, with Task 2's `keyed`); `parentChain`, `ProcessName` (`scannedApp.ts`).

**Interfaces — Produces:**

```ts
export const VSCODE_WINDOWS = 8
export const VSCODE_TERMINALS = 32
export const VSCODE_OPEN_MAX_BYTES = 96
export const VSCODE_OPEN_PER_SECOND = 1
export const VSCODE_STATE_MAX_BYTES = 1024
export const VSCODE_STATE_PER_SECOND = 8
export const CHAIN_RETRY_MS = 5_000

/** A terminal of an open window: the window's id and its shell's pid. */
export interface VscodeTerminal { window: string; shell: number }

export interface VscodeTerminals {
  handlers: { vscode: ListenerStreamHandler; 'vscode-state': ListenerHandler }
  /** The pids of the VS Code agents listed now (at most observed.ts's 50). A new one may ask for a read; one that is gone drops its chain. */
  agents(pids: readonly number[]): void
  /** The window and shell that hold the agent with that pid, from its kept chain; none while unknown. */
  terminalOf(agentPid: number): VscodeTerminal | undefined
  /** Queues `{"show":<shell>}` on the window's stream, the latest winning; false when that stream is gone. `tap` chooses the count only. */
  show(terminal: VscodeTerminal, tap: boolean): boolean
}

export interface VscodeTerminalsDeps {
  /** One read of every process's pid and parent; rejects when `ps` could not be read. */
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
  /** Which agents have a terminal changed. */
  changed(): void
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
  log(line: string): void
}
export function vscodeStreams(deps: VscodeTerminalsDeps): VscodeTerminals
```

Rules the tests pin:
- **`vscode`:** `keyed.key` is `window` when it is a string matching `/^[A-Za-z0-9-]{8,36}$/`, else REFUSED; `keyed.limit` 8. `open` keeps the stream under its window with no state, and drops the window on `ended` only if that stream is still the window's (a newer stream of the same id is the open one by the time the older ends).
- **`vscode-state`:** REFUSED unless `window` has that form and names an open window, `terminals` is an array of at most 32 distinct integers in 2..2^31-1, `active` is one of them or null, and `focused` is a boolean. Any other field is ignored. A refused one is counted.
- **Chains.** A read is wanted when some window holds a state and some agent has no chain and is due (never read, or its last failed read began 5 000 ms ago or more). It is checked when `agents()` adds a pid and when a state is taken. One read at a time; a want during a read sets one flag, and one more read follows. After a read, each agent with no chain whose pid the table holds keeps `parentChain(pid, table)`'s pids, itself first; one the table does not hold, and every one when the read rejected, is marked failed at the read's start.
- **`terminalOf`:** the first pid of the chain, nearest first, that an open window's state lists; of two windows that list it, the one whose state came last.
- **`changed()`** is called once whenever the answer of `terminalOf` for any listed agent differs from before: after a state, a stream's open or end, a read, an agent leaving.
- **A window's writer:** one line in flight per stream; a pending show (the latest wins) is written from `onWritable`.
- **Log lines, fixed words and counts only:** `[devices] vscode stream · open · windows <n>`, `[devices] vscode stream · ended · <StreamEnd> · windows <n>`, and, a minute after the first of a minute's events, `[devices] vscode · in the last minute: <n> shows, <n> taps, <n> refused states, <n> ps reads, <n> failed`.

- [ ] **Step 1: Write the failing tests** with a fake `ListenerStream` whose drain the test controls, a `processes` that answers from a table the test sets and counts its calls, and a clock the test moves:

```ts
it('the vscode stream is keyed by its window, eight at once, 96 bytes, one a second', …)
it('a window id of another form is refused', …)                 // 7 or 37 characters, a slash, a number
it.each([/* one row a form */])('a state is refused when %s', …)
// window not open · window of another form · terminals not an array · 33 terminals · a pid twice · pid 1 · pid 2**31 ·
// a fraction · active not among terminals · focused not a boolean · and each is counted in the minute's line
it('a state with a field it does not know is taken', …)
it('a shell several levels up is the agent\'s terminal', …)     // agent 900 → 800 → 700; a window lists 700: { window, shell: 700 }
it('an agent that is its terminal\'s own process is matched', …) // the window lists 900
it('a pid in no window has no terminal', …)
it('two windows listing one shell: the one that reported last holds it', …)
it('a reused window id: the newer stream\'s state stands, and the older stream ending after it drops nothing', …)
it('with no window open, an agent asks no read', …)             // processes never called
it('a window that opens after the agents were listed gives them their terminals with one read', …)
it('one read serves every agent with no chain; one that appears during it is read once more, after it; reads never overlap', …)
it('a state while every agent has its chain asks no read', …)   // a new shell with no agent in it
it('a read that fails is asked again by the next state or agent, no sooner than 5 s an agent', …)
it('an agent that left drops its chain: its pid, reused, is read anew', …)
it('changed is told once when a state gives an agent its terminal, once when its window\'s stream ends, and not otherwise', …)
it('a show is written at once on a writable stream; while a line drains the latest waits, and replaces an earlier one', …)
it('show answers false once the window\'s stream has ended', …)
it('the log holds counts and fixed words: no pid and no window id', …)  // every line matches one of the three forms above
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscodeTerminals.spec.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement.** The header says what the module owns and why the match is the process tree and never a name or an environment.
- [ ] **Step 4: Run** the same command, then `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Numbers for the pull request** (hot path: a state and a look). With 8 windows of 32 terminals and 50 agents with chains: the median of 1 000 `terminalOf` calls, and of 1 000 states taken, on this Mac. Both go in the pull request beside the rates they run at (a look per agent per list; 8 states a second a connection).
- [ ] **Step 6: Commit** `Dial: each VS Code window's shells, and the terminal an agent runs in, by the process tree`.

### Task 4: Observed: a scanned session's pid, and the adapter's bundle

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

- `locate`: the place's `pid` is `entry.caller ?? entry.pid` (a session the scan found has no caller until its first hook; its own pid is Claude Code's `sessions/<pid>.json` or Codex's `lsof` owner).
- `target`: the bundle is `e.bundle ?? near?.adapter.bundle` (today the adapter's bundle is taken only for a placed pane).

- [ ] **Step 1: Write the failing tests,** with an adapter of the test's own that makes a pane from `place.pid` and declares a `bundle`:

```ts
it('a session the scan found is placed by its own pid until a hook names its caller', …)      // the adapter's paneOf saw pid === owner.pid; after a hook, the hook's callerPid
it('a tap on a session the scan found takes its pane\'s adapter\'s bundle', …)                 // actions.open called with { bundle: 'com.example.app', pane }
it('an entry\'s own bundle wins over its pane\'s adapter\'s', …)
it('a pane whose adapter declares no bundle adds none', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement** the two lines, each with its comment. Run the whole file: a case that asserted no bundle for an agent's own pane in an adapter that declares one (Orca's) now expects that bundle; change only such expectations and list each in the pull request.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a session the scan found is placed by its own pid, and a tap takes its pane's app`.

### Task 5: Adapter: the terminal pane

**Depends on:** none in code. **Starts only on a head that contains #4407** (Base): it builds on the adapter as #4407 leaves it. If `cli/src/cable/hosts/vscode.ts` on the head is not `tap: 'instead'` with its verbs from `createAppLink`, stop and report. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/vscode.ts`, `cli/src/services/devices.ts` (the one `createVscodeAdapter` call), `cli/src/cable/hosts/observed.spec.ts` (its one `createVscodeAdapter` call)
- Test: `cli/src/cable/hosts/vscode.spec.ts`

**Interfaces — Consumes:** `createAppLink`, `AppLinkDeps` (`appLink.ts`, unchanged); the adapter as #4407 leaves it.

**Interfaces — Produces:**

```ts
/** No window is open. Task 10 passes the real windows and deletes this. */
export const NO_WINDOWS: { terminalOf(agentPid: number): undefined; show(): false }
/** The agent's pid a terminal pane names (`term:<pid>`, 2..2^31-1); none for the panel's pane or any other id. */
export function termPid(paneId: string): number | undefined

export function createVscodeAdapter(deps: AppLinkDeps & {
  /** The open windows (vscodeTerminals.ts), by shape. */
  terminals: {
    terminalOf(agentPid: number): { window: string; shell: number } | undefined
    show(terminal: { window: string; shell: number }, tap: boolean): boolean
  }
}): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>
```

One adapter, `id: 'vscode'`, `tap: 'instead'` (#4407's, unchanged), and it now declares `bundle: APP_BUNDLES.vscode` (for Task 4's `target`: a session the scan found has no bundle of its own). No `type`, no `paneKey`. A pane whose id `termPid` reads is a terminal pane; every other id goes to #4407's link verbs exactly as today, so the panel's tap and rest, and an id of neither form, behave as #4407 left them (`inFront` is #4407's, already passed by `services/devices.ts`).
- `paneOf`: #4407's panel rule first, unchanged. Else `{ adapter: 'vscode', id: 'term:<pid>' }` when `place.engine` is `claude` or `codex`, `place.app` is `vscode`, `CLAUDE_CODE_ENTRYPOINT` is not `claude-vscode`, and `place.pid` is an integer in 2..2^31-1.
- `canFocus` (terminal pane): a window holds its terminal, on any platform.
- `focus` (terminal pane): asks `terminalOf` again; none, or `show(terminal, true)` false, answers false (the opener then logs `[device] open · vscode · fallback` and runs `open -b` with the target's bundle, as for any pane). Once the show is queued: on macOS it runs `open -b com.microsoft.VSCode` itself (`openPath(deps.bin)`, `RUN_TIMEOUT_MS`), as `tap: 'instead'` asks, and answers true whatever that run exits, as the opener's `'before'` path did with its own `open -b`; off macOS the queued line alone is the tap, true, and nothing runs.
- `canShow` (terminal pane): `inFront()` (asked first) and a window holds its terminal.
- `show` (terminal pane): `'ok'` when `show(terminal, false)` is true, else `'failed'`.
- `services/devices.ts`: the call gains `terminals: NO_WINDOWS` beside #4407's `inFront`; it must compile and stay at 100% at every commit, and the windows are Task 10's. Nothing the devices do changes until Task 10, so `devices.spec.ts` gains no case: #4407's cases already reach `inFront`.
- `observed.spec.ts`: its `createVscodeAdapter` call gains `terminals: { terminalOf: () => undefined, show: () => false }`, its own, so Task 10 can delete `NO_WINDOWS` with no other reader.

- [ ] **Step 1: Write the failing tests** (the file's `recorder` gains a `terminals` fake, no window by default, that records each `show(terminal, tap)`; the opener it builds holds this adapter alone, as #4407's does):

```ts
it('a Claude Code or Codex agent in VS Code\'s terminal has a term pane of its pid', …)   // TERM_PROGRAM=vscode, pid 4321 → 'term:4321'
it('no term pane for the extension\'s panel, Cursor, another engine, or a place with no pid, pid 1, or a fraction', …)
it('a tap writes the show, then runs open -b for VS Code itself, and the opener runs nothing after it', …)
// darwin, through the opener: terminals.show(t, true), then exactly [run(OPEN, '-b', VSCODE)]; no fallback line
it('a tap whose own open -b fails still answers true: the show was queued', …)             // codes [1]: one run, no fallback line
it('off macOS the show alone is the tap', …)                                              // linux: show written, focus true, no run; can(target) true through the pane
it('a show that cannot be written falls back to the app, once', …)                        // show → false: '[device] open · vscode · fallback', then one open -b
it('with no window holding its terminal a tap brings the app only, with no fallback line', …)
it('a rest shows the terminal only while VS Code is in front', …)                         // canShow false with inFront false, asked before terminalOf; show → 'ok', terminals.show(t, false); no run
it('a rest whose window has gone fails', …)                                               // 'failed', no run
it('a term id out of form is no terminal pane: the link\'s verbs refuse it and run nothing', …) // 'term:0', 'term:1', 'term:x', 'term:2147483648': focus false, show 'failed', calls []
it('it declares VS Code\'s bundle', …)                                                    // adapter.bundle === 'com.microsoft.VSCode'
```

#4407's cases in `vscode.spec.ts` (the panel's link on a tap and a rest, `tap` `'instead'`, HARNESS_OPEN_BIN, a pane id out of form) stay as they are: none is edited, and they pass at every commit of this task.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts`. Expected: FAIL in the new cases only.
- [ ] **Step 3: Implement.** The header names the two pane kinds, why the terminal pane runs its own `open -b` (the adapter's one `tap` is `'instead'`, for the panel's link), and why the terminal is asked for again at each verb (a window comes and goes between looks).
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npx tsc --noEmit && npm run test:core -- --maxWorkers=4`. Expected: PASS, `devices.ts` at 100%.
- [ ] **Step 5: Commit** `Dial: an agent in VS Code's terminal has a pane, shown by its window`.

### Task 6: Extension: its folder, in the CLI's checks

**Depends on:** none. **Effort:** xhigh (`scripts/ci-plan.py` is the planner: two independent security reviews before the pull request merges).

**Files:**
- Create: `plugins/harness-device-vscode/package.json`, `plugins/harness-device-vscode/tsconfig.json`, `plugins/harness-device-vscode/src/window.ts`, `cli/src/devices/vscodeExtensionTypes.spec.ts`
- Modify: `cli/vitest.config.ts`, `cli/package.json`, `cli/package-lock.json`, `scripts/ci-plan.py`
- Test: `plugins/harness-device-vscode/src/window.test.ts`, `scripts/tests/test_ci_plan.py`, `cli/src/devices/vscodeExtensionTypes.spec.ts`

**Interfaces — Produces:**

```ts
// plugins/harness-device-vscode/src/window.ts
export const MAX_TERMINALS = 32
export interface WindowState { terminals: number[]; active: number | null; focused: boolean }
/** The window as the loop sees it. */
export interface WindowFacade {
  /** A remote window (SSH, WSL, a container): its terminals are another computer's. */
  readonly remote: boolean
  state(): WindowState
  /** `changed` runs whenever state() may answer differently. Returns its dispose. */
  onChange(changed: () => void): () => void
  /** Shows the terminal whose shell has that pid, with focus; false when none has. */
  show(pid: number): boolean
}
/** The first 32 distinct shells whose pid is known (an integer in 2..2^31-1), in order; `active` only when it is one of them. */
export function windowState(shells: readonly (number | undefined)[], active: number | undefined, focused: boolean): WindowState
```

`package.json`, whole:

```json
{
  "name": "harness-device",
  "displayName": "Harness Device",
  "description": "The Harness dial reaches Claude Code and Codex in this window's terminals.",
  "version": "0.0.0",
  "publisher": "autonomous-ai",
  "license": "MIT",
  "engines": { "vscode": "^1.75.0" },
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"]
}
```

`tsconfig.json`, whole (checked on this repository's TypeScript: `rootDir` keeps the CLI's own `tsconfig.json` from including a folder outside `cli/src`):

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "typeRoots": ["../../cli/node_modules/@types"], "types": ["node", "vscode"],
    "paths": { "*": ["../../cli/node_modules/*"] }
  },
  "include": ["src"]
}
```

The gate's files (Task 18) are outside it, as `cli/e2e` is outside the CLI's: they import the CLI's sources, which are checked under the CLI's own options.

- `cli/vitest.config.ts`: `include` gains `'../plugins/harness-device-vscode/src/**/*.test.ts'`. (Vitest 4.1.10 runs a file outside its root that imports `vitest`: checked.) `cli/ci-test-durations.json` names none of them: its paths are `src/` only, and a file it does not name gets the default cost.
- `cli/package.json` `devDependencies`: `@types/vscode` at `~1.75.0` (the API at the `engines` floor) and `@vscode/test-electron`, its current 2.x release pinned exactly (Task 18 uses it). `npm install` writes the lockfile.
- `scripts/ci-plan.py`: `ALSO.update({"plugins/harness-device-vscode/": "cli"})`, with its comment: the CLI's build inlines the folder and the CLI's vitest runs its tests.

- [ ] **Step 1: Write the failing tests.**

```ts
// plugins/harness-device-vscode/src/window.test.ts
it('lists the shells whose pid is known, in order, and the active one', () => {
  expect(windowState([101, undefined, 303], 303, true)).toEqual({ terminals: [101, 303], active: 303, focused: true })
})
it('an active terminal whose pid is not known yet, or is not listed, is null', () => {
  expect(windowState([101], undefined, false).active).toBeNull()
  expect(windowState([101], 999, false).active).toBeNull()
})
it('keeps the first 32, and an active one past them is null', () => {
  const many = Array.from({ length: 40 }, (_, at) => 1000 + at)
  expect(windowState(many, 1039, true)).toEqual({ terminals: many.slice(0, 32), active: null, focused: true })
})
it('leaves out what is no pid, and a pid twice', () => {
  expect(windowState([1, 0, -5, 2.5, 2 ** 31, 77, 77], 77, true).terminals).toEqual([77])
})
```

```ts
// cli/src/devices/vscodeExtensionTypes.spec.ts: PR CI's tsc reads cli/src alone, so the extension is checked here
it('the extension typechecks against VS Code 1.75\'s API', () => {
  // ts.getParsedCommandLineOfConfigFile on plugins/harness-device-vscode/tsconfig.json, ts.createProgram,
  // ts.getPreEmitDiagnostics: its messages, flattened, equal []
})
it('its manifest contributes nothing and wakes at startup alone', () => {
  // package.json: no `contributes`, activationEvents ['onStartupFinished'], engines.vscode '^1.75.0', no dependencies
})
```

```python
# scripts/tests/test_ci_plan.py, SelectionTests
def test_the_vscode_extension_belongs_to_the_cli_suite(self):
    # cli/build.mjs inlines it and cli/vitest.config.ts runs its tests.
    for path in ("plugins/harness-device-vscode/src/loop.ts", "plugins/harness-device-vscode/package.json"):
        with self.subTest(path=path):
            self.assertEqual(planner.owners(path), {"cli"})
            self.assertEqual(planner.select([path])[0], {"cli"})
            self.assertTrue(planner.reads("cli", path))
            self.assertIsNone(planner.shared_input(path))
    # Orca's plugin is tested by Orca's own tools: it stays outside every suite.
    self.assertEqual(planner.select(["plugins/harness-device-orca/src/dial.ts"])[0], set())
```

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/window.test.ts src/devices/vscodeExtensionTypes.spec.ts; cd .. && python3 -m unittest scripts.tests.test_ci_plan.SelectionTests`. Expected: FAIL (no file matches the include; no tsconfig; `owners` is empty).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts && npx vitest list --filesOnly | grep -c harness-device-vscode && npx tsc --noEmit; cd .. && python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py'`. Expected: PASS; the count is 1; `CrossReadTests` passes.
- [ ] **Step 5: Commit** `Harness Device for VS Code: its folder, typechecked and tested with the CLI`.

Said in the pull request: `scripts/verify-cli-test-shards.py --suite unit` accepts paths under `cli/src/` only; no workflow runs it for the unit suite today (`cli-e2e.yml` runs it with `--suite e2e`), so it is left as it is.

### Task 7: Extension: the window from VS Code's API

**Depends on:** 6. **Effort:** high.

**Files:**
- Create: `plugins/harness-device-vscode/src/vscodeApi.ts`, `plugins/harness-device-vscode/src/facade.ts`, `plugins/harness-device-vscode/src/testing/fakeVscode.ts`
- Test: `plugins/harness-device-vscode/src/facade.test.ts`

**Interfaces — Consumes:** `WindowFacade`, `windowState` (Task 6).

**Interfaces — Produces:**

```ts
// vscodeApi.ts: what the extension reads of VS Code, by shape. The real module satisfies it (extension.ts); tests pass a fake.
export interface Disposable { dispose(): void }
export interface ApiTerminal { readonly processId: PromiseLike<number | undefined>; show(preserveFocus?: boolean): void }
export interface VscodeApi {
  env: { readonly remoteName: string | undefined }
  window: {
    readonly terminals: readonly ApiTerminal[]
    readonly activeTerminal: ApiTerminal | undefined
    readonly state: { readonly focused: boolean }
    onDidOpenTerminal(listener: (terminal: ApiTerminal) => void): Disposable
    onDidCloseTerminal(listener: (terminal: ApiTerminal) => void): Disposable
    onDidChangeActiveTerminal(listener: (terminal: ApiTerminal | undefined) => void): Disposable
    onDidChangeWindowState(listener: (state: { readonly focused: boolean }) => void): Disposable
    createOutputChannel(name: string): { appendLine(line: string): void; dispose(): void }
  }
}
// facade.ts
export function windowFacade(api: VscodeApi): WindowFacade & Disposable
// testing/fakeVscode.ts: a VscodeApi a test drives
export function fakeVscode(options?: { remoteName?: string }): {
  api: VscodeApi
  /** A terminal whose shell's pid resolves when the test says. */
  open(): { terminal: ApiTerminal; resolve(pid: number | undefined): void; shown: boolean[] }
  close(terminal: ApiTerminal): void
  activate(terminal: ApiTerminal | undefined): void
  focus(focused: boolean): void
  /** Each channel made: its name, its lines, whether it was disposed. */
  channels: Array<{ name: string; lines: string[]; disposed: boolean }>
  /** How many listeners are still registered. */
  listeners(): number
}
```

The facade reads every terminal's `processId` again on each terminal event, on `onDidChangeTerminalState` and on a window focus change (a relaunched shell gets a new pid), and tells a change when the answer differs; one that rejects, or resolves undefined, is never listed.

- [ ] **Step 1: Write the failing tests.**

```ts
it('a terminal is listed once its shell\'s pid resolves, and the change is told', …)
it('a terminal that closed leaves, and the change is told', …)
it('the active terminal is its shell\'s pid, null while that is not known', …)
it('gaining and losing focus is told', …)
it('show calls Terminal.show(false) on the terminal with that shell; false for a pid no terminal has', …)
it('a processId that rejects lists nothing and throws nothing', …)
it('remote is true with a remoteName', …)
it('dispose takes every listener back', …)        // fake.listeners() === 0
```

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/facade.test.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: a window's terminals, read from VS Code's API`.

### Task 8: Extension: the loop

**Depends on:** 6. **Effort:** xhigh.

**Files:**
- Create: `plugins/harness-device-vscode/src/inputs.ts`, `plugins/harness-device-vscode/src/loop.ts`, `plugins/harness-device-vscode/src/testing/fakeWindow.ts`
- Test: `plugins/harness-device-vscode/src/inputs.test.ts`, `plugins/harness-device-vscode/src/loop.test.ts`

The pattern is `plugins/harness-device-orca/src/dial.ts` and `inputs.ts`: read them first. Orca installs its plugin from its own folder, so nothing is imported across the two.

**Interfaces — Consumes:** `WindowFacade`, `WindowState` (Task 6).

**Interfaces — Produces:**

```ts
// inputs.ts
export const MISSING: unique symbol
export type Ran = typeof MISSING | string | null
export interface Answer { status: number; chunks: AsyncIterable<Uint8Array> }
export interface LoopInputs {
  platform: string
  /** '' when there is none. */
  home: string
  path: string
  run(file: string, args: readonly string[], bounds: { path: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<Ran>
  /** POST `body` to `/` on the Unix socket and hold its answer open. Null when it cannot connect, or is aborted before the head. */
  connect(socketPath: string, body: string, signal: AbortSignal): Promise<Answer | null>
  /** POST `body` to `/` on a connection of its own, `Connection: close`, no keep-alive agent; the status, its body read to the end, or null. */
  post(socketPath: string, body: string, signal: AbortSignal): Promise<number | null>
  watch(folder: string, changed: (name: string | null) => void, failed: () => void): () => void
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
  /** The window's id, made once per activation: a random UUID. */
  windowId: string
}
export function nodeInputs(): LoopInputs

// loop.ts
export type LoopState = 'noHarness' | 'notRunning' | 'unplugged' | 'connected'
export interface Loop { state(): LoopState | undefined; stop(): Promise<void> }
/** Null on Windows and in a remote window: nothing starts. */
export function startLoop(inputs: LoopInputs, window: WindowFacade, tell: { changed(state: LoopState): void; log(line: string): void }): Loop | null

// testing/fakeWindow.ts
export function fakeWindow(initial?: Partial<WindowState> & { remote?: boolean }): {
  window: WindowFacade
  set(next: Partial<WindowState>): void     // tells the change
  shows: number[]                           // each pid asked to be shown
}
```

Rules the tests pin:
- **Link:** `~/.local/bin/harness`, then `harness` on `PATH`, `['device', 'vscode', 'link']`, 5 000 ms, 4 096 bytes. No launcher: `noHarness`. A run that failed, output that is not link's, or `daemon: false`: `notRunning`. `devicesReady: false`: `unplugged`, the socket's folder watched (a pass at most once a second), and a look after 300 000 ms.
- **Stream:** `{"type":"vscode","window":"<id>"}`; the head within 2 000 ms; 200 is `connected`; any other answer (409 for a ninth window, 404 from an older daemon) is `notRunning`. Waits 1 000, 2 000, 4 000 … 30 000 ms; a stream open over 30 000 ms resets the wait.
- **State reports:** after the head, and on each change of the window: the latest state, at most one post each 250 ms, never one equal to the last one taken, each through `inputs.post`, never on the stream's connection. A post not answered 2xx is counted, and the state is sent again at the next slot; three in a row end the stream, and the next pass's stream sends the state again.
- **Lines:** `{"show":<pid>}` with an integer pid calls `window.show(pid)`; false is counted `not found`. `{"replaced":true}` stops the loop for good, with no line logged: another holder has this id. Any other line is skipped and counted; a line that would hold more than 1 024 bytes with its newline ends the stream.
- **The channel's lines:** `state: <LoopState>` at each change, and, a minute after the first of a minute's events, `in the last minute: <n> shows, <n> not found, <n> lines skipped, <n> states sent, <n> not sent`.
- **Stop:** the stream, the watch, a `link` still running and every timer end; nothing is told or logged after it; it resolves once the pass in flight has ended.

- [ ] **Step 1: Write the failing tests.** `loop.test.ts` drives fake inputs (a table of `run` answers, a `connect` whose chunks the test feeds, a `post` that records bodies, a clock and timers the test moves): one `it` for each rule above, among them:

```ts
it('on Windows, or in a remote window, nothing starts: no run, no connect, null', …)
it('the home\'s launcher is tried before PATH\'s, with device vscode link, 5 s and 4 KiB', …)
it.each([['no launcher', 'noHarness'], ['a run that failed', 'notRunning'], ['daemon false', 'notRunning'],
  ['an older CLI\'s usage text', 'notRunning']])('%s is %s', …)
it('unplugged watches the socket\'s folder, passes at most once a second, and looks again after 5 min', …)
it('opens the stream with its window id and is connected at the head', …)
it.each([409, 404, 500])('a %i is notRunning, and the next pass waits 1 s, then 2 s … 30 s', …)
it('a stream open over 30 s starts the wait at 1 s again', …)
it('the state is sent once the head has come, then on each change, the latest only, at most four a second', …)
it('a state equal to the last one taken is not sent', …)
it('each state is a post of its own, never on the stream', …)
it('a post that fails is sent again at the next slot; three in a row end the stream', …)
it('after the stream ends, the next one sends the state again', …)
it('a show line shows that shell\'s terminal; one for no terminal is counted', …)
it('a line it does not know, a scroll among them, is skipped and counted', …)
it('a line over 1 KiB ends the stream', …)
it('replaced stops the loop: no pass follows, and nothing is logged', …)
it('the channel gets each state once and a minute\'s counts, and never a pid or the window id', …)
it('stop ends the stream, the watch and a link still running, and nothing is told after', …)
```

`inputs.test.ts`, against a Unix socket server and scripts in the test's own temporary folder: `run` (a missing file is MISSING, a timeout or output past the bound is null, the given PATH decides which file runs); `connect` (the chunks of a held answer; null with no socket; null when aborted before the head); `post` (sends `Connection: close`, answers the status, null with no socket, its connection closed after); `watch`; `windowId` matches `/^[A-Za-z0-9-]{8,36}$/`.

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/loop.test.ts ../plugins/harness-device-vscode/src/inputs.test.ts`. Expected: FAIL (no such modules).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: the loop that holds a window's stream and reports its shells`.

### Task 9: `harness device vscode link`

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`
- Test: `cli/src/deviceClaude/command.spec.ts`

`orcaLink` becomes `devicesLink`, answered for `orca link` and for `vscode link` alike: one function, the same output (PM's decision 6). `vscode link` is left out of `DEVICE_USAGE`, as `orca link` is; the file's header and the comment above `DEVICE_USAGE` name it.

- [ ] **Step 1: Write the failing test,** in `describe('harness device orca link')`, renamed `harness device orca link and vscode link`: each existing case runs for both words (`it.each(['orca', 'vscode'])`), and one more: `it('vscode link prints what orca link prints', …)` with the same dependencies.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL (`vscode link` prints the usage and exits 1).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `harness device vscode link: where the devices' socket is, as orca link says it`.

### Task 10: Devices: VS Code's terminals wired in

**Depends on:** 3, 5 (on a head with #4407: Base). **Effort:** xhigh.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/cable/hosts/vscode.ts` (`NO_WINDOWS` goes), `cli/AGENTS.md`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** `vscodeStreams`, `VscodeTerminals` (Task 3); `createVscodeAdapter`, `termPid` (Task 5).

**Interfaces — Produces:** `DevicesDeps.processParents?: VscodeTerminalsDeps['processes']` (for this service's tests; `readProcessParents` by default).

- One `vscodeStreams({ processes: deps.processParents ?? readProcessParents, changed, now: monotonic, after: timerIn('vscode'), log })`, made before the adapters. `changed` is `part.call('dial', () => cable.syncAgents())`: an adapter's capabilities are read at each look, so the dials are told to look.
- The adapter is given `terminals` (that object) in place of `NO_WINDOWS`, which is deleted from `vscode.ts`: nothing else reads it.
- The listener's handlers gain `vscode` and `'vscode-state'`, after `notice`.
- Each change of the observed source tells the windows which agents are VS Code's, in a part of its own (`part.call('vscode', …)`): `vscode.agents(...)` with `termPid(observed.paneOf(id, 'vscode') ?? '')` of each listed agent that has one.
- `cli/AGENTS.md`, the devices row, after Orca's plugin's sentence: Claude Code and Codex in VS Code's integrated terminal, matched to their terminal by the process tree from the shells each VS Code window reports through Harness's own extension (`plugins/harness-device-vscode`) on the listener's `vscode` stream, one per window and at most 8 (`cable/hosts/vscodeTerminals.ts`); a tap shows the terminal and brings VS Code forward, and a rest shows it while VS Code is in front; each window's latest state and one parent chain an agent (in memory).

- [ ] **Step 1: Write the failing tests.** `start()` gains `processParents` (a table the spec sets, counted; empty by default, so no spec reads this machine's processes). The spec opens the `vscode` handler with a fake stream and hands states to `'vscode-state'`, as it does for `tabs` and `dial`:

```ts
it('the listener is given the vscode stream and its state report, with their bounds', …)
// Object.keys(handlers) is ['front', 'attach', 'tab', 'tabs', 'dial', 'notify', 'notice', 'vscode', 'vscode-state'];
// handlers.vscode: { maxBytes: 96, perSecond: 1, keyed: { limit: 8 } }; handlers['vscode-state']: { maxBytes: 1024, perSecond: 8 }
it('an agent in VS Code\'s terminal gets its terminal once its window reports the shell, and the dials are told to look', …)
// linux: before, its caps have no f; after the state and the read, cable.syncAgents was called and its caps have f
it('a tap writes the show to its window, then brings VS Code forward', …)        // darwin: the stream got { show: <shell> }, then open -b com.microsoft.VSCode ran once (the adapter's own), no fallback line
it('a rest shows the terminal only while VS Code is in front', …)                // front 'vscode': '[device] swipe · ok' and { show }; front 'ghostty': no pane
it('an agent that left has its chain dropped', …)                                // its pid listed again reads the table again
it('with no listener (the services inside the core) no process table is read', …)
it('a throw on the VS Code path costs the dial nothing', …)                      // faults: ['vscode']: the hook is still taken and the list still built
```

#4407's devices cases stay as they are: its `a session in VS Code's integrated terminal has no rest, with VS Code in front` opens no window, so it holds with the real windows too; the extension panel's rest cases are untouched.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement,** and write the row.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/cable/hosts src/architecture.spec.ts src/architecture.environment.spec.ts src/leanEntry.spec.ts && npx tsc --noEmit && npm run test:core -- --maxWorkers=4`. Expected: PASS; `devices.ts` and `devicesListener.ts` at 100%.
- [ ] **Step 5: Commit** `Dial: a tap and a rest reach an agent in VS Code's terminal`.

### Task 11: End to end: a tap and a swipe

**Depends on:** 4, 8, 9, 10. **Effort:** high. The proof on a real daemon; it changes no behavior: one commit, no red test.

**Files:**
- Create: `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/harness/vscodeWindow.ts`
- Modify: `cli/e2e/harness/outsideAgent.ts`

- `outsideAgent.ts`: `Outside.start(d, folder, hints, app, { shell: true })` puts a real `/bin/sh` between the fake app and the tab's pseudo-terminal, kept there (it runs the tab as a command followed by another, so it cannot replace itself with it), and `outside.shellPid` is that shell's pid. The chain `ps` shows is then the computer's own: fake `code` → `sh` → `python3` → the fake engine.
- `harness/vscodeWindow.ts`: a script, as `harness/pluginDial.ts` is: `startLoop(nodeInputs(), fakeWindow().window, …)` in a process whose whole environment is the throwaway home and `/usr/bin:/bin`. Each line on stdin is a `Partial<WindowState>` it sets; each line on stdout is `{"state":…}`, `{"show":<pid>}` or `{"log":…}`. Stdin's end stops the loop; the process then ends by itself with code 0, which says nothing was left open.
- The launcher in the throwaway home (`~/.local/bin/harness`) starts this checkout's CLI under the daemon's environment and nothing else, as `dialStream.e2e.ts` writes it.

Cases (`e2e/dialVscode.e2e.ts`), on macOS and Linux, each on a daemon of its own with a fake dial on the desk; `open` is the harness's fake, checked to be inside the daemon's root before anything is tapped:
1. Two Claude Code sessions, A and B, each under its own shell under a fake VS Code (`TERM_PROGRAM=vscode`, and VS Code's bundle id on macOS), listed on the dial. The window's loop connects (`[devices] vscode stream · open · windows 1`) and reports both shells, A's active.
2. **Tap** B (`{ t: 'agent.open', agentId: B.id }`): the window's loop prints `{"show":<B's shell>}`. On macOS the fake `open` then ran `-b com.microsoft.VSCode`, once, and the log has no `[device] open · vscode · fallback`. On Linux no `open` ran.
3. **Swipe:** with VS Code in front (a `front` line on the stdin of the real `harness hardware watch --json`), a rest on A prints `{"show":<A's shell>}` and the log says `[device] swipe · ok`. With another app in front, a rest prints nothing: the next list the dial asks for is answered first, so nothing waits a fixed time.
4. **The window goes** (its stdin ends; exit code 0; `[devices] vscode stream · ended · gone · windows 0`): a tap on B then runs `open -b` alone on macOS, and on Linux B's caps have lost `f`.
5. No line of the daemon's log that holds `vscode` holds a shell's pid, an engine's pid, the window's id or the root's path.

- [ ] **Step 1: Write** the harness change, the script and the cases.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/dialStream.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/dialVscodeFollow.e2e.ts`. Expected: PASS (the last five use `Outside`, the listener or #4407's panel rest on the same adapter, and must not have moved).
- [ ] **Step 3: Commit** `Dial: a tap and a swipe reach VS Code's terminal, end to end`.

### Task 12: Extension: activate, and its README

**Depends on:** 7, 8. **Effort:** high.

**Files:**
- Create: `plugins/harness-device-vscode/src/wire.ts`, `plugins/harness-device-vscode/src/extension.ts`, `plugins/harness-device-vscode/README.md`
- Test: `plugins/harness-device-vscode/src/wire.test.ts`

**Interfaces — Consumes:** `VscodeApi`, `windowFacade`, `fakeVscode` (Task 7); `LoopInputs`, `nodeInputs`, `startLoop` (Task 8).

**Interfaces — Produces:**

```ts
// wire.ts: no `vscode` import, so vitest loads it
/** The loop on that API and those inputs, its lines in an output channel named Harness Device. Returns its stop. */
export function wire(api: VscodeApi, inputs: LoopInputs): () => Promise<void>
// extension.ts: the only file that imports `vscode`
export function activate(): void          // stop = wire(vscode, nodeInputs())
export function deactivate(): Promise<void>
```

`extension.ts` assigns the real module to a `VscodeApi` (`const api: VscodeApi = vscode`), so the typecheck spec fails when the shape the fake stands for is not VS Code 1.75's.

- [ ] **Step 1: Write the failing tests.**

```ts
it('on Windows, or in a remote window, nothing is made: no channel, no listener', …)
it('the channel is named Harness Device and gets the loop\'s lines, nothing else', …)   // 'state: noHarness'
it('stop disposes the channel and the window\'s listeners, and stops the loop', …)      // fake.listeners() === 0, channel.disposed
```

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/wire.test.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement** the two files, and write the README: what it does (a tap on the Harness dial opens a session's own terminal; a swipe switches VS Code to it while VS Code is in front); what it never does (types nothing, reads nothing from a terminal, starts nothing but `harness device vscode link`, shows no panel, item or notification, sends nothing off the computer, does nothing in a remote window or on Windows); how it is turned on (Harness Device's menu, **Turn on VS Code**, or `harness device vscode enable`) and off (uninstall it in VS Code's Extensions view; Harness then leaves it alone); its output channel's four states; VS Code 1.75 or later, the default profile; Cursor, VS Code Insiders and VSCodium are not covered.
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: activate, deactivate and what it says of itself`.

### Task 13: The extension's install: status, enable, disable, the `.vsix`

**Depends on:** none. **Effort:** xhigh (it runs a program and reads a person's file).

**Files:**
- Create: `cli/src/devices/vscodeExtension.ts`
- Test: `cli/src/devices/vscodeExtension.spec.ts`

**Interfaces — Produces:**

```ts
export const VSCODE_EXTENSION_ID = 'autonomous-ai.harness-device'
export const VSCODE_RUN_MS = 60_000
/** VS Code's record of a person with hundreds of extensions is a few hundred KiB. */
export const VSCODE_RECORD_MAX_BYTES = 8 * 1024 * 1024
export type VscodeStatus = { vscode: 'absent' } | { vscode: 'off' } | { vscode: 'on'; version: string }
export type VscodeFailure = 'no-code' | 'timeout' | 'failed'
export type VscodeChange = VscodeStatus | (VscodeStatus & { error: VscodeFailure })
/** The extension as cli.js carries it: its package.json's text and its one bundled file. */
export interface VscodeExtensionFiles { manifest: string; main: string }
export interface VscodeExtensionDeps {
  platform: NodeJS.Platform
  home: string
  /** PATH, where Linux has `code`. */
  pathVar: string
  exists(path: string): boolean
  /** A file's text; null when it is missing, larger than `maxBytes` or cannot be read. */
  read(path: string, maxBytes: number): string | null
  /** VS Code's own CLI, with no shell. `code` is null when it was killed or could not start. */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }>
  /** Null in a run from the sources, which carries no built extension. */
  files(): VscodeExtensionFiles | null
  /** A new folder only this account can read. */
  tempDir(): string
  /** Written for this account alone (0600). */
  write(path: string, data: Buffer): void
  /** A folder and all in it; never throws. */
  remove(path: string): void
}
/** Reads files only: it runs no `code`. */
export function vscodeStatus(deps: VscodeExtensionDeps): VscodeStatus
export function vscodeEnable(deps: VscodeExtensionDeps): Promise<VscodeChange>
export function vscodeDisable(deps: VscodeExtensionDeps): Promise<VscodeChange>
/** This build's extension version, from its manifest; null with no built extension. */
export function buildVersion(deps: Pick<VscodeExtensionDeps, 'files'>): string | null
/** The version VS Code's record (extensions.json's text) lists the extension at; none when it does not. */
export function recordVersion(text: string): string | undefined
export function packVsix(files: VscodeExtensionFiles): Buffer
/** The real ones. `files` reads what the build inlined (`__VSCODE_EXTENSION__`, Task 14). */
export function vscodeExtensionDeps(): VscodeExtensionDeps
```

Rules the tests pin:
- **`absent`:** Windows, always; macOS with no `Visual Studio Code.app` in `/Applications` or `<home>/Applications` (the first that exists is the app); Linux with no `code` on `pathVar`; any other platform.
- **`on`:** `<home>/.vscode/extensions/extensions.json`, read with the bound, is a JSON array with an entry whose `identifier.id`, lower-cased, is the id and whose `version` matches `/^[0-9A-Za-z.+-]{1,64}$/`. Anything else is `off`.
- **`enable`:** the CLI is `<app>/Contents/Resources/app/bin/code` on macOS when that file exists, the `code` found on Linux; none is `{"vscode":"off","error":"no-code"}`. The `.vsix` is written as `harness-device.vsix` in `tempDir()`, `[cli, ['--install-extension', <file>, '--force'], 60 000]` runs once, and the folder is removed whatever came of it. Past the time: `timeout`. A code other than 0, no built extension, a write that threw, or a status that is not `on` afterwards: `failed`. A failure's `vscode` is always `off`. Success is the status read afterwards.
- **`disable`:** `absent` or `off` runs nothing and is the status. Else `['--uninstall-extension', 'autonomous-ai.harness-device']`, 60 000 ms; the status read afterwards, with `error` when it is still `on`.
- **`packVsix`:** exactly four entries, in this order: `extension.vsixmanifest`, `[Content_Types].xml`, `extension/package.json` (the manifest's text), `extension/extension.js` (the main file). The two XML files, with the manifest's `name`, `version`, `publisher`, `displayName`, `description` and `engines.vscode` XML-escaped into them:

```xml
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="harness-device" Version="0.6.60" Publisher="autonomous-ai"/>
    <DisplayName>Harness Device</DisplayName>
    <Description xml:space="preserve">…</Description>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.75.0"/></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
```

```xml
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
```

- [ ] **Step 1: Write the failing tests,** every one on fake dependencies (a table of files, a `run` that records and answers from a list, a temporary folder of the test's own): one `it` for each rule above, among them:

```ts
it('absent on Windows whatever is on disk, on a Mac with no app, on Linux with no code on PATH', …)
it('the app in the home\'s Applications counts; /Applications is looked at first', …)
it('on with the record\'s version; the id is compared without case', …)
it.each(['no record', 'a record cut short', 'not an array', 'over the bound', 'a version that is no version',
  'another extension only'])('%s reads as off, and nothing throws', …)
it('status runs nothing', …)                                  // run.mock.calls is []
it('enable installs the packed file once, forced, in 60 s, and removes it', …)
// run: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', ['--install-extension', <dir>/harness-device.vsix, '--force'], 60_000];
// the file was 0600 in a folder that is gone afterwards; the answer is { vscode: 'on', version }
it.each([['no CLI in the app', 'no-code'], ['a run past its time', 'timeout'], ['exit 1', 'failed'],
  ['no built extension', 'failed'], ['still off afterwards', 'failed']])('enable with %s answers off and %s', …)
it('a failed install still removes the file', …)
it('disable uninstalls by id; off or absent runs nothing', …)
it('the app\'s path, spaces and all, is the file run, never a shell\'s line', …)
it('the .vsix is the four entries, and its manifest names the id, the version and the engine', …)
// read back as zipWriter.spec.ts reads a zip: names in order; extension/package.json's bytes are the manifest's;
// the XML holds Id="harness-device" Version="1.2.3" Publisher="autonomous-ai" and Value="^1.75.0"
it('a name that needs escaping is escaped in the XML', …)     // a description with & and <
it('buildVersion is the manifest\'s version; null with no built extension', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/vscodeExtension.spec.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement.** `vscodeExtensionDeps()` is the only place that touches the real home, PATH, `execFile` (its time ends the child with SIGKILL, its output bounded and dropped) and `declare const __VSCODE_EXTENSION__: string | undefined`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/vscodeExtension.spec.ts src/leanEntry.spec.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: whether it is on, and VS Code's own install and uninstall of it`.

### Task 14: Build: the extension inside `cli.js`

**Depends on:** 12, 13. **Effort:** high.

**Files:**
- Create: `cli/scripts/lib/vscodeExtensionBundle.mjs`
- Modify: `cli/build.mjs`, `cli/build-bundle.mjs`
- Test: `cli/src/devices/vscodeExtensionBundle.spec.ts`

**Interfaces — Consumes:** `packVsix`, `VscodeExtensionFiles` (Task 13); `plugins/harness-device-vscode/src/extension.ts` (Task 12).

**Interfaces — Produces:**

```js
// cli/scripts/lib/vscodeExtensionBundle.mjs
/** A build's version as the extension's: a dev label's all-digit part with a leading zero is no semver, so it gets a letter. */
export function extensionVersion(version)          // '0.6.60-dev.0123456.dirty' → '0.6.60-dev.g0123456.dirty'
/** JSON of { manifest, main }: package.json's text with `version` set, and the extension bundled to one CommonJS file. */
export async function readVscodeExtensionBundle(version)
```

`readVscodeExtensionBundle` bundles `src/extension.ts` with esbuild (`bundle: true`, `platform: 'node'`, `format: 'cjs'`, `target: 'node16'`, `external: ['vscode']`, `write: false`). Both builds add `__VSCODE_EXTENSION__: JSON.stringify(await readVscodeExtensionBundle(version))` to `define`, beside `__STATUS_LINE_SCRIPT__`, with the build's own `version` variable.

- [ ] **Step 1: Write the failing tests.**

```ts
it('a dev label whose sha is digits with a leading zero gets a letter; any other version is as it was', () => {
  expect(extensionVersion('0.6.60-dev.0123456.dirty')).toBe('0.6.60-dev.g0123456.dirty')
  for (const same of ['0.6.60', '0.6.60-dev.3e5b290ede', '0.6.60-dev.1234567', '0.0.0-dev.box-e2e']) expect(extensionVersion(same)).toBe(same)
})
it('the manifest carries the build\'s version and names the file it ships', …)   // version '1.2.3'; main './extension.js'; no contributes
it('the bundle is one CommonJS file that requires vscode and Node\'s own modules, and nothing else', …)
// every require("…") in it is 'vscode' or passes node:module's isBuiltin
it('packed, it is the four entries', …)                                           // packVsix(JSON.parse(bundle)) read back
it('both builds inline it', …)                                                    // build.mjs and build-bundle.mjs each hold __VSCODE_EXTENSION__
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/vscodeExtensionBundle.spec.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec and `npx vitest run src/leanEntry.spec.ts` (it runs the release build), then the release build itself: `cd cli && OUT=$(mktemp -d) && BUNDLE_OUT_DIR="$OUT" ADAPTER_VERSION=0.0.0-dev.0123456 node build-bundle.mjs && grep -c '0.0.0-dev.g0123456' "$OUT/cli.js" && node scripts/check-lean-bundle.mjs "$OUT/cli.js"`. Expected: PASS; the count is at least 1; the lean check passes. Run nothing of that `cli.js` but the check. Note the size of `cli.js` before and after for the pull request (the extension is carried in the main bundle and again in the devices' lean files).
- [ ] **Step 5: Commit** `CLI build: the VS Code extension goes inside cli.js, at the CLI's version`.

Said in the pull request: a later change to the extension alone ships with the next CLI release, as the two have one version.

### Task 15: `harness device vscode status`, `enable`, `disable`

**Depends on:** 9, 13. **Effort:** high.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/cli.ts`
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces — Consumes:** `vscodeStatus`, `vscodeEnable`, `vscodeDisable`, `vscodeExtensionDeps`, `VscodeExtensionDeps` (Task 13).

**Interfaces — Produces:** `DeviceDeps.vscode(): VscodeExtensionDeps`, asked only by these three words (`cli.ts` passes `vscodeExtensionDeps`).

- `status [--json]`: prints the status (one line with `--json`, indented without), exits 0.
- `enable`: prints what `vscodeEnable` answered as one JSON line; exits 0 when its `vscode` is `on`, else 1.
- `disable`: prints what `vscodeDisable` answered as one JSON line; exits 1 when it holds `error`, else 0.
- All three are left out of `DEVICE_USAGE`; an unknown `vscode` word prints the usage and exits 1.

- [ ] **Step 1: Write the failing tests** in `describe('harness device vscode')`, each with a `vscode` dependency of fakes (never `vscodeExtensionDeps`):

```ts
it('status --json prints one line: absent, off, or on with its version', …)     // '{"vscode":"on","version":"0.6.60"}', code 0
it('enable prints the status and exits 0 once it is on', …)
it.each(['no-code', 'timeout', 'failed'])('enable that fails prints {"vscode":"off","error":"%s"} and exits 1', …)
it('disable uninstalls and exits 0; one that fails exits 1 with its word', …)
it('the usage names none of them, and an unknown vscode word prints it', …)
it('link, claude and codex words never ask for the vscode dependencies', …)     // deps.vscode not called
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement.** The file's header gains the three words and who runs them (Harness Device's menu, support).
- [ ] **Step 4: Run** `cd cli && npx vitest run src/deviceClaude && npx tsc --noEmit`. Expected: PASS. Do not run the built command's `enable` or `disable` on this computer.
- [ ] **Step 5: Commit** `harness device vscode: status, enable and disable`.

### Task 16: Devices: the extension brought current

**Depends on:** 10 (shared `devices.ts`, after the path to tap and swipe), 13. **Effort:** high.

**Files:**
- Create: `cli/src/cable/vscodeExtensionUpdate.ts`
- Modify: `cli/src/services/devices.ts`, `cli/AGENTS.md`
- Test: `cli/src/cable/vscodeExtensionUpdate.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** `vscodeStatus`, `vscodeEnable`, `buildVersion`, `vscodeExtensionDeps`, `VscodeExtensionDeps` (Task 13).

**Interfaces — Produces:**

```ts
export const UPDATE_RETRY_MS = 3_600_000
export interface VscodeExtensionUpdateDeps {
  platform: NodeJS.Platform
  status(): VscodeStatus
  /** This build's extension version; null with no built extension. */
  version(): string | null
  enable(): Promise<VscodeChange>
  after(ms: number, run: () => void): () => void
  count(kind: 'updated' | 'failed' | 'off', reason?: string): void
}
/** One look now; a failed update is tried again an hour later, while the process runs. Never rejects, never throws. */
export function startVscodeExtensionUpdate(deps: VscodeExtensionUpdateDeps): void
// services/devices.ts
// DevicesDeps.vscodeExtension?: VscodeExtensionDeps   (for this service's tests; vscodeExtensionDeps() by default)
```

- On at this build's version, `absent`, Windows, or no built extension: nothing, nothing counted.
- `off`: nothing runs; `off` is counted (an extension the person uninstalled stays uninstalled).
- On at another version: `enable()`. `on` afterwards counts `updated`; else `failed` with the error's word, and one more look after 3 600 000 ms.
- In `devices.ts`: started once, in a part of its own (`part.call('vscodeExtension', …)`), only where the devices have their own listener (`deps.listen`), its `status`, `version` and `enable` being `vscodeStatus`, `buildVersion` and `vscodeEnable` on `deps.vscodeExtension ?? vscodeExtensionDeps()`, with `after: timerIn('vscodeExtension')` and a count through `createEngineTally('[device] vscode extension', ['vscode'], ['updated', 'failed', 'off'], log)`. The spec's measure list also names `set up`: nothing here installs from off, so it has no line.
- `cli/AGENTS.md`, the devices row: the extension brought current once at each start of the process when it is on at another version, through VS Code's own `code --install-extension`, up to 60 s, never when it is off (`cable/vscodeExtensionUpdate.ts`).

- [ ] **Step 1: Write the failing tests.**

```ts
// vscodeExtensionUpdate.spec.ts
it('on at another version runs enable once and counts updated', …)
it('on at this version, absent, Windows, or no built extension: nothing runs and nothing is counted', …)
it('off stays off: enable never runs, and off is counted', …)
it('a failed update counts its word and looks again after an hour, once', …)      // after called with 3_600_000; the second look updates
it('an enable that throws is a failed update, never a throw', …)
// devices.spec.ts: start() always passes a fake vscodeExtension (absent unless the spec says), never the real one
it('the extension is brought current as the devices start, in their own process alone', …)   // with listen: one install run; without: none
it('a throw there costs the dial nothing', …)                                                 // faults: ['vscodeExtension']
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/vscodeExtensionUpdate.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement,** and write the row.
- [ ] **Step 4: Run** the same, then `npm run test:core -- --maxWorkers=4 && npx vitest run src/leanEntry.spec.ts`. Expected: PASS, `devices.ts` at 100%.
- [ ] **Step 5: Commit** `Dial: the VS Code extension follows the CLI's version, and one that was removed stays removed`.

### Task 17: Harness Device: Turn on VS Code

**Depends on:** none (the CLI's words are its contract; its tests run the fake `harness`). **Effort:** high.

**Files:**
- Create: `device-app/src-tauri/src/vscode.rs`
- Modify: `device-app/src-tauri/src/types.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs`, `lib.rs`, `docs/naming-system.md`, `docs/plans/2026-11-13-device-menubar-design.md`
- Test: the `#[cfg(test)]` modules of `vscode.rs`, `model.rs`, `app.rs`, `runner.rs`, `main.rs`

**Interfaces — Produces:**

```rust
// types.rs
/// What `harness device vscode status --json` said. Absent: no VS Code on this computer.
pub enum Vscode { Absent, Off, On }
/// Why a turn-on did not happen: the CLI's own word.
pub enum VscodeFailure { NoCode, Timeout, Failed }     // as_str(): "no-code" | "timeout" | "failed"
// MenuAction gains TurnOnVscode. AppState gains:
//   pub vscode: Option<Vscode>,   // None: not read yet, or a CLI with no such word
//   pub vscode_busy: bool,        // the click's run has not answered
// Event gains Vscode(Option<Vscode>) and VscodeTurnedOn(Result<(), VscodeFailure>).
// Effect gains ReadVscode and TurnOnVscode.

// vscode.rs
pub const TURN_ON_DEADLINE: Duration = Duration::from_secs(90);
/// `device vscode status --json`, within STATUS_DEADLINE: exit 0 and a line {"vscode":"absent"|"off"|"on"}; else None.
pub fn status(cli: &dyn Cli) -> Option<Vscode>
/// `device vscode enable`, within 90 s. Ok when it exits 0 and says "on". Its "error" when that is one of the three
/// words; Timeout when the deadline passed; Failed for anything else.
pub fn turn_on(cli: &dyn Cli) -> Result<(), VscodeFailure>
```

- `model.rs` `menu`: `Action(TurnOnVscode, "Turn on VS Code")` is the last row above the separator, only when `cli == Found`, `vscode == Some(Off)` and `!vscode_busy`.
- `app.rs`: `read()` also pushes `Effect::ReadVscode` (at start, on `MenuOpened` at most every `READ_EVERY_SECS`); `Event::Vscode(v)` with the CLI found sets `state.vscode`, and is not heard once the CLI went; the click, when the item shows, sets `vscode_busy` and pushes `Effect::TurnOnVscode`, and any other click of it does nothing; `Event::VscodeTurnedOn(r)` clears `vscode_busy`, logs `vscode: not turned on · <word>` on a failure, and pushes `Effect::ReadVscode`; `Event::Cli(false)` clears both.
- `runner.rs`: both effects run on the CLI's thread (`with_cli`), with arguments fixed in Rust.
- `main.rs`: `menu_id(TurnOnVscode)` is `"turn_on_vscode"`; the two lists of actions hold eleven.
- `docs/naming-system.md`: "Keep vendor names intact: **Claude Code**, **Codex**, **OpenCode**, **pi**, and **VS Code**."
- `docs/plans/2026-11-13-device-menubar-design.md`: the Menu table gains the row (when it shows, what its click runs, that it goes once the extension is on), and "Claude Code and Codex" says the app runs two `harness device` words, both VS Code's, and none for an agent.

- [ ] **Step 1: Write the failing tests.**

```rust
// model.rs
#[test]
fn the_vs_code_item() {
    let off = AppState { vscode: Some(Vscode::Off), ..state() };
    let item = act(MenuAction::TurnOnVscode, "Turn on VS Code");
    let items = menu(&off);
    let at = items.iter().position(|row| *row == item).unwrap();
    assert_eq!(items[at + 1], Separator);
    for vscode in [None, Some(Vscode::Absent), Some(Vscode::On)] {
        assert!(!menu(&AppState { vscode, ..state() }).contains(&item), "{vscode:?}");
    }
    assert!(!menu(&AppState { vscode_busy: true, ..off.clone() }).contains(&item));
    for cli in [CliState::Removed, CliState::Installing, CliState::InstallFailed] {
        assert!(!menu(&AppState { cli, ..off.clone() }).contains(&item), "{cli:?}");
    }
}

/// states() now also crosses vscode (None, Absent, Off, On) and vscode_busy.
#[test]
fn no_agent_rows_in_any_state() {
    for state in states() {
        let line = menu_log(&menu(&state));
        for word in ["Claude Code", "Codex", "Turn off", "Turning"] {
            assert!(!line.contains(word), "{line}");
        }
        // "Turn on" names VS Code alone, an app and not an agent, and once at most.
        assert_eq!(line.matches("Turn on").count(), line.matches("Turn on VS Code").count(), "{line}");
        assert!(line.matches("Turn on VS Code").count() <= 1, "{line}");
    }
}
// the_menu_as_a_log_line gains: "Dial connected | Signed in | Turn on VS Code | Open Harness | About | Quit"
```

```rust
// vscode.rs, with the fake CLI (testing::Fake)
fn status_reads_the_three_words()      // {"vscode":"off"} → Some(Off); "on" with a version → Some(On); "absent" → Some(Absent)
fn a_cli_with_no_such_word_is_none()   // the usage on stderr and exit 1; a line that is no status; a word it does not know; @hang past the deadline
fn turn_on_is_ok_only_when_it_says_on()
fn a_failure_keeps_the_clis_word_and_no_other_text()   // {"vscode":"off","error":"no-code"} @exit 1 → NoCode; an unknown word → Failed; @hang → Timeout
// app.rs
fn the_status_is_read_at_start_when_the_menu_opens_and_after_a_click()
fn a_click_turns_it_on_once_and_the_item_hides_while_it_runs()
fn a_failed_turn_on_logs_its_word_and_reads_the_status_again()
fn a_status_that_answers_after_the_cli_went_away_is_not_heard()
// runner.rs: each_effect_gives_its_answer gains both effects ("device vscode status --json", "device vscode enable");
// the_binary_gets_its_four_effects_back and without_a_cli_what_needs_one_says_so list them
// main.rs: every_menu_action_has_its_own_id counts 11
```

- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: FAIL to compile (the new names).
- [ ] **Step 3: Implement,** and write the two documents.
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --locked` (on this Mac; `ui/dist` built). Expected: `test result: ok`, 0 failed.
- [ ] **Step 5: Commit** `Harness Device: Turn on VS Code, shown while VS Code is here and the extension is not`.

### Task 18: Local gate: the extension in a real, throwaway VS Code

**Depends on:** 3, 12, 14. **Effort:** high. A check, no behavior: one commit, no red test.

**Files:**
- Create: `cli/vitest.vscode.config.ts`, `plugins/harness-device-vscode/gate/realVscode.gate.ts`, `plugins/harness-device-vscode/gate/driver/package.json`, `plugins/harness-device-vscode/gate/driver/run.cjs`
- Modify: `cli/package.json` (`"test:vscode": "vitest run --config vitest.vscode.config.ts"`), `docs/validation-and-release.md`

**Interfaces — Consumes:** `readVscodeExtensionBundle` (Task 14); `packVsix`, `recordVersion` (Task 13); `openDevicesListener` and `vscodeStreams` (Tasks 2, 3): the gate's far end is the devices' real half, not a stand-in.

- `vitest.vscode.config.ts`: `include: ['../plugins/harness-device-vscode/gate/**/*.gate.ts']`, one file at a time, a 300 s timeout (the download).
- The gate, in one temporary root it makes and removes (`mkdtemp('/tmp/harness-vscode-gate-')`: short, as a Unix socket's path has 96 bytes):
  1. `downloadAndUnzipVSCode({ cachePath: <root>/vscode })`, the stable release. Before anything runs, it asserts that the executable, the user data folder, the extensions folder and the home are all inside the root.
  2. It builds the bundle at the CLI's `package.json` version, packs it, and installs it with the throwaway's own CLI: `--install-extension <root>/harness-device.vsix --force --user-data-dir <root>/user-data --extensions-dir <root>/extensions`, with `HOME=<root>/home`. Exit 0.
  3. `recordVersion` of `<root>/extensions/extensions.json` is that version: a real VS Code took the hand-packed file, and its record reads as `status` reads it.
  4. It opens the real listener on `<root>/h/devices.sock` with `vscodeStreams`' two handlers, and writes a launcher at `<root>/home/.local/bin/harness` that prints `{"daemon":true,"devicesSocket":"<that socket>","devicesReady":true}` for `device vscode link` and nothing else.
  5. `runTests` starts the throwaway with the same two directories, `extensionTestsEnv: { HOME: <root>/home, PATH: '/usr/bin:/bin' }`, and the driver as the development extension. The driver (`run.cjs`, inside the extension host) is the gate's hands and nothing more: it connects to a control socket under the root and answers `terminals` (it makes two and says their shells' pids), `active` (the active terminal's pid) and `exit`.
  6. Asserts, each waited for with `until`, never a sleep: one `vscode` stream opened; a state lists both shells; `show` of the second, queued through `vscodeStreams`, makes the state's `active` and the driver's `active` the second shell; `show` of the first makes them the first; after `exit`, VS Code ends with code 0 and the stream ended `gone`.
- `docs/validation-and-release.md`, "What PR CI does not run", one row: the Harness Device VS Code extension in a real VS Code (`npm run test:vscode` in `cli/`); nowhere automatically; when you change `plugins/harness-device-vscode/`, the `.vsix`'s packing or the record's reader (`cli/src/devices/vscodeExtension.ts`, `cli/scripts/lib/vscodeExtensionBundle.mjs`). It downloads a VS Code into a temporary folder and runs it with its own user data, extensions and home; a window opens for about a minute.

- [ ] **Step 1: Write** the config, the gate and the driver.
- [ ] **Step 2: Run** `cd cli && npm run test:vscode` on this Mac. Expected: PASS; one VS Code window opened and closed; `ls /tmp | grep -c harness-vscode-gate` prints 0; the repository holds no `.vscode-test` folder (`git status --short` is clean of it).
- [ ] **Step 3: Run** `cd cli && npx vitest list --filesOnly | grep -c 'gate'`. Expected: 0 (the default suite, and so PR CI, never runs the gate).
- [ ] **Step 4: Commit** `Harness Device for VS Code: a local gate runs it in a real, throwaway VS Code`.

### Task 19: The tap raises the window (only if the spike found a way)

**Depends on:** 1, 3, 5, 7, 8, 11, 12, 18 (it changes files each of them makes; on a head with #4407: Base). **Effort:** high. **Skipped whole** when "Spike findings" says "none", or names a way the PM has not approved (Task 1, step 4): the pull request then carries the sentence "With two or more VS Code windows, a tap on a terminal in a window behind shows it there without raising it."

This task is written for the one shape that needs no decision: a command the extension runs in its own window after it shows the terminal (candidates 1 to 3). Any other shape is planned again with the PM's answer.

**Files (the most it may touch):**
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts`, `cli/src/cable/hosts/vscode.ts`, `plugins/harness-device-vscode/src/loop.ts`, `src/window.ts`, `src/facade.ts`, `src/vscodeApi.ts`, `src/testing/fakeVscode.ts`, `src/testing/fakeWindow.ts`, `README.md`, `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/harness/vscodeWindow.ts`, `plugins/harness-device-vscode/gate/realVscode.gate.ts`, `gate/driver/run.cjs`
- Test: `cli/src/cable/hosts/vscodeTerminals.spec.ts`, `cli/src/cable/hosts/vscode.spec.ts`, `plugins/harness-device-vscode/src/loop.test.ts`, `src/facade.test.ts`

- A tap's line is `{"show":<pid>,"raise":true}`; a rest's stays `{"show":<pid>}` (an older extension ignores the field). `WindowFacade` gains `raise(): void`, which runs what the spike found.

- [ ] **Step 1: Write the failing tests.**

```ts
it('a tap\'s show asks for the window, a rest\'s does not', …)                       // vscodeTerminals.spec.ts: show(t, true) writes { show, raise: true }
it('a show that asks for the window raises it after the terminal is shown; one that does not, does not', …)   // loop.test.ts
it('raise runs <the command the spike found>', …)                                    // facade.test.ts
```

- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** The end-to-end case 2 expects the tap's line with `raise`; the two-window raise case is not in the gate (Decisions, 4).
- [ ] **Step 4: Run** the three files, `e2e/dialVscode.e2e.ts` and `npm run test:vscode`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a tap raises the VS Code window that holds the terminal`.

---

The six tasks below are scroll. See "Shipping without scroll".

### Task 20: Scroll: the shown agent's id reaches the host

**Depends on:** 11 (PM's order; no code dependency). **Effort:** high.

**Files:**
- Modify: `cli/src/cable/cableSession.ts`, `cli/src/cable/cableHost.ts`
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces — Produces:**

```ts
// cableSession.ts, CableHost
dialShows?(dial: object, agent: DialAgent | null, agentId: string | null): void
// cableHost.ts, DaemonCableHost
/** The id of the agent the dial that moved last shows; none once that dial shows none. */
shownAgentId(): string | undefined
```

`DialAgent` stays `{ name, app }` and `CableHostWiring.dialShows` stays `(agent) => void`: the `dial` stream keeps writing a name and an app only. `reportShown` tells the host when the id changed too, though the name and the app are the same.

- [ ] **Step 1: Write the failing tests.**

```ts
// cableSession.spec.ts
it('the host hears the shown agent\'s id beside its name and app', …)
it('a move between two agents of one name and app is told, with the new id', …)
// cableHost.spec.ts
it('shownAgentId is the agent the dial that moved last shows; none once it shows none; another dial\'s none changes nothing', …)
it('the wiring still hears a name and an app, and no id', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run src/services/devices.spec.ts src/services/devicesListener.spec.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the host knows which agent the dial shows, by its id`.

### Task 21: Scroll: travel into lines, and a window's scroll

**Depends on:** 3, 11 (PM's order). **Effort:** high.

**Files:**
- Create: `cli/src/cable/hosts/scrollLines.ts`
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts`
- Test: `cli/src/cable/hosts/scrollLines.spec.ts`, `cli/src/cable/hosts/vscodeTerminals.spec.ts`

**Interfaces — Produces:**

```ts
// scrollLines.ts: tui/src/dial.rs's numbers, so a stroke moves a terminal in VS Code as far as it moves Harness's own
export const SCROLL_SCALE = 2.5
export const SCROLL_LINE_PX = 16
/** One stroke's travel as whole lines: n < 0 toward older lines. `down` forgets what was left of the last stroke. */
export function createScrollLines(): { take(phase: 'down' | 'move' | 'up', dy: number): number }
// vscodeTerminals.ts, VscodeTerminals gains
/** Adds whole lines for that terminal; false when its window's stream is gone. */
scroll(terminal: VscodeTerminal, lines: number): boolean
export const VSCODE_SCROLL_MAX = 100
```

- `take`: `remainder += -dy * 2.5`; `n = Math.trunc(remainder / 16)`; `remainder -= n * 16`; a `down` sets `remainder` to 0 first. No line is `0`, never `-0` (`toBe(0)` tells them apart).
- A window's writer: the pending show first, then `{"scroll":<n>,"pid":<shell>}` with |n| at most 100, what is over staying for the line after it. Lines that cannot be written at once are added to what waits. Lines for another shell replace what waits, and what they replaced is counted dropped. What waits goes with its window.
- The minute's line ends `…, <n> scroll lines, <n> dropped`.

- [ ] **Step 1: Write the failing tests.**

```ts
// scrollLines.spec.ts
it('whole lines are spent and the rest is kept, as dial.rs travels', () => {
  const lines = createScrollLines()
  expect(lines.take('down', 0)).toBe(0)
  expect(lines.take('move', 4)).toBe(0)      // -10 px
  expect(lines.take('move', 4)).toBe(-1)     // -20 px: one line toward older, -4 px kept
  expect(lines.take('move', -8)).toBe(1)     // +16 px: one line toward newer, 0 kept
})
it('a down forgets what the last stroke left', …)
it('an up carries its travel and no fling', …)   // take('up', 8) is -1; nothing more comes
// vscodeTerminals.spec.ts
it('whole lines are written at once on a writable stream, with the shell\'s pid', …)      // { scroll: -3, pid: 700 }
it('lines that cannot be written yet are added to the next line, 100 at most, the rest after it', …)
it('a show that waits is written before the scroll', …)
it('lines for another shell replace what waits, and that is counted dropped', …)
it('scroll answers false once the window\'s stream has ended, and what waited is gone', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/scrollLines.spec.ts src/cable/hosts/vscodeTerminals.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a stroke's travel as lines for a VS Code window`.

### Task 22: Scroll: the extension runs a scroll line

**Depends on:** 7, 8, 12, 11 (PM's order). **Effort:** high.

**Files:**
- Modify: `plugins/harness-device-vscode/src/window.ts`, `src/vscodeApi.ts`, `src/facade.ts`, `src/loop.ts`, `src/testing/fakeVscode.ts`, `src/testing/fakeWindow.ts`, `README.md`
- Test: `plugins/harness-device-vscode/src/loop.test.ts`, `src/facade.test.ts`

**Interfaces — Produces:**

```ts
// window.ts, WindowFacade gains
/** One line toward older lines (`up`) or newer, in the active terminal. */
scrollLine(up: boolean): Promise<void>
// vscodeApi.ts, VscodeApi gains
commands: { executeCommand(command: string): PromiseLike<unknown> }
```

- `scrollLine(true)` runs `workbench.action.terminal.scrollUp`, `scrollLine(false)` `workbench.action.terminal.scrollDown`.
- `{"scroll":<n>,"pid":<pid>}` with a whole n that is not 0 and an integer pid: when the window's active terminal is that pid as the run starts, `scrollLine` runs min(|n|, 100) times, one after another. Otherwise the line is dropped and counted. One run at a time: lines that come during a run are summed into one next run for the same pid, held to 100 either way; a line for another pid replaces what waits. A `scrollLine` that rejects ends its run, counted.
- The channel's minute line ends `…, <n> scroll lines, <n> dropped`: `scroll lines` counts each `scrollLine` that resolved (VS Code ran its command), `dropped` each scroll line that ran nothing. Task 25's gate reads these two counts.
- The README gains: the dial's scroll scrolls that terminal while VS Code is in front.

- [ ] **Step 1: Write the failing tests.**

```ts
// loop.test.ts
it('n below zero scrolls up that many lines, above zero down', …)
it('more than 100 in a line runs 100', …)
it('a line for a terminal that is not the active one runs nothing and is counted', …)
it('lines that come during a run are one next run for the same terminal, 100 at most', …)
it.each(['{"scroll":0,"pid":7}', '{"scroll":1.5,"pid":7}', '{"scroll":2}', '{"scroll":"2","pid":7}'])('%s is skipped and counted', …)
it('a scroll that rejects ends its run and is counted', …)
it('the minute\'s line counts each scrollLine that resolved as a scroll line, and each line that ran nothing as dropped', …) // -3 on the active: 3; one for another pid: 1 dropped
// facade.test.ts
it('scrollLine runs the terminal\'s scrollUp or scrollDown, once', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src`. Expected: FAIL in the new cases (Task 8's `a line it does not know, a scroll among them` changes to a line of another kind).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts src/devices/vscodeExtensionBundle.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: a scroll line scrolls the active terminal`.

### Task 23: Scroll: the dial's scroll goes to the terminal

**Depends on:** 10, 20, 21. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/AGENTS.md`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** `shownAgentId()` (Task 20); `createScrollLines`, `VscodeTerminals.scroll` (Task 21); `termPid` (Task 5).

- The wiring's `scrolled` runs in the `dial` part. The route is chosen at a stroke's `down` and kept until its `up`; a `move` or an `up` with no `down` before it chooses then.
- **To VS Code** when `cableHost.latestFront() === 'vscode'`, the dial shows an agent (`cableHost.shownAgentId()`), that agent has a `term:` pane (`observed.paneOf(id, 'vscode')`), and a window holds its terminal (`vscode.terminalOf`). Then each piece's lines (`createScrollLines().take`) go to `vscode.scroll`, nothing goes to the windows, and an `up`'s velocity is not played.
- **Otherwise** `dial_scroll` goes to Harness's windows exactly as today, velocity and all.
- `cli/AGENTS.md`, the devices row: the dial's scroll scrolls that terminal, line by line, while VS Code is in front and the dial shows such an agent.

- [ ] **Step 1: Write the failing tests.**

```ts
it('with VS Code in front and the dial on an agent whose terminal a window holds, a stroke\'s lines go to that window and the windows hear no dial_scroll', …)
it.each(['another app in front', 'an agent with no terminal', 'a Harness agent', 'no agent shown'])('with %s the stroke goes to the windows as before, velocity and all', …)
it('a stroke keeps the route its down chose: the front changing in its middle moves neither its moves nor its up', …)   // both directions
it('a fling is not played: an up with a velocity writes its own travel and no more', …)
it('a stroke whose window went writes nothing and never turns to the windows mid-stroke', …)
it('a throw on the scroll path is the part\'s, not the dial\'s', …)
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement,** and write the sentence.
- [ ] **Step 4: Run** the same, then `npm run test:core -- --maxWorkers=4 && npx tsc --noEmit`. Expected: PASS, `devices.ts` at 100%.
- [ ] **Step 5: Numbers for the pull request** (hot path: a scroll frame): the median of 1 000 `scrolled('move', …)` calls on each route, on this Mac, before and after.
- [ ] **Step 6: Commit** `Dial: its scroll scrolls the session's terminal in VS Code`.

### Task 24: Scroll: end to end

**Depends on:** 11, 22, 23. **Effort:** high. One commit, no red test.

**Files:**
- Modify: `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/harness/vscodeWindow.ts`

- `vscodeWindow.ts` prints `{"scroll":"up"}` or `{"scroll":"down"}` for each `scrollLine`.
- One more case: with VS Code in front, the dial on A and A's shell the window's active terminal, the fake dial sends `{ t: 'scroll', phase: 'down', dy: 0, v: 0 }`, three moves of `dy` 8 (20 px each: one line toward older every time, by `scrollLines`' numbers), and an `up`: the window's loop prints `{"scroll":"up"}` three times and nothing else, and no window of Harness heard a `dial_scroll`. Then with B's shell active in the window: the same stroke prints nothing, and the loop's minute line counts it dropped. Then with another app in front: the stroke prints nothing in VS Code.

- [ ] **Step 1: Write** the case.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/deviceCompat.e2e.ts`. Expected: PASS (`deviceCompat` sends a scroll to Harness's windows and must not have moved).
- [ ] **Step 3: Commit** `Dial: its scroll reaches VS Code's terminal, end to end`.

### Task 25: Scroll: the gate counts a line's scroll commands

**Depends on:** 18, 21, 22. **Effort:** medium. A check, no behavior: one commit, no red test.

**Files:**
- Modify: `plugins/harness-device-vscode/gate/realVscode.gate.ts`

The gate does not read where a terminal is scrolled: VS Code's API does not say, and the visual scroll is the person's check after merge (Verification check 6 (d); PM, 2026-11-17). It proves, in the real throwaway, that a scroll line runs VS Code's scroll command on the right terminal, by the extension's own count (Task 22: `scroll lines` counts each `scrollLine` that resolved, `dropped` each line that ran nothing).

- **The count.** VS Code writes each extension's output channel to a file under its `--user-data-dir`'s `logs` folder. The gate reads the one file under `<root>/user-data/logs` whose name ends `Harness Device.log`, and sums, over every `in the last minute: …, <n> scroll lines, <n> dropped` line in it, the two counts. No file, or more than one, fails the gate with that number (no path in the message).
- **The steps,** in a test of their own after the shows' and before the exit's (each test keeps the file's 300 s), each waited for with `until`, never a sleep. The extension writes its counts a minute after a minute's first event, so the two steps take up to two minutes:
  1. With the second shell active (the last `show`), `scroll(<second terminal>, -3)` through `vscodeStreams`: the sums become 3 scroll lines and 0 dropped.
  2. Then `scroll(<first terminal>, 2)`, the first shell not active: the sums become 3 and 1. Step 2 waits for step 1's sums, so the devices never replace a line that waits with the next (Task 21).

- [ ] **Step 1: Write** the test.
- [ ] **Step 2: Run** `cd cli && npm run test:vscode` on this Mac. Expected: PASS; the same clean-up as Task 18's step 2 (`ls /tmp | grep -c harness-vscode-gate` prints 0).
- [ ] **Step 3: Commit** `Harness Device for VS Code: the gate counts a scroll line's commands on the active terminal`.

---

## Docs the spec names, and the task that changes each

| Document | Task |
|---|---|
| `cli/AGENTS.md`, the devices row (VS Code's terminals; the extension's update; scroll) | 10, 16, 23 |
| `cli/src/services/AGENTS.md` and the header of `devicesListener.ts` (a keyed stream type) | 2 |
| `docs/validation-and-release.md` (the `@vscode/test-electron` local gate) | 18 |
| `docs/naming-system.md` (VS Code among vendor names) | 17 |
| `docs/plans/2026-11-13-device-menubar-design.md` (the item) | 17 |
| `plugins/harness-device-vscode/README.md` | 12 (22 adds scroll) |

## Spike findings

**2026-11-17, VS Code 1.146.0 (stable) and 1.75.0, macOS 26.6.2 (arm64).**

**Setup.** The throwaway was downloaded with `@vscode/test-electron` into `/tmp/harness-vscode-spike-*` and made ready only by
the gate's `throwawayApp.ts`: `rebrand` before the first launch, `assertRebranded` and `stamp` before each launch,
`assertUnchanged` after each launch, and `unregister` before the folder was removed. Every launch had its own
`--user-data-dir`, `--extensions-dir` and `HOME`, with `VSCODE_*` and `ELECTRON_*` removed. The developer's
`com.microsoft.VSCode.plist` had the same mtime and hash before and after each of the 122 launches over four runs. After each run `pgrep -f`
on the root printed nothing.

A probe extension, installed as a `.vsix`, made one terminal in each of two windows (`w1`, `w2`) and took steps over a
Unix socket. A window counted as raised when `vscode.window.state.focused` turned true in `w1`. The app counted as in
front when `lsappinfo front` named the throwaway's pid. `w2` was always made the last active window first, by running
the throwaway's executable again with `w2`. Each candidate then ran from `w1` in two scenarios:
- **A:** the throwaway is in front.
- **B:** Finder is in front. After the candidate, the throwaway's executable runs with no folder: the running
  instance raises its last active window, as `open -b` does. `open -a <throwaway>` with no folder did not activate
  the throwaway, which had been started by its executable, so it could not stand in for `open -b`.

Only the throwaway's own path was ever run. No `vscode://` link was opened, and no permission prompt appeared.

| # | Candidate | A: `w1` raised | B: `w1` in front after the activation | Needs |
|---|---|---|---|---|
| 1 | `Terminal.show(false)` alone | no, 0 of 3 | no, 0 of 3 (`w2` raised) | — |
| 2 | `show(false)`, then `workbench.action.terminal.focus` | no, 0 of 3 | no, 0 of 3 (`w2` raised) | — |
| 3 | `show(false)`, then `workbench.action.focusWindow`, the only command the `focusWindow\|window\.focus` filter finds in 1.146.0 | **yes, 3 of 3** | **yes, 3 of 3**: the command alone brings the app in front | nothing new. The command first ships in VS Code **1.128.0** (`FocusWindowAction`, microsoft/vscode `dd6118537b`). Its run is `hostService.focus(getActiveWindow(), { mode: FocusMode.Force })`. 1.75.0 does not have it. |
| 4 | Outside: the throwaway's CLI, `--reuse-window <w1's folder>` | yes, 3 of 3 | yes, 3 of 3 | sends the folder's path off the window (ruled out, Task 1 step 4) |
| 5 | From the extension host: `<appRoot>/bin/code --reuse-window <own folder>` | yes, 3 of 3 | yes, 3 of 3 | the extension starting a program other than `link` (ruled out) |
| 6 | Outside: `open -a <throwaway app> <w1's folder>` | yes, 3 of 3 | yes, 2 of 2 (one setup failed) | sends a path (ruled out). A folder path that differs from the window's only by a symlink (`/tmp` and `/private/tmp`) opens a third window instead. |
| 7 | `show(false)`, then `vscode.openFolder(<own folder>, { forceReuseWindow: true })` | 2 of 3 | 0 of 3 | unreliable |

Window-related commands outside the filter, `workbench.action.switchWindow` and `workbench.action.quickSwitchWindow`, are
pickers and were not tried.

**Decision.** Candidate 3, `workbench.action.focusWindow` run in the terminal's own window after `Terminal.show(false)`,
is the first that works with no new permission. It sends no path and starts no program. It is a command the extension
runs in its own window, so Task 19 runs as written. Because the command makes `w1` the last active window, the
devices' `open -b` after the tap keeps `w1` in front, whichever runs first. On VS Code older than 1.128.0 the command
does not exist. There, a tap on a terminal in a window behind still shows the terminal in that window, without raising it.

**Task 19: runs.**
- `WindowFacade.raise()` is `vscode.commands.executeCommand('workbench.action.focusWindow')`.
- The extension runs it only on a tap's show (`"raise":true`), after `Terminal.show(false)`.
- On VS Code before 1.128.0 the command does not exist and `executeCommand` rejects. `raise()` swallows that: no
  throw, no log line with a name. The `^1.75.0` engine stays.
- The pull request says: "With two or more VS Code windows, a tap raises the window that holds the terminal on VS
  Code 1.128 or later; on older versions it shows the terminal there without raising it."
- The gate's second window: `runTests`' development host keeps a single window. The spike opened its second window by
  running the throwaway's executable again, with the same `--user-data-dir`, `--extensions-dir` and `HOME` and a
  second folder; the running instance took it. A window opened by the driver with `vscode.openFolder(…,
  { forceNewWindow: true })` also gets the installed extension.
  The gate does not use it in the end (Decisions, 4).

## Decisions of 2026-11-17 (the draft's open questions, answered by the PM)

1. #4407 (`feat/dial-vscode-follow`) merges first and this branch is rebased onto it (Base); the terminal pane stays in the one `vscode` adapter, `tap: 'instead'`, its `focus` running `open -b com.microsoft.VSCode` itself on macOS after its show is queued, and the panel's tap and rest stay as #4407 left them (Task 5).
2. The real-VS Code gate does not read the terminal's scroll position: it checks the install, the pids, `show`, and that a scroll line runs VS Code's scroll command on the right terminal by the extension's count (Task 25); the visual scroll is the person's check after merge (Verification check 6 (d)).
3. A process-table read happens only while some window holds a state and some VS Code agent has no chain, so never with the extension off (Design; Task 3).
4. (2026-11-17, after Task 19) The gate has no two-window raise case. Five runs showed macOS does not let a background throwaway VS Code activate itself. The spike's result and the person's check 6 (f) stand.

## Verification

PR CI runs by itself on the pull request and needs no start. This change selects `cli-typecheck` and `cli-tests` (the extension's tests among them), `companion-subsystems` and `pty-checks` (a `cli/` change), `device-app-checks` (Linux), `firmware-checks` (it reads `cli/src/services/devices.ts`), `os-checks` (it reads `cli/package.json` and `docs/naming-system.md`) and `process-checks` (`scripts/tests/test_ci_plan.py`), under `ci/required`.

**Before merge:**
- `scripts/ci-plan.py`, changed by Task 6, needs **two independent security reviews** before the pull request merges (`docs/validation-and-release.md`, the repo rule for the planner); each is recorded in the pull request.
- #4407 has merged and the branch is rebased onto `main` (Base), so the pull request's diff holds none of #4407's commits; checks 1 to 5 run on that head.

| # | Check | Where | Isolation | What a person sees |
|---|---|---|---|---|
| 1 | **CLI end to end, the new file**: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts` | this Mac, and Linux through check 2 | an isolated daemon under a throwaway root and home on a port of its own (never 18473), a fake dial on a pseudo-terminal, a real `sh` with the fake engine under it under a fake `code`, the extension's real loop in a process of its own over the real devices socket, the harness's fake `open`. No backend, no account, no VS Code | the file passes: a tap and a rest print the right shell's `show` (and, with Tasks 20 to 24, a stroke prints three `scroll` lines); on macOS the fake `open` ran `-b com.microsoft.VSCode` once per tap |
| 2 | **CLI end to end, the whole suite once at the final head**, started by hand: `gh workflow run cli-e2e.yml --ref feat/dial-vscode-extension` (Actions → CLI end to end → Run workflow) | GitHub, eight Linux shards and the macOS runner | each daemon under a throwaway root, fake dials, fake engines | every shard green; `e2e-summary` lists `e2e/dialVscode.e2e.ts` passed. Every file that plugs a fake dial now starts a devices process that looks once for the extension under its throwaway home: a file red here and green in main's last nightly run is this change's |
| 3 | **The extension in a real VS Code**: `cd cli && npm run test:vscode` | this Mac (macOS is the customer's platform, and where a tap brings VS Code forward) | a VS Code downloaded into a temporary folder, with its own user data, extensions and home, all removed at the end; the devices' real listener on a socket in that folder; never the installed VS Code, its settings or `~/.vscode`; nothing opened by bundle id or by link | one VS Code window opens for about a minute (up to three with Task 25, which waits for the extension's minute counts) and closes; vitest reports the gate passed: the hand-packed `.vsix` installed, two terminals' shells reported, `show` selected each (and, with Task 25, a scroll line ran VS Code's scroll command on the active terminal, and one for a terminal not active ran none, by the extension's count). The gate does not read where a terminal is scrolled: that is check 6 (d) |
| 4 | **Harness Device on a Mac** (PR CI compiles its Linux code only): `cd device-app/ui && npm ci && npm run build && cd ../src-tauri && cargo test --locked` | a Mac | the fake `harness` only; no daemon, no app launched, no VS Code | `test result: ok`, 0 failed |
| 5 | **Local gates' receipts**: `python3 scripts/local-checks.py --run` from a clean tree at the final commit, its output pasted into the pull request body. The change touches `cli/src/services/*` (`cli-core`, which is `npm run test:core`: the listener and `devices.ts` at 100% per file) and `cli/package.json`, `cli/package-lock.json` and `cli/vitest.config.ts`, which select every `cli-*` check, the three macOS ones among them | a Mac | vitest's throwaway homes and data folders | one `harness-local-checks` fence, every `cli-*` check passed |
| 6 | **By a person, after merge** (Diego decides where: a VS Code that is theirs to change, a real dial, this change's CLI as the daemon and this change's Harness Device). **Not run by an agent.** | the person's Mac | their own VS Code: a check only they can do | (a) Harness Device's menu shows **Turn on VS Code** above the separator; a click, and within a few seconds the item is gone and VS Code's Extensions view lists Harness Device. (b) Claude Code in a VS Code terminal: a tap on the dial brings VS Code forward on that session's terminal. (c) With two sessions in two terminals and VS Code in front, a swipe that rests on the other switches the terminal. (d) With scroll shipped: a finger on the glass scrolls that terminal line by line, the only check that sees the terminal move (PM, 2026-11-17). (e) The output channel "Harness Device" says `state: connected`. (f) With two VS Code windows, what the spike's findings say a tap does |

**No temporary workflow.** The one long check, the end-to-end suite, has its own workflow, started by hand once (check 2). The real-VS Code gate is local by the PM's decision 5: it opens an app window, and macOS is where it matters. **Proposal, not in this work:** a workflow started by hand that runs `npm run test:vscode` on Linux under Xvfb, so a later pull request that touches the extension can show the gate without a Mac.

No check runs against production: nothing here calls a backend. No check uses an account: none is needed.

**In the pull request:** the red-then-green commits; checks 1 to 5 with their links or output; the numbers of Tasks 3, 14 and 23; the spike's findings; the sentence of Task 6 about the shard verifier and of Task 14 about releases; the platforms (macOS and Linux; on Windows the extension stops and the menu item never shows; Cursor, VS Code Insiders, VSCodium and remote windows are not covered); and, if Tasks 20 to 25 were dropped, that scroll follows in the next pull request.

## Decision fix #1 (Diego, 2026-11-18): the extension turns on by itself

The design's "Set up once a computer" replaces task 17's menu item and the start-only update:

- **DF1a (`xhigh`):** `cli/src/cable/vscodeExtensionSetup.ts` replaces `vscodeExtensionUpdate.ts`; `dial-setup.json`
  gains `vscode`, `dial-skill.json`'s `removed` gains `vscode`; `harness device vscode enable` clears it and `disable`
  sets it; the setup runs at the service's start, at each attach and an hour after a failure. Red first: a dial attached
  with VS Code there installs once; an extension removed is never installed again; no VS Code does nothing. An e2e
  daemon never reaches a real VS Code. Files: `cli/src/cable/`, `cli/src/devices/`, `cli/src/deviceClaude/command.ts`,
  `cli/src/services/devices.ts` and their specs, `cli/e2e/` (isolation only), `cli/AGENTS.md`,
  `plugins/harness-device-vscode/README.md`.
- **DF1b (`medium`):** `device-app/` and `docs/plans/2026-11-13-device-menubar-design.md` back to `main`; red first:
  the menu test forbids every "Turn on" row.
