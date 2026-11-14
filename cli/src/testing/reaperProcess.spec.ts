import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const REAPER = resolve(import.meta.dirname, '..', '..', 'e2e', 'harness', 'reaperProcess.mjs')

let root = ''
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// The worker's reaper keeps its own copy of rootProcesses.ts's rule: a wrong root would have every process that names it
// SIGKILLed, group and all, and every folder under it made writable and removed.
it('the worker\'s reaper sweeps and removes nothing but a test root', () => {
  root = mkdtempSync(join(tmpdir(), 'reaper-guard-'))
  const notRoots = [join(root, 'not-a-root'), join(root, 'htmux-abc', 'bin')]
  for (const folder of notRoots) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'kept'), '')
  }
  const lines = notRoots.map((folder, i) => `${JSON.stringify({ tmux: join(root, `no-server-${i}`), root: folder })}\n`).join('')
  // Its stdin closing is the worker gone: it reaps and exits.
  const run = spawnSync(process.execPath, [REAPER], { input: lines, encoding: 'utf8', timeout: 20_000 })
  expect(run.status, run.stderr).toBe(0)
  for (const folder of notRoots) {
    expect(existsSync(join(folder, 'kept')), folder).toBe(true)
    expect(run.stderr).toContain(`[e2e reaper] not a test root, left alone: ${folder}`)
  }
})
