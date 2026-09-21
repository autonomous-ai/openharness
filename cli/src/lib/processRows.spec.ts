import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { processRows } from './tmux.js'

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
