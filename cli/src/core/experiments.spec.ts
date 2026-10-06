import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountNotices, createExperimentHooks, stateIsThere, wakeExperiments } from './experiments.js'

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

  it('hands the account\'s notices to each listener here, guarded, and to the experiments\' processes', () => {
    const tell = vi.fn()
    const log = vi.fn()
    const notices = createAccountNotices(tell, log)
    const heard = vi.fn()
    const stop = notices.onNotice(heard)
    notices.onNotice(() => { throw new Error('boom') })
    notices.onNotice(() => { throw 'odd' })
    notices.notice({ type: 'desk_changed', revision: 3 })
    stop()
    notices.notice({ type: 'desk_changed', revision: 4 })
    expect(heard.mock.calls).toEqual([[{ type: 'desk_changed', revision: 3 }]])
    expect(tell).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('odd'))
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const notices = createAccountNotices(() => {})
      notices.onNotice(() => { throw new Error('boom') })
      notices.notice({ type: 'desk_changed', revision: 1 })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    } finally {
      warn.mockRestore()
    }
  })

  it('asks for an experiment after doing what it must not miss, and tells each experiment in its own process the account\'s notices', () => {
    const order: string[] = []
    const notify = vi.fn(() => true)
    const hooks = createExperimentHooks({
      want: (service) => order.push(`want ${service}`), notify, outOfProcess: new Set(['collaboration']), experiments: ['orchestrator', 'collaboration'],
      onWant: { collaboration: () => order.push('keep the scopes') },
    })
    hooks.want('collaboration')
    hooks.want('orchestrator')
    expect(order).toEqual(['keep the scopes', 'want collaboration', 'want orchestrator'])
    const heard = vi.fn()
    hooks.onNotice(heard)
    hooks.notice({ type: 'desk_changed', revision: 5 })
    expect(heard).toHaveBeenCalledWith({ type: 'desk_changed', revision: 5 })
    expect(notify.mock.calls).toEqual([['collaboration', { type: 'service_event', payload: { kind: 'notice', notice: { type: 'desk_changed', revision: 5 } } }]])
    createExperimentHooks({ want: vi.fn(), notify, outOfProcess: new Set(), experiments: [] }).want('x')
  })
})
