import { describe, expect, it } from 'vitest'
import { freeze } from './cache.js'
import { cloneData } from './cloneData.js'
import { reassemble, split } from './parts/index.js'
import { fullSwarm, NOW, richSwarm, swarm } from './read/fixture.test-support.js'
import type { SuperTabState } from './model.js'

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/** Fails if any object is reached twice: on such a value a plain copy and structuredClone would differ. */
function reachedOnce(value: unknown, seen = new Set<object>(), path = '(root)'): void {
  if (!isObject(value)) return
  if (seen.has(value)) throw new Error(`reached twice at ${path}`)
  seen.add(value)
  for (const [key, item] of Object.entries(value)) reachedOnce(item, seen, `${path}.${key}`)
}

/** Fails if the copy holds any object of the source at the same place. */
function sharesNothing(source: unknown, copy: unknown, path = '(root)'): void {
  if (!isObject(source)) return
  if (source === copy) throw new Error(`shared at ${path}`)
  for (const [key, item] of Object.entries(source)) sharesNothing(item, (copy as Record<string, unknown>)[key], `${path}.${key}`)
}

/** The bench's default Swarm size (integration/bench/README.md): 200 groups and 20 workers, each working on one. */
function benchSized(): SuperTabState {
  const s = swarm()
  s.add('lead-harness', 'lead', true)
  const groups = Array.from({ length: 200 }, (_, i) => s.group(`Group ${i}`))
  for (let i = 0; i < 20; i++) {
    const worker = s.add(`worker-${i}`, groups[i]!)
    s.run({ type: 'work.assign', conversationId: groups[i]!, agentId: worker })
  }
  return s.state
}

const states = (): Array<[string, SuperTabState]> => [
  ['the rich fixture', richSwarm().state],
  ['a bench-sized Swarm', benchSized()],
  ['a reassembled state', reassemble(split(richSwarm().state, { tabId: 'tab', version: 1, now: NOW }), { share: true })],
  ['the full fixture', fullSwarm().state],
  ['the full fixture reassembled', reassemble(split(fullSwarm().state, { tabId: 'tab', version: 1, now: NOW }), { share: true })],
]

describe('cloneData', () => {
  it('copies every fixture state as structuredClone does, sharing nothing', () => {
    for (const [name, state] of states()) {
      expect(() => reachedOnce(state), name).not.toThrow()
      const copy = cloneData(state)
      expect(copy, name).toStrictEqual(structuredClone(state))
      expect(() => sharesNothing(state, copy), name).not.toThrow()
    }
  })

  it('keeps undefined values and copies a Date as a new Date', () => {
    const input = { a: undefined, at: new Date(NOW), list: [1, 'x', null, true] }
    const copy = cloneData(input)
    expect(copy).toStrictEqual(input)
    expect('a' in copy).toBe(true)
    expect(copy.at).toBeInstanceOf(Date)
    expect(copy.at).not.toBe(input.at)
    expect(copy.at.getTime()).toBe(NOW)
  })

  it('keeps an own __proto__ key as a key, as structuredClone does', () => {
    const input = JSON.parse('{"x":{"__proto__":{"p":1},"ok":2}}') as { x: Record<string, unknown> }
    const copy = cloneData(input)
    expect(JSON.stringify(copy)).toBe(JSON.stringify(structuredClone(input)))
    expect(Object.getPrototypeOf(copy.x)).toBe(Object.prototype)
  })

  it('returns a writable copy of frozen data', () => {
    const frozen = structuredClone(richSwarm().state)
    freeze(frozen)
    const copy = cloneData(frozen)
    expect(Object.isFrozen(copy)).toBe(false)
    expect(Object.isFrozen(copy.conversations[0])).toBe(false)
    expect(() => { copy.conversations[0]!.title = 'changed' }).not.toThrow()
  })

  it('throws on values it cannot copy, naming where they are', () => {
    expect(() => cloneData({ agents: [{ extra: new Map() }] })).toThrow(/cannot copy a Map at agents\.0\.extra/)
    expect(() => cloneData({ s: new Set() })).toThrow(/cannot copy a Set at s/)
    expect(() => cloneData({ c: new (class Thing {})() })).toThrow(/cannot copy a Thing at c/)
    expect(() => cloneData({ f: () => 1 })).toThrow(/cannot copy a function at f/)
  })
})
