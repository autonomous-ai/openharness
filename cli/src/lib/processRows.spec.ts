import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as table from './processTable.js'
import { launchArgs, processArgs, processLaunchArgs, processRows, type ProcessRow } from './processTable.js'

// The fake binaries below are /bin/sh scripts; their answers, not their speed, are what is tested
// (testing/patientExecWithoutDeadline.ts).
vi.mock('./patientExec.js', async (importOriginal) =>
  (await import('../testing/patientExecWithoutDeadline.js')).withoutDeadline(await importOriginal()))

/**
 * A `ps` on PATH that records every spawn and answers one well-formed row after a short pause — long
 * enough for concurrent callers to pile up behind the first read.
 */
describe('processRows', () => {
  let dir = ''
  let calls = ''
  let previousPath: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ps-coalesce-'))
    calls = join(dir, 'calls')
    writeFileSync(join(dir, 'ps'), `#!/bin/sh
echo x >> "${calls}"
if [ -f "${join(dir, 'fail')}" ]; then exit 1; fi
sleep 0.15
printf '  123     1 claude          Mon Sep 21 10:00:00 2026 claude --resume\\n'
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
  const spawns = (): number => { try { return readFileSync(calls, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }

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
