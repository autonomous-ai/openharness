import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createViewersWake, VIEWER_LEDGER, VIEWERS_ON_DEMAND, wakeViewers } from './viewersWake.js'

describe('when the viewers\' process is asked for', () => {
  const setup = (outOfProcess: string[] = ['viewers', 'store']) => {
    const want = vi.fn()
    const log = vi.fn()
    const wake = createViewersWake({ want, outOfProcess: new Set(outOfProcess), log })
    return { want, log, wake }
  }

  it('asks once for each service, saying why, however often a harness is attached', () => {
    const { want, log, wake } = setup()
    wake.ask('viewers', 'a harness here')
    wake.ask('viewers', 'a harness here')
    wake.ask('store', 'Memories to put in place')
    expect(want.mock.calls).toEqual([['viewers'], ['store']])
    expect(log.mock.calls).toEqual([["[viewers] a harness here: asking for the viewers' process"], ["[viewers] Memories to put in place: asking for the viewers' process"]])
  })

  it('asks nothing for a service in the core\'s process, or one that has connected', () => {
    const inCore = setup([])
    inCore.wake.ask('viewers', 'a harness here')
    expect(inCore.want).not.toHaveBeenCalled()
    const connected = setup()
    connected.wake.connected('search')
    connected.wake.connected('viewers')
    connected.wake.ask('viewers', 'a harness here')
    connected.wake.ask('store', 'Memories to put in place')
    expect(connected.want.mock.calls).toEqual([['store']])
    expect(VIEWERS_ON_DEMAND).toEqual(['viewers', 'store'])
  })

  it('logs to the console unless told otherwise', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const want = vi.fn()
      createViewersWake({ want, outOfProcess: new Set(['viewers']) }).ask('viewers', 'a harness here')
      expect(log).toHaveBeenCalledWith("[viewers] a harness here: asking for the viewers' process")
    } finally { log.mockRestore() }
  })
})

describe('the viewers\' process as the core starts', () => {
  const data = () => mkdtempSync(join(tmpdir(), 'viewers-wake-'))

  it('is asked for when an agent the registry kept has a harness', () => {
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [{ dsh: undefined }, { dsh: 'acme/blender' }], dataDir: data() })
    expect(ask.mock.calls).toEqual([['viewers', 'a harness here']])
  })

  it('is asked for when an earlier process left viewer servers in its ledger, to stop them', () => {
    const dir = data()
    writeFileSync(join(dir, VIEWER_LEDGER), JSON.stringify([{ pid: 4242, startedAt: 1, agentId: 'a1', dshId: 'acme/blender', viewerDir: '/x' }]))
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir })
    expect(ask.mock.calls).toEqual([['viewers', 'viewer servers an earlier process left running']])
    // An empty ledger, as a clean stop and the reaping leave it, asks nothing.
    writeFileSync(join(dir, VIEWER_LEDGER), '[]')
    ask.mockClear()
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir })
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not read an installed index or wake Store on an idle computer', () => {
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [{ dsh: null }], dataDir: data() })
    expect(ask).not.toHaveBeenCalled()
  })
})
