// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import { describe, expect, it, vi } from 'vitest'
import type { MachineCapabilities } from '../lib/machineCapabilities.js'
import { DISPATCH_RESULT_TYPE, createRemoteAgentBackend, dispatchJob, jobPrompt, placementFilter, type MachineLink, type WireFrame } from './remoteOrchestratorBackend.js'

function fakeLink(machineId = 'mind') {
  const sent: WireFrame[] = []
  const cbs = new Set<(f: WireFrame) => void>()
  const link: MachineLink = {
    machineId,
    send: (f) => { sent.push(f) },
    onFrame: (cb) => { cbs.add(cb); return () => { cbs.delete(cb) } },
  }
  return { link, sent, emit: (f: WireFrame) => { for (const cb of cbs) cb(f) } }
}

describe('createRemoteAgentBackend', () => {
  it('creates an agent over agent_create and correlates the result by requestId', async () => {
    const { link, sent, emit } = fakeLink()
    const b = createRemoteAgentBackend(link, { requestId: (() => { let i = 0; return () => `r${++i}` })() })
    const p = b.create({ engine: 'claude', cwd: '/w', prompt: 'do it', branchName: 'feat/x' })
    expect(sent[0]).toMatchObject({ type: 'agent_create', payload: { requestId: 'r2', creationId: 'r1', engine: 'claude', cwd: '/w', prompt: 'do it', branchName: 'feat/x' } })
    emit({ type: 'agent_create_result', payload: { requestId: 'r2', agentId: 'ag-9' } })
    await expect(p).resolves.toEqual({ agentId: 'ag-9' })
    await b.send('ag-9', 'more')
    await b.cancel('ag-9')
    expect(sent.slice(1)).toEqual([{ type: 'message', payload: { agentId: 'ag-9', content: 'more' } }, { type: 'cancel', payload: { agentId: 'ag-9' } }])
    b.close()
  })

  it('accepts a result echoing only creationId, and surfaces an error payload', async () => {
    const { link, emit } = fakeLink()
    const b = createRemoteAgentBackend(link, { requestId: (() => { let i = 0; return () => `r${++i}` })() })
    const p = b.create({ engine: 'codex', cwd: '/w', prompt: 'x' })
    emit({ type: 'agent_create_result', payload: { creationId: 'r1', id: 'ag-1' } })
    await expect(p).resolves.toEqual({ agentId: 'ag-1' })
    const p2 = b.create({ engine: 'codex', cwd: '/w', prompt: 'x' })
    emit({ type: 'agent_create_result', payload: { requestId: 'r4', error: 'ENGINE_MISSING' } })
    await expect(p2).rejects.toThrow('ENGINE_MISSING')
    b.close()
  })

  it('times out a create that never answers', async () => {
    vi.useFakeTimers()
    try {
      const { link } = fakeLink()
      const b = createRemoteAgentBackend(link, { timeoutMs: 50 })
      const p = b.create({ engine: 'claude', cwd: '/w', prompt: 'x' })
      const assertion = expect(p).rejects.toThrow('timed out after 50 ms')
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      b.close()
    } finally { vi.useRealTimers() }
  })

  it('resolves awaitResult from a dispatch_result frame, before or after the wait starts', async () => {
    const { link, emit } = fakeLink()
    const b = createRemoteAgentBackend(link)
    emit({ type: DISPATCH_RESULT_TYPE, payload: { agentId: 'early', summary: 'done', branch: 'b', diffStat: '1 file' } })
    await expect(b.awaitResult('early')).resolves.toEqual({ agentId: 'early', summary: 'done', branch: 'b', diffStat: '1 file', ok: true })
    const late = b.awaitResult('late', { timeoutMs: 1000 })
    emit({ type: DISPATCH_RESULT_TYPE, payload: { agentId: 'late', summary: 'failed', ok: false } })
    await expect(late).resolves.toMatchObject({ ok: false, summary: 'failed' })
    b.close()
  })

  it('reads status through session_get and returns null on failure', async () => {
    const { link, emit, sent } = fakeLink()
    const b = createRemoteAgentBackend(link, { requestId: () => 'q1', timeoutMs: 20 })
    const p = b.agent('ag-1')
    expect(sent[0]).toEqual({ type: 'session_get', payload: { requestId: 'q1', agentId: 'ag-1' } })
    emit({ type: 'session_get_result', payload: { requestId: 'q1', status: 'active', summary: 's' } })
    await expect(p).resolves.toEqual({ status: 'active', summary: 's' })
    await expect(b.agent('ag-2')).resolves.toBeNull()
    b.close()
  })

  it('dispatchJob composes create, brief and result', async () => {
    const { link, sent, emit } = fakeLink('blu')
    const b = createRemoteAgentBackend(link, { requestId: () => 'k' })
    const p = dispatchJob(b, { brief: 'Add ring animation', repo: '/w/pulse', branchName: 'feat/rings', engine: 'claude', machineId: 'blu', timeoutMs: 5000 })
    expect(sent[0]!.payload.prompt).toBe(jobPrompt({ brief: 'Add ring animation', repo: '/w/pulse', branchName: 'feat/rings', engine: 'claude', machineId: 'blu' }))
    expect(String(sent[0]!.payload.prompt)).toContain('DISPATCH_RESULT:')
    emit({ type: 'agent_create_result', payload: { requestId: 'k', agentId: 'w1' } })
    emit({ type: DISPATCH_RESULT_TYPE, payload: { agentId: 'w1', summary: 'rings added', branch: 'feat/rings' } })
    await expect(p).resolves.toMatchObject({ agentId: 'w1', branch: 'feat/rings' })
    b.close()
  })
})

const caps = (over: Partial<MachineCapabilities> & { free?: number; util?: number }): MachineCapabilities => ({
  at: 0, hostname: 'h', cpu: { cores: 8, load1: 1, load5: 1 },
  gpus: over.free === undefined ? [] : [{ name: 'g', vramTotalMb: 12000, vramUsedMb: 12000 - over.free, utilizationPct: over.util ?? 0 }],
  power: { onAc: true, batteryPct: null }, thermal: { maxC: 50 }, lid: 'unknown', toolchains: {}, ...over,
})

describe('placementFilter', () => {
  it('drops machines that refuse the job and orders the rest by free VRAM then load', () => {
    const out = placementFilter([
      { machineId: 'vic', caps: caps({ free: 4000 }) },
      { machineId: 'gus', caps: caps({ free: 10000, util: 90 }) },
      { machineId: 'mind', caps: caps({ free: 20000 }) },
      { machineId: 'blu', caps: caps({}) },
    ], { needsGpu: true })
    expect(out.map((c) => c.machineId)).toEqual(['mind', 'vic'])
    expect(out[0]!.reasons).toEqual([])
  })
})
