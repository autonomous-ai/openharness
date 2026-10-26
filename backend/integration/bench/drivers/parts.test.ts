import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttemptCounter } from '../attempts.js'
import { DEFAULT_CONFIG, type BenchConfig } from '../config.js'
import type { SwarmDriver } from '../driver.js'
import { machineId, seedAccounts } from '../fixtures.js'
import { localDatabase, type LocalDatabase } from '../mongo.js'
import { plan } from '../plan.js'
import { seedSwarm, type Swarm } from '../seed.js'
import { partsDriver } from './parts.js'

// A small Swarm built through the parts store's routes, read the way today's clients on the new read API read it.
const config: BenchConfig = { ...DEFAULT_CONFIG, groups: 4, doneShare: 0.5, workers: 2, machines: 2, text: { briefChars: 200, resultChars: 50, messageChars: 40 } }
let database: LocalDatabase, driver: SwarmDriver, swarm: Swarm
let clock = Date.now()

beforeAll(async () => {
  database = await localDatabase()
  const people = await seedAccounts(database.db, config.machines)
  driver = await partsDriver(new AttemptCounter().wrap(database.db), () => people, { now: () => clock })
  swarm = (await seedSwarm(driver, config, plan(config), people)).swarm
})
afterAll(async () => { await driver?.close(); await database?.stop() })

const post = (text: string) => driver.execute(swarm.tabId, swarm.people[0]!, `post-${text.replaceAll(' ', '-')}`,
  { type: 'message.send', conversationId: swarm.workers[0]!.group, text, replyTo: null, recipientIds: [] })

describe('the parts driver', () => {
  it('seeds through the new reads: check ids from the first load, machine generations from the host form', () => {
    for (const w of swarm.workers) expect(w.checkIds).toHaveLength(2)
    expect(swarm.generations).toHaveLength(config.machines)
    for (const generation of swarm.generations) expect(generation).toMatch(/\S/)
  })

  it('has a Desktop window load the Swarm once, then read only what changed since its cursor', async () => {
    const reader = driver.desktopReader(swarm.tabId, swarm.people[0]!)
    const first = await reader.poll() as { data: { format: number; head: unknown }; bytes: number }
    expect(first.data.format).toBe(2)
    expect(first.data.head).toBeTruthy()
    // A change read, not another first load. (Parts changed in the last 30 s come again by design, so right after seeding
    // it is not yet small.)
    const idle = await reader.poll() as { data: { reload: boolean; head?: unknown; cursor: string } }
    expect(idle.data.reload).toBe(false)
    expect(idle.data.cursor).toMatch(/\S/)
    expect((await post('after the first load')).code).toBeNull()
    const changed = await reader.poll() as { data: { groups: Array<{ key: string }> } }
    expect(changed.data.groups.map(g => g.key)).toContain(swarm.workers[0]!.group)
  })

  it('has a host read its form in full once, then by change naming the rows it holds, and in full again after a minute', async () => {
    const host = swarm.people[swarm.workers[0]!.machine]!
    const reader = driver.hostReader(host, machineId(swarm.workers[0]!.machine))
    const first = await reader.poll() as { data: { full: boolean; tabs: Array<{ tabId: string; roster?: unknown[] }> } }
    expect(first.data.full).toBe(true)
    expect(first.data.tabs.find(t => t.tabId === swarm.tabId)?.roster?.length).toBeGreaterThan(0)
    clock += 1_000
    const next = await reader.poll() as { data: { full: boolean; tabs: Array<{ tabId: string; unchanged?: true; roster?: unknown[] }> } }
    expect(next.data.full).toBe(false)
    // Whatever comes back for this Swarm hashes the same as the rows held, so it carries none.
    for (const tab of next.data.tabs) expect(tab.roster, tab.tabId).toBeUndefined()
    clock += 60_000
    const minute = await reader.poll() as { data: { full: boolean; tabs: Array<{ tabId: string; unchanged?: true; roster?: unknown[] }> } }
    expect(minute.data.full).toBe(true)
    expect(minute.data.tabs.find(t => t.tabId === swarm.tabId)).toMatchObject({ unchanged: true })
  })
})
