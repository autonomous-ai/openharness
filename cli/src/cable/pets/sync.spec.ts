import { describe, expect, it } from 'vitest'
import { planPetSync } from './sync.js'

const A = 'a'.repeat(16)
const B = 'b'.repeat(16)
const C = 'c'.repeat(16)

describe('planPetSync', () => {
  it('held nothing → send all mapped, map first', () => {
    const mapping = { all: A, engines: { codex: B, claude: A, hermes: C } }
    const plan = planPetSync(mapping, [])
    expect(plan.map).toEqual(mapping)
    // all first, then engines by name; the pack both "all" and claude use is listed once.
    expect(plan.send).toEqual([A, B, C])
    expect(plan.drop).toEqual([])
  })

  it('held stale → drop it, send only what is missing', () => {
    const plan = planPetSync({ all: null, engines: { claude: A, codex: B } }, [B, C])
    expect(plan.drop).toEqual([C])
    expect(plan.send).toEqual([A])
  })
})
