import { describe, expect, it } from 'vitest'
import type { Daemon } from '../../agentClient/daemon.js'
import { stopEveryAgent } from './agents.js'

function daemon(agents: Array<Record<string, unknown>>, answers: Record<string, Record<string, unknown>> = {}) {
  const requests: string[] = []
  let closed = false
  const line: Daemon = {
    machineId: 'm',
    close: () => { closed = true },
    request: async (type, payload = {}) => {
      requests.push(type === 'agent_delete' ? `${type} ${payload.agentId}` : type)
      if (type === 'agents_list') return { agents }
      return answers[String(payload.agentId)] ?? { ok: true }
    },
  }
  return { line, requests, closed: () => closed }
}

describe('stopEveryAgent', () => {
  it('stops each harness the daemon lists, and says which would not stop', async () => {
    const d = daemon([{ id: 'aaaaaaaa-1', name: 'codex-auth' }, { id: 'bbbbbbbb-2' }, { id: 'cccccccc-3', name: 'pwsh' }],
      { 'bbbbbbbb-2': { error: 'IDENTITY_UNAVAILABLE', detail: 'the native ps probe did not complete' } })
    expect(await stopEveryAgent(async () => d.line)).toEqual({ stopped: 2, failed: [{ name: 'bbbbbbbb', error: 'IDENTITY_UNAVAILABLE: the native ps probe did not complete' }] })
    expect(d.requests.sort()).toEqual(['agent_delete aaaaaaaa-1', 'agent_delete bbbbbbbb-2', 'agent_delete cccccccc-3', 'agents_list'])
    expect(d.closed()).toBe(true)
  })

  it('reports a daemon it cannot reach, and asks nothing', async () => {
    expect(await stopEveryAgent(async () => { throw new Error('connect ECONNREFUSED') })).toEqual({ stopped: 0, failed: [], unreachable: 'connect ECONNREFUSED' })
  })
})
