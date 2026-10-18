import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { summariesOf, summaryReader } from './summaries.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude' }) as RegisteredSession

describe('the one-line summaries of the agents asked about', () => {
  const setup = (states: Record<string, 'working' | 'idle' | 'unknown'>, prompts: Record<string, string>, recaps: Record<string, string | undefined>) => {
    const recap = vi.fn(async (agentId: string) => recaps[agentId])
    return { recap, run: (ids: string[]) => summariesOf(ids, {
      live: (agentId) => (agentId in states ? agent(agentId) : undefined),
      state: (session) => states[session.agentId],
      running: (agentId) => prompts[agentId],
      recap,
    }) }
  }

  it('is the running prompt while an agent works, and the latest recap line once it is idle, else the prompt', async () => {
    const t = setup({ w: 'working', i: 'idle', p: 'idle', u: 'unknown' }, { w: 'Fix the login', i: 'Fix it', p: 'Prompt only', u: 'Hm' }, { w: 'old recap', i: 'Fixed the login', p: undefined })
    expect(await t.run(['w', 'i', 'p', 'u'])).toEqual({ w: 'Fix the login', i: 'Fixed the login', p: 'Prompt only', u: 'Hm' })
  })

  it('reads no recap for an agent that works: the prompt is what it does', async () => {
    const t = setup({ w: 'working' }, { w: 'Fix the login' }, {})
    await t.run(['w'])
    expect(t.recap).not.toHaveBeenCalled()
  })

  it('leaves out an agent that is not live, and one nothing is known about', async () => {
    const t = setup({ i: 'idle' }, {}, {})
    expect(await t.run(['i', 'gone'])).toEqual({})
  })

  it('is cut and cleaned as a summary is, whatever the prompt held', async () => {
    const t = setup({ w: 'working' }, { w: `\n‮${'x'.repeat(300)}` }, {})
    const summary = (await t.run(['w'])).w
    expect(summary).toHaveLength(120)
    expect(summary).not.toMatch(/‮/)
  })

  it('takes an agent whose state is not read as unknown: the latest recap, else the prompt', async () => {
    const out = await summariesOf(['a', 'b'], { live: agent, state: () => undefined, running: () => 'Prompt', recap: async (id) => (id === 'a' ? 'Recap' : undefined) })
    expect(out).toEqual({ a: 'Recap', b: 'Prompt' })
  })

  it('treats a recap that cannot be read as none: the prompt stands in', async () => {
    const recap = vi.fn(async () => { throw new Error('mirror') })
    const out = await summariesOf(['i'], { live: agent, state: () => 'idle', running: () => 'Prompt', recap })
    expect(out).toEqual({ i: 'Prompt' })
  })
})

describe('the reader the core hands out', () => {
  it('reads the kept prompt and the latest recap line of the agent through the same rules', async () => {
    const prompts = new Map([['i', 'Fix it'], ['w', 'Fix the login']])
    const recent = vi.fn(async (agentId: string) => (agentId === 'i' ? [{ recap: 'Fixed it' }] : []))
    const read = summaryReader({ live: agent, state: (session) => (session.agentId === 'w' ? 'working' : 'idle'), prompts, recent })
    expect(await read(['i', 'w'])).toEqual({ i: 'Fixed it', w: 'Fix the login' })
    expect(recent).toHaveBeenCalledWith('i')
    expect(recent).not.toHaveBeenCalledWith('w')
    // No turn recapped yet: the prompt stands in.
    expect(await summaryReader({ live: agent, state: () => 'idle', prompts, recent: async () => [{}] })(['i'])).toEqual({ i: 'Fix it' })
  })
})
