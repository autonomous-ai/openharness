import { describe, expect, it } from 'vitest'
import type { UsageEvent } from './api.js'
import { createUsageOutcomes, MEASURED_REQUESTS } from './usageOutcomes.js'

const LOCAL = { local: true, tool: false, role: null }

function outcomes() {
  const sent: UsageEvent[] = []
  let at = 1_000
  const usage = createUsageOutcomes({ send: (event) => { sent.push(event) }, now: () => at })
  return { usage, sent, advance: (ms: number) => { at += ms } }
}

describe('what the usage report counts of a request, told raw', () => {
  it('tells nothing of a request it does not measure', () => {
    const { usage, sent } = outcomes()
    expect(usage.request('terminal_input', { data: 'PRIVATE' }, LOCAL)).toBeNull()
    expect(sent).toEqual([])
    expect(MEASURED_REQUESTS.has('agent_create')).toBe(true)
  })

  it('tells a request as it comes with the facts its counters are named from, and nothing else of its payload', () => {
    const { usage, sent } = outcomes()
    usage.request('agent_create', { creationId: 'c'.repeat(20), engine: 'codex', startedBy: 'agent', startedByHachi: true,
      userAction: true, usageSurface: 'phone', usageIntent: 'interactive', agentId: 'agent-1', cwd: '/PRIVATE', prompt: 'PRIVATE' },
    { local: false, tool: false, role: 'web' })
    expect(sent).toEqual([{ kind: 'request', request: { type: 'agent_create', local: false, tool: false, role: 'web', phone: true, userAction: true,
      creationId: 'c'.repeat(20), engine: 'codex', agentStarted: true, hachiStarted: true, interactive: true, agentId: 'agent-1' } }])
    // Too long to be what the report reads, a fact is none; so is a payload that is no record.
    usage.request('agent_create', { creationId: 'c'.repeat(97), engine: 'e'.repeat(33), agentId: 'a'.repeat(257), startedBy: 'person', usageIntent: 'tool' }, LOCAL)
    usage.request('session_search', ['PRIVATE'], { local: true, tool: true, role: null })
    expect(sent.slice(1)).toEqual([
      { kind: 'request', request: { type: 'agent_create', local: true, tool: false, role: null } },
      { kind: 'request', request: { type: 'session_search', local: true, tool: true, role: null } },
    ])
    expect(JSON.stringify(sent)).not.toContain('PRIVATE')
  })

  it('tells each answer with what its reply said, bounded, and which was the first; a later one only for its launch', () => {
    const { usage, sent, advance } = outcomes()
    const measured = usage.request('agent_create', { creationId: 'c'.repeat(20) }, LOCAL)!
    advance(1_500)
    measured.answered({ error: 'SPAWN_FAILED', state: 'failed', agent: { id: 'agent-1', launch: { state: 'failed', error: 'ENGINE_DID_NOT_START', detail: 'PRIVATE' }, cwd: '/PRIVATE' },
      ok: false, reason: 'changed_during', held: { service: 'install' }, detail: 'PRIVATE' })
    advance(500)
    measured.answered({ state: 'created', agent: { id: 'agent-1' } })
    measured.receipt('started')
    const request = { type: 'agent_create', local: true, tool: false, role: null, creationId: 'c'.repeat(20) }
    expect(sent.slice(1)).toEqual([
      { kind: 'answer', request, first: true, elapsedMs: 1_500, answer: { error: 'SPAWN_FAILED', state: 'failed', hasAgent: true, ok: false,
        preparation: 'changed_during', agent: { id: 'agent-1', launch: { state: 'failed', error: 'ENGINE_DID_NOT_START' } }, held: 'install' } },
      // A later reply still says what became of the launch; a receipt after an answer says nothing.
      { kind: 'answer', request, first: false, elapsedMs: 2_000, answer: { state: 'created', hasAgent: true, agent: { id: 'agent-1' } } },
    ])
    expect(JSON.stringify(sent)).not.toContain('PRIVATE')
  })

  it('reads an error, a reason and an agent as the report reads them: a code too long to be listed, one that is no string, none', () => {
    const { usage, sent } = outcomes()
    const answer = (reply: Record<string, unknown>) => {
      usage.request('agent_resume', {}, LOCAL)!.answered(reply)
      return (sent.at(-1) as Extract<UsageEvent, { kind: 'answer' }>).answer
    }
    expect(answer({ error: `PRIVATE${'x'.repeat(64)}` })).toEqual({ error: '-'.repeat(65) })
    expect(answer({ error: { code: 'PRIVATE' } })).toEqual({ error: true })
    expect(answer({ error: null, failure: { code: 'RESUME_FAILED', reason: 'invalid_json' } })).toEqual({ error: 'RESUME_FAILED', preparation: 'invalid_json' })
    expect(answer({ failure: 'PRIVATE', reason: `PRIVATE${'x'.repeat(64)}` })).toEqual({ preparation: null })
    expect(answer({ failure: { reason: null } })).toEqual({ preparation: null })
    expect(answer({ reason: null })).toEqual({})
    expect(answer({ state: 's'.repeat(65), held: 'install', ok: true })).toEqual({})
    expect(answer({ held: { service: 's'.repeat(33) } })).toEqual({})
    expect(answer({ agent: true })).toEqual({ hasAgent: true, agent: true })
    expect(answer({ agent: ['PRIVATE'] })).toEqual({ hasAgent: true, agent: true })
    expect(answer({ agent: {} })).toEqual({ hasAgent: true, agent: {} })
    expect(answer({ agent: { id: 'i'.repeat(257), launch: 'PRIVATE' } })).toEqual({ hasAgent: true, agent: {} })
    expect(answer({ agent: { launch: { state: 's'.repeat(33), error: { code: 'PRIVATE' } } } })).toEqual({ hasAgent: true, agent: { launch: {} } })
    expect(answer({ agent: { launch: { error: `PRIVATE${'x'.repeat(64)}` } } })).toEqual({ hasAgent: true, agent: { launch: { error: '-'.repeat(65) } } })
    expect(JSON.stringify(sent)).not.toContain('PRIVATE')
  })

  it('tells what became of a person\'s message once, as the first answer', () => {
    const { usage, sent } = outcomes()
    const measured = usage.request('message', { agentId: 'a1', content: 'PRIVATE' }, LOCAL)!
    measured.receipt('held')
    measured.receipt('started')
    measured.answered({ error: 'LATE' })
    const request = { type: 'message', local: true, tool: false, role: null, agentId: 'a1' }
    expect(sent).toEqual([
      { kind: 'request', request },
      { kind: 'answer', request, first: true, elapsedMs: 0, answer: { message: 'held' } },
      { kind: 'answer', request, first: false, elapsedMs: 0, answer: { error: 'LATE' } },
    ])
  })

  it('tells hn\'s own observation as it sent it, and nothing of one that is no record or too long to be one', () => {
    const { usage, sent } = outcomes()
    usage.observed({ flow: 'remote_connect', outcome: 'ok', durationMs: 12 })
    usage.observed(['flow'])
    usage.observed(null)
    usage.observed({ flow: 'x'.repeat(600) })
    usage.observed({ flow: 'remote_connect', durationMs: 1n })
    expect(sent).toEqual([{ kind: 'observed', payload: { flow: 'remote_connect', outcome: 'ok', durationMs: 12 } }])
  })

  it('measures time on the clock it is given, or the wall clock', async () => {
    const sent: UsageEvent[] = []
    const usage = createUsageOutcomes({ send: (event) => { sent.push(event) } })
    usage.request('session_search', {}, LOCAL)!.answered({})
    expect((sent[1] as Extract<UsageEvent, { kind: 'answer' }>).elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
