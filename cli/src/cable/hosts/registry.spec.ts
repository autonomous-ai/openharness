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
  const src: HostSource & { set(a: HostAgent[]): void } = {
    id,
    list: () => agents,
    capabilities: () => ({ status: true, voice: false, focus: false, answer: false }),
    set(a) { agents = a },
  }
  return src
}

const ids = (reg: HostRegistry) => reg.entries().map((e) => e.agent.id)

describe('HostRegistry', () => {
  it('harness wins over observed for the same engine+sessionId', () => {
    const h = agent({ id: 'h1', sessionId: 's1', host: 'harness' })
    const o = agent({ id: 'o1', sessionId: 's1' })
    const harness = fakeSource('harness', [h])
    const observed = fakeSource('observed', [o])
    // Listed weakest first on purpose: strength, not order, decides.
    expect(new HostRegistry([observed, harness]).entries()).toEqual([{ agent: h, source: harness }])
  })

  it('a host adapter beats observed and loses to harness', () => {
    const orca = fakeSource('orca', [agent({ id: 'x', sessionId: 's' })])
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's' })])
    expect(ids(new HostRegistry([observed, orca]))).toEqual(['x'])
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    expect(ids(new HostRegistry([observed, orca, harness]))).toEqual(['h'])
  })

  it('dedupes by callerPid when sessionId is missing', () => {
    const harness = fakeSource('harness', [agent({ id: 'h', callerPid: 42 })])
    const observed = fakeSource('observed', [agent({ id: 'o', callerPid: 42 }), agent({ id: 'p', callerPid: 43 })])
    expect(ids(new HostRegistry([harness, observed]))).toEqual(['h', 'p'])
  })

  it('keeps different sessions and engines apart', () => {
    const observed = fakeSource('observed', [
      agent({ id: '1', sessionId: 's' }),
      agent({ id: '2', sessionId: 't' }),
      agent({ id: '3', sessionId: 's', engine: 'codex' }),
    ])
    expect(new HostRegistry([observed]).entries()).toHaveLength(3)
  })

  it('handles no sources and empty sources', () => {
    expect(new HostRegistry([]).entries()).toEqual([])
    expect(new HostRegistry([fakeSource('observed', [])]).entries()).toEqual([])
  })

  it('reflects the sources live', () => {
    const observed = fakeSource('observed', [])
    const reg = new HostRegistry([observed])
    const o = agent({ id: 'o' })
    observed.set([o])
    expect(reg.entries()).toEqual([{ agent: o, source: observed }])
  })
})

describe('capsLetters', () => {
  it('capsLetters({status,voice,answer}) === sva', () => {
    expect(capsLetters({ status: true, voice: true, focus: false, answer: true })).toBe('sva')
    expect(capsLetters({ status: true, voice: true, focus: true, answer: true })).toBe('svfa')
    expect(capsLetters({ status: false, voice: false, focus: false, answer: false })).toBe('')
  })
})
