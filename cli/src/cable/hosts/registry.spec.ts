import { describe, expect, it } from 'vitest'
import { HostRegistry } from './registry.js'
import { capsLetters, type HostAgent, type HostSource } from './types.js'

function agent(over: Partial<HostAgent>): HostAgent {
  return {
    id: 'a',
    engine: 'claude',
    name: 'n',
    host: 'terminal', app: 'terminal',
    state: 'idle',
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

  it('observed beats a listing source and loses to harness', () => {
    const herdr = fakeSource('herdr', [agent({ id: 'x', sessionId: 's' })])
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's' })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['o'])
    expect(ids(new HostRegistry([herdr, observed]))).toEqual(['o'])
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    expect(ids(new HostRegistry([herdr, observed, harness]))).toEqual(['h'])
  })

  it("two copies from different sources that share a pane key are one agent, the stronger source's", () => {
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's1', paneKeys: ['herdr:w1:p1'] })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })])
    expect(ids(new HostRegistry([herdr, observed]))).toEqual(['o'])
  })

  it('two agents of one source that share a pane key are both listed', () => {
    const observed = fakeSource('observed', [
      agent({ id: 'o1', sessionId: 's1', paneKeys: ['herdr:w1:p1'] }),
      agent({ id: 'o2', sessionId: 's2', paneKeys: ['herdr:w1:p1'] }),
    ])
    const herdr = fakeSource('herdr', [agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['o1', 'o2'])
  })

  it('another pane, and no pane key at all, fold nothing', () => {
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's1' })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', paneKeys: ['herdr:w2:p1'] })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['o', 'x'])
    observed.set([agent({ id: 'o', sessionId: 's1', paneKeys: ['herdr:w1:p1'] })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['o', 'x'])
  })

  it("a copy folded away still folds the next source's copy", () => {
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's', paneKeys: ['herdr:w1:p1'] })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })])
    expect(ids(new HostRegistry([herdr, observed, harness]))).toEqual(['h'])
  })

  it("outside finds a listing source's copy by its id, the merged list folding it away or not", () => {
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's1', paneKeys: ['herdr:w1:p1'] })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })])
    const reg = new HostRegistry([observed, herdr])
    expect(ids(reg)).toEqual(['o'])
    expect(reg.outside('x')?.id).toBe('x')
    expect(reg.outside('o')?.id).toBe('o')
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

  it('outside: the agent any source but Harness holds by that id, the merged list folding it away or not', () => {
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 's' })])
    const reg = new HostRegistry([harness, observed])
    expect(ids(reg)).toEqual(['h'])
    expect(reg.outside('o')?.id).toBe('o')
    expect(reg.outside('h')).toBeUndefined()
    expect(reg.outside('nobody')).toBeUndefined()
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
