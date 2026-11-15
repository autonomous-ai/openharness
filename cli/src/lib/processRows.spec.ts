import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import * as table from './processTable.js'
import { ambiguousAgentProcess, engineProcessMatch, engineProcessMatchScore, launchArgs, processArgs, processLaunchArgs, processRows,
  readProcessRows, type ProcessRow } from './processTable.js'
import { processIdentityOf } from './terminalRuntime.js'

// The fake binaries below are /bin/sh scripts; their answers, not their speed, are what is tested
// (testing/patientExecWithoutDeadline.ts).
vi.mock('./patientExec.js', async (importOriginal) =>
  (await import('../testing/patientExecWithoutDeadline.js')).withoutDeadline(await importOriginal()))

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

  it('reads one process\'s command line, and none for a process it is not, or when ps fails', async () => {
    const [row] = (await processRows())!
    const differentProcess = {
      ...row,
      startMarker: 'another start',
      startTicks: row.startTicks === undefined ? undefined : row.startTicks + 1,
    }
    expect(await processArgs(row)).toBe('claude --resume')
    expect(await processArgs(differentProcess)).toBe('')
    // How it was launched is its own command line, when it still has one.
    expect(await processLaunchArgs(row)).toBe('claude --resume')
    expect(await processLaunchArgs(differentProcess)).toBe('')
    writeFileSync(join(dir, 'fail'), '')
    expect(await processArgs(row)).toBe('')
    expect(await processLaunchArgs(row)).toBe('')
  })

  // The first reconcile pass after a boot attaches a few agents at once, and each validates its pane
  // against the table; a hook burst does the same. One `ps` for the burst, not one per caller.
  it('callers that overlap share one ps, callers that follow get a fresh one', async () => {
    const burst = await Promise.all([processRows(), processRows(), processRows(), processRows(), processRows()])
    expect(spawns()).toBe(1)
    for (const rows of burst) expect(rows?.map((row) => row.pid)).toEqual([123])
    // Identity, not just equality: nobody was handed a copy of a table read for someone else earlier.
    expect(new Set(burst).size).toBe(1)
    const later = await processRows()
    expect(spawns()).toBe(2)
    expect(later?.map((row) => row.pid)).toEqual([123])
  })

  it('a failed read is not remembered', async () => {
    writeFileSync(join(dir, 'fail'), '')
    expect(await processRows()).toBeNull()
    rmSync(join(dir, 'fail'))
    expect((await processRows())?.length).toBe(1)
    expect(spawns()).toBe(2)
  })
})

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

describe('launchArgs', () => {
  const row = (pid: number, parentPid: number, args: string): ProcessRow =>
    ({ pid, parentPid, args, executable: args.split(' ')[0], startMarker: 'start' })
  const LAUNCHER = "/bin/zsh -lic . '/d/launch/1.sh' harness-engine /w /n/bin/pi --session s --model grid/m -e /c/grid-provider.ts"

  it('is the engine\'s own command line whenever it still has one', () => {
    const claude = row(2, 1, 'claude --resume x')
    expect(launchArgs([row(1, 0, LAUNCHER), claude], claude)).toBe('claude --resume x')
  })

  it("reads a renamed Pi's launch from the launcher this daemon started it under, and nothing else", () => {
    // Pi renames its process: `ps` shows `pi` and none of what it was launched with (2026-10-14).
    const pi = row(2, 1, 'pi       ')
    expect(launchArgs([row(1, 0, LAUNCHER), pi], pi)).toBe(LAUNCHER)
    // Without a cwd the binary is the next word.
    const bare = "/bin/zsh -lic . '/d/launch/1.sh' harness-engine /n/bin/pi --model grid/m"
    expect(launchArgs([row(1, 0, bare), pi], pi)).toBe(bare)
    // A parent that is not that launcher, launches another engine, or is not in the table says nothing.
    expect(launchArgs([row(1, 0, '/bin/zsh -l'), pi], pi)).toBe('')
    expect(launchArgs([row(1, 0, "/bin/zsh -lic . '/d/1.sh' harness-engine /w /n/bin/codex resume x"), pi], pi)).toBe('')
    expect(launchArgs([row(3, 0, LAUNCHER), pi], pi)).toBe('')
    expect(launchArgs([row(1, 0, LAUNCHER), row(2, 1, '')], row(2, 1, ''))).toBe('')
  })
})

describe('processTable module', () => {
  it('owns the process table API', () => {
    for (const name of ['processRows', 'parseProcessRow', 'argvTokens', 'engineProcessMatch',
      'resumeSessionId', 'selectEngineProcess', 'setProcessTableSource'] as const) {
      expect(typeof table[name]).toBe('function')
    }
  })

  it('reads through an injected source', async () => {
    const row = { pid: 7, parentPid: 1, executable: 'x', startMarker: 'w:1', args: 'x' }
    table.setProcessTableSource(async () => [row])
    try {
      expect(await table.processRows()).toEqual([row])
    } finally {
      table.setProcessTableSource(null)
    }
  })
})
