# The dial's scroll moves Claude Code's fullscreen view in a VS Code terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Status:** updated after the PM's four answers and the answer on the user settings file (option b, 2026-11-18). No
question remains.

**Goal:** With Claude Code's `"tui": "fullscreen"` in a VS Code terminal, a stroke on the dial moves the transcript a
page for each 20 lines of travel, and only while Claude Code is that terminal's foreground program and is not asking.

**Architecture:**
- **The devices process** asks two more things at a stroke's `down`, one after the other, within 500 ms in all:
  whether the session's Claude Code settings say `"tui": "fullscreen"` (the `tui` key alone, of four files), then
  whether the agent's process group is its VS Code terminal's foreground group, the tpgid of the shell VS Code started
  there (one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>`). The stroke's
  answer becomes `page`, `lines` or `windows`. A `page` stroke's lines go to the window as
  `{"scroll":n,"pid":shell,"page":true}`.
- **Harness's VS Code extension** runs a page line's host scroll as today and also presses PageUp or PageDown in that
  terminal, one key per 20 lines, through `terminal.sendText(seq, false)`.
- **Nothing in the daemon core.** Every file is the devices process's, the extension's or a test's.

**Tech Stack:** TypeScript (Node, vitest 4) in `cli/` and `plugins/harness-device-vscode/`; Python 3 for the end-to-end
pseudo-terminal helper; `@vscode/test-electron` for the local gate.

**Spec:** [docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md](2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md).
Its "Decided (PM, 2026-11-18)", 1 to 7, is not reopened here.

## Base

- **#4425 first** (`feat/dial-herdr-scroll`). No task starts until #4425 has merged and this branch
  (`fix/dial-vscode-claude-fullscreen-scroll`) is rebased onto `main`. The main session does the rebase.
- **Written against** `origin/feat/dial-herdr-scroll` at `3e88129332` (CI green, mergeable): `main` at `86558dafad`
  (#4427) plus #4425. That head holds every name below: in `services/devices.ts`, `routeScroll`, `scrollTarget`,
  `Held`, `decided`, the `{ deciding, held }` stroke and no `scrollTerminal`; `HostAdapter.canScroll`/`onScreen`/
  `scroll` in `adapter.ts`; VS Code's adapter on `canScroll(pane)` and `scroll(pane, lines)` with
  `terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll'>`; `SCROLL_PAGE_LINES = 20`, private to
  `herdrApp.ts`. `vscodeTerminals.ts` and the extension are as on `main`.
- Tasks name code by name, never by line. If a name below is gone after the rebase, stop and report.
- A task that names failing tests is two commits: the tests, red, then the change. The message given is the second's.
  A task marked "one commit" changes no product behavior and has no red test.
- Before the first task: `cd cli && npm ci`.

## File structure

| File | Change |
|---|---|
| `cli/src/cable/hosts/claudeRenderer.ts` (new) | the renderer read: the `tui` key of Claude Code's four settings files, in precedence |
| `cli/src/cable/hosts/vscodeTerminals.ts` | a window's waiting lines keep their kind; the foreground read (`readForeground`); the guard (`pageKeys`) over the `fullscreen` and `foreground` deps; the minute line's new counts |
| `cli/src/cable/hosts/adapter.ts` | `HostAdapter.pageKeys?`; `scroll?` gains `page?` |
| `cli/src/cable/hosts/vscode.ts` | the VS Code adapter's `pageKeys`; its `scroll` passes `page` |
| `cli/src/services/devices.ts` | the two deps wired (`DevicesDeps.claudeFullscreen`, `processGroups`); `routeScroll`'s third answer |
| `cli/src/cable/hosts/observed.ts` | `ObservedSource.transcriptOf`: the transcript path an agent's hook or the scan gave |
| `plugins/harness-device-vscode/src/window.ts`, `facade.ts`, `vscodeApi.ts` | `WindowFacade.pageKey`; `ApiTerminal.sendText` |
| `plugins/harness-device-vscode/src/loop.ts` | a line's `page`, the page remainder, the keys in a run, the `page keys` count |
| `plugins/harness-device-vscode/src/testing/fakeWindow.ts`, `fakeVscode.ts` | record page keys and `sendText` |
| `cli/e2e/harness/outsideAgent.ts` | the pseudo-terminal helper's job-control step; `Outside.background()` |
| `cli/e2e/harness/vscodeWindow.ts`, `cli/e2e/dialVscode.e2e.ts` | the window prints each key; one new case |
| `plugins/harness-device-vscode/gate/realVscode.gate.ts`, `gate/driver/run.cjs`, `gate/driver/altScreenApp.cjs` (new) | the gate's page case and its fake alt-screen app |
| `cli/AGENTS.md`, `plugins/harness-device-vscode/README.md` | what the devices read and what the extension types |

Nothing under `cli/src/core/` or `cli/src/harnessd/` changes; `cli/src/architecture.coreFiles.txt` gains no line.

## Global Constraints

- **Two sequences only:** `\x1b[5~` (PageUp, toward older lines, n < 0) and `\x1b[6~` (PageDown), each sent with
  `terminal.sendText(seq, false)`. The extension can write no other text to a terminal.
- **The guard:** the shown agent's engine is `claude`; it is not `needs-you`; its settings' `tui` is `"fullscreen"`;
  its pane pid's group is its VS Code terminal's foreground group (the agent's `pgid` equals the `tpgid` of the shell the
  window reported for its terminal, and that `tpgid` is above 0).
- **The renderer read:** only the `tui` key of, highest precedence first, the managed file
  (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on
  Linux), `<cwd>/.claude/settings.local.json`, `<cwd>/.claude/settings.json`, and `settings.json` in the session's own
  Claude Code home: `<home>` of its transcript path `<home>/projects/<slug>/<id>.jsonl`, else (no transcript path, or
  another shape) the default home `dirname(CLAUDE_PROJECTS_DIR)`. Each read with a 256 KiB cap and parsed as JSON.
  Nothing but `tui` is kept, and never logged.
- **Never another process's environment or arguments.** `CLAUDE_CODE_NO_FLICKER=1` is not seen: a documented limit.
- **The foreground read:** `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` through `execText` (`scannedApp.ts`). The
  foreground is the shell's `tpgid`, never the agent's own: under screen, script, asciinema or sudo's use_pty the agent
  leads a pseudo-terminal of its own and is always in front there.
- **The pid** is the pane's: `termPid(observed.paneOf(id, 'vscode'))`. Never `entry.pid`.
- **A refused guard is `lines`**, the VS Code terminal's line scroll as today, never Harness's windows.
- **A stroke is held at most 500 ms** of wall time, then goes out as lines and stays lines.
- **20 dial lines are one page key.** At most 100 lines and 5 keys from one line.
- **The wire:** `{"scroll":n,"pid":shell,"page":true}`. The devices write `page` only when it is true; the extension
  reads it only when it is `true`. Both sides ignore it when missing or unknown.
- **The page remainder** is per shell and resets on a line for another shell, on a line with no `page`, after 1 s with
  no page line, and when the stream ends.
- **Logs and measures:** counts and fixed words. Never a pid, a name, a path or a settings value.
- **Never a real `claude`** in any test or check, never the person's VS Code, `~/.claude*` or `~/.vscode`.
- **Repo rules:** a test that fails first, at the layer where the behavior lives; no fixed sleeps; comments say why;
  100% per file for `cli/src/services/`.
- **Platforms:** macOS and Linux. Windows is unchanged: no devices listener there.
- **Not here:** the unbounded `dy` of a frame writing plain lines without end is the PM's own small pull request. This
  plan only keeps it from becoming page keys (Task 1).

## Decisions the spec left to the plan

1. **The route stays general.** The adapter gets the door (`HostAdapter.pageKeys`, and `page` on `scroll`), as #4425
   made scroll an adapter's member. `routeScroll` owns who the agent is, whether it asks and its folder;
   `vscodeTerminals.ts` owns the two reads, their judgement, their deadline and the counts.
2. **The renderer is a dep of `vscodeTerminals.ts`** (`fullscreen(cwd, transcriptPath)`) beside `foreground(pid)`, so one deadline and
   one join cover both reads. Its code is a module of its own, `claudeRenderer.ts`, with its own tests.
3. **The renderer is read first, `ps` only when it passes.** Most sessions run the default renderer: they cost no `ps`.
   Both reads sit inside the one 500 ms.
4. **The first file, in precedence, whose JSON object has its own `tui` decides,** whatever the value; only the string
   `"fullscreen"` passes. A file missing, not a regular file, over 256 KiB, unreadable, not JSON, not an object, or
   with no `tui` gives way to the next. None decides: refused. A doubt errs toward today's line scroll.
5. **An agent with no folder, or a relative one, is refused `renderer` with nothing read:** its project files, which
   outrank the user's, cannot be found.
6. **A settings file is opened `O_RDONLY | O_NONBLOCK`, checked a regular file by `fstat`, and read to the cap plus one
   byte,** as `recordName.ts` reads a record. The project's files come from whatever folder the person opened: a FIFO
   there never holds a thread, and `/dev/zero` is no file.
7. **The 500 ms is a plain timer** on `vscodeTerminals.ts`'s `after`, so it is wall time. The `ps` read's own bound
   stays `PS_TIMEOUT_MS` on the patient exec: an answer that lands after 500 ms is dropped.
8. **`tpgid` of 0 or less is "no terminal"**, refused `ps`: macOS prints 0 there, Linux prints -1.
9. **One guard in flight per agent pid.** An ask while that agent's guard is in flight joins it.
10. **A window's waiting lines are at most two runs,** one page and one plain, written in the order they began to wait.
    The spec says a change of kind "flushes what waits first"; a stream that cannot take a line yet cannot be flushed.
11. **The extension sends a line's keys before its lines.** Fullscreen's move does not wait behind up to 100 host scroll
    commands that do nothing there, and the end-to-end test can say "no key" once a line's host scrolls ran.
12. **The extension's minute line** gets `page keys` before `scroll lines`: the end-to-end test and the gate parse the
    line's end (`…, N scroll lines, N dropped`), and both keep working at every commit.
13. **One constant each.** Herdr's `SCROLL_PAGE_LINES` is private to `herdrApp.ts` in the devices process, and the
    devices never need the number here: the extension does the page math, and it is bundled alone and imports nothing
    of the CLI. `loop.ts` gets `PAGE_LINES = 20` with that reason in its comment.
14. **A `needs-you` learnt mid-stroke is not counted as a refusal:** that stroke's guard passed.
15. **The end-to-end job control** is a second process in the fake engine's session: only a member of a session may
    move its terminal's foreground group, and the session's leader (the engine) cannot leave its own group.
16. **The end-to-end case fails at once, naming the file, when this machine's managed settings file sets a `tui`:** it
    outranks the test's own project file, and the devices must read the real path.
17. **The session's own home comes from its transcript path's shape alone.** The devices pass the path as the hook or
    the scan gave it (`ObservedSource.transcriptOf`); `claudeRenderer.ts` judges it. It names a home only when it is
    absolute, already normalized (no `.` or `..`, no doubled `/`), ends in `<id>.jsonl` and sits in
    `<home>/projects/<slug>/`; anything else is the default home. It is not held to the homes the devices list (theirs
    and Orca's): a home of the person's own `CLAUDE_CONFIG_DIR` is the case the PM's answer is for, and the read there
    is still one `settings.json`, by the same capped, non-blocking, regular-file read, keeping `tui` alone.

## Design

The spec's Design section stands. Nothing is stored. In memory: one guard answer per stroke, one guard per agent in
flight, at most two waiting runs per window, one page remainder per window. The settings' text lives only during its
parse.

## Review Focus

1. **A project's `.claude/settings.json` is a FIFO, a device or a huge file** (a cloned repo is outside data): it reads
   as no `tui`, at once, and no thread waits on it. Task 2 (`a FIFO`, `/dev/zero`, `one byte past`).
2. **A window's stream is not ready when the kind changes** (page lines wait, plain lines come): neither is merged
   into the other and neither is dropped. Task 1 (`never merged`).
4. **A dial sends `down` after `down` faster than the reads answer:** one guard in flight, and an older stroke held
   for the page guard sends its travel as plain lines. Task 3 (`joins it`), Task 7 (`a newer down`).
5. **The agent's session ends mid-stroke, and its hook tells the devices:** nothing more of the stroke is written, so
   no key reaches the shell that came back. Task 7 (`whose agent then leaves`).

## Tasks

| # | Task | Depends on | Effort |
|---|---|---|---|
| 1 | Devices: a window's lines keep their kind | none | high |
| 2 | Devices: Claude Code's renderer from its settings | none | xhigh |
| 3 | Devices: the page guard | 2 | xhigh |
| 4 | Extension: `pageKey` in the window | none | high |
| 5 | Extension: a page line sends page keys | 4 | xhigh |
| 6 | Adapter: `pageKeys`, and `page` on `scroll` | 1, 3 | high |
| 7 | Routing: the stroke's third answer | 6 | xhigh |
| 8 | End to end: renderer, foreground and background | 5, 7 | xhigh |
| 9 | Local gate: the key in a real VS Code | 1, 5 | high |
| 10 | Docs | none | medium |

**Longest chain:** 2 → 3 → 6 → 7 → 8 (five). Tasks 1, 2, 4 and 10 start at once.

**Start Task 9 as soon as 1 and 5 are done.** It tests the one thing the design assumes of VS Code and no unit test can
show: that `sendText` writes the key's bytes and nothing else.

**Tasks that share files** (never two of a group at once):
- `cli/src/cable/hosts/vscodeTerminals.ts` and its spec: 1, 3.
- `cli/src/services/devices.ts`, `devices.spec.ts`: 3, 7.
- `plugins/harness-device-vscode/src/loop.test.ts`: 4, 5.

---

### Task 1: Devices: a window's lines keep their kind

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts`
- Test: `cli/src/cable/hosts/vscodeTerminals.spec.ts`

**Interfaces — Produces:**

```ts
// VscodeTerminals
/** Adds whole lines for that terminal; false when its window's stream is gone. `page`: they are written with
 *  `"page":true`, and the extension presses Claude Code's page keys beside them. */
scroll(terminal: VscodeTerminal, lines: number, page?: boolean): boolean
```

- A page line is `{ scroll: n, pid: shell, page: true }`. A plain line is `{ scroll: n, pid: shell }`, as today: never
  `page: false`.
- What waits for a window is at most two runs for one shell, one page and one plain. Lines add to the run of their own
  kind; a run that adds up to 0 is gone. The run that began to wait first is written first, `VSCODE_SCROLL_MAX` a line.
- A page run that waits is held to ±`VSCODE_SCROLL_MAX` lines (5 keys' worth). Plain runs are as today.
- A count that is not a safe integer (`Number.isSafeInteger`) writes nothing and answers `true`, as 0 does.
- Lines for another shell replace every run that waits; each run replaced is counted `dropped`.
- The file's header comment says why the kinds stay apart.

- [ ] **Step 1: Write the failing tests** (in `describe('VS Code\'s windows')`, with its `harness()`).

```ts
it('page lines are written with "page":true, and plain lines carry no page', () => {
  const h = harness(); const one = h.open(W1); const terminal = { window: W1, shell: 700 }
  h.terminals.scroll(terminal, -45, true)
  one.drain()
  h.terminals.scroll(terminal, -3)
  expect(one.lines).toEqual([{ scroll: -45, pid: 700, page: true }, { scroll: -3, pid: 700 }])
})

it('page and plain lines that wait are never merged: each adds to its own kind, and the kind that waited first is written first', () => {
  const h = harness(); const one = h.open(W1); const terminal = { window: W1, shell: 700 }
  h.terminals.scroll(terminal, -1, true)    // written: the stream now has a line in flight
  h.terminals.scroll(terminal, -30, true)
  h.terminals.scroll(terminal, -3)
  h.terminals.scroll(terminal, -10, true)
  h.terminals.scroll(terminal, -2)
  one.drain(); one.drain(); one.drain()
  expect(one.lines).toEqual([{ scroll: -1, pid: 700, page: true }, { scroll: -40, pid: 700, page: true }, { scroll: -5, pid: 700 }])
})

it('page lines that wait are held to 100', () => {
  // -1 page written; -90 page and -90 page wait; two drains
  expect(one.lines).toEqual([{ scroll: -1, pid: 700, page: true }, { scroll: -100, pid: 700, page: true }])
})

it.each([Infinity, -Infinity, NaN, 1.5, 2 ** 53])('a count of %s writes nothing', (lines) => {
  // scroll(terminal, lines, true) and scroll(terminal, lines) both answer true; after a drain one.lines is []
})

it('lines for another shell replace both kinds that wait, each counted dropped', () => {
  // {700}: -1 written; -5 page and -5 plain wait; {710}: 2; two drains
  expect(one.lines).toEqual([{ scroll: -1, pid: 700 }, { scroll: 2, pid: 710 }])
  // the minute's timer run:
  expect(h.logged.at(-1)).toContain(', 2 dropped')
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscodeTerminals.spec.ts`. Expected: FAIL in the new
  cases only (no `page` on a line; two kinds merged).
- [ ] **Step 3: Implement** in `scroll` and `write`. The existing cases pass unchanged.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npx tsc --noEmit`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a VS Code window's page lines wait apart from its plain lines`.

### Task 2: Devices: Claude Code's renderer from its settings

**Depends on:** none. **Effort:** xhigh (it reads files a cloned repo can shape).

**Files:**
- Create: `cli/src/cable/hosts/claudeRenderer.ts`
- Test: `cli/src/cable/hosts/claudeRenderer.spec.ts` (new)

**Interfaces — Produces:**

```ts
/** A settings file is about 1–10 KiB; a larger file is not read. */
export const SETTINGS_MAX_BYTES = 256 * 1024
/** Claude Code's managed settings, by platform: the highest of its files. None elsewhere. */
export const MANAGED_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
}
export interface RendererOptions {
  /** The devices' default Claude Code home, dirname(CLAUDE_PROJECTS_DIR): the user file's home for a session whose
   *  transcript path names none. */
  defaultHome: string
  platform: NodeJS.Platform
}
/** The four files, highest precedence first: managed (where the platform has one), project local, project, user.
 *  `cwd` is absolute. The user file is `settings.json` in the session's own Claude Code home, `<home>` of its
 *  `transcriptPath` `<home>/projects/<slug>/<id>.jsonl` (Decision 17); in `opts.defaultHome` when there is none or it
 *  has another shape. From the path alone: no environment is read. */
export function settingsFiles(cwd: string, transcriptPath: string | undefined, opts: RendererOptions): string[]
/** One file's text: none when it is missing, not a regular file, over SETTINGS_MAX_BYTES or unreadable. Never rejects. */
export async function readSettings(path: string): Promise<string | undefined>
/** Whether Claude Code draws the session in `cwd` with that transcript fullscreen, as far as its settings say: the first
 *  of settingsFiles whose JSON object has its own `tui` decides, and only `"fullscreen"` passes. Reads `tui` alone;
 *  keeps and logs nothing. Never rejects. */
export async function readFullscreen(
  cwd: string, transcriptPath: string | undefined, opts: RendererOptions, read = readSettings,
): Promise<boolean>
```

- **The home from the path** (private to the module): `isAbsolute(p) && normalize(p) === p && extname(p) === '.jsonl'
  && basename(dirname(dirname(p))) === 'projects'` gives `dirname(dirname(dirname(p)))`; anything else gives
  `opts.defaultHome`.

- `readSettings`: `open(path, constants.O_RDONLY | constants.O_NONBLOCK)`, `fstat` must be a regular file, read
  `SETTINGS_MAX_BYTES + 1` bytes from 0, more than the cap is none. As `recordName.ts`'s read.
- `readFullscreen`: files read one at a time, stopping at the one that decides. `Object.hasOwn(parsed, 'tui')` on a
  parsed value that is a non-null, non-array object.
- The file's header comment says what is read and why only `tui`, the precedence (Claude Code's own, less its command
  line), why the user file's home comes from the transcript path (a session with its own `CLAUDE_CONFIG_DIR`, such as
  an Orca account home, reads its own `settings.json`, and another process's environment is never read), and the
  limit: fullscreen from `CLAUDE_CODE_NO_FLICKER=1` is not seen.

- [ ] **Step 1: Write the failing tests.** Real files under `mkdtempSync(join(tmpdir(), 'renderer-'))`, removed in
  `afterEach`; precedence with a fake `read` keyed by path.

```ts
const opts = { defaultHome: '/h/.claude', platform: 'darwin' as const }
/** A session of an Orca account, whose Claude Code home is its own. */
const ORCA_TRANSCRIPT = '/o/claude-profiles/acct/home/projects/-work-api/s1.jsonl'

it('the four files, highest first', () => {
  expect(settingsFiles('/work/api', undefined, opts)).toEqual([
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/work/api/.claude/settings.local.json', '/work/api/.claude/settings.json', '/h/.claude/settings.json'])
  expect(settingsFiles('/work/api', undefined, { ...opts, platform: 'linux' })[0]).toBe('/etc/claude-code/managed-settings.json')
  expect(settingsFiles('/work/api', undefined, { ...opts, platform: 'win32' })).toHaveLength(3)
})

it.each<[string, string | undefined, string]>([
  ['a transcript in an Orca account home: that home', ORCA_TRANSCRIPT, '/o/claude-profiles/acct/home/settings.json'],
  ['no transcript path: the default home', undefined, '/h/.claude/settings.json'],
  ['a transcript outside projects/<slug>/: the default home', '/o/home/sessions/-work-api/s1.jsonl', '/h/.claude/settings.json'],
  ['a relative transcript path: the default home', 'o/home/projects/-work-api/s1.jsonl', '/h/.claude/settings.json'],
  ['a transcript that is no .jsonl: the default home', '/o/home/projects/-work-api/s1.json', '/h/.claude/settings.json'],
  ['a transcript path with ..: the default home', '/o/home/projects/../projects/-work-api/s1.jsonl', '/h/.claude/settings.json'],
])('the user file, %s', (_, transcript, user) => {
  expect(settingsFiles('/work/api', transcript, opts).at(-1)).toBe(user)
})

it("a session in its own home is judged by that home's settings.json, never the default home's", async () => {
  const files: Record<string, string> = {
    '/o/claude-profiles/acct/home/settings.json': '{"tui":"fullscreen"}', '/h/.claude/settings.json': '{"tui":"default"}' }
  const read = vi.fn(async (path: string) => files[path])
  expect(await readFullscreen('/work/api', ORCA_TRANSCRIPT, opts, read)).toBe(true)
  expect(read.mock.calls.map(([path]) => path)).not.toContain('/h/.claude/settings.json')
})

it.each<[string, Record<string, string>, boolean]>([
  ['the user file alone says fullscreen', { '/h/.claude/settings.json': '{"tui":"fullscreen"}' }, true],
  ['the project file says default over the user fullscreen', { '/work/api/.claude/settings.json': '{"tui":"default"}', '/h/.claude/settings.json': '{"tui":"fullscreen"}' }, false],
  ['the local file says fullscreen over the project default', { '/work/api/.claude/settings.local.json': '{"tui":"fullscreen"}', '/work/api/.claude/settings.json': '{"tui":"default"}' }, true],
  ['managed says default over all', { '/Library/Application Support/ClaudeCode/managed-settings.json': '{"tui":"default"}', '/work/api/.claude/settings.local.json': '{"tui":"fullscreen"}' }, false],
  ['a file with no tui gives way', { '/work/api/.claude/settings.json': '{"model":"x"}', '/h/.claude/settings.json': '{"tui":"fullscreen"}' }, true],
  ['bad JSON gives way', { '/work/api/.claude/settings.json': '{"tui":', '/h/.claude/settings.json': '{"tui":"fullscreen"}' }, true],
  ['an array or a string is no object', { '/work/api/.claude/settings.json': '["tui"]', '/h/.claude/settings.json': '"fullscreen"' }, false],
  ['a tui that is not the string decides, and refuses', { '/work/api/.claude/settings.json': '{"tui":true}', '/h/.claude/settings.json': '{"tui":"fullscreen"}' }, false],
  ['an inherited tui is none', { '/h/.claude/settings.json': '{"__proto__":{"tui":"fullscreen"}}' }, false],
  ['no file', {}, false],
])('%s', async (_, files, fullscreen) => {
  const read = vi.fn(async (path: string) => files[path])
  expect(await readFullscreen('/work/api', undefined, opts, read)).toBe(fullscreen)
})

it('stops at the file that decides', …)                 // local says fullscreen: read called with the managed and the local path only
it('a read that rejects counts as no file, and nothing rejects', …)

describe('readSettings', () => {
  it('reads a file of exactly 256 KiB', …)
  it('one byte past 256 KiB is none', …)
  it('a missing file and a folder are none', …)
  it.skipIf(process.platform === 'win32')('a FIFO is none, at once, with no writer', async () => {
    execFileSync('mkfifo', [fifo])
    expect(await readSettings(fifo)).toBeUndefined()      // resolves: no writer is ever opened
  })
  it.skipIf(process.platform === 'win32')('a link to /dev/zero is none', …)
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeRenderer.spec.ts`. Expected: FAIL (the module is
  not there).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/claudeRenderer.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts && npx tsc --noEmit`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the devices read whether Claude Code's settings draw a session fullscreen`.

### Task 3: Devices: the page guard

**Depends on:** 2 (`devices.ts` wires `readFullscreen`). Shares files with Task 1. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/cable/hosts/vscodeTerminals.ts`, `cli/src/services/devices.ts` (the deps' wiring only)
- Test: `cli/src/cable/hosts/vscodeTerminals.spec.ts`, `cli/src/services/devices.spec.ts` (the spec's own fakes only)

**Interfaces — Consumes:** `readFullscreen`, `RendererOptions` (Task 2).

**Produces:**

```ts
// vscodeTerminals.ts
export const VSCODE_GUARD_MS = 500
/** The read prints two rows of three numbers of at most 10 digits and a sign, with ps's padding. */
export const GROUPS_MAX_BYTES = 128
export interface ProcessGroups { pgid: number; tpgid: number }
/** The agent's group and its VS Code terminal's foreground group, the tpgid of the shell VS Code started there, from
 *  one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` through scannedApp.ts's patient exec. None when `ps` failed, either
 *  process is gone, or it printed anything but one row of three numbers for each. */
export async function readForeground(agent: number, shell: number, exec: Exec = execText): Promise<ProcessGroups | undefined>
/** What the guard knows of the agent: whether it waits on the person, its folder, and its transcript path as its hook
 *  or the scan gave it (the user settings' home: claudeRenderer.ts). */
export interface PageAgent { asking: boolean; cwd?: string; transcriptPath?: string }

// VscodeTerminalsDeps, beside `processes`
/** Whether Claude Code's settings for that absolute folder, and the home its transcript path names, draw it fullscreen
 *  (claudeRenderer.ts readFullscreen). */
fullscreen(cwd: string, transcriptPath: string | undefined): Promise<boolean>
/** The agent's process group and the foreground group of the terminal whose shell has that pid (readForeground). */
foreground(agent: number, shell: number): Promise<ProcessGroups | undefined>

// VscodeTerminals
/** Whether a stroke on the terminal of the agent with that pid may carry page keys. `false` at once, with nothing read,
 *  when the agent asks or has no absolute folder; else a promise, never rejected, settled within VSCODE_GUARD_MS: true
 *  when its settings say fullscreen and its process group is its VS Code terminal's foreground group. Every answer is
 *  counted in the minute's line. */
pageKeys(agentPid: number, agent: PageAgent): false | Promise<boolean>

// devices.ts — DevicesDeps
/** For this service's tests: whether a Claude Code session's settings draw it fullscreen; its settings files by default
 *  (cable/hosts/claudeRenderer.ts readFullscreen). */
claudeFullscreen?: VscodeTerminalsDeps['fullscreen']
/** For this service's tests: how an agent's process group and its VS Code terminal's foreground group, through that
 *  terminal's shell, are read; `ps` by default (cable/hosts/vscodeTerminals.ts readForeground). */
processGroups?: VscodeTerminalsDeps['foreground']
```

- **The read:** `exec('ps', ['-o', 'pid=,pgid=,tpgid=', '-p', <agent>,<shell>], { timeout: PS_TIMEOUT_MS, maxBuffer: GROUPS_MAX_BYTES })`,
  an agent that is its terminal's own process named once. A row is three numbers, the last possibly negative; the
  answer is the agent's `pgid` and the shell's `tpgid`.
- **The judgement,** each ask counted once:
  - `asking` → `asking`, nothing read;
  - no `cwd`, or one that is not absolute → `renderer`, nothing read;
  - `fullscreen(cwd, agent.transcriptPath)` answers false or rejects → `renderer`, no `ps`;
  - then the agent has no terminal now (its window went meanwhile) → `ps`, no `ps` run;
  - `foreground(pid, terminal.shell)` answers none, or rejects, or `tpgid <= 0` → `ps`;
  - `pgid !== tpgid` → `background`;
  - `pgid === tpgid` → a page stroke, `true`;
  - no answer `VSCODE_GUARD_MS` after the ask, on `deps.after` → `slow`, `false`. What lands later counts nothing for
    that ask. An answer in time cancels the ask's timer.
- **One guard in flight per agent pid:** an ask for a pid whose guard is in flight joins it, with a deadline of its own.
- **The minute's line, exact** (the new counts after `dropped`):

```
[devices] vscode · in the last minute: 0 shows, 0 taps, 0 refused states, 0 ps reads, 0 failed, 0 scroll lines, 0 dropped, 1 page strokes, guard refused: 1 renderer, 1 asking, 1 background, 2 ps, 1 slow
```

- The file's header comment names the two reads: settings' `tui` alone, and two numbers from `ps`; never a name, an
  environment or arguments.
- `devices.ts`: `vscodeStreams({ …, fullscreen: deps.claudeFullscreen ?? ((cwd, transcriptPath) => readFullscreen(cwd, transcriptPath, { defaultHome: dirname(env.CLAUDE_PROJECTS_DIR), platform: apps.platform })), foreground: deps.processGroups ?? readForeground })`.
  Nothing else there: the transcript path reaches the guard from the route (Task 7).
- `devices.spec.ts`: two fakes beside `processTable`, passed by `start()` and reset where `processTable` is:

```ts
/** Whether a session's settings draw it fullscreen (services/devices.ts claudeFullscreen): the spec's own, fullscreen
 *  unless a spec sets it, each read's folder and transcript path kept, so no spec reads this machine's settings. */
const claudeSettings = { fullscreen: true, reads: [] as Array<[string, string | undefined]> }
/** An agent's process group and its VS Code terminal's foreground group (services/devices.ts processGroups): the spec's
 *  own, the agent in front unless a spec sets it, each read's agent and shell pids kept, and held while `held` until the
 *  spec lands it, so no spec runs this machine's ps. */
const processGroups = { answer: { pgid: 4242, tpgid: 4242 } as { pgid: number; tpgid: number } | undefined,
  reads: [] as Array<[number, number]>, held: false, land: [] as Array<() => void> }
```

- [ ] **Step 1: Write the failing tests** in `vscodeTerminals.spec.ts`. Its `harness()` gains a `fullscreen` dep (true
  unless a test sets it, each folder and transcript path kept) and a `foreground` dep whose reads are held until the test lands them (as
  `processes`); its timers keep whether each was cancelled.

```ts
describe('the foreground group the page guard reads', () => {
  it("is the agent's group and its VS Code terminal's foreground group as the terminal's shell sees it, from one ps read within its bounds", async () => {
    const exec = vi.fn<Exec>(async () => '  700   700   900\n  900   900   900\n')
    expect(await readForeground(900, 700, exec)).toEqual({ pgid: 900, tpgid: 900 })
    expect(exec.mock.calls).toEqual([['ps', ['-o', 'pid=,pgid=,tpgid=', '-p', '900,700'], { timeout: PS_TIMEOUT_MS, maxBuffer: GROUPS_MAX_BYTES }]])
  })
  it("an agent in front of a pseudo-terminal of its own (screen, script, sudo's) is not in front of the VS Code terminal", …)
    // '  700   700   800\n  900   900   900\n' → { pgid: 900, tpgid: 800 }
  it("an agent that is its terminal's own process is asked once", …)       // readForeground(900, 900): '-p', '900'
  it('reads the -1 Linux prints for a shell with no terminal', …)          // → { pgid: 900, tpgid: -1 }
  it.each([null, '', 'SECRET-TOKEN rotate the key\n', /* the agent gone, the shell gone, another's row, two numbers, a row twice */ …])
    ('a ps that failed, or printed anything but one row of three numbers for each, is none: %j', …)
  it.skipIf(process.platform === 'win32')("this machine's: this process has a group, and its parent a foreground group", async () => {
    expect(await readForeground(process.pid, process.ppid)).toEqual({ pgid: expect.any(Number), tpgid: expect.any(Number) })
  })
})

// in describe('VS Code\'s windows'); AGENT = { asking: false, cwd: '/work/api' }
it("a fullscreen agent in its terminal's foreground group may take page keys: its folder read, then one ps, for its pid", …)
  // { pgid: 900, tpgid: 900 } → true; fullscreen called with ('/work/api', undefined), foreground with (900, its shell), in that order
it("the agent's transcript path goes to the renderer read with its folder, as given", …)
  // pageKeys(900, { ...AGENT, transcriptPath: '/o/home/projects/-work-api/s1.jsonl' }): fullscreen called with
  // ('/work/api', '/o/home/projects/-work-api/s1.jsonl'); the shape is claudeRenderer.ts's to judge, not the guard's
it('an agent that asks is refused at once, with nothing read', …)          // pageKeys(900, { ...AGENT, asking: true }) === false, not a promise
it.each([undefined, 'work/api'])('a folder of %s is refused renderer at once, with nothing read', …)
it('settings that do not say fullscreen are refused renderer, and ps is not run', …)
it('a renderer read that rejects is refused renderer, and nothing rejects', …)
it('another group in front is refused', …)                                  // { pgid: 900, tpgid: 700 } → false
it.each([['none', undefined], ['macOS, no terminal', { pgid: 900, tpgid: 0 }], ['Linux, no terminal', { pgid: 900, tpgid: -1 }]])('a read of %s is refused', …)
it('an agent with no terminal now is refused ps, with no ps run', …)
it('a ps read that rejects is refused, and nothing rejects', …)
it('no answer in 500 ms is refused, and the answer that lands later counts nothing', …)     // the 500 timer run → false; then land
it('an answer in time cancels its 500 ms', …)
it("an ask while that agent's guard is in flight joins it: one renderer read, one ps, and each ask is answered and counted", …)
it("the minute's line counts page strokes and each refusal by its reason", …)               // the exact line above
```

  The three existing exact minute lines gain `, 0 page strokes, guard refused: 0 renderer, 0 asking, 0 background, 0 ps, 0 slow`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscodeTerminals.spec.ts`. Expected: FAIL
  (`readForeground` and `pageKeys` are not there).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts src/architecture.environment.spec.ts && npx tsc --noEmit && npm run test:core -- --maxWorkers=4`.
  Expected: PASS, `devices.ts` at 100%.
- [ ] **Step 5: Commit** `Dial: the devices read whether a VS Code agent draws fullscreen and is its terminal's foreground program`.

### Task 4: Extension: `pageKey` in the window

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `plugins/harness-device-vscode/src/window.ts`, `facade.ts`, `vscodeApi.ts`, `testing/fakeWindow.ts`,
  `testing/fakeVscode.ts`
- Test: `plugins/harness-device-vscode/src/facade.test.ts`; `loop.test.ts` (only `world()`'s window, which gains the
  member and tells `called()` as its `scrollLine` does)

**Interfaces — Produces:**

```ts
// vscodeApi.ts — ApiTerminal gains
sendText(text: string, addNewLine?: boolean): void

// window.ts — WindowFacade gains
/** Presses PageUp (`up`, toward older lines) or PageDown in the terminal whose shell has that pid: one of two fixed
 *  key sequences, with no newline. False when no terminal has that shell. The one member that writes to a terminal. */
pageKey(pid: number, up: boolean): boolean

// testing/fakeWindow.ts — the fake gains
/** Each page key asked, in order. */
pageKeys: Array<{ pid: number; up: boolean }>      // its pageKey answers state.terminals.includes(pid)

// testing/fakeVscode.ts — open() also returns
/** Each sendText on that terminal, in order: its text and its addNewLine. */
sent: Array<[string, boolean | undefined]>
```

- `facade.ts`: two constants, `'\x1b[5~'` and `'\x1b[6~'`, and `terminal.sendText(sequence, false)` on the terminal
  found as `show` finds it. No other call to `sendText` anywhere in the extension.

- [ ] **Step 1: Write the failing tests** in `facade.test.ts`.

```ts
it('pageKey sends ESC[5~ toward older lines and ESC[6~ toward newer to the terminal with that shell, each with no newline; false for a pid no terminal has', async () => {
  const w = watched()
  const shell = w.vscode.open(); shell.resolve(101)
  const other = w.vscode.open(); other.resolve(202)
  await flush()
  expect([w.facade.pageKey(101, true), w.facade.pageKey(101, false), w.facade.pageKey(303, true)]).toEqual([true, true, false])
  expect(shell.sent).toEqual([['\x1b[5~', false], ['\x1b[6~', false]])
  expect(other.sent).toEqual([])
})

it('nothing but pageKey writes to a terminal', async () => {
  // a terminal with shell 101, active: state(), show(101), raise(), await scrollLine(true), dispose()
  expect(shell.sent).toEqual([])
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/facade.test.ts`. Expected: FAIL
  (`pageKey` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts src/devices/vscodeExtensionBundle.spec.ts`.
  Expected: PASS (the typecheck spec holds `ApiTerminal` to VS Code 1.75's `Terminal`).
- [ ] **Step 5: Commit** `Harness Device for VS Code: the window presses PageUp or PageDown in a terminal`.

### Task 5: Extension: a page line sends page keys

**Depends on:** 4. **Effort:** xhigh.

**Files:**
- Modify: `plugins/harness-device-vscode/src/loop.ts`
- Test: `plugins/harness-device-vscode/src/loop.test.ts`

**Interfaces — Consumes:** `WindowFacade.pageKey`, the fake window's `pageKeys` (Task 4).

**Produces** (in `loop.ts`):

```ts
// The lines one page key stands for: Herdr's SCROLL_PAGE_LINES (cli/src/cable/hosts/herdrApp.ts), where a Claude Code
// page moved 19 lines at 46 rows. A constant of its own: the extension is bundled alone and imports nothing of the CLI.
const PAGE_LINES = 20
// SCROLL_MAX / PAGE_LINES: no more keys run from one line, or from what waits.
const PAGE_KEYS_MAX = 5
// A shell's page remainder is forgotten once no page line came for this long.
const PAGE_IDLE_MS = 1_000
/** Whole lines and page keys for the terminal of the shell `pid`, from `from` scroll lines of the stream. `keys` has a
 *  sign of its own: below zero is PageUp. */
type Scroll = { pid: number; n: number; keys: number; from: number }
```

- **Reading the line:** a scroll line is a page line only when `value.page === true`.
- **The remainder:** `{ pid, lines, at }` or none. A page line starts from 0 when there is none, when it is for another
  pid, or when `inputs.now() - at >= PAGE_IDLE_MS`. It adds the line's count as the loop runs it (`held(n)`), takes
  `keys = Math.trunc(lines / PAGE_LINES)`, keeps the rest and stamps `at`. A scroll line with no `page`, for any shell,
  forgets it.
- **It lives in `follow`, one per stream,** so a stream's end forgets it with no code of its own. No test can tell that
  from the 1 s rule (a stream reopens no sooner than 1 s after it ended, the loop's first backoff), so none is written.
- **The run:** a `Scroll`'s keys first, then its lines. Each key is one `window.pageKey(pid, keys < 0)` under the check
  a line has (`!stopped && window.state().active === pid`), counted `pageKeys` when it answers true; one that answers
  false ends that `Scroll`'s keys.
- **What waits:** for the same pid, `n` and `keys` each add up and are held apart, to ±`SCROLL_MAX` and
  ±`PAGE_KEYS_MAX`. Another pid replaces it as today.
- **`dropped`:** a line is dropped when neither a key nor a line of it ran.
- **The minute's line, exact:**

```
in the last minute: 0 shows, 0 not found, 0 lines skipped, 1 states sent, 0 not sent, 2 page keys, 45 scroll lines, 0 dropped
```

- [ ] **Step 1: Write the failing tests.**

```ts
it('a page line of 45 sends 2 keys and keeps 5; the next page line for that shell adds to them', async () => {
  const win = fakeWindow({ terminals: [101], active: 101 })
  const { w, stream } = await connected(win)
  stream.send('{"scroll":-45,"pid":101,"page":true}\n')
  await w.until(() => win.scrolls.length === 45)
  expect(win.pageKeys).toEqual([{ pid: 101, up: true }, { pid: 101, up: true }])
  stream.send('{"scroll":-15,"pid":101,"page":true}\n')
  await w.until(() => win.scrolls.length === 60)
  expect(win.pageKeys).toHaveLength(3)
})

it('toward newer lines the key is PageDown', …)                       // {"scroll":20,"pid":101,"page":true} → [{ pid: 101, up: false }]
it("a line's keys go before its lines", …)                            // the first scrollLine held: pageKeys already has both keys
it.each([
  ['1 s with no page line', …],                                       // await w.to(1_000)
  ['a page line for another shell', …],                               // {"scroll":-15,"pid":202,"page":true}
  ['a line with no page', …],                                         // {"scroll":-1,"pid":101}
])('the remainder is forgotten after %s', …)                          // -15 page, the event, -15 page: no key
it('999 ms with no page line keeps the remainder', …)                 // -15 page, w.to(999), -15 page: one key
it('a terminal that is not the active one gets no key', …)            // active 202, a page line of -45 for 101: no key, no line, 1 dropped
it.each(['1', '"true"', 'false', 'null'])('a page of %s is no page: its lines run and no key is sent', …)
it('at most 5 keys from one line, and from what waits', …)            // -250 → 100 lines, 5 keys; two page lines of -100 during a held run → one run of 100 lines, 5 keys
it("the minute's line counts the page keys sent", …)                  // the exact line above
it('stop ends a run: what waited sends no key', …)
```

  Every existing exact minute line gains `, 0 page keys` before its `scroll lines`.
- [ ] **Step 2: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src/loop.test.ts`. Expected: FAIL in
  the new cases and the minute lines.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts src/devices/vscodeExtensionBundle.spec.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Harness Device for VS Code: a page line presses Claude Code's page keys beside its lines`.

### Task 6: Adapter: `pageKeys`, and `page` on `scroll`

**Depends on:** 1, 3. **Effort:** high.

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/vscode.ts`
- Test: `cli/src/cable/hosts/vscode.spec.ts`

**Interfaces — Consumes:** `VscodeTerminals.scroll(terminal, lines, page?)` (Task 1), `VscodeTerminals.pageKeys`,
`PageAgent` (Task 3).

**Produces:**

```ts
// HostAdapter
/** Whether the program in the pane takes its own page keys now: Claude Code's fullscreen view keeps no history for its
 *  app to scroll. Asked at a stroke's down, after `canScroll`, only for an agent whose engine has such keys, with
 *  whether it waits on the person, its folder and its transcript path. `false` at once when no key may go and nothing
 *  was read; else a promise, never rejected, settled within the adapter's own deadline. */
pageKeys?(pane: Pane, agent: { asking: boolean; cwd?: string; transcriptPath?: string }): false | Promise<boolean>
/** … `page`: this stroke's `pageKeys` said yes, and the lines may carry those keys too. */
scroll?(pane: Pane, lines: number, page?: boolean): void

// createVscodeAdapter's deps
terminals: Pick<VscodeTerminals, 'terminalOf' | 'show' | 'scroll' | 'pageKeys'>
```

- `pageKeys(pane, agent)`: the tab's pane (no `termPid`) is `false`; a terminal's is
  `deps.terminals.pageKeys(pid, agent)`.
- `scroll(pane, lines, page = false)` passes `page` to `deps.terminals.scroll`.
- Herdr's adapter has no `pageKeys` and ignores `page`: its own guard stays its own.

- [ ] **Step 1: Write the failing tests** (the spec's `recorder()` keeps each scroll's `page` and each `pageKeys` ask).

```ts
it("pageKeys asks the terminals for the pane's own pid, with what the route knows of its agent", async () => {
  // terminals.pageKeys answers Promise.resolve(true) when not asking and false when asking
  const agent = { asking: false, cwd: '/w', transcriptPath: '/t/s1.jsonl' }
  expect(await r.adapter.pageKeys!(pane(), agent)).toBe(true)
  expect(r.adapter.pageKeys!(pane(), { ...agent, asking: true })).toBe(false)
  expect(r.windows.guards).toEqual([{ pid: 4242, agent }, { pid: 4242, agent: { ...agent, asking: true } }])
})
it("pageKeys is false at once for the tab's pane or a term id out of form, and asks nothing", …)   // UUID, 'term:1', 'term:x'
it('scroll passes page on, and lines with none are plain', () => {
  r.adapter.scroll!(pane(), -3, true); r.adapter.scroll!(pane(), -3)
  expect(r.windows.scrolls).toEqual([{ terminal: HELD, lines: -3, page: true }, { terminal: HELD, lines: -3, page: false }])
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/vscode.spec.ts`. Expected: FAIL in the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts && npx tsc --noEmit`.
  Expected: PASS.
- [ ] **Step 5: Commit** `Dial: the VS Code adapter asks whether a terminal's program takes page keys`.

### Task 7: Routing: the stroke's third answer

**Depends on:** 6. **Effort:** xhigh.

**Files:**
- Modify: `cli/src/services/devices.ts`, `cli/src/cable/hosts/observed.ts` (`transcriptOf` only)
- Test: `cli/src/services/devices.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`

**Interfaces — Consumes:** `HostAdapter.pageKeys`, `scroll(pane, lines, page)` (Task 6); `observed.byPane(adapter, id)`
(there today: the live agent at a pane, with its `id`, `engine`, `state` and `cwd`); the spec's `claudeSettings` and
`processGroups` fakes (Task 3).

**Produces** (in `observed.ts`, beside `waitingOn`):

```ts
// ObservedSource
/** The transcript path the agent's latest hook or the scan gave, as given; none when neither gave one. Its user
 *  settings' home for the page guard (claudeRenderer.ts judges the path). */
transcriptOf(agentId: string): string | undefined
```

- **The answer has three values.** `decided(asked, to: 'page' | 'lines' | 'windows')`. `windows` is today's replay and
  its `not on screen` line. `lines` and `page` take the held travel as one `move` and go on as that route. Herdr's
  `onScreen` maps `true` to `lines` and `false` to `windows`: its behavior and its tests do not move.
- **A decided route keeps `page: boolean`.**
- **A stroke is held for the guard only when it can pass.** At a stroke's start, for a target whose adapter has no
  `onScreen`: read the agent at the pane (`observed?.byPane(target.adapter.id, target.pane.id)`). When its engine is
  `claude` and the adapter has `pageKeys`, call `pageKeys(pane, { asking: agent.state === 'needs-you', cwd: agent.cwd,
  transcriptPath: observed.transcriptOf(agent.id) })`:
  - `false` → decided at once as `lines`, as now (Codex and every other engine never reach the call);
  - a promise → the stroke is held as Herdr's is (`{ deciding: target, held }`), and its answer goes to `decided` as
    `page` or `lines`. The adapter settles it within 500 ms (Task 3), so the routing arms no timer of its own.
- **The state is read again each time a page stroke sends lines** (the held travel, a move, the up): once the agent at
  the pane is `needs-you`, `page` is off for the rest of the stroke.
- **A newer `down` drops the older answer** (`stroke !== asked`) and **a stopped devices process writes nothing**, as
  today.
- The comments on `stroke`, `decided` and `routeScroll` say the third answer and why a refused guard is `lines`.

- [ ] **Step 1: Write the failing tests** (beside #4427's stroke cases, with `inVscodeTerminal()`, `shows`, `stroke`;
  and one in `observed.spec.ts`'s `describe('ObservedSource and a waiting prompt')`, beside `waitingOn`'s).

```ts
// observed.spec.ts
it("transcriptOf is the path the agent's latest hook gave, kept when a later hook gives none, and none for an agent it does not list", …)
  // session-start with transcriptPath '/o/home/projects/-work-api/s1.jsonl', then turn-start with none:
  // transcriptOf(agent.id) is that path; transcriptOf('claude:unknown') is undefined

// devices.spec.ts
const page = (n: number) => ({ scroll: n, pid: SHELL, page: true })
const plain = (n: number) => ({ scroll: n, pid: SHELL })

it("Claude Code drawn fullscreen in its terminal's foreground group: the stroke is held for the reads, then its lines carry page", async () => {
  const { core, reported, front } = await inVscodeTerminal()
  const window = await reported(); front('vscode'); shows(ID)
  processGroups.held = true
  host().scrolled('down', 0, 0); host().scrolled('move', 8, 0); host().scrolled('move', 8, 0)
  await vi.waitFor(() => expect(processGroups.reads).toEqual([4242]))
  expect([claudeSettings.reads, window.lines]).toEqual([[['/work/api', '/t/sess-1.jsonl']], []])   // the hook's own
  processGroups.land.shift()!()
  await vi.waitFor(() => expect(window.lines).toEqual([page(-2)]))      // the held travel, as one piece
  host().scrolled('move', 8, 0); host().scrolled('up', 0, 0)
  expect(window.lines).toEqual([page(-2), page(-1)])
  expect(dialScrolls(core)).toEqual([])
})

it("a session in an Orca account home: the renderer read gets the transcript path its hook gave, so that home's settings decide", …)
  // inVscodeTerminal({ transcriptPath: '/o/claude-profiles/acct/home/projects/-work-api/sess-1.jsonl' }); stroke([8]):
  // claudeSettings.reads is [['/work/api', '/o/claude-profiles/acct/home/projects/-work-api/sess-1.jsonl']]
it.each(['Codex', 'an agent that asks at the down'])('%s is decided at once as lines, with nothing read', …)
  // stroke([8, 8, -24]) → [plain(-1), plain(-1), plain(3)] with no await; claudeSettings.reads and processGroups.reads are []
it('settings that do not draw fullscreen: the lines carry no page, and no ps is read', …)
  // claudeSettings.fullscreen = false; stroke([8, 8]) → [plain(-2)]; processGroups.reads is []
it.each<[string, { pgid: number; tpgid: number } | undefined]>([
  ['another group in front', { pgid: 4242, tpgid: 4000 }],
  ['no terminal', { pgid: 4242, tpgid: 0 }],
  ['a failed read', undefined],
])('%s: the lines carry no page, and the windows hear nothing', …)      // stroke([8, 8]) → [plain(-2)]; dialScrolls is []

it('no answer in 500 ms: the held travel goes out as lines, the stroke stays lines, and the late answer changes nothing', …)
  // held; down, 8, 8; advanceTimersByTimeAsync(500) → [plain(-2)]; land; move 8, up → [plain(-2), plain(-1)]
it('a newer down drops the older answer: nothing of the older stroke is written', …)
  // held; down, 8, 8; down, 8; land → [page(-1)]; processGroups.reads is [4242]
it('the answer lands after the up: the whole stroke goes out with page', …)       // stroke([8, 8]) → [page(-2)]
it('needs-you learnt mid-stroke turns the rest of the stroke to lines', …)
  // down, 8; land → [page(-1)]; hook('needs-input') with the same host hints; move 8, up → [page(-1), plain(-1)]
it('an agent that asks by the time the answer lands gets its held travel as lines', …)   // → [plain(-2)]
it('a stroke whose guard passed and whose agent then leaves writes nothing more', …)
  // [page(-1)]; hook('session-end'); move 8, up → still [page(-1)]
it('once the devices began to stop, the answer writes nothing', …)
it("the minute's line counts a page stroke and a refusal for asking", …)
  // one of each, then 60 s: '… 1 page strokes, guard refused: 0 renderer, 1 asking, 0 background, 0 ps, 0 slow'
```

  #4427's stroke cases write a line as each frame comes, on a Claude Code agent. A Claude Code stroke is now held, so
  they keep their assertions on a Codex agent, which is decided at once: `inVscodeTerminal` takes the engine and the
  session-start hook's `transcriptPath`. Its hook carries `cwd: '/work/api'` and `transcriptPath: '/t/sess-1.jsonl'`
  (the spec's `hook()` defaults).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/cable/hosts/observed.spec.ts`.
  Expected: FAIL in the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm run test:core -- --maxWorkers=4 && npx tsc --noEmit`. Expected: PASS,
  `devices.ts` at 100%.
- [ ] **Step 5: Numbers for the pull request** (hot path: a scroll frame): the median of 1 000 `scrolled('move', …)`
  calls on a plain stroke and on a page stroke, on this Mac, before and after.
- [ ] **Step 6: Commit** `Dial: a stroke on Claude Code's fullscreen view in VS Code's terminal carries its page keys`.

### Task 8: End to end: renderer, foreground and background

**Depends on:** 5, 7. **Effort:** xhigh.

**Files:**
- Modify: `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/harness/vscodeWindow.ts`
- Test: `cli/e2e/dialVscode.e2e.ts`

**Interfaces — Consumes:** `MANAGED_SETTINGS` (Task 2), for the case's precondition.

**Produces:**

```ts
// outsideAgent.ts
static async start(d, folder, hints, app?, { shell = false } = {}): Promise<Outside>
/** With `shell`: Ctrl+Z, as a person types it, and the engine leaves its terminal's foreground, a job its shell stopped.
 *  Resolves once `ps -o pgid=,tpgid=` of the engine shows another group in front. */
background(): Promise<void>
// vscodeWindow.ts prints, for each pageKey
{"key":"up"|"down","pid":<pid>}
```

- **The shell in the terminal.** With `shell`, the Python helper's pseudo-terminal runs `/bin/sh -i -c SHELL sh
  <engine>`, as VS Code starts a shell in its terminal: interactive, so it has job control, and the engine is its
  foreground job, in a group of its own that holds the terminal's foreground, so the shell's `tpgid` is the engine's
  `pgid`. `--say` before the command makes the helper's own stderr the child's fd 3, where the shell's job says
  `engine <pid>` before it becomes the engine; the helper prints the shell's pid as it prints its child's today.
  Without `shell` the helper runs exactly as before (seven other end-to-end files use it).
- `background()` types Ctrl+Z into the tab: the fake engine stops its group (SIGTSTP) and the shell takes the terminal
  back. It waits on `ps`, with `until`.
- **Clean-up:** `kill()` sends the engine `SIGCONT` before its `SIGKILL` (a suspended engine is stopped). The shell
  stays after its engine, as a person's does, reading its terminal: `close()` kills it and resolves only once it is
  gone, which is once the helper, its parent, ends with the terminal.
- **The settings** are the session's own project file, `<the engine's folder>/.claude/settings.json`, under the
  daemon's throwaway projects folder. The user file is in the home the fake engine's transcript path names:
  `fakeEngine.mjs` writes it at `<projects>/<slug>/<id>.jsonl` under its `CLAUDE_CONFIG_DIR`, else under the
  daemon's throwaway projects folder. The engine runs with the daemon's isolated environment (`d.env`), whose
  `CLAUDE_CONFIG_DIR`, if set, `assertHooksContained` (`e2e/harness/daemon.ts`) holds inside the test's root. That
  home holds no `settings.json`, and no person's home is read.
- **The case,** `it("a stroke on Claude Code's fullscreen view in its terminal's foreground carries page keys, and none for the default renderer or in the background", …, 300_000)`:
  0. **Precondition:** this platform's `MANAGED_SETTINGS` file, if it exists, has no `tui` (read in the test). Else
     fail at once with a message that names the file: it outranks the test's own.
  1. A in a VS Code terminal, its project file `{"tui":"fullscreen"}`, the window connected, VS Code in
     front, the dial on A, A's shell active.
  2. **Fullscreen, foreground:** `down`, one `move` of `dy: 128` (320 px: 20 lines of 16), `up`. The window prints 20
     `up` scrolls and one `up` key.
  3. **Default renderer:** the project file becomes `{"tui":"default"}`, the same stroke. The window prints 20 more
     scrolls; its keys are still one. The loop sends a line's keys before its lines (Task 5), so the lines printed
     mean no key came.
  4. **Background:** the project file back to `{"tui":"fullscreen"}`, `await a.background()` (Ctrl+Z), the same stroke. 20 more
     scrolls; the keys are still one.
  5. The devices' minute lines, summed (a stroke may fall either side of a minute): 1 page stroke, 1 refused
     `renderer`, 1 refused `background`.
  6. No `vscode` line holds a pid, a window id, the root's path or the word `fullscreen`, as the file's first case
     checks.
  Every wait is a printed line, a log line or `ps`, never a fixed time. Never a real `claude`.
- If step 2 prints no key, compare the pane's pid with the engine's, and the folder the hook reported with the
  engine's, before anything else: stop and report rather than loosen the case.

- [ ] **Step 1: Write the case** and `vscodeWindow.ts`'s line. Commit them red.
- [ ] **Step 2: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts`.
  Expected: FAIL in the new case (`background` is not a function).
- [ ] **Step 3: Implement** the helper's step, `background()` and the clean-up.
- [ ] **Step 4: Run** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts e2e/deviceWithoutApp.e2e.ts`.
  Expected: PASS (`deviceWithoutApp` starts the helper with no `shell`: that path is as it was).
- [ ] **Step 5: Commit** `Dial: a stroke's page keys reach a VS Code terminal only while Claude Code's fullscreen view is in front, end to end`.

### Task 9: Local gate: the key in a real VS Code

**Depends on:** 1, 5. **Effort:** high. A check and its tools, no product behavior: one commit, no red test.

**Files:**
- Modify: `plugins/harness-device-vscode/gate/realVscode.gate.ts`, `plugins/harness-device-vscode/gate/driver/run.cjs`
- Create: `plugins/harness-device-vscode/gate/driver/altScreenApp.cjs`

**Interfaces — Consumes:** `VscodeTerminals.scroll(terminal, lines, page)` (Task 1); the extension's page keys and its
minute line (Task 5).

- **The fake app** (`altScreenApp.cjs`, run as Node by VS Code's own binary): writes
  `\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h` (the alternate screen, mouse tracking in SGR form, bracketed paste),
  sets its stdin raw, and appends each chunk it reads to the file named by its first argument. It runs until killed.
- **The driver:** an ask carries arguments (`{ ask, ...args }`). A new ask, `app`, with `script` and `record`, makes
  `vscode.window.createTerminal({ name: 'app', shellPath: process.execPath, shellArgs: [script, record], env: { ELECTRON_RUN_AS_NODE: '1' } })`
  and answers `{ app: <its processId> }`.
- **The case,** after the scroll case and before the exit's, each wait an `until`:
  1. `ask('app', …)` with `record` under the gate's root (`inside(record)` asserted); its start goes in `shellStarts`
     so the clean-up kills it; wait for a state that lists it.
  2. `streams.show({ window, shell: app }, false)`; wait until the last state's `active` is the app.
  3. `streams.scroll({ window, shell: app }, -45, true)`.
  4. Wait until the extension's minute lines sum to 2 page keys (`MINUTE_LINE` and `scrollCounts` gain the count).
  5. `expect(readFileSync(record)).toEqual(Buffer.from('\x1b[5~\x1b[5~'))`: one PageUp per page and nothing else. No
     `ESC[200~`, so VS Code did not wrap a key as a paste, and no byte from the 45 host scroll commands.
- The gate's `vscodeStreams({ … })` gains `fullscreen: () => Promise.resolve(false)` and
  `foreground: () => Promise.resolve(undefined)` (Task 3's deps): no stroke is guarded here, and nothing of this
  machine is read. The gate is not typechecked, so the lines are harmless if Task 3 has not landed yet.
- **Never:** the gate never starts `claude`.
- **If the record holds anything else, stop and report.** The design then does not hold in VS Code; do not work around
  it in the test.

- [ ] **Step 1: Write** the app, the ask and the case.
- [ ] **Step 2: Run** `cd cli && npm run test:vscode` on this Mac. Expected: PASS, the page case among them; the gate's
  own clean-up leaves no root in `/tmp` and the developer's VS Code preferences as they were (it asserts both).
- [ ] **Step 3: Commit** `Harness Device for VS Code: the gate reads a page key's bytes in a real terminal`.

### Task 10: Docs

**Depends on:** none. **Effort:** medium. One commit, no red test.

**Files:**
- Modify: `cli/AGENTS.md`, `plugins/harness-device-vscode/README.md`

- `cli/AGENTS.md`, the devices row. After "and the dial's scroll scrolls that terminal, line by line, while VS Code is
  in front and the dial shows such an agent", add: "; for Claude Code whose settings say `"tui": "fullscreen"` (that
  key alone, of its managed, project-local, project and user settings files, the user file in the session's own
  Claude Code home as its transcript path names it, each read up to 256 KiB at a stroke's start:
  `cable/hosts/claudeRenderer.ts`), that is its terminal's foreground program (its group is the foreground group of
  the shell VS Code started in that terminal, one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` read a stroke; both
  waited for at most 500 ms) and is not waiting on the person, the extension also presses PageUp or
  PageDown there, one key per 20 lines, which moves Claude Code's fullscreen view".
- `README.md`, "What it does", the Scroll line: "**Scroll** on the dial while VS Code is in front: that terminal
  scrolls, line by line. With `"tui": "fullscreen"` in Claude Code's settings, its view moves a page for each 20
  lines; fullscreen set only by `CLAUDE_CODE_NO_FLICKER=1` scrolls line by line."
- `README.md`, "What it never does", the first line: "It reads nothing from a terminal. It types only the PageUp and
  PageDown keys, and only where Claude Code's fullscreen view is in front and not asking."

- [ ] **Step 1: Write** the three sentences. If #4425's merge reworded the devices row, keep its words and add the
  clause.
- [ ] **Step 2: Commit** `docs: the dial's scroll presses Claude Code's page keys in a VS Code terminal`.

---

## Verification

PR CI runs by itself on the pull request and needs no start. This change selects `cli-typecheck` and `cli-tests` (the
extension's tests among them), the suites that read `cli/`, and `process-checks`.

| # | Check | Where | Isolation | What a person sees |
|---|---|---|---|---|
| 1 | **Unit:** `cd cli && npx vitest run src/cable/hosts src/services/devices.spec.ts ../plugins/harness-device-vscode/src src/devices/vscodeExtensionTypes.spec.ts src/devices/vscodeExtensionBundle.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts && npx tsc --noEmit` | this Mac; PR CI on Linux | fakes only: a fake `ps`, fake settings reads, a fake window, a fake VS Code API; `claudeRenderer.spec.ts` reads files under its own temporary folder | all pass; each behavior's test was committed red before its code |
| 2 | **CLI end to end, the file:** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialVscode.e2e.ts` | this Mac | the repo's own (cli/AGENTS.md rule 6): a daemon under a throwaway root and home on a port of its own (never 18473), a fake dial, the fake engine in a pseudo-terminal under a fake `code`, in a throwaway folder whose `.claude/settings.json` the case writes, the user file in the throwaway Claude home its transcript names; the extension's real loop over a fake window in a process of its own; the real `ps` reads only the test's own processes; the machine's managed settings file is read, and the case fails at once if it sets a `tui`; no VS Code, no `claude` | three cases pass; the new one prints one `up` key for fullscreen in front, and none for the default renderer or after `background()` |
| 3 | **CLI end to end on Linux, the whole suite once at the final head, when the PM gives the turn:** `gh workflow run cli-e2e.yml --ref fix/dial-vscode-claude-fullscreen-scroll` (Actions → CLI end to end → Run workflow). | GitHub, Linux runners | each daemon under a throwaway root, fake dials, fake engines; no `/etc/claude-code` on the runner | every shard green, `e2e/dialVscode.e2e.ts` among them. Linux is where `ps` prints -1, the managed path differs, and the Python job control differs most from a Mac |
| 4 | **The extension in a real VS Code:** `cd cli && npm run test:vscode` | this Mac, in a desktop session (it opens a window) | a VS Code downloaded into a temporary folder, with its own user data, extensions, home and bundle id, all removed at the end; a fake alt-screen app, never `claude`; never the installed VS Code, its settings or `~/.vscode` | a VS Code window opens and closes by itself; every case passes; the record holds exactly `ESC[5~` twice |
| 5 | **Local gates' receipt:** `python3 scripts/local-checks.py --run` from a clean tree at the final commit. The change touches `cli/src/services/*`, so it runs `cli-core` (`npm run test:core`: `devices.ts` at 100%). Its output goes in the pull request body before the push that carries that head. | this Mac | the unit suites' own | one `harness-local-checks` fence, `cli-core` passed |
| 6 | **By a person, after merge. Needs Diego himself** (his Claude Code login, his dial, his eye). Not run by an agent. | Diego's Mac | his own VS Code and Claude Code: a check only he can do | (a) with `"tui": "fullscreen"` in his settings: a stroke moves the transcript a page for each 20 lines, both ways, and text typed in the prompt is unchanged; (b) with that line removed: line by line, as today, and nothing is typed; (c) while Claude Code asks, or at a shell prompt: line scroll only, and nothing is typed; (d) a Claude Code of an Orca account, in a VS Code terminal, with `"tui": "fullscreen"` only in that account's own `settings.json`: pages, as (a) |

**No temporary workflow.** The one long check, the end-to-end suite, has its own workflow, started by hand once when
the PM gives the turn (check 3); the new case then runs in it every night with no further change. The real-VS Code
gate is local: it opens an app window.

No check runs against production: nothing here calls a backend. No check uses an account: checks 1 to 5 need none, and
check 6 is the person's own.

**In the pull request:** the red-then-green commits; checks 1 to 5 with their output or links; Task 7's numbers; the
platforms (macOS and Linux; Windows unchanged); the limit (`CLAUDE_CODE_NO_FLICKER=1` alone scrolls line by line); and
that #4425 merged first.

## Open questions

None. The last one (which home's `settings.json` is the user file) was answered by the PM on 2026-11-18: the session's own
home from its transcript path, else the default home (Decision 17, Tasks 2, 3 and 7).
