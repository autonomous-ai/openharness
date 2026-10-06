import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stateIsThere, wakeExperiments } from './experiments.js'

describe('the experiments on as the core starts', () => {
  let dataDir: string
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'experiments-')) })
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

  it('finds saved state by path, or by a file of its kind in its folder', () => {
    expect(stateIsThere(dataDir, ['teams'])).toBe(false)
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    mkdirSync(join(dataDir, 'orchestrator'))
    // A folder made by a look, with no project in it, is not a project.
    writeFileSync(join(dataDir, 'orchestrator', 'notes.txt'), '')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(false)
    writeFileSync(join(dataDir, 'orchestrator', `${'a'.repeat(32)}.json`), '{}')
    expect(stateIsThere(dataDir, ['orchestrator/*.json'])).toBe(true)
    mkdirSync(join(dataDir, 'teams'))
    expect(stateIsThere(dataDir, ['nothing', 'teams'])).toBe(true)
    expect(stateIsThere(dataDir, [])).toBe(false)
  })

  it('asks for each experiment in its own process that has saved state, and for no other', () => {
    mkdirSync(join(dataDir, 'orchestrator'))
    writeFileSync(join(dataDir, 'orchestrator', 'p.json'), '{}')
    writeFileSync(join(dataDir, 'harness-shares.json'), '[]')
    const want = vi.fn()
    const woken = wakeExperiments({
      dataDir,
      experiments: { orchestrator: { state: ['orchestrator/*.json'] }, sharing: { state: ['harness-shares.json'] }, teams: { state: ['teams'] } },
      // Share runs in the core's process here: it is started there, not asked for.
      outOfProcess: new Set(['orchestrator', 'teams']),
      want,
    })
    expect(woken).toEqual(['orchestrator'])
    expect(want.mock.calls).toEqual([['orchestrator']])
  })
})
