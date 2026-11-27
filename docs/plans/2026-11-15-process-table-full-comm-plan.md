# macOS process scan reads the whole program path: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Three tasks, each test-first: a red commit (the
> tests alone), then the code commit. Task 2 starts when Task 1 is done, Task 3 when Task 2 is. Task 1's red commit
> does not typecheck, by design: its Step 2 says what `tsc` prints there. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** On macOS the process scan knows each program's whole path, so Claude Code run by the Claude app (from
`~/Library/Application Support/…`) is matched as Claude Code: its sessions are found after a daemon restart, and
Cmd-P shows a session the app has open as open in an app instead of resuming it a second time. The four provider
helpers that read the program's name themselves read the whole path too.

**Architecture:** `readProcessRows` (`cli/src/lib/processTable.ts`, a file of the core's process) runs a second
`ps -axo pid=,lstart=,comm=` beside the first on macOS and puts the whole `comm` on a row as an ephemeral
`commandPath`, joined on pid and start, only where the row's `executable` is what the table reads of that name's
first 16 bytes. `executable` stays the cut name, the saved identity. One exported function of the same file,
`commandOf(row)`, answers `commandPath ?? executable`: the matcher reads the program through it, and so do the four
provider helpers. `servesOthers` also reads its subcommand after the whole program. Session search's process list
(`listProcesses`, `RunningProcess`) carries the field. No new file, no new process, nothing stored or sent.

**Tech Stack:** TypeScript, Vitest, Node. No new dependency.

**Spec:** [docs/plans/2026-11-15-process-table-full-comm-design.md](2026-11-15-process-table-full-comm-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority; its "Decisions" (PM,
2026-11-15) are fixed: a separate ephemeral `commandPath`; the cut compared in bytes, as the table reads them; the
four provider helpers in scope as a third task; `servesOthers` reading the subcommand after the whole command path;
the hook's matcher a follow-up. No question is open.

**Base:** `e4b1ca94a9` (`origin/main`). No file this plan touches changed since `aad8dcd535`, where its first draft
was rehearsed.

## Global Constraints

- macOS only. The second read is `ps -axo pid=,lstart=,comm=`, started beside the first, through the file's own `run`
  with the same options: `{ timeout: 3000, env: psEnv() }`.
- A row gets `commandPath` only when all of these hold: the second table has the same pid with the same `lstart`;
  the second table's `comm` is longer than the row's `executable`; and
  `Buffer.from(comm).subarray(0, 16).toString().trimEnd() === executable` (PM, 2026-11-15: bytes, not characters,
  which also covers a cut inside a character and a cut that ends in a space).
- `executable` never changes: it is the saved identity, compared with `===` in `nativeControls.ts`,
  `stoppedAgents.ts`, `forget.ts`, `deleteAgentFallback.ts` and `processEvidence.ts`. `commandPath` is never
  persisted and never sent: no registry field, no wire field, nothing in `processIdentityOf`.
- One way to read the program: `commandOf(row)` in `cli/src/lib/processTable.ts`. No reader writes
  `commandPath ?? executable` itself.
- The second read failing (an error, a timeout, a line that does not parse) leaves every row as it is today.
- Linux and Windows are unchanged: one `ps`, no `commandPath`. A row without one reads as before everywhere.
- Nothing reads another process's environment. `src/architecture.environment.spec.ts` reads code: keep
  `KERN_PROCARGS2` and `procargs` out of every string and identifier (a comment is no finding).
- No file is added to the core's process: `cli/src/architecture.coreFiles.txt` does not change.
- Out of scope, from the spec: `processEvidence.ts` keeps reading the cut `comm`; the hook's own table and matcher
  (`cli/hook/notify.mjs`) are a follow-up.
- Fixtures use `/Users/someone/…`, and `/Users/josé/…` (the PM's example) for the non-ASCII row. The cut name is
  `path.slice(0, 16)` where the path is ASCII: `/Users/someone/L`. Nothing of this Mac's paths or names goes in a
  comment, a commit message or the pull request body.
- Tests never read the developer's machine: a fake `ps` on `PATH`, or injected rows, under the suite's throwaway
  folders. The one read of the real `ps` is the script below, by hand.
- Comments say why, in plain sentences, with the spec's measurement (2026-11-15: 667 of 789 rows cut, 127 of them
  from a path with a space; 63 ms for the table, 44 ms for the second read).
- A task runs only the specs it names. No full local suite: PR CI runs it.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS changes; Linux and Windows do not. One pull request; its body names that and carries the red and
  green outputs, the before and after wall time of `processRows()`, and the Verification results.

## Found while reading the code

Checked at `e4b1ca94a9` on this Mac (Apple Silicon, Node v22.23.5 arm64), with all three tasks rehearsed in the
working tree and put back.

- **The cut is 16 bytes, wherever they fall.** `/Users/josé/Library/…` comes back as `/Users/josé/Lib` (15
  characters, 16 bytes). With `comm` last every name comes back whole. A character that straddles byte 16 is cut in
  two and reads back as `U+FFFD` (`/Users/abcdefghé/…` reads `/Users/abcdefgh\uFFFD`), and a cut ending in a space
  loses it in the table's parse (`parseProcessRow` takes `comm` lazily: `/Users/abcdefgh ij/…` reads
  `/Users/abcdefgh`). Checked on five `sleep` processes renamed with `argv0`: the join's expression equals the
  `executable` read for each. No row on this Mac has a non-ASCII `comm`.
- **`comm` is argv[0].** A process renamed at start shows the new name in `comm` and at the start of `args`, so a
  real row's `args` always begins with its `commandPath`. Two things follow for `servesOthers`. Its contract's `args`
  pattern (`/(?:^|\/)codex-acp(?:\s|$)/`) already finds a `codex-acp` under any path, so the red test of its
  `executable` pattern is a row whose `args` does not name the program, as pid 312 of
  `transcriptReads.golden.spec.ts` is. And its arguments can be read after the whole program: today
  `…/Application Support/X/codex app-server` reads `Support/X/codex` as the subcommand.
- **Both tables print `lstart` the same** (`Sun Nov 15 15:41:22 2026`, then padding), so the join compares the
  captured text as it is.
- **Each Claude app session is two processes:** the app's helper
  (`/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- <path> …`) and Claude Code itself, whose `comm`
  reads `/Users/<name>` and whose `args` starts with the whole path. Only the second is Claude Code.
- **The callers of the matcher do not change.** `engines/kit/adoption.ts` (lines 184, 198, 230) and the providers
  hand a `RunningProcess` to `engineProcessMatch`, whose row is a `Pick<ProcessRow, …>`: once the pick names
  `commandPath` and `RunningProcess` has it, they pass it. `npm run typecheck` is clean after Task 1 alone, after
  Tasks 1 and 2, and after all three.
- **The four helpers each read `executable` once,** and each file already imports from `processTable.js`:
  `externals/grok.ts:172` (`isGrok`), `externals/copilot.ts:286` (`copilotProcess`), `externals/cursor.ts:254`
  (`persistent`), `engines/kit/adoption.ts:126` (`servesOthers`). `servesOthers` has no spec of its own: it is
  tested as `codexServer` in `externals/codex.spec.ts`.
- **`listProcesses` (`support.ts:223`) is the one place that rebuilds a row field by field for matching.**
  `processIdentityOf` (`terminalRuntime.ts:106`) and `hermesGatewaysUnder` build saved identities field by field, so
  they never carry it. `lib/tmux.ts:220` builds a diagnostic list and stays as it is. `lib/uninstall/ptyHosts.ts`
  already knows the cut (2026-10-18) and reads its program from `args`; `lib/callerPane.ts` reads a Windows name.
  `cable/hosts/scannedApp.ts` reads a table of its own.
- **On a Mac every real read now spawns two `ps`.** `processRows.spec.ts` "callers that overlap share one ps" counts
  spawns, so it has to count the table's reads. `tmux.paneState.spec.ts` and `tmuxBackend.spec.ts` answer every `ps`
  the same way (an error or an empty table) and stay green.
- **A field sliced out of `ps` output keeps the whole output alive** (`parseProcessRow`'s comment: 13.8 MiB of old
  tables). `commandPath` owns its storage the same way.
- **`withStartTicks` takes the injected platform too.** On a Linux runner a read named `'darwin'` would otherwise
  add `/proc` start ticks to a row whose fake pid happens to exist, and the cases compare whole rows.
- **Rehearsed.** Task 1 red: `Tests  6 failed | 7 passed (13)`; green: `13 passed (13)`; its list: 12 files, 303
  tests. Task 2 red, with Task 1 in: `Tests  2 failed | 46 passed (48)`; green: `48 passed (48)`. Task 3 red, with
  Tasks 1 and 2 in: `Tests  5 failed | 92 passed (97)`; green: `97 passed (97)`. The session-search list with all
  three in: 30 files, 680 tests (so 675 after Task 2). `npm run test:core`: 249 files, 4414 tests, 79 s, no coverage
  error (it runs the specs of `src/core/` and `src/services/` only). From the first rehearsal, not run again: against a read that runs one `ps` after the other, "runs the two
  reads side by side" fails, in 25 s.
- **Measured with the script below.** On a quiet Mac, with the cut walked character by character: before, median
  57.4 ms (640 rows); after, 55.4 to 59.4 ms over three runs (about 650 rows). With the cut as it is now, only a
  busy Mac was to be had (load average 56), runs alternated: before 73 to 107 ms, after 75 to 127 ms (about 700
  rows), which says nothing either way; the cut alone costs 0.24 ms for 700 names. In every "after" run the three
  Claude app processes score 3 (0 before) and 561 to 576 rows have a `commandPath`. The spec's own: 63 ms for the
  table, 44 ms for the second read. Task 1 measures again, on a quiet Mac.
- **The local gate script selects nothing** for this plan's files (`python3 scripts/local-checks.py --list …` prints
  `{}`). The spec asks for `npm run test:core` once anyway: `processTable.ts` is a file of the core's process.
- **PR CI runs the CLI's unit suite on Linux only.** So every macOS case names its platform, or injects its rows.

## The read-only script

Task 1 (Steps 3 and 8) and Verification 3 use it. Save it as `process-rows.mts` in your scratchpad, never inside
the repository. It runs `ps` and nothing else: no daemon, no socket, no engine home. It prints counts and numbers,
never a path.

```ts
const { processRows, engineProcessMatch } = await import(process.argv[2])
const none = { cursorFileKeys: new Set<string>(), grokFileKeys: new Set<string>(), conflictingFileKeys: new Set<string>(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [] }
type Row = { executable: string; args: string; commandPath?: string }
await processRows() // the first spawn pays for the page cache
const times: number[] = []
let rows: Row[] = []
for (let run = 0; run < 30; run++) {
  const start = performance.now()
  rows = (await processRows()) ?? []
  times.push(performance.now() - start)
}
times.sort((a, b) => a - b)
// The program itself, not the app's helper that names it in its arguments.
const app = rows.filter((row) => /^\S*\/Library\/Application Support\/Claude\/claude-code\/\S+\/claude\.app\/Contents\/MacOS\/claude(\s|$)/.test(row.args))
console.log(JSON.stringify({
  rows: rows.length, medianMs: +times[15].toFixed(1), p90Ms: +times[27].toFixed(1), minMs: +times[0].toFixed(1),
  withCommandPath: rows.filter((row) => row.commandPath !== undefined).length,
  claudeApp: app.length,
  claudeAppScores: app.map((row) => engineProcessMatch(row, 'claude', none).score),
  claudeAppWholePath: app.filter((row) => row.commandPath?.endsWith('/claude.app/Contents/MacOS/claude')).length,
}))
```

Run it from `cli/`, under a throwaway home: importing the table loads `config/env.ts`, which looks at the real
`~/.harness`, and can move files in it, when these are unset.

```bash
cd cli && dir=$(mktemp -d) && env HOME="$dir" ADAPTER_DATA_DIR="$dir/data" ADAPTER_RUNTIME_DIR="$dir/runtime" \
  HARNESS_AUTH_DIR="$dir/auth" HARNESS_HOOK_ROUTES_DIR="$dir/hook-routes" \
  node_modules/.bin/tsx <scratchpad>/process-rows.mts "$PWD/src/lib/processTable.ts"; rm -rf "$dir"
```

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/lib/processRows.spec.ts` | the fake `ps` answers both reads; six new cases | 1 |
| `cli/src/lib/processTable.ts` | `commandPath`, `commandOf`, the second read and its join, the matcher reads it | 1 |
| `cli/src/lib/sessionSearch/externals/support.spec.ts` | one case | 2 |
| `cli/src/lib/sessionSearch/indexer.spec.ts` | one case: the Cmd-P test | 2 |
| `cli/src/lib/sessionSearch/externals/types.ts` | `RunningProcess.commandPath` | 2 |
| `cli/src/lib/sessionSearch/externals/support.ts` | `listProcesses` carries it | 2 |
| `cli/src/lib/sessionSearch/externals/grok.spec.ts` | one case | 3 |
| `cli/src/lib/sessionSearch/externals/copilot.spec.ts` | one case | 3 |
| `cli/src/lib/sessionSearch/externals/cursor.spec.ts` | one case | 3 |
| `cli/src/lib/sessionSearch/externals/codex.spec.ts` | two cases (`servesOthers`, as `codexServer`) | 3 |
| `cli/src/lib/sessionSearch/externals/grok.ts` | `isGrok` reads `commandOf(row)` | 3 |
| `cli/src/lib/sessionSearch/externals/copilot.ts` | `copilotProcess` reads `commandOf(row)` | 3 |
| `cli/src/lib/sessionSearch/externals/cursor.ts` | `persistent` reads `commandOf(parent)` | 3 |
| `cli/src/engines/kit/adoption.ts` | `servesOthers` reads `commandOf(row)`, and its subcommand after it | 3 |

## Review Focus

- A pid that went to another process, or a process that ran another program (an `exec` keeps the pid and the start),
  between the two reads: the row must not get the other program's path, or it is matched as an engine it is not.
  Task 1 Step 1, rows 502 and 505. What the rule lets through: an `exec` into a program whose path has the same
  first 16 bytes gets that program's path beside the old `args`, until the next read.
- The second read failing every time, or another `ps` first on `PATH` that prints something else: rows as today,
  never fewer, never null. Task 1 Step 1, "leaves every row as one read gives it…". A timeout reaches the same branch
  as the error it is (`patientExec`), and `patientExec.spec.ts` tests the deadline.
- The two reads run one after the other: every hook's scan then costs both (63 + 44 ms). Task 1 Step 1, "runs the
  two reads side by side".
- A session bound before the update holds the cut name in its saved identity: it must still compare equal. Task 1
  Step 1: `processIdentityOf` gives the cut name, and every row's `executable` is asserted as read.
- A name whose 16 bytes are not 16 characters, and a name that only starts with the row's: Task 1 Step 1, rows 508
  (joined, 15 characters), 510 (cut inside a character, joined), 511 (cut at a space, joined) and 509 (`codex`
  beside `codex --flags`: not joined). And a program that only starts with another's whole path: Task 3 Step 1, the
  last line of the subcommand case.

---

### Task 1: The macOS scan reads the whole command path, and the matcher uses it

**Depends on:** nothing. **Effort:** xhigh (a file of the core's process on the path of every hook; two reads run
side by side and joined against pid reuse).

**Files:**
- Modify: `cli/src/lib/processTable.ts`
- Test: `cli/src/lib/processRows.spec.ts`

**The test that fails before the change:** in `cli/src/lib/processRows.spec.ts`, the two cases of
`the whole command path, where ps cut it` and the four of `readProcessRows on macOS`. Each macOS case names its
platform, so it is red on any runner.

**Interfaces:** produces, from `cli/src/lib/processTable.ts`:
- `ProcessRow.commandPath?: string`
- `commandOf(row: Pick<ProcessRow, 'executable' | 'commandPath'>): string`, exported: `commandPath ?? executable`
- `readProcessRows(os: NodeJS.Platform = process.platform): Promise<ProcessRow[] | null>`, now exported
- `engineProcessMatch`, `engineProcessMatchScore` and `ambiguousAgentProcess` take a row that may carry
  `commandPath` (their `Pick<ProcessRow, …>` names it).

- [ ] **Step 1: Write the failing tests**

In `cli/src/lib/processRows.spec.ts`, replace the two imports from `./processTable.js` and add two:

```ts
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import * as table from './processTable.js'
import { ambiguousAgentProcess, engineProcessMatch, engineProcessMatchScore, launchArgs, processArgs, processLaunchArgs, processRows,
  readProcessRows, type ProcessRow } from './processTable.js'
import { processIdentityOf } from './terminalRuntime.js'
```

Replace the comment above `describe('processRows', …)` and that describe's opening, down to and including its
`spawns` line, with the helper and the new opening. The describe's three cases stay as they are.

```ts
const ROWS = 'pid=,ppid=,comm=,lstart=,args='
const PATHS = 'pid=,lstart=,comm='

/**
 * A `ps` on PATH that records what each spawn asked for. Asked for the table, it answers after a short pause, long
 * enough for concurrent callers to pile up behind the first read: the file `rows`, or one well-formed row. Asked for
 * the whole command paths (macOS's second read), it answers the file `paths`, or nothing. `fail` and `paths-fail`
 * make either exit 1. With `side-by-side`, each waits until the other has started, and fails if it never does.
 */
function fakePs(): { dir: () => string; asked: (format: string) => number } {
  let dir = ''
  let previousPath: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ps-coalesce-'))
    writeFileSync(join(dir, 'ps'), `#!/bin/sh
echo "$2" >> "${join(dir, 'calls')}"
kind=rows; other=paths
if [ "$2" = "${PATHS}" ]; then kind=paths; other=rows; fi
: > "${dir}/started-$kind"
if [ -f "${join(dir, 'side-by-side')}" ]; then
  i=0
  while [ ! -f "${dir}/started-$other" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i+1)); done
  [ -f "${dir}/started-$other" ] || exit 1
fi
if [ "$kind" = paths ]; then
  if [ -f "${join(dir, 'paths-fail')}" ]; then exit 1; fi
  if [ -f "${join(dir, 'paths')}" ]; then cat "${join(dir, 'paths')}"; fi
  exit 0
fi
if [ -f "${join(dir, 'fail')}" ]; then exit 1; fi
sleep 0.15
if [ -f "${join(dir, 'rows')}" ]; then cat "${join(dir, 'rows')}"; else printf '  123     1 claude          Mon Sep 21 10:00:00 2026 claude --resume\\n'; fi
`)
    chmodSync(join(dir, 'ps'), 0o700)
    previousPath = process.env.PATH
    process.env.PATH = `${dir}:${previousPath ?? ''}`
  })
  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir: () => dir,
    asked: (format) => { try { return readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((line) => line === format).length } catch { return 0 } },
  }
}

describe('processRows', () => {
  const ps = fakePs()
  let dir = ''
  beforeEach(() => { dir = ps.dir() })
  // The table's reads alone: on a Mac each read also asks for the whole command paths.
  const spawns = (): number => ps.asked(ROWS)
```

Between that describe and `describe('launchArgs', …)`, add:

```ts
const APP = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.325/485fdac4332e/claude.app/Contents/MacOS/claude'
const NO_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(), agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

// macOS `ps` cuts `comm` to 16 bytes when it is not the last column, and `args` is split at a space: the Claude
// app runs Claude Code from `~/Library/Application Support/…`, so both named a folder and nothing matched (2026-11-15).
describe('the whole command path, where ps cut it', () => {
  it("matches the Claude app's Claude Code by its whole path, which the cut one never did", () => {
    const cut = { executable: APP.slice(0, 16), args: `${APP} --resume x` }
    expect(cut.executable).toBe('/Users/someone/L')
    expect(engineProcessMatch(cut, 'claude', NO_OWNERS).score).toBe(0)
    expect(engineProcessMatch({ ...cut, commandPath: APP }, 'claude', NO_OWNERS)).toEqual({ score: 3, evidence: 'native-or-process-name' })
    expect(engineProcessMatchScore({ ...cut, commandPath: APP }, 'codex', NO_OWNERS)).toBe(0)
    // Claude Code's native install, named only by its version, under a home folder with a space.
    const versioned = '/Users/Some One/.local/share/claude/versions/2.1.246'
    expect(engineProcessMatchScore({ executable: versioned.slice(0, 16), args: versioned }, 'claude', NO_OWNERS)).toBe(0)
    expect(engineProcessMatchScore({ executable: versioned.slice(0, 16), commandPath: versioned, args: versioned }, 'claude', NO_OWNERS)).toBe(3)
    // Antigravity's IDE-side `agy`, renamed to a bare `agy`: its whole path says it is in the app's bundle.
    const ide = '/Applications/Antigravity.app/Contents/Resources/app/bin/agy'
    expect(engineProcessMatchScore({ executable: ide.slice(0, 16), args: 'agy' }, 'agy', NO_OWNERS)).toBe(3)
    expect(engineProcessMatchScore({ executable: ide.slice(0, 16), commandPath: ide, args: 'agy' }, 'agy', NO_OWNERS)).toBe(0)
  })

  it('reads the `agent` alias, and what is not one, from the whole path', () => {
    const agent = '/Users/someone/Library/Application Support/Tools/bin/agent'
    expect(ambiguousAgentProcess({ executable: agent.slice(0, 16), args: agent }, NO_OWNERS)).toBe(false)
    expect(ambiguousAgentProcess({ executable: agent.slice(0, 16), commandPath: agent, args: agent }, NO_OWNERS)).toBe(true)
    // Cursor's own binary, started as `agent`: named by its whole path, it is no unresolved alias.
    const cursor = '/Users/someone/Library/Application Support/Cursor/cursor-agent'
    expect(ambiguousAgentProcess({ executable: cursor.slice(0, 16), args: 'agent' }, NO_OWNERS)).toBe(true)
    expect(ambiguousAgentProcess({ executable: cursor.slice(0, 16), commandPath: cursor, args: 'agent' }, NO_OWNERS)).toBe(false)
  })
})

describe('readProcessRows on macOS', () => {
  const ps = fakePs()
  const START = 'Sun Nov 15 15:41:22 2026'
  const LATER = 'Sun Nov 15 15:49:00 2026'
  const OTHER = '/Users/someone/Library/Application Support/Other/bin/tool'
  // `é` is two bytes: the cut is 16 bytes, 15 characters.
  const ACCENT = '/Users/josé/Library/Application Support/Tools/claude'
  // Byte 16 falls inside `é`: `ps` prints half of it, which reads back as U+FFFD.
  const SPLIT = '/Users/abcdefghé/Library/tool'
  // Byte 16 is the space: the table's parse drops it.
  const SPACE = '/Users/abcdefgh ij/tool'
  const table = [
    `  501     1 /Users/someone/L ${START}     ${APP} --resume x`,
    // Its pid went to another process between the two reads: the second table's start differs.
    `  502     1 /Users/someone/L ${START}     ${OTHER}`,
    // Exactly 16 bytes, and whole.
    `  503     1 /usr/libexec/abc ${START}     /usr/libexec/abc`,
    // Shorter than 16 bytes: never cut, whatever the second table says.
    `  504     1 /sbin/launchd    ${START}     /sbin/launchd`,
    // It ran another program by the second read (an exec keeps the pid and the start).
    `  505     1 /Users/someone/L ${START}     ${OTHER}`,
    // Gone by the second read.
    `  506     1 /Users/someone/L ${START}     ${OTHER}`,
    `  508     1 /Users/josé/Lib ${START}     ${ACCENT} --resume y`,
    // The second table's name only starts with it: its own 16-byte cut is the whole of it, not `codex`.
    `  509     1 codex            ${START}     codex --flags`,
    `  510     1 /Users/abcdefgh\uFFFD ${START}     ${SPLIT}`,
    `  511     1 /Users/abcdefgh  ${START}     ${SPACE}`,
  ].join('\n') + '\n'
  const paths = [
    `  501 ${START}     ${APP}`,
    `  502 ${LATER}     ${OTHER}`,
    `  503 ${START}     /usr/libexec/abc`,
    `  504 ${START}     /sbin/launchd-helper`,
    `  505 ${START}     /opt/homebrew/bin/another-program`,
    // Started after the first read: in no row.
    `  507 ${START}     ${OTHER}`,
    `  508 ${START}     ${ACCENT}`,
    `  509 ${START}     codex --flags`,
    `  510 ${START}     ${SPLIT}`,
    `  511 ${START}     ${SPACE}`,
    'not a row',
  ].join('\n') + '\n'
  const cut = (pid: number, executable: string, args: string): ProcessRow => ({ pid, parentPid: 1, executable, startMarker: START, args })
  const asRead = [
    cut(501, '/Users/someone/L', `${APP} --resume x`), cut(502, '/Users/someone/L', OTHER), cut(503, '/usr/libexec/abc', '/usr/libexec/abc'),
    cut(504, '/sbin/launchd', '/sbin/launchd'), cut(505, '/Users/someone/L', OTHER), cut(506, '/Users/someone/L', OTHER),
    cut(508, '/Users/josé/Lib', `${ACCENT} --resume y`), cut(509, 'codex', 'codex --flags'),
    cut(510, '/Users/abcdefgh\uFFFD', SPLIT), cut(511, '/Users/abcdefgh', SPACE),
  ]
  beforeEach(() => { writeFileSync(join(ps.dir(), 'rows'), table) })

  it("gives a cut command its whole path, so the Claude app's Claude Code is matched, and no other row one", async () => {
    writeFileSync(join(ps.dir(), 'paths'), paths)
    const rows = await readProcessRows('darwin')
    expect(rows).toEqual([{ ...asRead[0], commandPath: APP }, ...asRead.slice(1, 6), { ...asRead[6], commandPath: ACCENT }, asRead[7],
      { ...asRead[8], commandPath: SPLIT }, { ...asRead[9], commandPath: SPACE }])
    expect(engineProcessMatch(rows![0], 'claude', NO_OWNERS).score).toBe(3)
    expect(engineProcessMatch(rows![6], 'claude', NO_OWNERS).score).toBe(3)
    // What is saved of it is the cut name, as before: a session bound before this read still compares equal.
    expect(processIdentityOf(rows![0])).toEqual({ pid: 501, executable: '/Users/someone/L', startMarker: START })
    expect([ps.asked(ROWS), ps.asked(PATHS)]).toEqual([1, 1])
  })

  it('leaves every row as one read gives it when the second read fails, or says nothing that parses', async () => {
    writeFileSync(join(ps.dir(), 'paths'), paths)
    writeFileSync(join(ps.dir(), 'paths-fail'), '')
    expect(await readProcessRows('darwin')).toEqual(asRead)
    rmSync(join(ps.dir(), 'paths-fail'))
    writeFileSync(join(ps.dir(), 'paths'), 'ps: illegal option\n\n')
    expect(await readProcessRows('darwin')).toEqual(asRead)
    // The table itself unread is still "we could not look", whatever the second read said.
    writeFileSync(join(ps.dir(), 'paths'), paths)
    writeFileSync(join(ps.dir(), 'fail'), '')
    expect(await readProcessRows('darwin')).toBeNull()
  })

  it('runs the two reads side by side', async () => {
    writeFileSync(join(ps.dir(), 'paths'), paths)
    writeFileSync(join(ps.dir(), 'side-by-side'), '')
    expect((await readProcessRows('darwin'))?.[0].commandPath).toBe(APP)
  })

  it('reads once everywhere else', async () => {
    writeFileSync(join(ps.dir(), 'paths'), paths)
    const rows = await readProcessRows('linux')
    expect(rows?.map((row) => [row.pid, row.executable, row.commandPath])).toEqual(asRead.map((row) => [row.pid, row.executable, undefined]))
    expect([ps.asked(ROWS), ps.asked(PATHS)]).toEqual([1, 0])
  })
})
```

The cut-name assertions (`score` 0, `false`, `true` without `commandPath`) pass before the change too: they hold
what the cut name alone says. Rows 508 to 511 are the PM's (2026-11-15): a rule that counts characters leaves 508
without its path, one that only asks "starts with" gives 509 one, and one that cuts between characters leaves 510
and 511 without theirs.

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/lib/processRows.spec.ts`
Expected: `Tests  6 failed | 7 passed (13)`. The seven are the file's old cases, on the new fake. The six:

```
AssertionError: expected { score: +0, evidence: 'none' } to deeply equal { score: 3, …(1) }
AssertionError: expected false to be true // Object.is equality
TypeError: readProcessRows is not a function        (four times)
```

Keep the output for the pull request body. `npm run typecheck` is red on this commit, by design: eight errors, all
in `processRows.spec.ts` (`'commandPath' does not exist in type 'Pick<ProcessRow, …>'`, `no exported member named
'readProcessRows'`).

- [ ] **Step 3: Measure before**

The product code is still the base's. Run the read-only script (above) twice.
Expected: `withCommandPath` 0, and `claudeAppScores` all 0 when the Claude app has sessions running. Keep both
lines: `medianMs`, `p90Ms`, `minMs` and `rows` are the pull request's "before".

- [ ] **Step 4: Commit the red tests**

```bash
git add cli/src/lib/processRows.spec.ts
git commit -m "CLI core: specs for the whole command path on macOS (red)"
```

- [ ] **Step 5: Read the whole path, and match on it**

All in `cli/src/lib/processTable.ts`.

1. `ProcessRow` gains the field, after `entrypointFileKey`:

   ```ts
   /**
    * macOS: the whole `comm`, where `executable` is its first 16 bytes. Ephemeral like `imagePath`: never
    * persisted, never sent. `executable` stays the cut one, because it is the saved identity every later read is
    * compared with (`processIdentityOf`).
    */
   commandPath?: string
   ```

2. The one way to read the program, exported, right after the interface. Task 3's helpers call it too:

   ```ts
   /** The program [row] runs, as `ps` names it: its whole path where macOS cut `executable`. */
   export function commandOf(row: Pick<ProcessRow, 'executable' | 'commandPath'>): string
   ```

3. `readProcessRows` is exported and takes the platform:
   `export async function readProcessRows(os: NodeJS.Platform = process.platform): Promise<ProcessRow[] | null>`.
   Both reads start before either is awaited (`Promise.all`); the second starts only when `os === 'darwin'`. The
   table read, its parse and its "nobody in it is a failed read" rule stay as they are. `os` is also
   `withStartTicks`'s third argument (its second stays `processStartTicks`). `processRows()` calls it with no
   argument, as today.

4. The second read is a function of its own in this file, not exported:
   `function readCommandPaths(): Promise<ReadonlyMap<number, { startMarker: string; comm: string }>>`. It runs
   `run('ps', ['-axo', 'pid=,lstart=,comm='], { timeout: 3000, env: psEnv() }, …)` and reads each line with

   ```ts
   /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/
   ```

   (pid, `lstart` in the table's own shape, `comm`). An error gives an empty map; a line that does not match is
   passed over. Its comment:

   ```ts
   /**
    * macOS: each process's whole `comm`, by pid, beside the start it was read with. `ps` cuts `comm` to 16 bytes
    * unless it is the last column, and the table needs `lstart` and `args` after it. Measured on one Mac,
    * 2026-11-15: 667 of 789 rows cut, 127 of them from a path with a space, which `args` splits too. The Claude app
    * runs Claude Code from `~/Library/Application Support/…`: both fields named a folder, and its sessions matched
    * nothing. So a second read, `comm` last, runs beside the first (44 ms beside its 63 ms). Empty when it fails:
    * the rows then stay as the table gave them.
    */
   ```

5. The cut, a function of its own in this file, not exported, with the PM's expression as its body (2026-11-15):

   ```ts
   /**
    * What the table reads of [comm]. macOS `ps` cuts a column that is not the last at 16 bytes, wherever they fall:
    * a character cut in two reads back as U+FFFD, and a cut ending in a space loses it in the parse (measured
    * 2026-11-15: `/Users/abcdefghé/…` reads `/Users/abcdefgh\uFFFD`).
    */
   function cutComm(comm: string): string {
     return Buffer.from(comm).subarray(0, 16).toString().trimEnd()
   }
   ```

6. The join, applied to the rows the read returns (after the zombie filter and the start ticks). A row gets
   `commandPath` only when the map has its pid, that entry's `startMarker` equals the row's, the entry's `comm` is
   longer than `row.executable`, and `cutComm(comm) === row.executable`. Any other row is returned as the same
   object. `commandPath` owns its storage, as `parseProcessRow`'s fields do
   (`Buffer.from(comm, 'utf16le').toString('utf16le')`), for the reason its comment gives.

7. The matcher. `heuristicEngineProcessMatchScore`, `engineProcessMatch`, `engineProcessMatchScore`,
   `ambiguousAgentProcess` and `agentAliasCandidate` add `'commandPath'` to their row's `Pick`. In
   `heuristicEngineProcessMatchScore`, one local, `const command = commandOf(row)`, replaces every read of
   `row.executable` (the program name, the `agy` bundle check, the override comparison and its Linux prefix,
   Command Code's `⌘` test, the versioned install). `ambiguousAgentProcess` and `agentAliasCandidate` read
   `programName(commandOf(row))`.

8. `commTruncatedPrefixOf`'s comment says macOS "prints the full executable path". Make that sentence true: on
   macOS the table's `comm` is its first 16 bytes, and the whole path is `commandPath`.

- [ ] **Step 6: Run the spec, the typecheck and the neighbours**

Run: `cd cli && npx vitest run src/lib/processRows.spec.ts`
Expected: `Tests  13 passed (13)`.

Run: `cd cli && npm run typecheck`
Expected: no error (about 30 s).

Run:

```bash
cd cli && npx vitest run src/lib/processRows.spec.ts src/lib/processRowsMemory.spec.ts src/lib/processArgv.spec.ts \
  src/lib/tmux.spec.ts src/lib/tmux.paneState.spec.ts src/lib/tmuxBackend.spec.ts \
  src/lib/processTable.engineChildren.spec.ts src/lib/processTable.hermesGateway.spec.ts \
  src/lib/windows/engineProcessMatch.spec.ts src/engines/discovery.golden.spec.ts \
  src/architecture.spec.ts src/architecture.environment.spec.ts
```

Expected: `Test Files  12 passed (12)`, about 303 tests.

- [ ] **Step 7: Check the diff is that and nothing else**

Run: `git status --short && git diff --stat`
Expected: `cli/src/lib/processTable.ts` modified, about 69 lines added and 17 removed; nothing else but the untracked
documents under `docs/plans/`.

- [ ] **Step 8: Measure after**

Run the read-only script twice more.
Expected: `medianMs` near Step 3's (the first rehearsal, on a quiet Mac: 55 to 59 ms against 57);
`withCommandPath` in the hundreds;
with Claude app sessions running, `claudeAppScores` all 3 and `claudeAppWholePath` equal to `claudeApp`. A median
more than about 20 ms above Step 3's on a quiet Mac means the reads are not side by side: stop and report. On a
busy Mac (`uptime` shows a load far above the core count) the medians prove nothing: report them with the `uptime`
line and conclude nothing from them. Verification 3 takes the pull request's pair.

- [ ] **Step 9: Commit**

```bash
git add cli/src/lib/processTable.ts
git commit -m "CLI core: the macOS process scan reads the whole command path, so the Claude app's Claude Code is matched"
```

Report both commits, the Step 2 (red) and Step 6 (green) outputs with the commit each ran on, and the Step 3 and
Step 8 lines.

---

### Task 2: Session search's process list carries it, so a session the Claude app has open reads as open

**Depends on:** Task 1 (`ProcessRow.commandPath`, and the matcher reading it). **Effort:** medium (mechanical: one
field and one line, every value given below).

**Files:**
- Modify: `cli/src/lib/sessionSearch/externals/types.ts`
- Modify: `cli/src/lib/sessionSearch/externals/support.ts`
- Test: `cli/src/lib/sessionSearch/externals/support.spec.ts`
- Test: `cli/src/lib/sessionSearch/indexer.spec.ts`

**The test that fails before the change:** `SessionSearchIndex › says a conversation the Claude app has open is open
in an app`, in `cli/src/lib/sessionSearch/indexer.spec.ts` (the Cmd-P test the PM asked for), and
`processes › carries the whole command path where ps cut it, and adds none of its own`, in
`cli/src/lib/sessionSearch/externals/support.spec.ts`.

**Interfaces:** consumes `ProcessRow.commandPath?: string` and the matcher of Task 1. Produces
`RunningProcess.commandPath?: string` (`externals/types.ts`), set by `listProcesses` (`externals/support.ts`), which
Task 3 reads.

- [ ] **Step 1: Write the failing tests**

In `cli/src/lib/sessionSearch/externals/support.spec.ts`, inside `describe('processes', …)`, after "lists no
processes when ps cannot be read…":

```ts
  it('carries the whole command path where ps cut it, and adds none of its own', async () => {
    const app = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.325/485fdac4332e/claude.app/Contents/MacOS/claude'
    const row = { pid: 5, parentPid: 1, executable: app.slice(0, 16), args: app, startMarker: 'Sun Nov 15 15:41:22 2026' }
    const [cut, whole] = await listProcesses(async () => [row, { ...row, pid: 6, commandPath: app }])
    expect(cut).not.toHaveProperty('commandPath')
    expect(whole).toMatchObject({ pid: 6, executable: '/Users/someone/L', commandPath: app })
  })
```

In `cli/src/lib/sessionSearch/indexer.spec.ts`, add `mkdirSync` to the `node:fs` import, and these imports:

```ts
import type { ProcessRow } from '../processTable.js'
import { OpenSessions } from './external.js'
import { claudeProvider } from './externals/claude.js'
import { listProcesses, processView } from './externals/support.js'
```

Then, inside `describe('SessionSearchIndex', …)`, after "indexes a conversation Harness did not start…":

```ts
  // Cmd-P must not resume a conversation the Claude app still has open: two processes would write it. Desktop refuses
  // a hit that is open in an app (swarm_search.dart `sessionUnavailable`), so the daemon has to say so. It did not:
  // macOS `ps` cut the app's Claude Code to `/Users/<name>` and nothing matched it as Claude Code (2026-11-15).
  it('says a conversation the Claude app has open is open in an app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-search-claude-app-'))
    dirs.push(root)
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const path = '/Users/someone/Library/Application Support/Claude/claude-code/2.1.325/485fdac4332e/claude.app/Contents/MacOS/claude'
    const startMarker = 'Sun Nov 15 15:41:22 2026'
    // The row as macOS reads it: `comm` cut at 16 bytes, argv[0] split at the space, the whole path beside them.
    const app: ProcessRow = { pid: 73704, parentPid: 73703, executable: path.slice(0, 16), startMarker,
      args: `${path} --output-format stream-json`, commandPath: path }
    // Claude Code's own record of the session it has open (engines/claude/adoption.ts).
    mkdirSync(join(root, 'sessions'))
    writeFileSync(join(root, 'sessions', '73704.json'), JSON.stringify({ pid: 73704, sessionId, status: 'idle', startedAt: Date.parse(startMarker) + 400 }))
    const transcriptPath = join(root, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, prompt('why does the dial scroll jump', 0) + answer('The delta is doubled.', 1))
    const openSessions = new OpenSessions({
      providers: [claudeProvider({ projectsDir: join(root, 'projects'), home: root })],
      view: () => processView(async () => null, () => true, () => listProcesses(async () => [app])),
      // The app's process has no terminal, and is in no pane of Harness's.
      ttys: async (pids) => new Map(pids.map((pid) => [pid, null])),
      harnessTtys: async () => new Set(),
    })
    const store = SessionSearchStore.open(':memory:')!
    const index = new SessionSearchIndex({
      store, agents: () => [], openSessions,
      sources: () => [{ agentId: '', sessionId, engine: 'claude', transcriptPath, header: '', changedAt: 1,
        external: { cwd: '/work/dial', origin: 'claude-app', title: '' } }],
    })
    cleanups.push(() => { index.stop(); store.close() })
    index.sweep()
    await vi.waitFor(() => { expect((index as unknown as { running: boolean }).running).toBe(false) })
    // A search never waits for a process table: it reads the last look.
    await openSessions.fresh()
    expect(index.search('dial scroll').hits[0]).toMatchObject({ sessionId, agentId: '', external: { origin: 'claude-app', open: true, openIn: 'app' } })
  })
```

It runs the real chain: `listProcesses`, the Claude adoption provider (`engines/kit/adoption.ts` through
`externals/claude.ts`), `OpenSessions` and `SessionSearchIndex.search`. Only the process table, the terminals and the
folders are the test's own.

- [ ] **Step 2: Run them and see them fail**

Run: `cd cli && npx vitest run src/lib/sessionSearch/externals/support.spec.ts src/lib/sessionSearch/indexer.spec.ts`
Expected: `Tests  2 failed | 46 passed (48)`:

```
AssertionError: expected { …(11) } to match object { …(3) }
-     "open": true,
-     "openIn": "app",
+     "open": false,
AssertionError: expected { pid: 6, ppid: 1, …(4) } to match object { pid: 6, …(2) }
```

Keep the output for the pull request body. `npm run typecheck` is clean on this commit.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/sessionSearch/externals/support.spec.ts cli/src/lib/sessionSearch/indexer.spec.ts
git commit -m "CLI search: specs for a session the Claude app has open (red)"
```

- [ ] **Step 4: Carry the field**

In `cli/src/lib/sessionSearch/externals/types.ts`, `RunningProcess` gains, after `executable`:

```ts
  /** macOS: the whole `comm`, where `executable` is its first 16 bytes (lib/processTable.ts `commandPath`). */
  commandPath?: string
```

In `cli/src/lib/sessionSearch/externals/support.ts`, `listProcesses` adds the key to the row it builds only when the
process row has it (a conditional spread, like `started`), so a row without one keeps today's exact shape. Nothing
else changes: `engines/kit/adoption.ts` and the providers already hand the row to `engineProcessMatch`. The four
helpers that read `row.executable` themselves are Task 3's.

- [ ] **Step 5: Run the specs, the typecheck and the neighbours**

Run: `cd cli && npx vitest run src/lib/sessionSearch/externals/support.spec.ts src/lib/sessionSearch/indexer.spec.ts`
Expected: `Tests  48 passed (48)`.

Run: `cd cli && npm run typecheck`
Expected: no error.

Run:

```bash
cd cli && npx vitest run src/lib/sessionSearch src/engines/transcriptReads.golden.spec.ts \
  src/services/externalSessions.spec.ts src/services/devices.spec.ts src/architecture.spec.ts
```

Expected: `Test Files  30 passed (30)`, about 675 tests.

- [ ] **Step 6: Check the diff is that and nothing else**

Run: `git status --short && git diff --stat`
Expected: `types.ts` 2 lines added, `support.ts` 1 line added; nothing else but the untracked documents.

- [ ] **Step 7: Commit**

```bash
git add cli/src/lib/sessionSearch/externals/types.ts cli/src/lib/sessionSearch/externals/support.ts
git commit -m "CLI search: the process list carries the whole command path, so a session the Claude app has open reads as open"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

### Task 3: The four provider helpers read the whole command path

**Depends on:** Task 1 (`commandOf`) and Task 2 (`RunningProcess.commandPath`: without it this task's rows do not
typecheck). **Effort:** medium (one call in each of four helpers and a few lines in `servesOthers`, every test
given below).

**Files:**
- Modify: `cli/src/lib/sessionSearch/externals/grok.ts` (`isGrok`)
- Modify: `cli/src/lib/sessionSearch/externals/copilot.ts` (`copilotProcess`)
- Modify: `cli/src/lib/sessionSearch/externals/cursor.ts` (`persistent`)
- Modify: `cli/src/engines/kit/adoption.ts` (`servesOthers`)
- Test: `cli/src/lib/sessionSearch/externals/grok.spec.ts`
- Test: `cli/src/lib/sessionSearch/externals/copilot.spec.ts`
- Test: `cli/src/lib/sessionSearch/externals/cursor.spec.ts`
- Test: `cli/src/lib/sessionSearch/externals/codex.spec.ts` (`servesOthers` is tested there, as `codexServer`)

**The test that fails before the change:** one for each helper, each in its existing spec file, and one more for
`servesOthers`'s subcommand:
- `grok.spec.ts`, in `grokProvider.owners`: "knows a Grok that runs as `agent` under a folder with a space, by its
  whole path"
- `copilot.spec.ts`, in `copilotProvider.owners`: "knows an editor's runtime under a folder with a space, by its
  whole path"
- `cursor.spec.ts`, in `cursorProvider.owners`: "knows Cursor's tmux server under a folder with a space, by its
  whole path"
- `codex.spec.ts`, in `codexProvider`: "knows an editor's `codex-acp` by its whole path, where ps cut its name"
- `codex.spec.ts`, in `codexProvider`: "knows Codex's server under a folder with a space, by what follows its whole
  path"

**Interfaces:** consumes `commandOf(row: Pick<ProcessRow, 'executable' | 'commandPath'>): string` from
`cli/src/lib/processTable.ts` (Task 1) and `RunningProcess.commandPath?: string` (Task 2). Produces nothing a later
task uses.

- [ ] **Step 1: Write the failing tests**

Each first assertion holds what the cut name alone says, and passes before the change too.

In `cli/src/lib/sessionSearch/externals/grok.spec.ts`, after "knows a Grok that runs as `agent`, the name it shares
with Cursor":

```ts
  // macOS `ps` cuts `comm` at 16 bytes and `args` is split at a space: under such a folder neither says `agent`.
  it('knows a Grok that runs as `agent` under a folder with a space, by its whole path', async () => {
    const root = home()
    session(root, ID)
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([{ session_id: ID, pid: 51, cwd: '/work/app' }]))
    const path = '/Users/someone/Library/Application Support/Grok/bin/agent'
    const cut: RunningProcess = { pid: 51, ppid: 1, executable: path.slice(0, 16), args: path }
    expect(await grokProvider({ home: root }).owners!(view([cut]))).toEqual([])
    const claims = await grokProvider({ home: root }).owners!(view([{ ...cut, commandPath: path }]))
    expect(claims.map((claim) => claim.pid)).toEqual([51])
  })
```

In `cli/src/lib/sessionSearch/externals/copilot.spec.ts`, after "never offers to stop an editor's runtime or a
Copilot serving other programs":

```ts
  // macOS `ps` cuts `comm` at 16 bytes and `args` is split at a space: under such a folder neither says `copilot-runtime`.
  it("knows an editor's runtime under a folder with a space, by its whole path", async () => {
    const root = home()
    session(root, ID)
    lock(root, ID, 24, 1_700_000_000)
    const path = '/Users/someone/Library/Application Support/Code/copilot/sdk/runtime/copilot-runtime'
    const cut: RunningProcess = { pid: 24, ppid: 1, executable: path.slice(0, 16), args: `${path} --headless --stdio` }
    expect(await copilotProvider({ home: root }).owners!(view([cut]))).toEqual([])
    const claims = await copilotProvider({ home: root }).owners!(view([{ ...cut, commandPath: path }]))
    expect(claims.map((claim) => [claim.pid, claim.app ?? false])).toEqual([[24, true]])
  })
```

In `cli/src/lib/sessionSearch/externals/cursor.spec.ts`, after "never offers to stop a chat in Cursor's own tmux
server":

```ts
  // macOS `ps` cuts `comm` at 16 bytes and `args` is split at a space: under such a folder neither says `tmux`.
  it("knows Cursor's tmux server under a folder with a space, by its whole path", async () => {
    const { config, provider } = roots()
    chat(config, CWD, ID)
    const tmux = '/Users/someone/Library/Application Support/Tools/bin/tmux'
    const cut: RunningProcess = { pid: 15, ppid: 1, executable: tmux.slice(0, 16), args: `${tmux} -L cursor-agent new-session -d` }
    const app = async (server: RunningProcess) =>
      (await provider().owners!(view([server, cursorRow(84, `--resume ${ID}`, 15)]).processes)).map((claim) => claim.app ?? false)
    expect(await app(cut)).toEqual([false])
    expect(await app({ ...cut, commandPath: tmux })).toEqual([true])
  })
```

In `cli/src/lib/sessionSearch/externals/codex.spec.ts`, after "tells Codex's servers from a person's Codex":

```ts
  // macOS `ps` cuts `comm` at 16 bytes: the cut name of a `codex-acp` under a long path does not end in it.
  it("knows an editor's `codex-acp` by its whole path, where ps cut its name", () => {
    const path = '/Users/someone/Library/Application Support/Zed/external_agents/codex-acp'
    const cut = { pid: 1, ppid: 0, executable: path.slice(0, 16), args: 'codex-acp-wrapper --stdio' }
    expect(codexServer(cut)).toBe(false)
    expect(codexServer({ ...cut, commandPath: path })).toBe(true)
  })
```

That row's `args` does not name the program, as pid 312 of `transcriptReads.golden.spec.ts` does not: with `args`
starting with the same path the contract's `args` pattern already answers, before and after. Right after it, the
subcommand (PM, 2026-11-15):

```ts
  // `args` is split at a space: under such a folder the subcommand read was a piece of the path, and Codex's server
  // was taken for a person's Codex.
  it("knows Codex's server under a folder with a space, by what follows its whole path", () => {
    const path = '/Users/someone/Library/Application Support/X/codex'
    const row = (args: string, commandPath?: string) => ({ pid: 1, ppid: 0, executable: path.slice(0, 16), args, ...(commandPath ? { commandPath } : {}) })
    expect(codexServer(row(`${path} app-server --listen stdio`))).toBe(false)
    expect(codexServer(row(`${path} app-server --listen stdio`, path))).toBe(true)
    expect(codexServer(row(`${path} --verbose mcp`, path))).toBe(true)
    // A person's Codex there is still one.
    expect(codexServer(row(path, path))).toBe(false)
    expect(codexServer(row(`${path} resume 01a0`, path))).toBe(false)
    expect(codexServer(row(`${path} "run the mcp tests"`, path))).toBe(false)
    // A program that only starts with the same text is read as before.
    expect(codexServer(row(`${path}-helper mcp`, path))).toBe(false)
  })
```

- [ ] **Step 2: Run them and see them fail**

Run:

```bash
cd cli && npx vitest run src/lib/sessionSearch/externals/grok.spec.ts src/lib/sessionSearch/externals/copilot.spec.ts \
  src/lib/sessionSearch/externals/cursor.spec.ts src/lib/sessionSearch/externals/codex.spec.ts
```

Expected: `Tests  5 failed | 92 passed (97)`:

```
AssertionError: expected false to be true // Object.is equality        (codex.spec.ts, twice)
AssertionError: expected [] to deeply equal [ [ 24, true ] ]            (copilot.spec.ts)
AssertionError: expected [ false ] to deeply equal [ true ]             (cursor.spec.ts)
AssertionError: expected [] to deeply equal [ 51 ]                      (grok.spec.ts)
```

Keep the output for the pull request body. `npm run typecheck` is clean on this commit.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/sessionSearch/externals/grok.spec.ts cli/src/lib/sessionSearch/externals/copilot.spec.ts \
  cli/src/lib/sessionSearch/externals/cursor.spec.ts cli/src/lib/sessionSearch/externals/codex.spec.ts
git commit -m "CLI search: specs for a program under a long path in the four provider helpers (red)"
```

- [ ] **Step 4: Read the program through `commandOf`, and `servesOthers`'s subcommand after it**

Each file adds `commandOf` to the import it already has from `processTable.js`, and one call replaces the one read
of `executable`. The `args` fallback beside each stays as it is.

- `externals/grok.ts` `isGrok`: `basename(commandOf(row))` in place of `basename(row.executable)`.
- `externals/copilot.ts` `copilotProcess`: `commandOf(row)` in place of `row.executable` in the `runtime` test.
- `externals/cursor.ts` `persistent`: `basename(commandOf(parent))` in place of `basename(parent.executable)`.
- `engines/kit/adoption.ts` `servesOthers`: `servers.executable.test(commandOf(row))`. Then its arguments: where
  `row.args` starts with `commandOf(row)` and what follows is nothing or begins with whitespace, the arguments are
  `argvTokens` of what follows; anywhere else they are `argvTokens(row.args).slice(1)`, as today. The subcommand is
  the first of them that is not an option, as today. A comment above says why: `args` is split at a space, so under
  `…/Application Support/…` its second word is a piece of the path.

The three other helpers' comments do not change: each says what it decides, and `commandOf`'s says why the path is
whole. A row without `commandPath` whose `args` starts with its `executable` reads the same arguments as before, so
every old case of "tells Codex's servers from a person's Codex" holds.

- [ ] **Step 5: Run the specs, the typecheck and the neighbours**

Run: Step 2's command.
Expected: `Tests  97 passed (97)`.

Run: `cd cli && npm run typecheck`
Expected: no error.

Run:

```bash
cd cli && npx vitest run src/lib/sessionSearch src/engines/transcriptReads.golden.spec.ts \
  src/services/externalSessions.spec.ts src/services/devices.spec.ts src/architecture.spec.ts
```

Expected: `Test Files  30 passed (30)`, about 680 tests. The golden file of `transcriptReads.golden.spec.ts` does not
change: its rows carry no `commandPath`, and their arguments read as before.

- [ ] **Step 6: Check the diff is that and nothing else**

Run: `git status --short && git diff --stat`
Expected: the four product files: 2 lines added and 2 removed in each provider, about 8 added and 3 removed in
`adoption.ts`; nothing else but the untracked documents.

- [ ] **Step 7: Commit**

```bash
git add cli/src/lib/sessionSearch/externals/grok.ts cli/src/lib/sessionSearch/externals/copilot.ts \
  cli/src/lib/sessionSearch/externals/cursor.ts cli/src/engines/kit/adoption.ts
git commit -m "CLI search: Grok, Copilot, Cursor's tmux and Codex's servers are known by their whole command path"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

## Left out

- The hook's own table and matcher (`cli/hook/notify.mjs` `processRows`, `processMatchScore`): a follow-up item of
  its own (PM, 2026-11-15; the spec's "Out of scope"). It is a standalone script in the engine's hook process, and a
  hook already brings the Claude app's sessions back.
- Other code that reads a process's arguments from `args` (`resumeSessionId`, `namedSession`, Grok's `shared`): not
  examined for a program path with a space; the spec names `servesOthers` alone.
- `processEvidence.ts`: the spec keeps it on the cut `comm`.
- A log line or a measure for a failed second read: the spec gives none, and the first read has none either (null is
  its failure).
- `lib/tmux.ts:220`, the list of a pane's processes shown when a launch fails: it prints the cut name as before.
- A new end-to-end file: see Verification.

## Verification

All on the final head, after the review, on this Mac: macOS is the only platform the change runs on, and no workflow
runs the CLI's unit suite on macOS. Isolation is the repo's own (`cli/AGENTS.md`, rule 6): the specs run under the
suite's throwaway home, data and runtime folders (`cli/vitest.setup.ts`), with a fake `ps` on `PATH` or injected
rows. Check 3 reads the real `ps`, under a throwaway home of its own. Nothing connects to the developer's daemon
(port 18473) or reads `~/.harness`, `~/.claude` or `~/.codex`. No account, sign-in, backend or device, nothing of
production, and none of it needs Diego himself.

1. **The specs and the typecheck, on macOS.** Here the real reads in these files spawn both `ps`.

   ```bash
   cd cli && npm run typecheck && npx vitest run src/lib/processRows.spec.ts src/lib/processRowsMemory.spec.ts \
     src/lib/processArgv.spec.ts src/lib/tmux.spec.ts src/lib/tmux.paneState.spec.ts src/lib/tmuxBackend.spec.ts \
     src/lib/processTable.engineChildren.spec.ts src/lib/processTable.hermesGateway.spec.ts \
     src/lib/windows/engineProcessMatch.spec.ts src/engines/discovery.golden.spec.ts src/architecture.spec.ts \
     src/architecture.environment.spec.ts src/lib/sessionSearch src/engines/transcriptReads.golden.spec.ts \
     src/services/externalSessions.spec.ts src/services/devices.spec.ts
   ```

   To see: no type error; `Test Files  41 passed (41)`, about 960 tests, none skipped among the thirteen new cases
   (about a minute).

2. **The core gate, once, by hand.** PR CI does not run it, and `scripts/local-checks.py` selects it only for
   `cli/src/core/` and `cli/src/services/`; the spec asks for it because `processTable.ts` runs in the core.

   ```bash
   cd cli && npm run test:core
   ```

   To see: about `Test Files  249 passed (249)` and `Tests  4414 passed (4414)`, no `ERROR: Coverage for …` line,
   exit 0, in one to three minutes. The script writes no receipt for these paths, so put the command, the two
   summary lines and `macos` in the pull request body as plain text, never as a fence written by hand.

3. **The real `ps` on this Mac, read-only.** The read-only script, run twice as its section says.

   To see, with sessions of the Claude app running (three on 2026-11-15): `claudeAppScores` all 3 and
   `claudeAppWholePath` equal to `claudeApp`; `withCommandPath` in the hundreds (about 565 of 700 in the rehearsal).
   With `claudeApp` 0, no such session is running: report the match as unverified, never as passed, and do not
   start the app.

   The pull request's before and after, taken as a pair on a quiet Mac (`uptime`: a load below the core count; with
   a load of 56 the rehearsal's medians ran from 73 to 127 ms and overlapped). The base's table is read from a copy
   that is deleted again, and the script runs against each in turn, three times:

   ```bash
   cd cli && git show e4b1ca94a9:cli/src/lib/processTable.ts > src/lib/zzBaseProcessTable.ts
   # the script's command with "$PWD/src/lib/zzBaseProcessTable.ts" (before), then "$PWD/src/lib/processTable.ts" (after), three times
   rm src/lib/zzBaseProcessTable.ts && git status --short
   ```

   To see: the "after" medians within about 20 ms of the "before" ones, and `git status --short` showing nothing of
   `cli/`. If no quiet moment comes, record the runs with their `uptime` line and say the cost is unmeasured.

On GitHub nothing is started by hand. PR CI runs by itself what a `cli/` change selects: `cli-typecheck` and
`cli-tests` (Linux, four shards), where the macOS cases run by naming their platform and the providers' cases by
injecting their rows. To see: `ci/required` green.

**End to end:** none beyond these. What the specs fake is macOS's own `ps`, and check 3 reads the real one. A daemon
level test would need a stand-in Claude app (a program under a folder with a space, with its session record) and
could run only on macOS, where the end-to-end workflow has one narrow job. `cli-e2e.yml` and `windows.yml` are not
run: no end-to-end file changes, and Linux and Windows read one `ps` as before.

**Temporary workflow:** none. No check is long, and all three are about macOS.

**Not checked, and said so in the pull request:** an Intel Mac and another macOS version (this Mac only), and a
real Grok, Copilot runtime, tmux, `codex-acp` or Codex server installed under a folder with a space (Task 3's specs
inject those rows; none was looked for on this Mac).
