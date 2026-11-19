# The dial reaches agents in Cursor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Status:** draft, with the PM's answers to its five questions (PM for Diego, 2026-11-18) folded in.

**Goal:** In Cursor, a tap, a swipe and a scroll on the dial reach Claude Code, Codex and cursor-agent in an integrated
terminal and Claude Code's panel, as in VS Code, and a tap on any other Cursor agent opens Cursor's window for its
folder.

**Architecture:**
- **One adapter file, two editors.** `createVscodeAdapter` is made once for VS Code and once for Cursor, each with its
  own id, bundle and link scheme, on the one `vscodeStreams` pool: Harness's extension in a Cursor window opens the same
  `vscode` stream.
- **A second Cursor adapter, `cursor-folder`,** after it: its pane is the agent's folder, and its tap runs
  `open -b com.todesktop.230313mzl4w4u92 <folder>`.
- **The extension is set up in Cursor as in VS Code:** `vscodeExtension.ts` and `vscodeExtensionSetup.ts` take the
  editor, two setups run in the devices process, each with its own record and removal key, and
  `harness device cursor enable|disable` is the person's word.
- **Nothing in the daemon core.** Every file is the devices process's, the `harness` command's or a test's.

**Tech Stack:** TypeScript (Node, vitest 4) in `cli/`.

**Spec:** [docs/plans/2026-11-18-dial-cursor-design.md](2026-11-18-dial-cursor-design.md). Its "Decided (PM for Diego,
2026-11-18)", 1 to 5, is not reopened here.

## Base

- **Written against** `feat/dial-cursor` at `9249b9afa2`, which is `origin/main` with #4452, #4456 and #4458. Tasks
  name code by name, never by line. If a name below is gone, stop and report.
- A task that names failing tests is two commits: the tests, red, then the change. The message given is the second's.
  A task marked "one commit" changes no product behavior and has no red test.
- **Dependencies.** The worktree has no `cli/node_modules`: clone them from the main checkout, as the implementer's
  definition says.
- **Per task:** `cd cli && npx tsc --noEmit -p .` and only the Vitest files the task touches. No task starts a real
  app.

## File structure

| File | Change |
|---|---|
| `cli/src/cable/hosts/adapter.ts` | `Place.cwd` |
| `cli/src/cable/hosts/observed.ts` | a place carries the agent's folder; the folder is updated before the place is read |
| `cli/src/cable/hosts/vscode.ts` | the editor table; `createVscodeAdapter(editor, deps)`; cursor-agent's terminal pane |
| `cli/src/cable/hosts/cursorFolder.ts` (new) | the `cursor-folder` adapter |
| `cli/src/devices/vscodeExtension.ts` | the editor table (app, CLI, record); the editor-neutral state; the shim passed over on Linux |
| `cli/src/devices/dialSkillFiles.ts`, `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialSetup.ts` | `dial-setup.json`'s `cursor`, `dial-skill.json`'s `removed.cursor` |
| `cli/src/cable/vscodeExtensionSetup.ts` | the removal key by editor |
| `cli/src/services/devices.ts` | the two editors' adapters and the folder adapter; the pool told both editors' pids; `DevicesDeps.cursorExtension`; the second setup; the tally per editor; `HARNESS_CURSOR_BIN` |
| `cli/src/deviceClaude/command.ts` | `harness device cursor status\|enable\|disable`; the usage |
| `cli/src/lib/logBundleFacts.ts`, `cli/src/lib/logBundle.ts` | `device cursor status --json` in the support bundle |
| `cli/e2e/harness/daemon.ts`, `cli/scripts/remote-viewers-stack.ts`, `local-stack-peer.ts`, `remote-viewer-peer.ts` | `HARNESS_CURSOR_BIN` beside `HARNESS_VSCODE_BIN` |
| `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/dialVscode.e2e.ts`, `cli/e2e/dialVscodeFollow.e2e.ts`, `cli/e2e/developerState.e2e.ts` | the fake Cursor; Cursor's cases |
| `plugins/harness-device-vscode/README.md`, `docs/cli.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/plans/2026-11-17-dial-vscode-extension-design.md` | the docs the spec lists |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes; `cli/src/architecture.coreFiles.txt` gains no line.
`cli/src/cli.ts` and `plugins/harness-device-vscode/src/` are not edited.

## Global Constraints

- **Cursor's values, fixed in code, never from a hook:** bundle `com.todesktop.230313mzl4w4u92` (`APP_BUNDLES.cursor`);
  link `cursor://anthropic.claude-code/open?session=<id>`; app `Cursor.app`; its CLI
  `Cursor.app/Contents/Resources/app/bin/cursor`; record `~/.cursor/extensions/extensions.json`; on Linux `cursor` on
  `PATH`, passing over an entry whose real path is `~/.local/bin/cursor` (cursor-agent's shim).
- **Adapter ids:** `vscode`, `cursor`, `cursor-folder`, in that order in the devices' list.
- **The terminal pane** is for engine `claude` or `codex`, or `cursor` with a `TERM_PROGRAM` hint (cursor-agent in a
  terminal), in both editors. Cursor's own agent sends no `TERM_PROGRAM`: it gets no terminal pane and costs no `ps`
  read (PM, 2026-11-18). Page keys stay Claude Code's alone: `routeOf` in `devices.ts` already asks `pageKeys` only for engine `claude`, and that line does not change.
- **The folder:** an absolute path of at most 4096 characters with no control character. The tap is
  `open -b com.todesktop.230313mzl4w4u92 <path>`, no shell, the path one argument, through `openPath(bin)`, within
  `RUN_TIMEOUT_MS`. The path never reaches a log line, a count or the dial.
- **No voice, no chat link, no `cursor://anysphere…` link** for Cursor's own agent.
- **Records:** `dial-setup.json` `cursor` (a version, at most 64 characters, `VERSION` in `dialSkillFiles.ts`), written
  only by the devices service through the dial setup's record; `dial-skill.json` `removed.cursor` (`true` or absent),
  written only by `harness device cursor enable|disable`.
- **Test bin:** `HARNESS_CURSOR_BIN`, read in `services/devices.ts` as `HARNESS_VSCODE_BIN` is.
- **Any path under `~/.harness`** goes through `cli/src/config/harnessHome.ts` (`harnessHome.guard.spec.ts` fails on
  `homedir()` + `'.harness'`). This work builds none.
- **Log lines (PM, 2026-11-18; root AGENTS.md rule 7, as #4458 holds the daemon to it):** a line carries only ids (an
  adapter's id, a Harness agent id) and sizes, counts and fixed reason words. Never a question's text, a chat's or a
  session's name or title, a person's folder path (the `cursor-folder` pane's id is one), transcript content, a pid, a
  window id or a bundle id. The lines this work adds are three, all of fixed words:
  `[device] open · cursor · fallback`, `[device] open · cursor-folder · fallback` (the opener's own line, by the
  adapter's id) and the tally's `[device] vscode extension · cursor · <kind>[ · <reason>]` with its day line.
  Nothing in this work throws out to the devices' part guard, whose line prints an error's message.
- **Log checks follow #4458's form and extend what the file has.** #4458 added no log test to a file this plan
  touches (its own are in `cableSession.spec.ts`, the core's, `lib/` and three other services' specs). Its form: the
  person's value is a marker (`SECRET-FOLDER-MARKER`), and the whole of the test's log is searched for it. The
  checks to extend, not to write beside: `devices.spec.ts`'s `'no swipe line carries the VS Code session, the link or
  the bundle'` (its `logs.filter(…secret…)` line), `dialVscode.e2e.ts`'s `leaks()`, and `dialVscodeFollow.e2e.ts`'s
  last step.
- **Never the person's own apps or agents in a test or a check:** not their Cursor or VS Code, `~/.cursor`,
  `~/.vscode`, `/Applications`, their daemon (port 18473), nor a real `claude`, `codex` or `cursor-agent`, and never a
  real `open` of a `cursor://` or `vscode://` link. No screenshot is taken, in any task.
- **Repo rules:** a test that fails first, at the layer where the behavior lives; no fixed sleeps; comments say why;
  names per `docs/naming-system.md` (**VS Code**, **Cursor**, **Claude Code**, **Codex** spelled so); English only;
  100% per file for `cli/src/services/` (`npm run test:core`, run in phase 4).
- **Platforms:** macOS: all of it. Linux: the setup, and a terminal's tap (a show, no raise); no swipe or scroll in
  Cursor (its front app is not read as Cursor there; accepted, PM 2026-11-18, said in the README and the pull
  request); no folder window. Windows: nothing.
- **Not here:** a Cursor chat's own link, voice into Cursor's own agent, a folder window for VS Code, VS Code
  Insiders, VSCodium, Windsurf, Cursor's non-default profiles, the core, the firmware, Harness Desktop.

## Decisions the spec left to the plan

1. **Each table is its file's own.** `vscode.ts` and `vscodeExtension.ts` each key a table by `'vscode' | 'cursor'`;
   neither imports the other's, so the adapter and the extension's CLI stay apart.
2. **The editor travels in `VscodeExtensionDeps.editor`.** `vscodeStatus`, `vscodeEnable` and `vscodeDisable` keep one
   parameter and read it there; the setup reads its removal key from `deps.vscode.editor`. The record key is the
   caller's (`skill.cursor()`, `skill.recordCursor`).
3. **The neutral state's field is `state`.** The command prints `{ [editor]: state, …version, …error }`: VS Code's
   lines stay the same bytes (`{"vscode":"on","version":"0.6.60"}`).
4. **The failure word `no-code` stays for both editors:** a fixed word the tally and the command already print.
5. **`DeviceDeps.vscode(editor)`.** `cli.ts` already passes `vscodeExtensionDeps`, whose first parameter becomes the
   editor: the file needs no edit.
6. **The shim is told by real path,** through a new dep `real(path)`: a symlink on `PATH` that ends at
   `~/.local/bin/cursor` is passed over too.
7. **Each setup is a part of its own** (`vscodeExtension`, `cursorExtension`): a fault, or a failed pass's hour, in
   one never holds the other.
8. **Both Cursor adapters carry `bundle: APP_BUNDLES.cursor`,** as VS Code's does: a session the scan found has no
   bundle until its first hook.
9. **The folder check is `statSync(path).isDirectory()`** behind a dep `isFolder`; `focus` checks the id's form and the
   folder again before `open`.
10. **The end-to-end cases join the two existing files.** Their hints carry Cursor's bundle id on every platform: only
    that names Cursor. On Linux, where no Cursor sets it, the case checks the code path, not a Linux Cursor.
11. **`logBundle.ts`'s README line names `cursor` too:** it says what `status.txt` holds.

## Design

The spec's Design section stands. Stored: two fields in files that exist. In memory: nothing new.

## Review Focus

1. **The agent's folder goes, or becomes a file, between the look and the tap:** nothing runs, and the tap brings
   Cursor forward alone. Task 3 (`finds it gone`), Task 7 (`with the folder gone`).
2. **A folder whose name holds a space, a non-ASCII letter or a leading `-`:** it reaches `open` as one argument,
   unchanged. Task 3 (`the path one argument`).
3. **Both editors open at once:** a rest on a Cursor agent while VS Code is in front shows nothing, and each editor's
   agent is shown only through its own adapter. Task 7 (`nothing while VS Code is`, `both editors'`).
4. **An agent on Cursor's page with no terminal or tab pane** (another engine in Cursor's terminal, a panel session
   whose id is no UUID): its tap still opens its folder's window. Task 3 (`whatever its engine`), Task 7 (`falls to`).
5. **One editor there and the other not, or one's install failing:** the other's pass, record and tally are as if it
   ran alone. Task 6 (`reads Cursor's removal alone`), Task 8 (`leaves VS Code's alone`).

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | Observed: a place carries the agent's folder | none | high |
| 2 | The VS Code adapter, made for either editor | none | high |
| 3 | Cursor's folder window | 1 | xhigh |
| 4 | The extension's CLI and record, by editor | none | high |
| 5 | Dial records: `cursor` | none | xhigh |
| 6 | The setup, by editor | 4, 5 | high |
| 7 | Devices: Cursor's adapters on the shared pool | 2, 3 | high |
| 8 | Devices: the extension set up in Cursor | 4, 5, 6, 9 | xhigh |
| 9 | End-to-end daemons and local stacks find no Cursor | none | medium |
| 10 | `harness device cursor`, and the support bundle | 4, 5 | high |
| 11 | End to end: Cursor's terminal and folder window | 7 | xhigh |
| 12 | End to end: Claude Code's panel link in Cursor | 7 | high |
| 13 | ~~Gate feasibility: a throwaway Cursor under `runTests`~~ dropped (PM, 2026-11-19) | none | xhigh |
| 14 | ~~Gate: the run for either editor~~ dropped (PM, 2026-11-19) | 13 | xhigh |
| 15 | Docs | none | medium |

**Longest chain:** 1 → 3 → 7 → 11 (four). Tasks 1, 4, 5, 9 and 15 start at once; 2 as soon as no running task
shares its files.

**Tasks 13 and 14 are dropped (PM, 2026-11-19).** Task 13's one launch ran, but the throwaway Cursor's crash
reporting wrote into the person's own `~/Library/Application Support/Cursor/` (spec §7). Nothing of either lands on
this branch. No other task depended on them.

**Task 8 waits for Task 9** though they share no file: without `HARNESS_CURSOR_BIN` an end-to-end daemon on a Mac
with Cursor would install Harness's extension into the developer's own Cursor.

**Tasks that share files** (never two of a group at once):
- `cli/src/cable/hosts/observed.spec.ts`: 1, 2.
- `cli/src/services/devices.ts`: 2, 4, 7, 8. `devices.spec.ts`: 4, 7, 8.
- `cli/src/cable/vscodeExtensionSetup.ts` and its spec: 4, 6.
- `cli/src/deviceClaude/command.ts` and its spec: 4, 10.

---

### Task 1: Observed: a place carries the agent's folder

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces — Produces:**

```ts
// adapter.ts, Place
cwd?: string   // the folder its latest event named, else its scan row's: Cursor's folder window opens it
```

- [ ] **Step 1: Write the failing tests** in `describe('ObservedSource actions', …)`, with the file's `fakeActions()`
  and `setup()`:

```ts
/** An adapter whose pane is the place's folder, as Cursor's folder window's is (cursorFolder.ts). */
const byFolder: HostAdapter = { id: 'by-folder', tap: 'instead', canFocus: () => true, focus: async () => true,
  paneOf: (place) => (place.cwd ? { adapter: 'by-folder', id: place.cwd } : undefined) }

it('a place carries the folder of the hook that placed it: a session that moved is placed there at that hook', () => {
  const { src, ev } = setup({ actions: { ...fakeActions().actions, adapters: [byFolder] } })
  src.ingest(ev('session-start', { cwd: '/work/one' }))
  const { id } = src.list()[0]
  expect(src.paneOf(id, 'by-folder')).toBe('/work/one')
  // The same caller: no tty read places it a second time, so the place must be right at this hook's own look.
  src.ingest(ev('turn-start', { cwd: '/work/two' }))
  expect(src.paneOf(id, 'by-folder')).toBe('/work/two')
  // A hook cut to its bound names no folder: the last one stands.
  src.ingest(ev('turn-stop', { cwd: undefined }))
  expect(src.paneOf(id, 'by-folder')).toBe('/work/two')
})

it('a session the scan found is placed at its row\'s folder', async () => {
  // As the file's scan tests set a session: open, its owner (pid 77, claude) and its row, { cwd: '/work/scan' }.
  await src.scanOpen()
  expect(src.paneOf(observedAgentId('claude', 's9'), 'by-folder')).toBe('/work/scan')
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "folder"`. Expected: FAIL, the
  first `paneOf` is `undefined`.
- [ ] **Step 3: Implement.** `Place.cwd`. In `locate()`, the place gains `cwd: entry.agent.cwd`. In `ingest()`, the
  block that sets `a.cwd` and `entry.startedIn` moves above `this.locate(entry)`, with the reason in its comment
  (`learnTty` returns early for a caller it already read, so nothing else places the session again at that hook).
  Nothing else in `ingest()` moves.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npx tsc --noEmit -p .`. Expected:
  PASS.
- [ ] **Step 5: Commit** `Dial: an outside agent's place carries its folder`.

### Task 2: The VS Code adapter, made for either editor

**Depends on:** none. Shares `observed.spec.ts` with Task 1 and `devices.ts` with Tasks 4, 7 and 8. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/vscode.ts`
- Modify, the call alone (`createVscodeAdapter('vscode', …)`): `cli/src/services/devices.ts`,
  `cli/src/cable/hosts/observed.spec.ts` (`fakeActions`)
- Test: `cli/src/cable/hosts/vscode.spec.ts`

**Interfaces — Produces:**

```ts
// vscode.ts. The table is the file's own: { vscode: { bundle: APP_BUNDLES.vscode, scheme: 'vscode' },
//                                           cursor: { bundle: APP_BUNDLES.cursor, scheme: 'cursor' } }
export function createVscodeAdapter(
  editor: 'vscode' | 'cursor',
  deps: AppLinkDeps & { terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll' | 'pageKeys'> },
): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>>
```

The adapter's `id` is the editor, its `bundle` the editor's, every pane's `adapter` the editor. `termPid` is unchanged.
`inFront` stays a dep: the devices pass `latestFront() === <the editor>` (Task 7).

- [ ] **Step 1: Write the failing tests.** `recorder(over, codes, editor = 'vscode')` passes the editor on.

```ts
describe('the adapter made for Cursor', () => {
  const CURSOR = 'com.todesktop.230313mzl4w4u92'
  const cursorLink = (id: string) => `cursor://anthropic.claude-code/open?session=${id}`
  const PANEL = { __CFBundleIdentifier: CURSOR, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }
  const TERM = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR }
  const at = (hints: Record<string, string>, over: Partial<Place> = {}): Place =>
    ({ host: detectHost(hints), app: detectApp(hints), hints, engine: 'claude', sessionId: UUID, pid: 4242, ...over })

  it('its id is cursor and its bundle Cursor\'s', () => {
    const { adapter } = recorder({}, [], 'cursor')
    expect([adapter.id, adapter.bundle, adapter.tap]).toEqual(['cursor', CURSOR, 'instead'])
  })

  it('Claude Code\'s panel in Cursor opens by cursor://, sent to Cursor alone', async () => {
    const { adapter, calls } = recorder({}, [], 'cursor')
    expect(adapter.paneOf(at(PANEL))).toEqual({ adapter: 'cursor', id: UUID })
    expect(await adapter.focus({ adapter: 'cursor', id: UUID })).toBe(true)
    expect(calls).toEqual([run(OPEN, '-b', CURSOR, cursorLink(UUID))])
  })

  it('each editor takes its own panel and its own terminals alone', () => {
    const vscode = recorder().adapter
    const cursor = recorder({}, [], 'cursor').adapter
    expect(vscode.paneOf(at(PANEL))).toBeUndefined()
    expect(vscode.paneOf(at(TERM))).toBeUndefined()
    expect(cursor.paneOf(at({ __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }))).toBeUndefined()
    expect(cursor.paneOf(at({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: VSCODE }))).toBeUndefined()
    expect(cursor.paneOf(at(TERM))).toEqual({ adapter: 'cursor', id: 'term:4242' })
  })

  it('a tap on a terminal in Cursor queues its show with the raise, then opens Cursor by its bundle', async () => {
    const r = recorder({}, [], 'cursor')
    r.windows.held = { window: 'w1', shell: 4000 }
    expect(await r.adapter.focus({ adapter: 'cursor', id: 'term:4242' })).toBe(true)
    expect(r.windows.shows).toEqual([{ terminal: { window: 'w1', shell: 4000 }, tap: true }])
    expect(r.calls).toEqual([run(OPEN, '-b', CURSOR)])
  })
})

it.each(['vscode', 'cursor'] as const)('cursor-agent in %s\'s terminal has the terminal pane; with no TERM_PROGRAM, or another engine, none', (editor) => {
  const bundle = editor === 'vscode' ? VSCODE : 'com.todesktop.230313mzl4w4u92'
  const place = (engine: string, hints: Record<string, string> = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: bundle }): Place =>
    ({ host: detectHost(hints), app: detectApp(hints), hints, engine, pid: 4242 })
  const { adapter } = recorder({}, [], editor)
  expect(adapter.paneOf(place('cursor'))).toEqual({ adapter: editor, id: 'term:4242' })
  expect(adapter.paneOf(place('opencode'))).toBeUndefined()
  // Cursor's own agent: its bundle id names the app, but it sends no TERM_PROGRAM, so its pid is never read with `ps`.
  expect(adapter.paneOf(place('cursor', { __CFBundleIdentifier: bundle }))).toBeUndefined()
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts`. Expected: FAIL (`id` is `vscode`; no
  pane for engine `cursor`).
- [ ] **Step 3: Implement.** The table, the parameter, and each `'vscode'`, `APP_BUNDLES.vscode` and `vscode://` in
  the factory read from the editor's row. The terminal rule's engines become `claude`, `codex`, and `cursor` when
  `place.hints.TERM_PROGRAM` is set; its comment says why (Cursor's own agent carries no `TERM_PROGRAM`, and its hook's
  pid may be a short-lived process that `CHAIN_RETRY_MS` would read with `ps` every 5 s). The file's
  header comment says it is made once an editor, and the comment in `paneOf` that names Cursor as "another fork" is
  rewritten: each editor's own bundle id is what its adapter takes. Update the two call sites.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts src/cable/hosts/observed.spec.ts && npx tsc --noEmit -p .`.
  Expected: PASS; every existing VS Code case passes unchanged.
- [ ] **Step 5: Commit** `Dial: the VS Code adapter is made for Cursor too, and cursor-agent in a terminal has its pane`.

### Task 3: Cursor's folder window

**Depends on:** 1 (`Place.cwd`). **Effort:** xhigh (a hook's path becomes a command's argument).

**Files:**
- Create: `cli/src/cable/hosts/cursorFolder.ts`
- Test: `cli/src/cable/hosts/cursorFolder.spec.ts` (new)

**Interfaces — Consumes:** `Place.cwd` (Task 1). **Produces:**

```ts
export const CURSOR_FOLDER_MAX = 4096
export interface CursorFolderDeps {
  run: OrcaDeps['run']
  platform: NodeJS.Platform
  /** The raw `HARNESS_OPEN_BIN` (open.ts openPath). */
  bin?: string
  /** Whether the path is a folder now. */
  isFolder(path: string): boolean
}
/** `statSync(path).isDirectory()`; false for a file, a path that is not there, or any error. */
export function isFolder(path: string): boolean
// No `log` among the deps: the adapter can write no line.
/** id `cursor-folder`, tap `'instead'`, bundle `APP_BUNDLES.cursor`; no `canShow`, `show`, scroll or `type`. */
export function createCursorFolderAdapter(deps: CursorFolderDeps): HostAdapter
```

- `paneOf`: `place.app === 'cursor'` and `place.cwd` in form (`isAbsolute`, at most `CURSOR_FOLDER_MAX` characters, no
  `[\u0000-\u001f\u007f]`); the pane's id is that path. Whatever the engine.
- `canFocus`: macOS, the id in form, `deps.isFolder(id)`.
- `focus`: the same three checks, then `deps.run(openPath(deps.bin), ['-b', APP_BUNDLES.cursor, id], RUN_TIMEOUT_MS)`;
  true for exit 0. It never throws (adapter rule 3): a run that rejects answers false.
- **It writes no log line, and takes no `log`.** Its pane's id is the person's folder. A tap's outcome is said by the
  opener, by the adapter's id alone (`[device] open · cursor-folder · fallback`), and an error it caught, whose message
  may name the folder, goes nowhere.

- [ ] **Step 1: Write the failing tests.** A `rig(over, codes)` in the file's own style: a recording `run` that
  answers `codes` then 0, `platform: 'darwin'`, `isFolder: (path) => folders.has(path)`.

```ts
const CURSOR = 'com.todesktop.230313mzl4w4u92'
const place = (over: Partial<Place> = {}): Place => ({ host: 'cursor', app: 'cursor', hints: {}, engine: 'cursor', cwd: '/work/api', ...over })

it('its id is cursor-folder, a tap is its own open, its bundle is Cursor\'s, and it shows, scrolls and types nothing', …)
  // [id, tap, bundle] toEqual ['cursor-folder', 'instead', CURSOR]; show, canShow, scroll, canScroll, type, pageKeys undefined
it('the pane of an agent in Cursor is its folder, whatever its engine; in another app there is none', …)
  // paneOf(place()) toEqual { adapter: 'cursor-folder', id: '/work/api' }; the same for engine 'claude' and 'opencode';
  // paneOf(place({ app: 'vscode' })) undefined
it.each([undefined, '', 'work/api', './api', '/work/a\nb', '/work/a\u0000b', '/work/a\u007fb', `/${'a'.repeat(4096)}`])(
  'a folder that is %j gives no pane', …)
it('a folder of exactly 4096 characters gives its pane', …)
it('a tap opens Cursor on the folder: one open, the path one argument, in 10 s', …)
  // for each of '/work/my proj/ü' and '/work/-rf': folders.add(it); focus toBe true;
  // calls toEqual [{ file: '/usr/bin/open', args: ['-b', CURSOR, it], timeoutMs: 10_000 }]
it('HARNESS_OPEN_BIN, absolute, is the open it runs', …)                      // bin '/tmp/e2e/fake-open'
it('a folder that is not there cannot be tapped, and a tap that finds it gone runs nothing', …)
  // canFocus false; folders.add → canFocus true; folders.delete → focus toBe false; calls toEqual []
it('an open that exits non-zero, was killed, or rejects answers false', …)    // codes [1], [null]; a run that rejects
it('an error that names the folder is caught: the tap answers false and nothing is thrown', …)
  // run rejects with new Error('open /work/SECRET-FOLDER-MARKER failed'), then isFolder throws the same:
  // await expect(adapter.focus(pane)).resolves.toBe(false); expect(adapter.canFocus(pane)).toBe(false)
it.each(['linux', 'win32'] as const)('on %s nothing can be tapped and nothing runs', …)
it('a pane id not in its form runs nothing', …)                               // 'work', '--args', '' → false, calls []
it('isFolder: a folder is one; a file and a path that is not there are not', …)   // on the spec's own temporary folder
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/cursorFolder.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** as above. The header comment says what the adapter is for, why the pane is a folder and
  not a chat (Cursor documents no link to one), and that a multi-root window is opened by its first root.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/cursorFolder.spec.ts && npx tsc --noEmit -p .`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a tap opens Cursor's window for an agent's folder`.

### Task 4: The extension's CLI and record, by editor

**Depends on:** none. Shares files with Tasks 2, 6, 7, 8 and 10. **Effort:** high.

**Files:**
- Modify: `cli/src/devices/vscodeExtension.ts`
- Modify, to the new types alone (no behavior): `cli/src/cable/vscodeExtensionSetup.ts`,
  `cli/src/deviceClaude/command.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/devices/vscodeExtension.spec.ts`; fakes updated in `cli/src/cable/vscodeExtensionSetup.spec.ts`,
  `cli/src/deviceClaude/command.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces — Produces:**

```ts
// vscodeExtension.ts. The table is the file's own:
//   vscode: app 'Visual Studio Code.app', cli 'code',   folder '.vscode'
//   cursor: app 'Cursor.app',             cli 'cursor', folder '.cursor', shim ~/.local/bin/cursor
export type VscodeEditor = 'vscode' | 'cursor'
export type VscodeStatus = { state: 'absent' } | { state: 'off' } | { state: 'on'; version: string }
export type VscodeChange = VscodeStatus | (VscodeStatus & { error: VscodeFailure })
export interface VscodeExtensionDeps {
  /** Which editor: its app, its CLI and its record. */
  editor: VscodeEditor
  /** A path through its links; the path itself when it cannot be resolved. */
  real(path: string): string
  // …the members it has today
}
export function vscodeExtensionDeps(editor: VscodeEditor, bin?: string): VscodeExtensionDeps
// vscodeStatus, vscodeEnable, vscodeDisable: one parameter, as today.

// command.ts
DeviceDeps.vscode(editor: VscodeEditor): VscodeExtensionDeps
```

- [ ] **Step 1: Write the failing tests.** `computer()` takes `editor` (default `'vscode'`) and `links` (a map
  `real` follows). Existing expectations change `{ vscode: … }` to `{ state: … }`, nothing else.

```ts
describe('Cursor', () => {
  const APP = '/Applications/Cursor.app'
  const CLI = `${APP}/Contents/Resources/app/bin/cursor`
  const RECORD = `${HOME}/.cursor/extensions/extensions.json`
  const SHIM = `${HOME}/.local/bin/cursor`
  const cursor = (options: ComputerOptions = {}) => computer({ editor: 'cursor', ...options })

  it('absent with no Cursor.app, off with no record, on with the version in ~/.cursor\'s record', () => {
    expect(vscodeStatus(cursor({ disk: { ...MAC, [`${HOME}/.vscode/extensions/extensions.json`]: record('1.2.3') } }).deps)).toEqual({ state: 'absent' })
    expect(vscodeStatus(cursor({ disk: { [APP]: '', [CLI]: '', [`${HOME}/.vscode/extensions/extensions.json`]: record('1.2.3') } }).deps)).toEqual({ state: 'off' })
    expect(vscodeStatus(cursor({ disk: { [APP]: '', [CLI]: '', [RECORD]: record('1.2.3') } }).deps)).toEqual({ state: 'on', version: '1.2.3' })
  })

  it('enable and disable run the cursor inside the app', async () => {
    const c = cursor({ disk: { [APP]: '', [CLI]: '' } })
    c.whenRun = () => c.disk.set(RECORD, record('1.2.3'))
    expect(await vscodeEnable(c.deps)).toEqual({ state: 'on', version: '1.2.3' })
    expect(c.runs).toEqual([[CLI, ['--install-extension', join(c.folders[0], 'harness-device.vsix'), '--force'], 60_000]])
    c.whenRun = () => c.disk.delete(RECORD)
    expect(await vscodeDisable(c.deps)).toEqual({ state: 'off' })
    expect(c.runs[1]).toEqual([CLI, ['--uninstall-extension', VSCODE_EXTENSION_ID], 60_000])
  })

  it('on Linux it is the cursor on PATH, and cursor-agent\'s shim is passed over, by its real path', async () => {
    const pathVar = `${HOME}/.local/bin:/usr/local/bin:/opt/cursor/bin`
    const disk = { [SHIM]: '', '/usr/local/bin/cursor': '', '/opt/cursor/bin/cursor': '' }
    const c = cursor({ platform: 'linux', pathVar, disk, links: { '/usr/local/bin/cursor': SHIM } })
    c.whenRun = () => c.disk.set(RECORD, record('1.2.3'))
    expect(await vscodeEnable(c.deps)).toEqual({ state: 'on', version: '1.2.3' })
    expect(c.runs.map(([file]) => file)).toEqual(['/opt/cursor/bin/cursor'])
    expect(vscodeStatus(cursor({ platform: 'linux', pathVar, disk: { [SHIM]: '' } }).deps)).toEqual({ state: 'absent' })
  })

  it('VS Code\'s code under ~/.local/bin is not a shim', () => {
    expect(vscodeStatus(computer({ platform: 'linux', pathVar: `${HOME}/.local/bin`, disk: { [`${HOME}/.local/bin/code`]: '' } }).deps)).toEqual({ state: 'off' })
  })

  it('HARNESS_CURSOR_BIN, absolute, is the only Cursor looked for', async () => {
    const c = cursor({ disk: { [APP]: '', [CLI]: '', [RECORD]: record('0.0.1') }, bin: '/e2e/root/cursor/cursor' })
    expect(vscodeStatus(c.deps)).toEqual({ state: 'absent' })
    expect(await vscodeEnable(c.deps)).toEqual({ state: 'off', error: 'no-code' })
    expect(c.runs).toEqual([])
  })

  it('the real deps say their editor, and real follows a link', …)
    // vscodeExtensionDeps('cursor', '/x').editor toBe 'cursor'; .bin toBe '/x';
    // a symlink in the spec's scratch: real(link) toBe realpathSync(target); real('/nowhere/x') toBe '/nowhere/x'
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/vscodeExtension.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the table and the types. `installed()`, `vscodeCli()` and the record's path read the
  editor's row. On Linux a candidate is passed over when its row has a shim and
  `deps.real(candidate) === deps.real(join(deps.home, '.local', 'bin', 'cursor'))`.
- [ ] **Step 4: Bring the three consumers to the new types, with no change in what they do.**
  `vscodeExtensionSetup.ts` reads `status.state`. `command.ts` asks `deps.vscode('vscode')` and prints through

```ts
/** An editor's answer as its command prints it: the state under the editor's own key, as `vscode`'s always was. */
const printed = (editor: VscodeEditor, { state, ...rest }: VscodeChange): Record<string, unknown> => ({ [editor]: state, ...rest })
```

  `devices.ts` calls `vscodeExtensionDeps('vscode', process.env.HARNESS_VSCODE_BIN)`. In the three specs the fake deps
  gain `editor: 'vscode'` and `real: (path) => path`; `devices.spec.ts`'s spy on `vscodeExtensionDeps` takes
  `(editor, given)` and expects `[['vscode', bin]]`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/devices/vscodeExtension.spec.ts src/cable/vscodeExtensionSetup.spec.ts src/deviceClaude/command.spec.ts src/services/devices.spec.ts -t "VS Code|vscode" && npx tsc --noEmit -p .`.
  Expected: PASS; `command.spec.ts`'s printed lines (`{"vscode":"absent"}`, `{"vscode":"on","version":"0.6.60"}`,
  `{"vscode":"off","error":"failed"}`) are unchanged.
- [ ] **Step 6: Commit** `Harness Device for VS Code: its CLI and record are read for VS Code or Cursor`.

### Task 5: Dial records: `cursor`

**Depends on:** none. **Effort:** xhigh (two files on disk, each with one writer).

**Files:**
- Modify: `cli/src/devices/dialSkillFiles.ts`, `cli/src/cable/dialHomeSetup.ts`, `cli/src/cable/dialSetup.ts`
- Test: `cli/src/devices/dialSkillFiles.spec.ts`, `cli/src/cable/dialSetup.spec.ts`

**Interfaces — Produces:**

```ts
// dialSkillFiles.ts
export interface DialRemoved { claude?: true; codex?: true; vscode?: true; cursor?: true }
export interface DialSetupRecord { dial: boolean; plugin?: string; vscode?: string; cursor?: string; homes: DialSkillHomes; pluginHomes: string[] }
// writeRemoved(dataDir, what: keyof DialRemoved, removed, written?): `written` is kept for an engine alone.
// dialHomeSetup.ts DialHomeSetup, and dialSetup.ts DialSetup
cursor(): { dial: boolean; version?: string } | undefined
recordCursor(version: string): boolean
```

- [ ] **Step 1: Write the failing tests.**

```ts
// dialSkillFiles.spec.ts
it('removed.cursor: only true is a removal, and alone it still keeps removed in the file', () => {
  writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"cursor":1}}')
  expect(readRemoved(dataDir)).toEqual({})
  expect(writeRemoved(dataDir, 'cursor', true)).toBeUndefined()
  expect(file()).toEqual({ removed: { cursor: true } })
  expect(writeRemoved(dataDir, 'vscode', true)).toBeUndefined()
  expect(readRemoved(dataDir)).toEqual({ vscode: true, cursor: true })
  writeRemoved(dataDir, 'cursor', false)
  expect(file()).toEqual({ removed: { vscode: true } })
})
it('a removal of Cursor writes no skills folder, as VS Code\'s writes none', () => {
  expect(writeRemoved(dataDir, 'cursor', true, ['/a/skills'])).toBeUndefined()
  expect(readWritten(dataDir)).toEqual({ claude: [], codex: [] })
})
it('dial-setup.json keeps cursor as it keeps vscode: a version, or nothing', () => {
  expect(writeSetup(dataDir, { dial: true, vscode: '0.6.60', cursor: '0.6.60-dev.g0123', homes, pluginHomes: [] })).toBeUndefined()
  expect(readSetup(dataDir)).toEqual({ dial: true, vscode: '0.6.60', cursor: '0.6.60-dev.g0123', homes, pluginHomes: [] })
  expect(writeSetup(dataDir, { dial: true, cursor: '0.6.60 beta', homes, pluginHomes: [] })).toBe('EINVAL')
  for (const cursor of [true, 660, '', '../x', '0.6.60 beta', 'v'.repeat(65)]) {
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, cursor }))
    expect(readSetup(dataDir), String(cursor)).toEqual({ dial: true, homes, pluginHomes: [] })
  }
})

// dialSetup.spec.ts, beside the case that records VS Code's
it('Cursor\'s version is recorded beside VS Code\'s, and each save keeps the other', async () => {
  // r attached once, as that case sets it
  expect(r.setup.cursor()).toEqual({ dial: true })
  expect(r.setup.recordVscode('0.6.60')).toBe(true)
  expect(r.setup.recordCursor('0.6.61')).toBe(true)
  expect(r.setup.cursor()).toEqual({ dial: true, version: '0.6.61' })
  expect(readSetup(r.dataDir)).toMatchObject({ vscode: '0.6.60', cursor: '0.6.61' })
  expect(r.setup.recordCursor('0.6.62 beta')).toBe(false)
  expect(r.setup.cursor()).toEqual({ dial: true, version: '0.6.61' })
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts src/cable/dialSetup.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** `removedOf`, the condition that keeps `removed` in the file, `writeRemoved`'s
  skills-folder exception, `setupOf`, `writeSetup`'s version check, the file's header comment; `cursor()` and
  `recordCursor` in `dialHomeSetup.ts` as `vscode()` and `recordVscode` are; both passed on in `dialSetup.ts`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/devices/dialSkillFiles.spec.ts src/cable/dialSetup.spec.ts src/cable/dialHomeSetup.spec.ts && npx tsc --noEmit -p .`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the setup's records hold Cursor beside VS Code`.

### Task 6: The setup, by editor

**Depends on:** 4 (`VscodeExtensionDeps.editor`), 5 (`DialRemoved.cursor`). Shares files with Task 4.
**Effort:** high.

**Files:**
- Modify: `cli/src/cable/vscodeExtensionSetup.ts`
- Test: `cli/src/cable/vscodeExtensionSetup.spec.ts`

**Interfaces — Consumes:** `VscodeExtensionDeps.editor` (Task 4), `DialRemoved.cursor` (Task 5). **Produces:**
`createVscodeExtensionSetup(deps)` as today; its removal key is `deps.removed()[deps.vscode.editor]`.

- [ ] **Step 1: Write the failing tests.** `rig()` takes `editor` (default `'vscode'`): the fake deps carry it and
  their record is that editor's (`~/.cursor/extensions/extensions.json` for Cursor).

```ts
describe('Cursor\'s setup, beside VS Code\'s', () => {
  it('reads Cursor\'s removal alone: VS Code\'s does not stop it, its own does', async () => {
    const r = rig({ editor: 'cursor' })
    r.state.removed = { vscode: true }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.counted).toEqual([['set up']])
    const off = rig({ editor: 'cursor' })
    off.state.removed = { cursor: true }
    await off.setup.pass()
    expect(off.runs).toEqual([])
  })
  it('VS Code\'s setup is not stopped by Cursor\'s removal', async () => {
    const r = rig()
    r.state.removed = { cursor: true }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
  })
  it('a disable of Cursor that lands while its install runs takes it out again, and records nothing', async () => {
    const r = rig({ editor: 'cursor' })
    r.state.during = (flag) => { if (flag === INSTALL) r.state.removed = { cursor: true } }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL, UNINSTALL])
    expect(r.state.record).toEqual({ dial: true })
  })
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/vscodeExtensionSetup.spec.ts`. Expected: FAIL (Cursor's
  setup stops at `removed.vscode`).
- [ ] **Step 3: Implement** the key in `pass()` and `install()`; the header comment says the setup runs once an
  editor.
- [ ] **Step 4: Run** the same file and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the extension's setup reads its own editor's removal`.

### Task 7: Devices: Cursor's adapters on the shared pool

**Depends on:** 2, 3. Shares files with Tasks 2, 4 and 8. **Effort:** high.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** `createVscodeAdapter(editor, deps)` (Task 2); `createCursorFolderAdapter`, `isFolder`
(Task 3).

- In the adapters' list, where VS Code's is today, in this order: VS Code's, Cursor's
  (`inFront: () => cableHost.latestFront() === 'cursor'`, the same `terminals: vscode`), then
  `createCursorFolderAdapter({ run: apps.run, platform: apps.platform, bin: openBin, isFolder })`. All three inside the
  `.map(noting)`.
- The observed source's change handler tells the pool the pids of `observed.paneOf(id, 'vscode')` and
  `observed.paneOf(id, 'cursor')`.
- The comment where the pool is made says Cursor's windows hold the same stream, and why that needs no word from the
  extension.

- **Log lines.** This task adds no line of its own. The opener's `[device] open · cursor-folder · fallback` and
  `[device] open · cursor · fallback` name the adapter alone. The cases below hold the whole log to that, in the form
  of the file's `'no swipe line carries the VS Code session, the link or the bundle'`, with #4458's marker for the
  folder: no line holds the folder, the session's id, a `cursor://` link or Cursor's bundle id.

- [ ] **Step 1: Write the failing tests,** beside the VS Code terminal cases. `inVscodeTerminal(over, agent, bundle)`
  gains the hook's bundle id, today's by default; with Cursor's it is in the hints on every platform.

```ts
const CURSOR = 'com.todesktop.230313mzl4w4u92'
const IN_CURSOR = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR }

it('a tap on an agent in Cursor\'s terminal writes the show with the raise, then brings Cursor forward', async () => {
  const { reported } = await inVscodeTerminal({ orca: mac }, {}, CURSOR)
  const window = await reported()
  expect(await host().openAgent(ID)).toBeUndefined()
  expect(window.lines).toEqual([{ show: SHELL, raise: true }])
  expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', CURSOR], 10_000]])
  expect(said()).toEqual([])
})
it('a rest shows Cursor\'s terminal while Cursor is in front, and nothing while VS Code is', …)
  // front('vscode'): swipeSwitches(ID) false. front('cursor'): true; swipeEnded(ID, 'rest'); swiped('ok');
  // window.lines toEqual [{ show: SHELL }]; orcaRuns toEqual []
it('a stroke scrolls Cursor\'s terminal while Cursor is in front', …)
  // as the file's stroke case, IN_CODEX in Cursor: front('cursor'); shows(CODEX); stroke([8, 8, -24]);
  // window.lines toEqual [{ scroll: -1, pid: SHELL }, { scroll: -1, pid: SHELL }, { scroll: 3, pid: SHELL }]
it('the pool hears both editors\' terminal agents: one in VS Code and one in Cursor each get their terminal from one read', …)
  // two hooks (callerPid 4242 in VS Code, 4343 in Cursor), processTable.rows their two trees, one window reporting
  // both shells: both caps 'sf'; processTable.reads toBe 1
it('cursor-agent in a terminal has its terminal, and a stroke on it asks no page keys', …)
  // engine 'cursor': caps 'sf'; its stroke's lines carry no "page"; the fullscreen and foreground fakes were not read
it('Cursor\'s own agent has status and a tap and no voice, and its tap opens Cursor on its folder', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'SECRET-FOLDER-MARKER-'))
  const { port } = startHere({ orca: mac })
  port.observed(hook('session-start', { engine: 'cursor', sessionId: 'cur-1', title: 'SECRET-TITLE-MARKER', cwd: folder, hostHints: { __CFBundleIdentifier: CURSOR } }))
  attach(port)
  const id = observedAgentId('cursor', 'cur-1')
  expect(await caps()).toEqual([{ id, caps: 'sf' }])
  expect(await host().openAgent(id)).toBeUndefined()
  expect(orcaRuns).toEqual([['/usr/bin/open', ['-b', CURSOR, folder], 10_000]])
  expect(logs.filter((line) => ['SECRET-', 'cur-1', CURSOR].some((secret) => line.includes(secret)))).toEqual([])
})
it('an agent in Cursor\'s terminal whose window is not there falls to its folder\'s window', …)
  // Claude Code, IN_CURSOR, cwd the folder, no window: orcaRuns toEqual [[open, ['-b', CURSOR, folder], 10_000]]
it('with the folder gone a tap brings Cursor forward alone; with its open failing the opener says so, then brings Cursor', …)
  // cwd '/nowhere/gone': orcaRuns toEqual [[open, ['-b', CURSOR], 10_000]], said() toEqual []
  // the folder there (a SECRET-FOLDER-MARKER one) and the run answering 1 once:
  //   orcaRuns toEqual [[…, ['-b', CURSOR, folder], …], [open, ['-b', CURSOR], 10_000]],
  //   said() toEqual ['[device] open · cursor-folder · fallback'], and no line of logs holds 'SECRET-' or CURSOR
it('off macOS Cursor\'s own agent has no tap', …)                              // caps 's'
it('Claude Code\'s panel in Cursor opens by cursor://, sent to Cursor alone', …)
  // sessionId UUID, hints { __CFBundleIdentifier: CURSOR, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }:
  // orcaRuns toEqual [[open, ['-b', CURSOR, `cursor://anthropic.claude-code/open?session=${UUID}`], 10_000]];
  // logs.filter((line) => [UUID, 'cursor://', CURSOR].some((secret) => line.includes(secret))) toEqual []
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "Cursor"`. Expected: FAIL (a tap
  brings Cursor forward and writes no show; no folder is opened).
- [ ] **Step 3: Implement** the three bullets.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devices.spec.ts && npx tsc --noEmit -p .`. Expected:
  PASS. Every new branch in `devices.ts` has a case: the file is held to 100% in phase 4.
- [ ] **Step 5: Numbers for the pull request** (idle work: the dial looks at each listed agent about once a second):
  the median time of one `canFocus` of the folder adapter on an existing folder, over 10 000 calls on this Mac.
- [ ] **Step 6: Commit** `Dial: a tap, a swipe and a scroll reach a terminal in Cursor, and a tap opens any other Cursor agent's folder`.

### Task 8: Devices: the extension set up in Cursor

**Depends on:** 4, 5, 6, 9. Shares files with Tasks 2, 4 and 7. **Effort:** xhigh (it installs into the person's own
Cursor by itself, and must stay out of it once they remove it).

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces — Consumes:** `vscodeExtensionDeps(editor, bin?)` (Task 4); `DialSetup.cursor`, `recordCursor` (Task 5);
the setup's own removal key (Task 6). **Produces:**

```ts
// DevicesDeps
/** For this service's tests: how Cursor and Harness's extension in it are found and `cursor` is run; the real ones by default. */
cursorExtension?: VscodeExtensionDeps
```

- One tally for both: `createEngineTally('[device] vscode extension', ['vscode', 'cursor'], SETUP_COUNTS, log)`.
- A second `createVscodeExtensionSetup`, for Cursor: `vscode: deps.cursorExtension ?? vscodeExtensionDeps('cursor', process.env.HARNESS_CURSOR_BIN)`,
  `recorded: () => skill.cursor()`, `record: (version) => skill.recordCursor(version)`, `after: timerIn('cursorExtension')`,
  its counts under `cursor`.
- Its pass runs wherever VS Code's does (after the dial setup's start pass; at each attach), each through its own
  part: `part.call('cursorExtension', …)`.
- **Log lines.** The tally's alone: `[device] vscode extension · cursor · <set up|updated|failed|left removed>`, a
  failure's reason one of the fixed words `no-code`, `timeout`, `failed`, `save`, `error`, and the day line's counts.
  Never Cursor's path, the home, the record's text or an error's message: a pass never rejects, so the part guard's
  line, which prints a message, is reached only by an injected fault.

- [ ] **Step 1: Write the failing tests** in the describe of VS Code's setup. `fakeVscode()` takes the editor.
  `start()` gives `cursorExtension` an absent Cursor unless the spec gives its own, and `null` leaves it out, as it
  does for `vscodeExtension`.

```ts
const counted = (editor: string) => (line: string) => line.startsWith(`[device] vscode extension · ${editor}`)

it('a dial\'s first attach installs it into Cursor too, records it and counts it under cursor', async () => {
  const cursor = fakeVscode({ app: true, editor: 'cursor' })
  start({ faults: ['fleet'], listen: fakeListener().listen, cursorExtension: cursor.deps })
  seen.host.watching!(true)
  await vi.waitFor(() => expect(readSetup(dataDir).cursor).toBe('9.9.9'))
  expect(flags(cursor)).toEqual(['--install-extension'])
  expect(readSetup(dataDir).vscode).toBeUndefined()
  expect(logs.filter(counted('cursor'))).toEqual(['[device] vscode extension · cursor · set up'])
  expect(logs).toContainEqual(expect.stringMatching(
    /^\[device\] vscode extension · day \d{4}-\d\d-\d\d · vscode set up 0 updated 0 failed 0 left removed 0 · cursor set up 1 updated 0 failed 0 left removed 0$/))
})
it('Cursor\'s install failing leaves VS Code\'s alone: VS Code\'s is set up and recorded, Cursor\'s counted failed', …)
  // cursor's run answers { code: 1 }: readSetup(dataDir) toMatchObject { vscode: '9.9.9' } with no cursor;
  // logs hold '[device] vscode extension · vscode · set up' and '[device] vscode extension · cursor · failed · failed'
it('marked removed for Cursor, nothing is installed there, and VS Code\'s still is', …)
  // writeRemoved(dataDir, 'cursor', true) before the attach: flags(cursor) toEqual [], flags(vscode) toEqual ['--install-extension']
it('a read of Cursor\'s record that throws is counted by a fixed word: no line holds its path, the home or the error\'s words', …)
  // the fake's home '/Users/SECRET-HOME-MARKER', its read throwing new Error('EACCES: /Users/SECRET-HOME-MARKER/.cursor/extensions/extensions.json'):
  // logs.filter(counted('cursor')) toEqual ['[device] vscode extension · cursor · failed · error'];
  // logs.filter((line) => line.includes('SECRET-')) toEqual []
it.each([
  ['unset: Cursor in /Applications is found, and installed into', undefined, ['--install-extension']],
  ['a file that is not there: none is found, and nothing runs', '/tmp/e2e/root/cursor/cursor', []],
])('HARNESS_CURSOR_BIN %s', …)
  // as HARNESS_VSCODE_BIN's case, with cursorExtension: null and VS Code's the spec's fake: the spy's calls toEqual [['cursor', bin]]
it('in the core\'s process nothing is installed into Cursor', …)               // no listen: flags(cursor) toEqual []
it('a throw on Cursor\'s path costs the dial, and VS Code\'s setup, nothing', …)
  // faults ['fleet', 'cursorExtension']: logs toContain '[devices] cursorExtension failed · injected fault: cursorExtension';
  // VS Code's pass still installs
```

  The existing day-line expectation gains ` · cursor set up 0 updated 0 failed 0 left removed 0`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "extension"`. Expected: FAIL.
- [ ] **Step 3: Implement** the three bullets; the comment on `HARNESS_VSCODE_BIN` names `HARNESS_CURSOR_BIN` beside
  it.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/architecture.startEnvironment.spec.ts && npx tsc --noEmit -p .`.
  Expected: PASS (`HARNESS_` variables are kept at a start).
- [ ] **Step 5: Commit** `Dial: Harness's extension is set up in Cursor once a dial has attached`.

### Task 9: End-to-end daemons and local stacks find no Cursor

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts`, `cli/scripts/remote-viewers-stack.ts`, `cli/scripts/local-stack-peer.ts`,
  `cli/scripts/remote-viewer-peer.ts`
- Test: `cli/e2e/developerState.e2e.ts`

- [ ] **Step 1: Write the failing test,** beside the one for VS Code:

```ts
it('finds none of the developer\'s Cursor: its devices look for Cursor\'s cursor only in its own root, where there is none', async () => {
  const d = daemon = await IsolatedDaemon.create()
  const bin = d.env.HARNESS_CURSOR_BIN ?? ''
  expect(isAbsolute(bin), bin).toBe(true)
  expect(relative(d.root, bin).startsWith('..'), bin).toBe(false)
  expect(existsSync(bin), bin).toBe(false)
})
```

- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/developerState.e2e.ts`.
  Expected: FAIL (`bin` is empty).
- [ ] **Step 3: Implement.** `daemon.ts`: `HARNESS_CURSOR_BIN: join(own, 'cursor', 'cursor')` beside VS Code's, its
  comment naming both. The three scripts: `HARNESS_CURSOR_BIN: join(<root>, 'no-cursor', 'cursor')` beside their
  `HARNESS_VSCODE_BIN`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `test: a daemon under test finds none of this computer's Cursor`.

### Task 10: `harness device cursor`, and the support bundle

**Depends on:** 4, 5. Shares files with Task 4. **Effort:** high.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts`, `cli/src/lib/logBundleFacts.ts`, `cli/src/lib/logBundle.ts`
- Test: `cli/src/deviceClaude/command.spec.ts`, `cli/src/lib/logBundleFacts.spec.ts`, `cli/src/lib/logBundle.spec.ts`

**Interfaces — Consumes:** `VscodeEditor`, `DeviceDeps.vscode(editor)`, `printed` (Task 4);
`writeRemoved(dataDir, 'cursor', …)` (Task 5).

- `harness device cursor status [--json]`, `enable`, `disable`: `vscode`'s code, run for the editor the word names.
  `harness device cursor link` is no word: it prints the usage and exits 1.
- The usage, exactly:

```
Harness device (with a dial plugged in, Claude Code and Codex are set up to ring it, and VS Code and Cursor to follow it; disable takes that away, enable brings it back):
  harness device cursor enable           set Cursor up again: Harness's extension in it
  harness device cursor disable          remove Harness's extension; Harness leaves it removed
```

  The two `cursor` lines follow `vscode`'s two. No line for `cursor status`.
- `STATUS_COMMANDS` gains `['device', 'cursor', 'status', '--json']` after VS Code's; `logBundle.ts`'s README line
  becomes `` 'status.txt: what `harness status` and `harness device claude|codex|vscode|cursor status --json` printed.' ``.

- [ ] **Step 1: Write the failing tests.** `command.spec.ts`'s `fakeVscode(options)` takes `editor` (its app, CLI
  and record are that editor's) and answers `vscode: (editor) => …`, recording each editor asked.

```ts
describe('harness device cursor', () => {
  it('status prints one line under cursor: absent, off, or on with its version', async () => {
    expect(await device(['cursor', 'status', '--json'], fakeVscode({ editor: 'cursor', app: false }))).toEqual({ code: 0, err: [], out: ['{"cursor":"absent"}'] })
    expect(await device(['cursor', 'status', '--json'], fakeVscode({ editor: 'cursor' }))).toEqual({ code: 0, err: [], out: ['{"cursor":"off"}'] })
    expect(await device(['cursor', 'status', '--json'], fakeVscode({ editor: 'cursor', version: '0.6.60' }))).toEqual({ code: 0, err: [], out: ['{"cursor":"on","version":"0.6.60"}'] })
  })
  it('enable clears Cursor\'s removal, then installs with Cursor\'s own CLI; disable marks it, then uninstalls', …)
    // writeRemoved(dataDir, 'vscode', true); writeRemoved(dataDir, 'cursor', true)
    // enable: out ['{"cursor":"on","version":"0.6.60"}'], code 0; at the install readRemoved(dataDir) toEqual { vscode: true }
    // disable: out ['{"cursor":"off"}'], code 0; answers(dataDir) toEqual { removed: { vscode: true, cursor: true } }
  it('enable that fails prints {"cursor":"off","error":"failed"} and exits 1', …)
  it('the cursor words ask for Cursor\'s dependencies, and the vscode words for VS Code\'s', …)   // the editors asked: ['cursor'], ['vscode']
  it('cursor link, cursor with no verb and an unknown verb print the usage and exit 1', …)
})
```

  The usage case gains the header above and the two `cursor` lines, and checks no line holds `cursor status`.
  `logBundleFacts.spec.ts`: `status.txt` ends with `'$ harness device cursor status --json'` and its answer, five
  commands are started before any is awaited, and their comments say five. `logBundle.spec.ts`: the README line above.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/deviceClaude/command.spec.ts src/lib/logBundleFacts.spec.ts src/lib/logBundle.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** `vscodeCommand` takes the editor; the file's header comment and `DEVICE_USAGE`'s comment
  name Cursor's words.
- [ ] **Step 4: Run** the same files and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `harness device cursor enable|disable: Harness's extension in Cursor, on and off`.

### Task 11: End to end: Cursor's terminal and folder window

**Depends on:** 7. **Effort:** xhigh.

**Files:**
- Modify: `cli/e2e/harness/outsideAgent.ts`
- Test: `cli/e2e/dialVscode.e2e.ts`

- `FAKE_APPS` gains `cursor: { bundle: 'Cursor', id: 'com.todesktop.230313mzl4w4u92', exe: 'cursor' }`.
- In the test file: `const CURSOR = 'com.todesktop.230313mzl4w4u92'` and
  `const IN_CURSOR = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR }`, on every platform (Decision 10, said
  in a comment). `stroke` moves from the scroll case to the describe, so both cases use it.
- **One new case,** `it('in Cursor: a rest shows its terminal, a tap raises its window and brings Cursor, a stroke scrolls it, and once the window goes a tap opens its folder', …, 300_000)`:
  1. `fresh()`. A = `Outside.start(d, 'SECRET-FOLDER-MARKER', IN_CURSOR, 'cursor', { shell: true })` (#4458's marker,
     as its folder's name); W in Ghostty, as `twoTerminals` starts it. Wait for an `apps` frame that counts `cursor` 1
     and `ghostty` 1.
  2. The window (`vscodeWindow(d)`) reports A's shell, active and focused; wait for `connected` and
     `[devices] vscode stream · open · windows 1`. Off macOS, wait for A's `f`.
  3. `front(CURSOR)`; `dial.turnUntil(a.id, "A's terminal shown", () => window.shows[0])`. `window.shows` is
     `[a.shellPid]`, `window.raised` is `[]`, the log says `[device] swipe · ok`.
  4. Tap A (`agent.open`): `window.raised` becomes `[2]`, `window.shows` `[a.shellPid, a.shellPid]`. On macOS
     `d.opens()` is `[['-b', CURSOR]]`; elsewhere `[]`. The log holds no `[device] open · cursor · fallback`.
  5. `stroke()`: `window.scrolls` becomes `['up', 'up', 'up']`.
  6. `window.stop()` is 0, and the log says `[devices] vscode stream · ended · gone · windows 0`.
  7. On macOS, tap A again: `d.opens()` gains one run, `['-b', CURSOR, <a folder>]`, whose folder's real path is that
     of `join(d.projectsDir, 'SECRET-FOLDER-MARKER')`. Elsewhere A's `f` goes and `d.opens()` stays `[]`.
  8. **The log.** The file's own check, `leaks()`, is extended, not doubled: it reads the lines that hold `vscode` or
     `cursor` (Cursor's adapter ids and its tally say `cursor`). `leaks(d, [a])` is `[]`: no pid, no window id, no
     path under the root, which A's folder is. And no line of the devices' own (`linesWith(d, '[device')`,
     `linesWith(d, '[observed]')`) holds `SECRET-FOLDER-MARKER`. A line of another process that holds it is reported,
     not fixed here.
  Every wait is a frame, a printed line or a log line.
- The file's header comment says Cursor's case and the fake Cursor.

- [ ] **Step 1: Write the case.** Commit it red.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts -t "in Cursor"`.
  Expected: FAIL (`'cursor'` is no fake app).
- [ ] **Step 3: Implement** the fake app and the hoist.
- [ ] **Step 4: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts`.
  Expected: PASS, all four cases. If step 3 of the case shows no terminal, compare the pane's pid with the engine's
  before anything else: stop and report rather than loosen the case.
- [ ] **Step 5: Commit** `Dial: a tap, a swipe and a scroll reach a terminal in Cursor, and a tap its folder, end to end`.

### Task 12: End to end: Claude Code's panel link in Cursor

**Depends on:** 7. **Effort:** high. A case for behavior Task 7 built red-then-green at its own layer (`Claude Code's
panel in Cursor opens by cursor://`): one commit, no red test.

**Files:**
- Test: `cli/e2e/dialVscodeFollow.e2e.ts`

- The file's one case becomes `it.each([['VS Code', 'vscode', VSCODE], ['Cursor', 'cursor', CURSOR]])`: the app's
  name in the case's title, its id on the dial (`m.shown`, the counted app) and its bundle (the hook's
  `__CFBundleIdentifier`, the watch's `front`, the `-b` of each open). `link` takes the scheme, which is the id:
  `` `${app}://anthropic.claude-code/open?session=${session}` ``.
- **The log.** The case's last step is the file's own log check, and the parameters extend it: no line holds either
  session's id, `` `${app}://` `` or `` `[device] open · ${app} · fallback` ``.
- The header comment names both editors. The file stays skipped off macOS.

- [ ] **Step 1: Write** the parameters.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscodeFollow.e2e.ts`
  on this Mac. Expected: PASS, both rows; Cursor's `d.opens()` is
  `[['-b', CURSOR, 'cursor://anthropic.claude-code/open?session=<v2>'], ['-b', CURSOR, 'cursor://…<v1>']]`.
- [ ] **Step 3: Commit** `Dial: a rest opens Claude Code's panel session in Cursor by its link, end to end`.

### Tasks 13 and 14 (dropped, spec §7): a real-app gate in a throwaway Cursor

Dropped (PM, 2026-11-19): a throwaway Cursor's crash reporting wrote into the person's own Cursor folder. Nothing of
either lands on this branch. A Cursor gate is later work, on a VM or a machine with no person's Cursor on it.

### Task 15: Docs

**Depends on:** none. **Effort:** medium. One commit, no red test.

**Files:**
- Modify: `plugins/harness-device-vscode/README.md`, `docs/cli.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`,
  `docs/plans/2026-11-17-dial-vscode-extension-design.md`

- `README.md`:
  - first line: "Lets the Harness dial reach Claude Code, Codex and cursor-agent running in VS Code's or Cursor's
    integrated terminal, on this computer."
  - after "What it does"'s list: "In Cursor it does the same. There the dial also lists Cursor's own agent: a tap on
    one opens Cursor's window for its folder (for a multi-root workspace its first folder, which may open as a second
    window)."
  - "On and off": "…Harness installs it into VS Code and into Cursor." Off: "uninstall it in the editor's Extensions
    view, or `harness device vscode disable` (`harness device cursor disable` for Cursor)". Back on: the two `enable`s.
  - "Where it runs": "VS Code 1.75 or later and Cursor, each in its default profile. VS Code Insiders, VSCodium and
    Windsurf are not covered. On Linux, in Cursor, a tap shows the terminal; swipe and scroll do not follow." (PM,
    2026-11-18.)
- `docs/cli.md`, a row after `harness device codex …`:
  "| `harness device vscode enable` · `disable` · `harness device cursor enable` · `disable` | From the first dial
  plugged in on this computer, the devices service installs Harness's extension into VS Code and into Cursor by
  itself, once, through each editor's own CLI, and keeps it current as Harness updates. These take that away or bring
  it back, one editor at a time: `disable` uninstalls it, and Harness leaves it removed · `enable` clears that and
  installs it. Each prints one JSON line, `{"vscode":"on","version":"…"}` or `{"cursor":"off"}`. |"
- `cli/src/services/AGENTS.md`, the `vscode` stream's sentence, after "(src/cable/hosts/vscodeTerminals.ts)": "Cursor's
  windows hold the same `vscode` stream: the extension is the same and cannot tell the apps apart, and a terminal is
  found by its shell's pid, whichever app holds it."
- The VS Code spec, "Platforms": "Cursor, VS Code Insiders and VSCodium are not in this work." becomes "Cursor is
  covered by [2026-11-18-dial-cursor-design.md](2026-11-18-dial-cursor-design.md); VS Code Insiders and VSCodium are
  not in this work."
- `cli/AGENTS.md`, the `devices` row (PM, 2026-11-18), three clauses after VS Code's terminal clause and its
  extension clause, in the row's own form:
  - "Claude Code, Codex and cursor-agent in Cursor's integrated terminal, on the same `vscode` stream from Harness's
    extension in Cursor's windows (one pool of at most 8 windows for both editors): as in VS Code, a tap shows the
    terminal and brings Cursor forward, and a rest and the dial's scroll follow it while Cursor is in front, on
    macOS; a tap opens a Claude Code session in Cursor's extension tab by
    `cursor://anthropic.claude-code/open?session=<id>` (`cable/hosts/vscode.ts`)"
  - "a tap on any other agent in Cursor opens Cursor's window for its folder, `open -b com.todesktop.230313mzl4w4u92
    <folder>`, the folder checked absolute, at most 4096 characters, with no control character and a folder now, on
    macOS (`cable/hosts/cursorFolder.ts`)"
  - "Harness's extension set up in Cursor as in VS Code, through Cursor's own `cursor --install-extension`, recorded
    under `cursor` in `dial-setup.json`, and never installed again once `harness device cursor disable` marked it
    removed in `dial-skill.json`"

- [ ] **Step 1: Write** the sentences.
- [ ] **Step 2: Commit** `docs: the dial in Cursor`.

---

## Verification

PR CI runs by itself on the pull request and needs no start. This change selects `cli-typecheck` and `cli-tests` (the
extension's and the gate guards' unit tests among them) and `process-checks`. **PR CI does not run `cli/e2e`**
(`.github/workflows/cli-e2e.yml` runs nightly and by hand only): in phase 4 the touched end-to-end files run locally,
as one tester group (check 2), and the whole suite runs once on GitHub at the final head only on the PM's go
(check 3).

| # | Check | Where | Isolation | What a person sees |
|---|---|---|---|---|
| 1 | **Unit:** `cd cli && npx tsc --noEmit -p . && npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/vscode.spec.ts src/cable/hosts/cursorFolder.spec.ts src/cable/hosts/vscodeTerminals.spec.ts src/cable/vscodeExtensionSetup.spec.ts src/cable/dialSetup.spec.ts src/cable/dialHomeSetup.spec.ts src/devices src/deviceClaude src/lib/logBundleFacts.spec.ts src/lib/logBundle.spec.ts src/services/devices.spec.ts ../plugins/harness-device-vscode src/architecture.spec.ts src/architecture.startEnvironment.spec.ts src/config/harnessHome.guard.spec.ts` | this Mac; PR CI on Linux | fakes only: a fake `open`, fake editors, records under each spec's temporary folder | all pass; each behavior's test was committed red before its code; no log line of a case holds its `SECRET-` marker |
| 2 | **CLI end to end, the touched files, locally in phase 4 (one tester group):** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/dialVscodeFollow.e2e.ts e2e/developerState.e2e.ts` | this Mac | the repo's own (cli/AGENTS.md rule 6): each daemon under a throwaway root and home on a port of its own (never 18473), a fake dial, the fake engine under a fake Cursor in a pseudo-terminal, the extension's real loop over a fake window, the harness's fake `open`; `HARNESS_CURSOR_BIN` and `HARNESS_VSCODE_BIN` name files that are not there; no Cursor, no VS Code, no `claude` | every case passes; Cursor's shows its terminal, raises its window, scrolls three lines, and records `open -b com.todesktop.230313mzl4w4u92 <folder>` and the `cursor://` link; no line of the devices holds the folder, a pid, a window's id or a session's id |
| 3 | **CLI end to end on Linux, the whole suite, one run at the final head, only on the PM's go** (PM, 2026-11-18): `gh workflow run cli-e2e.yml --ref feat/dial-cursor` (Actions → CLI end to end → Run workflow). The merge does not wait for it unless the PM says so. | GitHub, eight Linux runners | each daemon under a throwaway root, fake dials, fake engines | every shard green, `e2e/dialVscode.e2e.ts` and `e2e/developerState.e2e.ts` among them; `dialVscodeFollow.e2e.ts` is skipped off macOS |
| 6 | **Local gates' receipt:** `python3 scripts/local-checks.py --run` from a clean tree at the final commit. It runs the gates the changed files select, `cli-core` (`devices.ts` at 100%) among them. Its output goes in the pull request body before the push that carries that head. | this Mac | the unit suites' own | one `harness-local-checks` fence, every gate passed |
| 7 | **By a person, in the morning. Needs Diego himself** (his Cursor, his Claude Code login, his dial, his eye). Listed in the pull request body; it does not hold the merge. | Diego's Mac | his own Cursor: a check only he can do | (a) a Claude Code panel session in Cursor: a tap on the dial opens its tab; (b) Cursor's Extensions view lists Harness Device after the dial attached; (c) a tap on Cursor's own agent opens its folder's window; (d) with two Cursor windows, a tap on a terminal agent in the one behind brings that window forward |

**No temporary workflow.** The one long check that can run on GitHub, the end-to-end suite, has its own workflow,
started by hand only on the PM's go. No real-app gate runs (spec §7).

No check runs against production: nothing here calls a backend. No check uses an account: checks 1 to 6 need none,
and check 7 is the person's own.

**In the pull request:** the red-then-green commits; checks 1 to 6 with their output or links; Task 7's numbers; the
platforms (macOS all of it; Linux the setup and a terminal's tap, and in Cursor on Linux no swipe or scroll, said
so: "On Linux, in Cursor, a tap shows the terminal; swipe and scroll do not follow"; Windows unchanged); the dropped Cursor gate and why (spec §7), with the three files it wrote into Diego's Cursor folder; the three log lines this work adds, word for word; Diego's morning check (7), (a) to (d).

