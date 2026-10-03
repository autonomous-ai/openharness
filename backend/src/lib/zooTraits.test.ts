import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { individualFlags, oneIn, rollTraits, type Traits } from './zooTraits.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'
import { ZOO_SEED_MAX } from './zoo.js'

/** The reference renderer's pinned rolls (daemons/tools/generate.mjs writes them from render.mjs). */
interface Roll { id: string; seed: number; traits: Traits; flags: string; oneIn: number }
const FRAMES = JSON.parse(readFileSync(new URL('../../../daemons/frames.json', import.meta.url), 'utf8')) as { traitRolls: Roll[] }
const WITH_TRAITS = (DAEMON_ROSTER.daemons as ReadonlyArray<{ id: string; traits?: unknown }>).filter((d) => d.traits).map((d) => d.id)

describe('traits: the server port of the roll matches the reference exactly', () => {
  it('pins a spread of rolls for every species with a catalogue', () => {
    expect(new Set(FRAMES.traitRolls.map((r) => r.id))).toEqual(new Set(WITH_TRAITS))
    expect(FRAMES.traitRolls.length).toBeGreaterThan(WITH_TRAITS.length * 10)
    // The ends of the seed range are among them: 0 (the default), 1 and the highest a hatch draws.
    for (const id of WITH_TRAITS) {
      const seeds = FRAMES.traitRolls.filter((r) => r.id === id).map((r) => r.seed)
      expect(seeds).toEqual(expect.arrayContaining([0, 1, ZOO_SEED_MAX]))
    }
  })

  it.each(FRAMES.traitRolls.map((r) => [r.id, r.seed, r] as const))('%s seed %i: traits, flags and rarity', (id, seed, roll) => {
    const traits = rollTraits(id, seed)!
    expect(traits).toEqual(roll.traits)
    expect(Object.keys(traits)).toEqual(Object.keys(roll.traits))
    expect(individualFlags(id, traits)).toBe(roll.flags)
    expect(oneIn(id, traits)).toBe(roll.oneIn)
  })

  it('gives seed 0 the species\' default look, and nothing for a species without a catalogue', () => {
    for (const id of WITH_TRAITS) {
      const t = rollTraits(id, 0)!
      expect(t).toMatchObject({ seed: 0, marks: null, extra: null, oddEye: false, temper: 'calm' })
      expect(individualFlags(id, t)).toBe(`${id} -c ${t.colour}`)
    }
    expect(rollTraits('tmux', 42)).toBeNull()                              // a held drop's species: no catalogue yet
    expect(rollTraits('nobody', 42)).toBeNull()
  })
})
