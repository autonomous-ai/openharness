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

describe('an ended copy (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)', () => {
  const ended = (over: Partial<HostAgent>) => agent({ ...over, ended: true })
  function counting(id: string, agents: HostAgent[]) {
    const src = fakeSource(id, agents)
    let calls = 0
    const list = src.list
    return Object.assign(src, { list: () => { calls++; return list() }, calls: () => calls })
  }

  it("an observed copy and a store copy of one session are one row, the observed's, by its session id", () => {
    const o = agent({ id: 'o', sessionId: 's' })
    const observed = fakeSource('observed', [o])
    const store = fakeSource('claude-app', [agent({ id: 'o', sessionId: 's', resting: true })])
    expect(new HostRegistry([observed, store]).entries()).toEqual([{ agent: o, source: observed }])
    expect(new HostRegistry([store, observed]).entries()).toEqual([{ agent: o, source: observed }])
  })

  it('… and by the pane key alone', () => {
    const observed = fakeSource('observed', [agent({ id: 'o', sessionId: 'new', paneKeys: ['claude-app:local_a'] })])
    const store = fakeSource('claude-app', [agent({ id: 'c', sessionId: 'old', paneKeys: ['claude-app:local_a'] })])
    expect(ids(new HostRegistry([store, observed]))).toEqual(['o'])
  })

  it("an ended observed copy gives its row to the store's live copy", () => {
    const c = agent({ id: 'o', sessionId: 's', resting: true })
    const store = fakeSource('claude-app', [c])
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 's' })])
    expect(new HostRegistry([observed, store]).entries()).toEqual([{ agent: c, source: store }])
  })

  // The ChatGPT app's threads (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md): its listed copy carries no
  // pane key, so the session id alone makes a hooked thread and its listed copy one row.
  it('an observed copy and a codex-app copy of one ChatGPT thread are one row, the observed one', () => {
    const o = agent({ id: 'o', engine: 'codex', sessionId: 't' })
    const observed = fakeSource('observed', [o])
    const app = fakeSource('codex-app', [agent({ id: 'o', engine: 'codex', sessionId: 't', host: 'codex', app: 'codex', resting: true })])
    expect(new HostRegistry([observed, app]).entries()).toEqual([{ agent: o, source: observed }])
    expect(new HostRegistry([app, observed]).entries()).toEqual([{ agent: o, source: observed }])
  })

  it('an ended observed copy gives its row to the codex-app copy of its thread', () => {
    const c = agent({ id: 'o', engine: 'codex', sessionId: 't', host: 'codex', app: 'codex', resting: true })
    const app = fakeSource('codex-app', [c])
    const observed = fakeSource('observed', [ended({ id: 'o', engine: 'codex', sessionId: 't' })])
    expect(new HostRegistry([observed, app]).entries()).toEqual([{ agent: c, source: app }])
  })

  it("… and to herdr's, by the session id or by a pane key", () => {
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 's' })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', sessionId: 's' })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['x'])
    observed.set([ended({ id: 'o', sessionId: 's', paneKeys: ['herdr:w1:p1'] })])
    herdr.set([agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['x'])
  })

  // Each listing source's copy as it lists it: herdr's, hc's and cmux's have no session id until their client names one,
  // and the store's may name an older id of the session, so only the pane key the ended hooked copy keeps finds them.
  it.each([
    ['herdr', 'herdr:w1:p1', {}],
    ['hc', 'herdr-app:t7', {}],
    ['cmux', 'cmux:s1', { callerPid: 4242 }],
    ['claude-app', 'claude-app:local_a', { sessionId: 'old', resting: true }],
  ] as [string, string, Partial<HostAgent>][])("an ended hooked copy gives its row to %s's live copy by the pane key it keeps", (id, key, over) => {
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 'new', paneKeys: [key] })])
    const listed = fakeSource(id, [agent({ id: 'x', paneKeys: [key], ...over })])
    expect(ids(new HostRegistry([observed, listed]))).toEqual(['x'])
  })

  it('an ended copy no other source lists is listed alone', () => {
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 's' })])
    const herdr = fakeSource('herdr', [agent({ id: 'x', sessionId: 't' })])
    expect(ids(new HostRegistry([observed, herdr]))).toEqual(['o', 'x'])
  })

  it("an ended copy takes no key: the live copy that took its row still folds the next source's", () => {
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 's' })])
    const cmux = fakeSource('cmux', [agent({ id: 'x', sessionId: 's' })])
    const opencode = fakeSource('opencode', [agent({ id: 'y', sessionId: 's' })])
    expect(ids(new HostRegistry([observed, cmux, opencode]))).toEqual(['x'])
  })

  it("a Harness agent's session still takes an ended copy's row", () => {
    const harness = fakeSource('harness', [agent({ id: 'h', sessionId: 's' })])
    const observed = fakeSource('observed', [ended({ id: 'o', sessionId: 's' })])
    expect(ids(new HostRegistry([harness, observed]))).toEqual(['h'])
  })

  it.each([
    ['herdr', { paneKeys: ['herdr:w1:p1'] }],
    ['cmux', { sessionId: 's', paneKeys: ['cmux:s1'] }],
    ['opencode', { engine: 'opencode', sessionId: 's' }],
  ] as [string, Partial<HostAgent>][])("%s's rows merge as before", (id, over) => {
    const live = agent({ id: 'o', ...over })
    const observed = fakeSource('observed', [live])
    const listed = fakeSource(id, [agent({ id: 'x', ...over })])
    expect(ids(new HostRegistry([listed, observed]))).toEqual(['o'])
    observed.set([live, ended({ id: 'e', sessionId: 'gone' })])
    expect(ids(new HostRegistry([listed, observed]))).toEqual(['o', 'e'])
  })

  it('each list is read once a call, with an ended copy or none', () => {
    const observed = counting('observed', [agent({ id: 'o', sessionId: 's' })])
    const herdr = counting('herdr', [agent({ id: 'x', sessionId: 't' })])
    const store = counting('claude-app', [agent({ id: 'c', sessionId: 'u', resting: true })])
    const reg = new HostRegistry([observed, herdr, store])
    reg.entries()
    expect([observed.calls(), herdr.calls(), store.calls()]).toEqual([1, 1, 1])
    observed.set([ended({ id: 'o', sessionId: 's' })])
    reg.entries()
    expect([observed.calls(), herdr.calls(), store.calls()]).toEqual([2, 2, 2])
  })
})

describe('capsLetters', () => {
  it('capsLetters({status,voice,answer}) === sva', () => {
    expect(capsLetters({ status: true, voice: true, focus: false, answer: true })).toBe('sva')
    expect(capsLetters({ status: true, voice: true, focus: true, answer: true })).toBe('svfa')
    expect(capsLetters({ status: false, voice: false, focus: false, answer: false })).toBe('')
  })
})
