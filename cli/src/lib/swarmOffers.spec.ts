import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmOffers } from './swarmOffers.js'

const GRID = 'swarm-0123456789ab'

describe('models shared with you, offered to a Swarm', () => {
  it('offers and stops by Swarm, grid and model, privately, and the same twice changes nothing', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'swarm-offers-')), 'offers.json')
    const offers = new SwarmOffers(file)
    expect(offers.list()).toEqual([])
    const muse = { grid: GRID, sharedGrid: 'team', model: 'muse' }
    expect(offers.set(muse, true)).toEqual([muse])
    expect(offers.set(muse, true)).toEqual([muse])
    offers.set({ grid: 'swarm-ffffffffffff', sharedGrid: 'team', model: 'muse' }, true)
    expect(offers.list(GRID)).toEqual([muse])
    expect(offers.list()).toHaveLength(2)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(offers.set(muse, false)).toEqual([])
    expect(offers.list()).toEqual([{ grid: 'swarm-ffffffffffff', sharedGrid: 'team', model: 'muse' }])
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1)
  })
  it('reads junk and an unreadable file as nothing offered', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'swarm-offers-')), 'offers.json')
    await writeFile(file, JSON.stringify([null, { grid: GRID }, { grid: GRID, sharedGrid: 'team', model: 'x'.repeat(201) }, { grid: GRID, sharedGrid: 'team', model: 'm', extra: 1 }]))
    expect(new SwarmOffers(file).list()).toEqual([{ grid: GRID, sharedGrid: 'team', model: 'm' }])
    await writeFile(file, '{}')
    expect(new SwarmOffers(file).list()).toEqual([])
    await writeFile(file, 'not json')
    expect(new SwarmOffers(file).list()).toEqual([])
  })
})
