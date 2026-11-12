import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Ledger, ledgerPath } from '../agentClient/ledger.js'
import { createHachiHandOver } from './hachiHandOver.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hachi-hand-over-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('handing what Hachi started to the person', () => {
  const setup = (tell: (machineId: string) => Promise<unknown>) => {
    const ledger = new Ledger(ledgerPath(dir))
    const log = vi.fn(), count = vi.fn()
    const hand = createHachiHandOver({ ledger, self: () => 'm1', tell, now: () => 100, log, count })
    return { ledger, log, count, hand }
  }
  const start = (ledger: Ledger, agentId: string, machineId: string, name = agentId) =>
    ledger.append({ at: 1, depth: 1, by: { machineId: 'm1', agentId: 'hachi', name: 'Hachi', engine: 'claude', hachi: true }, child: { machineId, agentId, name } })

  it('hands each over once, even asked twice at once', async () => {
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    const tell = vi.fn(async () => { await held })
    const t = setup(tell)
    start(t.ledger, 'far', 'm2', '')
    const first = t.hand.over('hachi')
    const second = t.hand.over('hachi')
    release()
    await Promise.all([first, second])
    expect(tell).toHaveBeenCalledOnce()
    expect(t.count).toHaveBeenCalledOnce()
    // A harness with no name is said by its id's start.
    expect(t.log).toHaveBeenCalledWith('[hachi] handed far to the person: Hachi closed.')
  })

  it('says a machine that could not be asked, whatever it threw, by the harness\'s id when it has no name', async () => {
    const t = setup(async () => { throw 'asleep' })
    start(t.ledger, 'far-away-harness', 'm2', '')
    await t.hand.over('hachi')
    expect(t.log).toHaveBeenCalledWith('[hachi] could not hand far-away to the person on its machine yet: asleep. Asked again at the next look.')
    expect(t.hand.handed('far-away-harness')).toBe(false)
  })
})
