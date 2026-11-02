import { describe, expect, it } from 'vitest'
import { machineSlots, slotCounter, teamPoolOf, type ContributedMachine } from './machines.js'
import { startFinished } from './parts/write.js'
import type { SuperTabState } from './model.js'

/** The count before slotCounter: each pool filtered the Swarm's whole lists (prod 10-31: 543 released harnesses, 17 machines,
 *  ~27 k callbacks a change read). Kept here only as the reference the counter must equal. */
function referenceSlots(state: SuperTabState, pool: ContributedMachine): number {
  const poolSlots = (each: ContributedMachine) => {
    const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === each.machineId)
    const live = new Set(reservations.map(r => r.harnessId))
    const released = (state.releasedHarnesses ?? []).filter(r => r.machineId === each.machineId && !live.has(r.harnessId)).map(r => r.harnessId)
    const observed = each.observation?.stoppedHarnessIds ?? []
    const stopped = new Set([...observed.filter(id => {
      const reservation = reservations.find(r => r.harnessId === id)
      return !reservation || !reservation.renewed || each.observation?.stoppedReservations?.some(r => r.harnessId === id && r.generation === reservation.generation)
    }), ...released])
    const running = new Set((each.observation?.runningHarnessIds ?? []).filter(id => !stopped.has(id)))
    for (const a of state.agents) if (a.machineId === each.machineId && !stopped.has(a.harnessId)) running.add(a.harnessId)
    for (const r of reservations) if (!stopped.has(r.harnessId)) running.add(r.harnessId)
    let pending = 0
    for (const start of state.starts ?? []) {
      if (start.request.machineId !== each.machineId || start.error) continue
      if (start.harnessId) { if (!startFinished(start) && !stopped.has(start.harnessId)) running.add(start.harnessId) }
      else pending++
    }
    return running.size + pending
  }
  const mac = pool.hostMachineId ? state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId) : pool
  const team = mac && teamPoolOf(state, mac)
  return [...new Set([pool, mac, team])].reduce((sum, each) => sum + (each ? poolSlots(each) : 0), 0)
}

/** A small seeded generator, so a failure names the state that broke. */
function random(seed: number) {
  let s = seed
  const next = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31 }
  return { next, pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!, chance: (p: number) => next() < p }
}

function swarmOf(seed: number): SuperTabState {
  const r = random(seed)
  const machineIds = ['m1', 'm2', 'm3', 'mac']
  const harness = () => `h${Math.floor(r.next() * 12)}`
  const machines = machineIds.map(machineId => ({ machineId, contributorId: 'p1', maxAgents: 4,
    ...(machineId !== 'mac' && r.chance(0.3) ? { hostMachineId: 'mac' } : {}),
    observation: { runningHarnessIds: Array.from({ length: 3 }, harness), stoppedHarnessIds: Array.from({ length: 3 }, harness),
      ...(r.chance(0.5) ? { stoppedReservations: [{ harnessId: harness(), generation: r.pick(['g1', 'g2']) }] } : {}) } })) as unknown as ContributedMachine[]
  return {
    machines,
    harnessReservations: Array.from({ length: 6 }, () => ({ machineId: r.pick(machineIds), harnessId: harness(), generation: r.pick(['g1', 'g2']), renewed: r.chance(0.5) })),
    releasedHarnesses: Array.from({ length: 40 }, () => ({ machineId: r.pick(machineIds), harnessId: harness() })),
    agents: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, machineId: r.pick(machineIds), harnessId: harness() })),
    starts: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, request: { machineId: r.pick(machineIds) },
      ...(r.chance(0.2) ? { error: 'failed' } : {}), ...(r.chance(0.6) ? { harnessId: harness() } : {}),
      ...(r.chance(0.5) ? { poolGeneration: 'g1', ...(r.chance(0.5) ? { poolSettled: true } : {}) } : {}) })),
  } as unknown as SuperTabState
}

describe('slotCounter (machines.ts)', () => {
  it('counts every pool exactly as filtering the Swarm\'s lists per pool did, over many states', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const state = swarmOf(seed), count = slotCounter(state)
      for (const pool of state.machines!) expect(count(pool), `seed ${seed} ${pool.machineId}`).toBe(referenceSlots(state, pool))
    }
  })

  it('answers as machineSlots does, which commands still call on the state they are changing', () => {
    const state = swarmOf(7)
    for (const pool of state.machines!) expect(machineSlots(state, pool)).toBe(slotCounter(state)(pool))
  })
})
