import { describe, expect, it } from 'vitest'
import { planPetSync } from './sync.js'

const A = 'a'.repeat(16)
const B = 'b'.repeat(16)
const C = 'c'.repeat(16)

describe('planPetSync', () => {
  it('held nothing → send all mapped, map first', () => {
    const mapping = { all: A, engines: { codex: B, claude: A, hermes: C } }
    const plan = planPetSync(mapping, [], new Set())
    expect(plan.map).toEqual(mapping)
    // all first, then engines by name; the pack both "all" and claude use is listed once.
    expect(plan.send).toEqual([A, B, C])
    expect(plan.drop).toEqual([])
    expect(plan.spare).toEqual([])
  })

  it('held stale → drop it, send only what is missing', () => {
    const plan = planPetSync({ all: null, engines: { claude: A, codex: B } }, [B, C], new Set([C]))
    expect(plan.drop).toEqual([C])
    expect(plan.send).toEqual([A])
    expect(plan.spare).toEqual([])
  })

  it("an empty mapping and another computer's packs → nothing dropped, all spare in the dial's order", () => {
    const plan = planPetSync({ all: null, engines: {} }, [C, A, B], new Set())
    expect(plan.drop).toEqual([])
    expect(plan.send).toEqual([])
    expect(plan.spare).toEqual([C, A, B])
  })

  it('a held pack neither own nor mapped is spare, an own one is dropped, a mapped one is neither', () => {
    const plan = planPetSync({ all: A, engines: {} }, [B, A, C], new Set([C]))
    expect(plan.drop).toEqual([C])
    expect(plan.spare).toEqual([B])
    expect(plan.send).toEqual([])
  })
})
