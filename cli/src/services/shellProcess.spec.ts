import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi } from '../core/api.js'
import { SHELL_REQUESTS } from '../lib/shellProtocol.js'
import { runServiceProcess, type ServiceProcessOptions } from './process.js'
import { runShellService, shellCoreApi } from './shellProcess.js'
import { startShell } from './shell.js'
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
afterEach(() => vi.clearAllMocks())

describe('shell requests in the edge process', () => {
  it('preserves launch refusals and details, and treats missing confirmation as uncertain', async () => {
    const ask = vi.fn(async () => ({ ok: true, agentId: 'a' }) as Record<string, unknown>)
    const core = shellCoreApi('/data', ask)
    const request = { argv: ['sh'], cwd: '/work' }
    expect(await core.terminals.open(request)).toEqual({ ok: true, agentId: 'a' })
    expect(ask).toHaveBeenLastCalledWith('open', request)
    ask.mockResolvedValueOnce({ ok: false, error: 'BUSY', detail: 'worktree in use' })
    expect(await core.terminals.open(request)).toEqual({ ok: false, error: 'BUSY', detail: 'worktree in use' })
    ask.mockResolvedValueOnce({ ok: false, error: 'FAILED', detail: 7 })
    expect(await core.terminals.open(request)).toEqual({ ok: false, error: 'FAILED' })
    for (const answer of [{}, { ok: true }, { ok: true, agentId: '' }, { ok: false }, { error: 'QUERY_FAILED' }]) {
      ask.mockResolvedValueOnce(answer)
      await expect(core.terminals.open(request)).rejects.toThrow('did not confirm')
    }
  })
  it('reads current descriptions and never guesses that an engine exited', async () => {
    const ask = vi.fn(async () => ({ agent: { id: 'a' } }) as Record<string, unknown>)
    const core = shellCoreApi('/data', ask)
    expect(await core.terminals.describe('a')).toEqual({ id: 'a' })
    expect(ask).toHaveBeenLastCalledWith('describe', { agentId: 'a' })
    for (const agent of [null, undefined, 7, []]) {
      ask.mockResolvedValueOnce({ agent })
      expect(await core.terminals.describe('a')).toBeNull()
    }
    ask.mockResolvedValueOnce({ error: 'QUERY_FAILED' })
    await expect(core.terminals.describe('a')).rejects.toThrow('did not answer')
    for (const exited of [undefined, 'true', false, true]) {
      ask.mockResolvedValueOnce({ exited })
      expect(await core.terminals.visitStatus('a')).toEqual({ exited: exited === true })
      expect(ask).toHaveBeenLastCalledWith('visitStatus', { agentId: 'a' })
    }
    ask.mockRejectedValueOnce(new Error('disconnected'))
    await expect(core.terminals.visitStatus('a')).rejects.toThrow('disconnected')
  })
  it('uses the current connection and refuses calls while disconnected', async () => {
    let options!: ServiceProcessOptions, core!: CoreApi
    const stop = vi.fn()
    const service = runShellService({ dataDir: '/data', socketPath: '/socket', machineId: 'm', token: 't',
      run: o => { options = o; return { stop } }, start: c => { core = c; return {} } })
    expect(options).toMatchObject({ name: 'shell', socketPath: '/socket', machineId: 'm', token: 't' })
    await expect(core.terminals.describe('a')).rejects.toThrow('disconnected')
    options.onConnected!({ query: async () => ({ agent: { id: 'a' } }) })
    expect(await core.terminals.describe('a')).toEqual({ id: 'a' })
    options.onDisconnected!()
    await expect(core.terminals.describe('a')).rejects.toThrow('disconnected')
    options.onConnected!({ query: async () => ({ agent: null }) })
    expect(await core.terminals.describe('a')).toBeNull()
    service.stop()
    expect(stop).toHaveBeenCalledOnce()
    const dataDir = mkdtempSync(join(tmpdir(), 'shell-process-'))
    try {
      runShellService({ dataDir, socketPath: '/socket', machineId: 'm', token: 't' })
      expect(Object.keys(vi.mocked(runServiceProcess).mock.calls.at(-1)![0].requests).sort()).toEqual([...SHELL_REQUESTS].sort())
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
  it('does not repeat a launch whose reply was lost, even after the service restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shell-receipt-'))
    const ask = vi.fn(async () => { throw new Error('link lost after launch') })
    const payload = { creationId: randomUUID(), argv: ['sh'], cwd: dataDir }
    const owner = { local: true, owner: true }
    try {
      const first = startShell(shellCoreApi(dataDir, ask))
      const result = await first.shell_open!(payload, owner)
      expect(result).toMatchObject({ creationId: payload.creationId, state: 'unconfirmed' })
      const restarted = startShell(shellCoreApi(dataDir, ask))
      expect(await restarted.shell_open!(payload, owner)).toEqual(result)
      expect(await restarted.shell_open_status!(payload, owner)).toEqual(result)
      expect(ask).toHaveBeenCalledTimes(1)
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
})
