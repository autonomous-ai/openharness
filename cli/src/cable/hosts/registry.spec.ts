import { describe, expect, it } from 'vitest'
import { HostRegistry } from './registry.js'
import { capsLetters, type HostAgent, type HostSource } from './types.js'

function agent(over: Partial<HostAgent>): HostAgent {
  return {
    id: 'a',
    engine: 'claude',
    name: 'n',
    host: 'terminal',
    state: 'idle',
    since: 0,
    lastActivityAt: 0,
    unseenDone: false,
    ...over,
  }
}

function fakeSource(id: string, agents: HostAgent[]) {
  const listeners = new Set<() => void>()
  const src: HostSource & { set(a: HostAgent[]): void } = {
    id,
    list: () => agents,
    onChange(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    capabilities: () => ({ status: true, voice: false, focus: false, answer: false }),
    set(a) {
      agents = a
      for (const l of [...listeners]) l()
    },
  }
  return src
}

describe('HostRegistry', () => {
  it('harness wins over observed for the same engine+sessionId', () => {
    const h = agent({ id: 'h1', sessionId: 's1', host: 'harness' })
    const o = agent({ id: 'o1', sessionId: 's1' })
    const harness = fakeSource('harness', [h])
    const observed = fakeSource('observed', [o])
    // Listed weakest first on purpose: strength, not order, decides.
    const reg = new HostRegistry([observed, harness])
    expect(reg.agents()).toEqual([h])
    expect(reg.source('h1')).toBe(harness)
    expect(reg.source('o1')).toBeUndefined()
  })

  it('a host adapter beats observed and loses to harness', () => {
    const orca = fakeSource('orca', [agent({ id: 'x', sessionId: 's' })])
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's' })])
    expect(new HostRegistry([observed, orca]).agents().map((a) => a.id)).toEqual(['x'])
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    expect(new HostRegistry([observed, orca, harness]).agents().map((a) => a.id)).toEqual(['h'])
  })

  it('dedupes by callerPid when sessionId is missing', () => {
    const harness = fakeSource('harness', [agent({ id: 'h', callerPid: 42 })])
    const observed = fakeSource('observed', [agent({ id: 'o', callerPid: 42 }), agent({ id: 'p', callerPid: 43 })])
    expect(new HostRegistry([harness, observed]).agents().map((a) => a.id)).toEqual(['h', 'p'])
  })

  it('keeps different sessions and engines apart', () => {
    const observed = fakeSource('observed', [
      agent({ id: '1', sessionId: 's' }),
      agent({ id: '2', sessionId: 't' }),
      agent({ id: '3', sessionId: 's', engine: 'codex' }),
    ])
    expect(new HostRegistry([observed]).agents()).toHaveLength(3)
  })

  it('handles no sources and empty sources', () => {
    expect(new HostRegistry([]).agents()).toEqual([])
    expect(new HostRegistry([fakeSource('observed', [])]).agents()).toEqual([])
  })

  it('onChange fires once per source change', () => {
    const observed = fakeSource('observed', [])
    const harness = fakeSource('harness', [])
    const reg = new HostRegistry([harness, observed])
    let n = 0
    const off = reg.onChange(() => n++)
    observed.set([agent({ id: 'o' })])
    expect(n).toBe(1)
    harness.set([agent({ id: 'h' })])
    expect(n).toBe(2)
    off()
    observed.set([])
    expect(n).toBe(2)
  })

  it('reflects the sources live', () => {
    const observed = fakeSource('observed', [])
    const reg = new HostRegistry([observed])
    observed.set([agent({ id: 'o' })])
    expect(reg.agents().map((a) => a.id)).toEqual(['o'])
    expect(reg.source('o')).toBe(observed)
  })
})

describe('capsLetters', () => {
  it('capsLetters({status,voice,answer}) === sva', () => {
    expect(capsLetters({ status: true, voice: true, focus: false, answer: true })).toBe('sva')
    expect(capsLetters({ status: true, voice: true, focus: true, answer: true })).toBe('svfa')
    expect(capsLetters({ status: false, voice: false, focus: false, answer: false })).toBe('')
  })
})
