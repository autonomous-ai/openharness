import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLife } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { agentLifeIn, followLink } from './followLink.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude' }) as RegisteredSession
const told = (event: AgentLife) => ({ kind: 'agent', event })

/** A core that answers `follow_agents` with [answer]. */
const coreAnswering = (answer: Record<string, unknown>) => vi.fn(async (_query: string, _payload?: Record<string, unknown>) => answer)

function setup(options: Parameters<typeof followLink>[0] = {}) {
  const log = vi.fn()
  const link = followLink(options, log)
  const heard: AgentLife[] = []
  link.follow((event) => { heard.push(event) })
  return { link, log, heard }
}

describe('what a service in its own process hears of agents', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('frame publishers learn a current lease on every connection, including a restarted core with the same agent', async () => {
    const { link, heard } = setup({ frames: true })
    const old = { ...agent('a'), frameEpoch: 'old-core:1' }, next = { ...agent('a'), frameEpoch: 'new-core:1' }
    await link.connected(coreAnswering({ agents: [old] }))
    link.disconnected()
    await link.connected(coreAnswering({ agents: [old] }))
    link.disconnected()
    await link.connected(coreAnswering({ agents: [next] }))
    expect(heard).toEqual([{ kind: 'running', session: old }, { kind: 'running', session: old }, { kind: 'running', session: next }])
  })

  it('reads only what the core tells of an agent, in the shape it tells it', () => {
    expect(agentLifeIn({ kind: 'touch' })).toBeNull()
    expect(agentLifeIn({ kind: 'agent' })).toBeNull()
    expect(agentLifeIn({ kind: 'agent', event: 'running' })).toBeNull()
    expect(agentLifeIn(told({ kind: 'running', session: agent('a1') }))).toEqual({ kind: 'running', session: agent('a1') })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'running', session: { dsh: 'x' } } })).toBeNull()
    expect(agentLifeIn(told({ kind: 'ended', agentId: 'a1' }))).toEqual({ kind: 'ended', agentId: 'a1' })
    expect(agentLifeIn(told({ kind: 'stopped', agentId: 'a1' }))).toEqual({ kind: 'stopped', agentId: 'a1' })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'stopped', agentId: '' } })).toBeNull()
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'purged', agentId: 'a1', sessionIds: ['s1', 7, ''] } })).toEqual({ kind: 'purged', agentId: 'a1', sessionIds: ['s1'] })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'purged', agentId: 'a1', sessionIds: 's1' } })).toBeNull()
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'purged', sessionIds: [] } })).toBeNull()
    expect(agentLifeIn(told({ kind: 'taken', from: 'a1', to: 'a2' }))).toEqual({ kind: 'taken', from: 'a1', to: 'a2' })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'taken', from: 'a1', to: 'g1', guest: true } })).toEqual({ kind: 'taken', from: 'a1', to: 'g1', guest: true })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'taken', from: 'a1', to: 'g1', guest: 'yes' } })).toEqual({ kind: 'taken', from: 'a1', to: 'g1' })
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'taken', from: 'a1' } })).toBeNull()
    expect(agentLifeIn({ kind: 'agent', event: { kind: 'moved' } })).toBeNull()
  })

  it('tells its followers what the core tells, and says whether it was what happens to an agent', () => {
    const { link, heard } = setup()
    expect(link.heard({ kind: 'stream' })).toBe(false)
    // One it cannot read is the core's to have sent: taken, and told to nobody.
    expect(link.heard({ kind: 'agent', event: { kind: 'running' } })).toBe(true)
    expect(link.heard(told({ kind: 'running', session: agent('a1') }))).toBe(true)
    link.heard(told({ kind: 'purged', agentId: 'a1', sessionIds: ['s1'] }))
    link.heard(told({ kind: 'ended', agentId: 'a1' }))
    expect(heard).toEqual([{ kind: 'running', session: agent('a1') }, { kind: 'purged', agentId: 'a1', sessionIds: ['s1'] }, { kind: 'ended', agentId: 'a1' }])
  })

  it('a follower that comes later is told at once the agents it was told run, and hears nothing once it stops', () => {
    const { link } = setup()
    link.heard(told({ kind: 'running', session: agent('a1') }))
    link.heard(told({ kind: 'running', session: agent('a2') }))
    link.heard(told({ kind: 'ended', agentId: 'a2' }))
    const later: AgentLife[] = []
    const unfollow = link.follow((event) => { later.push(event) })
    expect(later).toEqual([{ kind: 'running', session: agent('a1') }])
    unfollow()
    link.heard(told({ kind: 'stopped', agentId: 'a1' }))
    expect(later).toHaveLength(1)
  })

  it('a follower that throws is said in the log, and the others go on', () => {
    const { link, log, heard } = setup()
    link.heard(told({ kind: 'running', session: agent('a1') }))
    link.follow(() => { throw new Error('boom') })
    link.follow(() => { throw 'not an error' })
    link.heard(told({ kind: 'stopped', agentId: 'a1' }))
    expect(log.mock.calls).toEqual([
      ['[agents] a follower failed on running: Error'],
      ['[agents] a follower failed on running: string'],
      ['[agents] a follower failed on stopped: Error'],
      ['[agents] a follower failed on stopped: string'],
    ])
    expect(heard.map((event) => event.kind)).toEqual(['running', 'stopped'])
  })

  it('says a failing follower in the process\'s log when it is given none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const link = followLink({})
    link.follow(() => { throw new Error('boom') })
    link.heard(told({ kind: 'stopped', agentId: 'a1' }))
    expect(warn).toHaveBeenCalledWith('[agents] a follower failed on stopped: Error')
  })

  describe('as it connects', () => {
    it('asks to follow as it follows, and catches up: the agents listed run, the ones it was told run and no longer listed ended', async () => {
      const { link, heard } = setup({ each: true, having: ['dsh'] })
      link.heard(told({ kind: 'running', session: agent('gone') }))
      link.heard(told({ kind: 'running', session: agent('kept') }))
      link.disconnected()
      const query = coreAnswering({ agents: [agent('kept'), agent('new'), { not: 'an agent' }] })
      await link.connected(query)
      expect(query).toHaveBeenCalledWith('follow_agents', { each: true, having: ['dsh'] })
      // At every look, asked so: one it knew is told again.
      expect(heard.slice(2)).toEqual([{ kind: 'ended', agentId: 'gone' }, { kind: 'running', session: agent('kept') }, { kind: 'running', session: agent('new') }])
    })

    it('once a run, an agent it knew runs is not told again', async () => {
      const { link, heard } = setup()
      link.heard(told({ kind: 'running', session: agent('kept') }))
      await link.connected(coreAnswering({ agents: [agent('kept')] }))
      expect(heard).toEqual([{ kind: 'running', session: agent('kept') }])
    })

    it('leaves an agent heard of since it asked: news newer than the answer', async () => {
      const { link, heard } = setup()
      link.heard(told({ kind: 'running', session: agent('a1') }))
      let answer: (value: Record<string, unknown>) => void = () => {}
      const connecting = link.connected(() => new Promise((done) => { answer = done }))
      link.heard(told({ kind: 'running', session: agent('a4') }))
      link.heard(told({ kind: 'ended', agentId: 'a1' }))
      answer({ agents: [agent('a1')] })
      await connecting
      expect(heard).toEqual([
        { kind: 'running', session: agent('a1') },
        { kind: 'running', session: agent('a4') },
        { kind: 'ended', agentId: 'a1' },
      ])
    })

    it('uses no answer that comes after its connection ended or a newer one began', async () => {
      const { link, heard } = setup()
      let answer: (value: Record<string, unknown>) => void = () => {}
      const old = link.connected(() => new Promise((done) => { answer = done }))
      link.disconnected()
      answer({ agents: [agent('late')] })
      await old
      expect(heard).toEqual([])
      expect(await link.ready(0)).toBe(false)
    })

    it('a core that does not answer, or answers no agents, tells it nothing as agents run, said once a connection', async () => {
      const { link, log, heard } = setup()
      await link.connected(coreAnswering({ error: 'UNKNOWN_QUERY' }))
      await link.connected(vi.fn(async () => { throw new Error('the core went away') }))
      await link.connected(coreAnswering({ agents: 'none' }))
      expect(log.mock.calls).toEqual([
        ['[agents] the core did not answer what agents to follow (UNKNOWN_QUERY): none is heard of as it runs'],
        ['[agents] the core did not answer what agents to follow (no answer): none is heard of as it runs'],
        ['[agents] the core did not answer what agents to follow (no answer): none is heard of as it runs'],
      ])
      expect(heard).toEqual([])
      expect(await link.ready(0)).toBe(false)
    })

    it("a core's refusal in words is said by its length, never its words", async () => {
      const { link, log } = setup()
      await link.connected(coreAnswering({ error: 'peer said /Users/sentinel/x' }))
      const lines = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(lines).not.toContain('sentinel')
      expect(lines).toContain('[agents] the core did not answer what agents to follow (text(27)): none is heard of as it runs')
    })

    it('one that follows no runs asks nothing: what it hears the core holds for it', async () => {
      const { link } = setup({ running: false })
      const query = coreAnswering({ agents: [] })
      await link.connected(query)
      expect(query).not.toHaveBeenCalled()
    })
  })

  describe('whether it is caught up', () => {
    it('at once once this connection\'s catch-up is in, and not after the connection ends', async () => {
      const { link } = setup()
      await link.connected(coreAnswering({ agents: [] }))
      expect(await link.ready(10_000)).toBe(true)
      link.disconnected()
      expect(await link.ready(0)).toBe(false)
    })

    it('waits for the catch-up, at most as long as it is asked to', async () => {
      vi.useFakeTimers()
      const { link } = setup()
      const late = link.ready(1_000)
      const caught = link.ready(5_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await late).toBe(false)
      await link.connected(coreAnswering({ agents: [] }))
      expect(await caught).toBe(true)
    })
  })
})
