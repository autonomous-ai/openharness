import { describe, expect, it } from 'vitest'
import { restoreMissingHerdrPanes } from './herdrRestore.js'

const row = (agentId: string, paneId: string) => ({
  agentId,
  engine: 'omp' as const,
  cwd: '/work',
  runtimes: [{ backend: 'herdr' as const, paneId }],
})

describe('restoreMissingHerdrPanes', () => {
  it('does not create a pane that is still live', async () => {
    const created: string[] = []
    const result = await restoreMissingHerdrPanes({
      rows: [row('live', 'w1:p1'), row('gone', 'w2:p1')],
      livePaneIds: new Set(['w1:p1']),
      create: async (entry) => { created.push(entry.agentId); return { ok: true, paneId: 'w9:p1' } },
      adopt: () => {},
      log: () => {},
    })
    expect(created).toEqual(['gone'])
    expect(result.skipped).toEqual(['live'])
    expect(result.restored).toEqual(['gone'])
  })

  it('creates nothing when the survey failed', async () => {
    const created: string[] = []
    const result = await restoreMissingHerdrPanes({
      rows: [row('live', 'w1:p1')],
      livePaneIds: null,
      create: async () => { created.push('x'); return { ok: true, paneId: 'w9:p1' } },
      adopt: () => {},
      log: () => {},
    })
    expect(created).toEqual([])
    expect(result.restored).toEqual([])
  })

  it('creates nothing when any check failed, even for a pane that looks missing', async () => {
    const created: string[] = []
    const logs: string[] = []
    const result = await restoreMissingHerdrPanes({
      rows: [row('live', 'w1:p1'), row('gone', 'w2:p1')],
      livePaneIds: new Set(['w1:p1']),
      failedChecks: 2,
      create: async (entry) => { created.push(entry.agentId); return { ok: true, paneId: 'w9:p1' } },
      adopt: () => { throw new Error('must not adopt') },
      log: (line) => { logs.push(line) },
    })
    expect(created).toEqual([])
    expect(result.restored).toEqual([])
    expect(result.skipped).toEqual(['live', 'gone'])
    expect(logs).toEqual(['[restore] skipped: 2 checks failed'])
  })

  it('rebuilds only panes this daemon created; a closed pane someone else opened stays closed', async () => {
    const created: string[] = []
    const logs: string[] = []
    const result = await restoreMissingHerdrPanes({
      rows: [row('mine', 'w1:p1'), row('desk', 'wN:p6DB'), row('live', 'w3:p1')],
      livePaneIds: new Set(['w3:p1']),
      owned: (paneId) => paneId === 'w1:p1',
      create: async (entry) => { created.push(entry.agentId); return { ok: true, paneId: 'w9:p1' } },
      adopt: () => {},
      log: (line) => { logs.push(line) },
    })
    expect(created).toEqual(['mine'])
    expect(result.restored).toEqual(['mine'])
    expect(result.skipped).toEqual(['desk', 'live'])
    expect(logs).toContain('[restore] herdr · 1 missing panes not created by this daemon · left closed')
  })
})
