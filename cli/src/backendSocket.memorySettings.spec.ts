import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { MemoryControl } from './memory/control.js'
import { MemoryExperimentSettings } from './memory/experiment.js'

afterEach(() => vi.restoreAllMocks())

it('lets the verified local owner disable coding memory while companions stay off', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-setting-route-'))
  const settings = new MemoryExperimentSettings(directory)
  const owner = 'a'.repeat(64)
  settings.write(owner, true, 0)
  const socket = new BackendSocket('fixture')
  const runtime = vi.fn(() => null)
  let person = true
  const verify = vi.fn(async () => person ? { ok: true as const, pid: 123 }
    : { ok: false as const, error: 'INSIDE_HARNESS' as const, detail: 'agent' })
  const memory = new MemoryControl({ runtime, verify,
    experiment: { owner: () => owner, read: key => settings.read(key),
      write: async (key, enabled, expected) => settings.write(key, enabled, expected) } })
  socket.daemonsOn = () => false
  socket.pairControl = { verbs: new Set(['memory']), local: (payload, connId) => memory.local(payload, connId) }
  const frames: Array<Record<string, any>> = []
  vi.spyOn(socket, 'sendTo').mockImplementation((_to, frame) => { frames.push(frame) })
  socket.registerLocalClient('local:settings', { sendFrame: () => true, sendBinary: () => true }, { tool: true })
  const ask = async (input: Record<string, unknown>) => {
    const requestId = String(frames.length)
    socket.handleLocalFrame('local:settings', { type: 'pair', payload: { requestId, verb: 'memory', ...input } })
    await vi.waitFor(() => expect(frames.some(frame => frame.payload?.requestId === requestId)).toBe(true))
    return frames.find(frame => frame.payload?.requestId === requestId)!.payload
  }
  try {
    expect(await ask({ action: 'experiment' })).toMatchObject({ ok: true, enabled: true, revision: 1 })
    expect(await ask({ action: 'configure_experiment', enabled: false, expected: 1 }))
      .toMatchObject({ ok: true, enabled: false, revision: 2 })
    expect(new MemoryExperimentSettings(directory).enabled(owner)).toBe(false)
    expect(await ask({ action: 'configure_experiment', enabled: true, expected: 2, token: 'agent' }))
      .toMatchObject({ error: 'PERSON_ONLY' })
    person = false
    expect(await ask({ action: 'configure_experiment', enabled: true, expected: 2 }))
      .toMatchObject({ error: 'INSIDE_HARNESS' })
    person = true
    expect(await ask({ action: 'experiment', owner: 'b'.repeat(64) })).toMatchObject({ error: 'INVALID_INPUT' })
    verify.mockClear()
    for (const action of ['status', 'list', 'show', 'preview', 'apply']) {
      expect(await ask({ action })).toMatchObject({ error: 'DAEMONS_OFF' })
    }
    expect(await ask({ verb: 'recall_memory', query: 'test' })).toMatchObject({ error: 'DAEMONS_OFF' })
    expect(verify).not.toHaveBeenCalled()
    expect(runtime).not.toHaveBeenCalled()
    expect(settings.enabled(owner)).toBe(false)
    socket.pairControl = null
    expect(await ask({ action: 'experiment' })).toMatchObject({ error: 'DAEMONS_OFF' })
  } finally {
    await socket.unregisterLocalClient('local:settings')
    await socket.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
