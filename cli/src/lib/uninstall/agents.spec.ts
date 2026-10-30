import { describe, expect, it, vi } from 'vitest'
import type { Daemon } from '../../agentClient/daemon.js'
import { AGENT_STOP_TIMEOUT_MS, AGENTS_AT_ONCE, stopEveryAgent } from './agents.js'

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

  it('runs at most AGENTS_AT_ONCE stops at a time, and stops them all', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}`, name: `n${i}` }))
    let inFlight = 0, peak = 0
    const line: Daemon = {
      machineId: 'm', close: () => {},
      request: async (type) => {
        if (type === 'agents_list') return { agents }
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { ok: true }
      },
    }
    expect(await stopEveryAgent(async () => line)).toEqual({ stopped: 10, failed: [] })
    expect(peak).toBe(AGENTS_AT_ONCE)
  })

  it('does not let one hung harness hold the others', async () => {
    vi.useFakeTimers()
    try {
      const line: Daemon = {
        machineId: 'm', close: () => {},
        request: async (type, payload = {}, timeoutMs) => {
          if (type === 'agents_list') return { agents: [{ id: 'a', name: 'hung' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }] }
          if (payload.agentId === 'a') {
            return new Promise((_, reject) => setTimeout(() => reject(new Error('Harness did not answer agent_delete in time.')), timeoutMs))
          }
          return { ok: true }
        },
      }
      const done = stopEveryAgent(async () => line)
      await vi.advanceTimersByTimeAsync(AGENT_STOP_TIMEOUT_MS)
      expect(await done).toEqual({ stopped: 2, failed: [{ name: 'hung', error: 'Harness did not answer agent_delete in time.' }] })
    } finally { vi.useRealTimers() }
  })

  it('reports a request that throws as a failed harness', async () => {
    const line: Daemon = {
      machineId: 'm', close: () => {},
      request: async (type) => {
        if (type === 'agents_list') return { agents: [{ id: 'a', name: 'x' }] }
        throw new Error('The connection to Harness closed.')
      },
    }
    expect(await stopEveryAgent(async () => line)).toEqual({ stopped: 0, failed: [{ name: 'x', error: 'The connection to Harness closed.' }] })
  })

  it('closes the line when the list itself throws', async () => {
    let closed = false
    const line: Daemon = { machineId: 'm', close: () => { closed = true }, request: async () => { throw new Error('boom') } }
    expect(await stopEveryAgent(async () => line)).toEqual({ stopped: 0, failed: [], unreachable: 'boom' })
    expect(closed).toBe(true)
  })

  it('reports DELETE_IN_PROGRESS as a harness that did not stop', async () => {
    const d = daemon([{ id: 'a', name: 'busy' }], { a: { error: 'DELETE_IN_PROGRESS' } })
    expect(await stopEveryAgent(async () => d.line)).toEqual({ stopped: 0, failed: [{ name: 'busy', error: 'DELETE_IN_PROGRESS' }] })
  })

  it('does not read a list error as nothing to stop', async () => {
    const line: Daemon = { machineId: 'm', close: () => {}, request: async () => ({ error: 'NOT_READY', detail: 'starting' }) }
    const result = await stopEveryAgent(async () => line)
    expect(result.stopped).toBe(0)
    expect(result.failed).toEqual([])
    expect(result.unreachable).toContain('NOT_READY: starting')
  })
})
