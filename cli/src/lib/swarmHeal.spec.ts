import { describe, expect, it, vi } from 'vitest'
import { HEAL_MS, liveModels, SwarmHeal } from './swarmHeal.js'

const GRID = 'swarm-0123456789ab'
const share = (model: string) => ({ grid: GRID, connectionId: 'c1', model, name: 'OpenRouter' })

function setup(patch: { live?: Set<string> | null | Error; shares?: string[]; apps?: string[] } = {}) {
  let now = 1_000_000
  const deps = {
    live: vi.fn(async () => { if (patch.live instanceof Error) throw patch.live; return patch.live === undefined ? new Set<string>() : patch.live }),
    shares: { list: vi.fn(() => (patch.shares ?? []).map(share)), rejoin: vi.fn(async () => ({ ok: true })) },
    apps: { served: vi.fn(async () => patch.apps ?? []), rejoin: vi.fn(async () => true) },
    now: () => now,
  }
  return { heal: new SwarmHeal(deps), deps, later: (ms: number) => { now += ms } }
}

describe('keeping this computer\'s models on a Swarm\'s grid', () => {
  it('says what the grid lists, and does nothing while it lists all of this computer\'s models', async () => {
    const f = setup({ live: new Set(['ds', 'llama', 'other']), shares: ['ds'], apps: ['llama'] })
    expect(await f.heal.check(GRID)).toEqual({ live: ['ds', 'llama', 'other'], missing: [] })
    expect(f.deps.shares.rejoin).not.toHaveBeenCalled()
    expect(f.deps.apps.rejoin).not.toHaveBeenCalled()
  })

  it('joins a missing API share again, then waits before trying again', async () => {
    const f = setup({ live: new Set(), shares: ['ds'], apps: ['llama'] })
    // Not in the process's first minutes, while the restore joins them.
    await f.heal.check(GRID)
    expect(f.deps.shares.rejoin).not.toHaveBeenCalled()
    f.later(HEAL_MS)
    expect(await f.heal.check(GRID)).toEqual({ live: [], missing: ['ds', 'llama'] })
    expect(f.deps.shares.rejoin).toHaveBeenCalledWith(GRID, 'c1', 'ds')
    // One join restarts grid's engine with every model: an app engine is not joined beside it.
    expect(f.deps.apps.rejoin).not.toHaveBeenCalled()
    f.later(HEAL_MS - 1)
    await f.heal.check(GRID)
    expect(f.deps.shares.rejoin).toHaveBeenCalledOnce()
    f.later(1)
    await f.heal.check(GRID)
    expect(f.deps.shares.rejoin).toHaveBeenCalledTimes(2)
  })

  it('joins an app engine again when no API share is missing, and a failing join breaks nothing', async () => {
    const f = setup({ live: new Set(['ds']), shares: ['ds'], apps: ['llama'] })
    f.later(HEAL_MS)
    f.deps.apps.rejoin.mockRejectedValueOnce(new Error('grid'))
    expect(await f.heal.check(GRID)).toEqual({ live: ['ds'], missing: ['llama'] })
    expect(f.deps.apps.rejoin).toHaveBeenCalledWith(GRID)
  })

  it('says nothing about a grid it could not read, and reads an app list that fails as none', async () => {
    expect(await setup({ live: null, shares: ['ds'] }).heal.check(GRID)).toEqual({ live: null, missing: [] })
    expect(await setup({ live: new Error('offline'), shares: ['ds'] }).heal.check(GRID)).toEqual({ live: null, missing: [] })
    const f = setup({ live: new Set() })
    f.deps.apps.served.mockRejectedValueOnce(new Error('state'))
    expect(await f.heal.check(GRID)).toEqual({ live: [], missing: [] })
    // With the default clock too.
    const plain = new SwarmHeal({ ...f.deps, now: undefined })
    expect(await plain.check(GRID)).toEqual({ live: [], missing: [] })
  })

  it('reads the models a `grid models --json` answer lists', () => {
    expect(liveModels('[{"model":"ds","node":"m"},{"model":7},null,{"engine":"x"}]')).toEqual(new Set(['ds']))
    expect(liveModels('{"model":"ds"}')).toBeNull()
    expect(liveModels('(no live models)')).toBeNull()
  })
})
