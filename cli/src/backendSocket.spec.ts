import * as gitPullRequest from './lib/gitPullRequest.js'
import * as sessionGitPullRequest from './lib/sessionGitPullRequest.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from './testing/relaySocket.js'
import { AGENT_OPENED_THROTTLE_MS } from './core/agents/update.js'
import { deviceAgentListItem, deviceAgentRow } from './core/agents/list.js'
import { grokHistoryPage } from './core/transcripts/history.js'
import { bindAgentList, bindAgentUpdate, bindCancelRequest, bindLaunchRequests, bindCloseRequests, bindMessageRequest, bindPurgeRequest, bindQuestionResponse, bindStopRequest, bindTerminalRequests } from './testing/socketCore.js'
import { emptyPorts, MODELS_FALLBACKS, MODELS_OFF, MONITOR_FALLBACKS, type ModelsPort } from './core/api.js'
import { createServiceHost, ServiceUnavailableError } from './core/serviceHost.js'
import { MODELS_REQUESTS, startModels } from './services/models.js'
import { SHELL_REQUESTS, startShell } from './services/shell.js'
import { USAGE_REQUESTS, startUsage } from './services/usage.js'
import { MONITOR_REQUESTS, startMonitor, type MonitorDeps } from './services/monitor.js'
import { PROJECTS_REQUESTS, startProjects } from './services/projects.js'
import { createHarnessResourcesReader } from './lib/harnessResources.js'
import { createHarnessStorageReader } from './lib/harnessTelemetry.js'
import { fakeCore } from './testing/fakeCore.js'
import { AuthSessionError, type AuthSessionManager } from './lib/authSession.js'
import { WS_IDLE_DEADLINE_MS as IDLE_DEADLINE_MS } from './lib/wsLiveness.js'
import { TerminalStreamManager } from './lib/terminalStreamManager.js'
import type { TerminalBackendCoordinator } from './lib/terminalBackendCoordinator.js'
import { decodeTerminalLocal, TerminalBinaryKind } from './lib/terminalBinary.js'
import { registry, type RegisteredSession } from './lib/registry.js'
import { stoppedAgents } from './lib/stoppedAgents.js'
import { AgentStopError } from './lib/stopAgentService.js'
import type { PurgeAgentService } from './lib/purgeAgentService.js'
import * as mediaPreview from './lib/mediaPreview.js'
import * as gitProject from './lib/gitProject.js'
import * as scmProjects from './scm/scmProjects.js'
import * as machineResources from './lib/machineResources.js'
import * as projectFolder from './lib/projectFolder.js'
import * as projectPreview from './lib/projectPreview.js'
import * as opencodeVersion from './engines/opencode/version.js'
import { randomUUID } from 'node:crypto'
import { fakeGridAnswers, installFakeGrid, type FakeGrid } from './lib/__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache } from './lib/gridMcpUrl.js'
import { LocalModels } from './lib/localModels.js'
import { STRICT_DOWN_TYPES, encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './lib/e2ee/applicationFrames.js'
import { CloseAgentService } from './lib/closeAgentService.js'
import { env } from './config/env.js'

describe('safe session close RPC', () => {
  it('seals cleanup previews and passes the open-tab condition to Close', async () => {
    const socket = relaySocket('fixture'), frames: any[] = []
    socket.registerLocalClient('local:cleanup', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    const cleanupPreview = vi.fn(async () => ({ version: 1, agents: [], kept: 2 }))
    bindCloseRequests(socket, cleanupPreview)
    const request = vi.fn(async () => ({ error: 'SESSION_IN_TAB' }))
    socket.closeAgentService = { request, dispose() {} } as unknown as CloseAgentService
    expect(encryptDownFrame('agents_cleanup_preview')).toBe(true)
    expect(encryptRpcResult('agents_cleanup_preview_result')).toBe(true)
    await dispatchDown(socket, { type: 'agents_cleanup_preview', payload: { requestId: 'unsealed' } }, 'remote')
    expect(cleanupPreview).not.toHaveBeenCalled()
    socket.handleLocalFrame('local:cleanup', { type: 'agents_cleanup_preview', payload: { requestId: 'preview' } })
    const target = { agentId: 'a', sessionId: 's', createdAt: '2026-10-01T00:00:00.000Z', mode: 'now', onlyIfHidden: true }
    socket.handleLocalFrame('local:cleanup', { type: 'agent_close', payload: { ...target, requestId: 'close' } })
    await vi.waitFor(() => expect(frames.some(f => f.payload?.requestId === 'close')).toBe(true))
    expect(request).toHaveBeenCalledWith(target)
    expect(frames.find(f => f.payload?.requestId === 'preview').payload).toMatchObject({ version: 1, kept: 2 })
    await socket.stop()
  })
  it.each([
    { activity: 'idle', sessionId: 'close-history' },
    { activity: 'working', sessionId: 'close-history' },
    { activity: 'idle', sessionId: '' },
    { activity: 'working', sessionId: '' },
  ] as const)('uses $activity activity for session "$sessionId" even with another live viewer', async ({ activity, sessionId }) => {
    const socket = relaySocket('fixture')
    const frames: any[] = []
    for (const connId of ['local:close', 'local:other']) {
      socket.registerLocalClient(connId, {
        sendFrame: frame => { frames.push({ connId, ...frame }); return true },
        sendBinary: () => true,
      })
    }
    const row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%7302' }], cwd: '/tmp' })!
    row.sessionId = sessionId
    const checkpoint = vi.fn(async () => {})
    const stop = vi.fn(async (_agentId, options) => {
      await options.checkpoint(row, 'before')
      await options.beforeStop(row)
      expect(options.current()).toBe(true)
      registry.removeAgent(row.agentId)
    })
    socket.closeAgentService = new CloseAgentService({
      registry, activity: async () => activity, checkpoint, stop, changed: () => {},
    })
    bindCloseRequests(socket)
    const terminals = new TerminalStreamManager({
      terminals: {
        openStream: async () => ({ state: 'succeeded', value: {
          runtime: { backend: 'tmux', paneId: '%7302' },
          beginSnapshot: () => {},
          endSnapshot: () => {},
          snapshot: async () => ({ state: 'succeeded', value: { bytes: Buffer.from('fixture'), cols: 80, rows: 24 } }),
          close: async () => {},
        } }),
      } as unknown as TerminalBackendCoordinator,
      resolveAgent: id => registry.byAgent(id),
      sendTarget: (connId, type, payload) => { frames.push({ connId, type, payload }); return true },
      sendBinaryTarget: () => true,
      streamingAvailable: true,
    })
    socket.setTerminalStreamManager(terminals)
    try {
      const opening = { agentId: row.agentId, protocolVersion: 3, cols: 80, rows: 24 }
      await terminals.handleFrame('local:close', 'terminal_open', { ...opening, requestId: 'own' })
      await terminals.handleFrame('local:other', 'terminal_open', { ...opening, requestId: 'other', takeover: false })
      expect(frames.filter(frame => frame.type === 'terminal_ready')).toHaveLength(2)
      expect(frames.find(frame => frame.payload?.requestId === 'other')?.payload.readOnly).toBe(true)
      const closing = { agentId: row.agentId, sessionId: row.sessionId, createdAt: new Date(row.registeredAt).toISOString() }
      const ask = async (mode: string) => {
        socket.handleLocalFrame('local:close', { type: 'agent_close', payload: { ...closing, mode, requestId: mode } })
        await vi.waitFor(() => expect(frames.some(frame => frame.type === 'agent_close_result' && frame.payload.requestId === mode)).toBe(true))
        return frames.find(frame => frame.type === 'agent_close_result' && frame.payload.requestId === mode).payload
      }
      expect(await ask('inspect')).toMatchObject({ activity })
      expect(await ask('idle')).toMatchObject(activity === 'idle' ? { closed: true } : { error: 'SESSION_NOT_IDLE', activity })
      if (activity === 'working') {
        expect(stop).not.toHaveBeenCalled()
        expect(await ask('now')).toMatchObject({ closed: true })
      }
      expect(checkpoint).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledOnce()
      expect(registry.byAgent(row.agentId)).toBeUndefined()
    } finally {
      registry.removeAgent(row.agentId)
      await socket.stop()
    }
  })

  it('requires encrypted remote frames and never blocks unrelated inventory while saving', async () => {
    const socket = relaySocket('fixture')
    bindAgentList(socket)
    const frames: any[] = []
    socket.registerLocalClient('local:close', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    let finish!: (value: { closed: true }) => void
    const request = vi.fn(() => new Promise<{ closed: true }>(resolve => { finish = resolve }))
    socket.closeAgentService = { request, dispose() {} } as unknown as CloseAgentService
    bindCloseRequests(socket)
    const payload = { requestId: 'closing', agentId: 'fixture', sessionId: 'history', createdAt: '2026-09-30T12:00:00.000Z', mode: 'idle' }
    expect(encryptDownFrame('agent_close')).toBe(true)
    expect(encryptRpcResult('agent_close_result')).toBe(true)
    await dispatchDown(socket, { type: 'agent_close', payload }, 'remote')
    expect(request).not.toHaveBeenCalled()
    socket.handleLocalFrame('local:close', { type: 'agent_close', payload })
    socket.handleLocalFrame('local:close', { type: 'agents_list', payload: { requestId: 'inventory' } })
    await vi.waitFor(() => expect(frames.some(f => f.type === 'agents_list_result')).toBe(true))
    expect(frames.some(f => f.type === 'agent_close_result')).toBe(false)
    finish({ closed: true })
    await vi.waitFor(() => expect(frames.find(f => f.type === 'agent_close_result')?.payload).toMatchObject({ requestId: 'closing', closed: true }))
    await socket.stop()
  })
})

describe('reviewed permanent deletion RPCs', () => {
  afterEach(() => vi.restoreAllMocks())
  it('tells a relayed client whose sealed frame finds no session that its session is gone, and only then', async () => {
    const socket = relaySocket('fixture')
    const internals = socket as any
    const sent = () => upstreamOf(socket).queue.map((item: { msg: unknown }) => item.msg)
    const sealed = { type: 'message', payload: { __e2e: { v: 1, k: 'p', n: 3, ct: 'fixture' } } }
    await dispatchDown(socket, sealed, 'web:gone')
    expect(sent()).toContainEqual({ t: 'up', targetConnId: 'web:gone', frame: { type: 'e2e_session_unknown', payload: { refused: { type: 'message', n: 3 } } } })
    // A frame that does not open on a live session is dropped without a word.
    const before = sent().length
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionGone').mockReturnValue(null)
    await dispatchDown(socket, sealed, 'web:live')
    expect(sent()).toHaveLength(before)
  })

  it('tells a relayed client whose terminal bytes find no session that its session is gone', async () => {
    const socket = relaySocket('fixture')
    const internals = socket as any
    const { sealTerminalBinary } = await import('./lib/e2ee/terminalSeal.js')
    const raw = sealTerminalBinary(new Uint8Array(32).fill(7), 9, { kind: 1, streamId: '00112233-4455-6677-8899-aabbccddeeff', seq: 1, bytes: new TextEncoder().encode('ls\r'), compressed: false })!
    const gateway = gatewayOf(socket) as any
    gateway.enqueueTerminalBinary('web:gone', raw)
    await gateway.downChains.get('web:gone')
    expect(upstreamOf(socket).queue.map((item: { msg: unknown }) => item.msg)).toContainEqual({ t: 'up', targetConnId: 'web:gone', frame: { type: 'e2e_session_unknown', payload: { refused: { type: 'terminal_binary', kind: 1, n: 9 } } } })
  })

  it.each(['agent_purge', 'agent_worktree_delete'])('%s requires an owner, explicit identity and a review token', async type => {
    const socket = relaySocket('fixture')
    const internals = socket as any, frames: any[] = []
    socket.registerLocalClient('local:purge', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    const request = vi.fn(async () => ({ reviewId: 'review', sessionBytes: 4096 }))
    socket.purgeAgentService = { busy: () => false, request, worktreeRequest: request } as unknown as PurgeAgentService
    bindPurgeRequest(socket)
    const payload = { requestId: 'delete', agentId: 'selected', sessionId: 'history', createdAt: 1234, mode: 'inspect' }
    expect(encryptDownFrame(type)).toBe(true)
    expect(encryptRpcResult(type + '_result')).toBe(true)
    await dispatchDown(socket, { type, payload }, 'remote')
    expect(request).not.toHaveBeenCalled()
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('device')
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type, payload })
    vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: type + '_result', payload: { __e2e: 'sealed' } })
    const sealed = { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    await dispatchDown(socket, sealed, 'remote')
    expect(request).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    expect(request).toHaveBeenCalledOnce()
    request.mockClear()
    for (const invalid of [{ ...payload, sessionId: undefined }, { ...payload, createdAt: '1234' }, { ...payload, mode: 'delete' }]) {
      await dispatchDown(socket, { type, payload: invalid }, 'local:purge', 'local')
    }
    expect(request).not.toHaveBeenCalled()
    expect(frames.filter(f => f.payload.error === 'INVALID_DELETE_REQUEST')).toHaveLength(3)
    await dispatchDown(socket, { type, payload: { ...payload, mode: 'delete', reviewId: 'review', path: '/reviewed', discardChanges: true } }, 'local:purge', 'local')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review', path: '/reviewed', discardChanges: true }))
    request.mockClear()
    await dispatchDown(socket, { type, payload: { ...payload, mode: 'describe' } }, 'local:purge', 'local')
    expect(request).toHaveBeenCalledTimes(type === 'agent_worktree_delete' ? 1 : 0)
    request.mockClear()
    await dispatchDown(socket, { type, payload: { ...payload, mode: 'delete', reviewId: 'review', choices: { sessionData: false, worktreeData: 'yes' } } }, 'local:purge', 'local')
    expect(request).not.toHaveBeenCalled()
    await dispatchDown(socket, { type, payload: { ...payload, includeWorktree: true, choices: { sessionData: false, worktreeData: true } } }, 'local:purge', 'local')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ includeWorktree: true, choices: { sessionData: false, worktreeData: true } }))
    await socket.stop()
  })
})

describe('local model lifecycle RPCs', () => {
  afterEach(() => vi.restoreAllMocks())
  it('a slow catalog never blocks terminal or agent inventory, and errors stay redacted', async () => {
    const socket = relaySocket('fixture')
    bindAgentList(socket)
    socket.setHarnessGridName('home')
    serveModels(socket)
    const frames: any[] = []
    socket.registerLocalClient('local:models', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    let reject!: (cause: Error) => void
    vi.spyOn(LocalModels.prototype, 'list').mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    socket.handleLocalFrame('local:models', { type: 'grid_fleet_models_list', payload: { requestId: 'catalog' } })
    socket.handleLocalFrame('local:models', { type: 'agents_list', payload: { requestId: 'agents' } })
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'agents_list_result')).toBe(true))
    expect(frames.some(frame => frame.type === 'grid_fleet_models_list_result')).toBe(false)
    reject(new Error('private-token'))
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'grid_fleet_models_list_result')).toBe(true))
    expect(frames.find(frame => frame.type === 'grid_fleet_models_list_result').payload).toMatchObject({ requestId: 'catalog', error: 'Models are unavailable. Try again.' })
    expect(JSON.stringify(frames)).not.toContain('private-token')
    await socket.stop()
  })

  it('rejects unencrypted remote lifecycle requests before reaching the model service', async () => {
    const socket = relaySocket('fixture')
    const models = serveModels(socket)
    const routed = vi.spyOn(models, 'route')
    const act = vi.spyOn(LocalModels.prototype, 'act')
    for (const type of ['grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop']) {
      await dispatchDown(socket, { type, payload: { requestId: 'unsafe', modelId: 'fixture/model' } }, 'remote')
    }
    expect(routed).not.toHaveBeenCalled()
    expect(act).not.toHaveBeenCalled()
    await socket.stop()
  })
})

describe('confirmed harness pause replies', () => {
  it.each(['unsupported', 'unconfirmed', 'confirmed'] as const)('%s stop never sends a false success', async state => {
    const socket = relaySocket('fixture')
    const frames: any[] = []
    socket.registerLocalClient('local:pause', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    if (state !== 'unsupported') bindStopRequest(socket, async () => {
      if (state === 'unconfirmed') throw new AgentStopError('The process could not be verified.')
    })
    await dispatchDown(socket, { type: 'agent_delete', payload: { requestId: 'pause', agentId: 'fixture' } }, 'local:pause')
    const reply = frames.find(frame => frame.type === 'agent_delete_result')?.payload
    expect(reply).toMatchObject(state === 'confirmed' ? { deleted: true } : {
      error: state === 'unsupported' ? 'UNSUPPORTED' : 'STOP_UNCONFIRMED',
    })
    if (state !== 'confirmed') expect(reply.deleted).toBeUndefined()
    if (state === 'unconfirmed') expect(reply.detail).toBe('The process could not be verified.')
    await socket.stop()
  })
})

/**
 * `agent_update {opened: true}` — an app opened this agent, so the daemon that owns it stamps
 * `lastOpenedAt` on its own clock and tells every app, which then all sort by the same "last used".
 */
describe('agent_update opened: one "last used" for every app', () => {
  const OPENED = Date.UTC(2026, 8, 26, 9, 30)
  const iso = (ms: number) => new Date(ms).toISOString()
  let socket: BackendSocket
  let frames: any[]
  let agentId = ''

  beforeEach(() => {
    vi.restoreAllMocks()
    // Only the clock: the dispatch queue and vi.waitFor still run on real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(OPENED)
    socket = relaySocket('fixture')
    bindAgentUpdate(socket)
    frames = []
    socket.registerLocalClient('local:opened', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    agentId = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%7301' }], cwd: '/tmp/opened' })!.agentId
  })

  afterEach(async () => {
    registry.removeAgent(agentId)
    vi.useRealTimers()
    vi.restoreAllMocks()
    await socket.stop()
  })

  const replyTo = (requestId: string) => frames.find(frame => frame.type === 'agent_update_result' && frame.payload.requestId === requestId)?.payload
  /** What `handleLocalFrame` queues for a window on this computer, awaited so the clock stays put. */
  async function update(payload: Record<string, unknown>, requestId: string): Promise<any> {
    await dispatchDown(socket, { type: 'agent_update', payload: { requestId, ...payload } }, 'local:opened', 'local')
    return replyTo(requestId)
  }
  const pushes = () => frames.filter(frame => frame.type === 'agent_synced')

  it('arrives through the desktop window’s own door (localWsServer → handleLocalFrame)', async () => {
    socket.handleLocalFrame('local:opened', { type: 'agent_update', payload: { requestId: 'door', agentId, opened: true } })
    await vi.waitFor(() => expect(replyTo('door')).toBeTruthy())
    // vi.waitFor moves a faked clock while it polls, so the stamp is read back rather than predicted.
    const stamped = registry.byAgent(agentId)?.lastOpenedAt
    expect(stamped).toBeGreaterThanOrEqual(OPENED)
    expect(replyTo('door').agent.lastOpenedAt).toBe(iso(stamped!))
    expect(pushes()).toHaveLength(1)
  })

  it('stamps the owner’s clock, answers with the frame, and pushes it to every app but the dial', async () => {
    const commander = vi.spyOn(socket, 'sendCommander')
    // A time from the client is never taken: two apps whose clocks disagree would order the list differently.
    const reply = await update({ agentId, opened: true, lastOpenedAt: '2001-01-01T00:00:00.000Z', at: 1 }, 'open-1')
    expect(reply.error).toBeUndefined()
    expect(reply.agent).toMatchObject({ id: agentId, lastOpenedAt: iso(OPENED) })
    expect(registry.byAgent(agentId)?.lastOpenedAt).toBe(OPENED)
    expect(pushes()).toHaveLength(1)
    expect(pushes()[0].payload.agent).toEqual(reply.agent)
    expect(commander).not.toHaveBeenCalled()
  })

  it('answers a repeat inside the throttle with the current frame, and stamps and tells no one', async () => {
    await update({ agentId, opened: true }, 'open-1')
    vi.setSystemTime(OPENED + AGENT_OPENED_THROTTLE_MS - 1)
    const repeat = await update({ agentId, opened: true }, 'open-2')
    expect(repeat.agent).toMatchObject({ id: agentId, lastOpenedAt: iso(OPENED) })
    expect(registry.byAgent(agentId)?.lastOpenedAt).toBe(OPENED)
    expect(pushes()).toHaveLength(1)

    vi.setSystemTime(OPENED + AGENT_OPENED_THROTTLE_MS)
    const later = await update({ agentId, opened: true }, 'open-3')
    expect(later.agent.lastOpenedAt).toBe(iso(OPENED + AGENT_OPENED_THROTTLE_MS))
    expect(pushes()).toHaveLength(2)
    expect(pushes()[1].payload.agent.lastOpenedAt).toBe(iso(OPENED + AGENT_OPENED_THROTTLE_MS))
  })

  it('still answers MISSING_UPDATE for a request that asks for nothing, and stamps nothing', async () => {
    expect(await update({ agentId }, 'empty')).toMatchObject({ error: 'MISSING_UPDATE' })
    expect(await update({ agentId, opened: false }, 'not-opened')).toMatchObject({ error: 'MISSING_UPDATE' })
    expect(await update({ agentId, opened: 'yes' }, 'truthy')).toMatchObject({ error: 'MISSING_UPDATE' })
    expect(await update({ opened: true }, 'no-agent')).toMatchObject({ error: 'MISSING_AGENT_ID' })
    expect(await update({ agentId: 'nobody', opened: true }, 'unknown')).toMatchObject({ error: 'AGENT_NOT_FOUND' })
    expect(registry.byAgent(agentId)?.lastOpenedAt).toBeUndefined()
    expect(pushes()).toHaveLength(0)
  })

  it('stamps but does not push an agent whose terminal this daemon cannot see', async () => {
    // Such a row is not in agents_list; a push would put it back on every screen (cli.ts syncSession).
    registry.setTerminalAvailable(agentId, false)
    const reply = await update({ agentId, opened: true }, 'hidden')
    expect(reply.agent.lastOpenedAt).toBe(iso(OPENED))
    expect(pushes()).toHaveLength(0)
  })

  it('takes the open from a sealed remote session too — the phone, or another computer’s desktop via its relay', async () => {
    const internals = socket as any
    const clear = { type: 'agent_update', payload: { requestId: 'remote-1', agentId, opened: true } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const sealedReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_update_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, { type: 'agent_update', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'remote-conn')
    expect(sealedReply).toHaveBeenCalledWith('remote-conn', 'agent_update_result', 'remote-1',
      expect.objectContaining({ agent: expect.objectContaining({ id: agentId, lastOpenedAt: iso(OPENED) }) }))
    // ...and this computer's own window hears the new order like everyone else.
    expect(pushes()).toHaveLength(1)
  })

  it('refuses an unsealed remote open like any other agent_update', async () => {
    await dispatchDown(socket, { type: 'agent_update', payload: { requestId: 'plain', agentId, opened: true } }, 'remote-conn')
    expect(registry.byAgent(agentId)?.lastOpenedAt).toBeUndefined()
    expect(pushes()).toHaveLength(0)
  })
})

describe('viewer forwarding authentication', () => {
  it('routes a sealed command_bar to the command bar with its connection, who asked, and nothing in the clear', async () => {
    const socket = relaySocket('token')
    const routed: Array<{ type: string; asker: unknown }> = []
    socket.serviceRouter = (type, _payload, asker, reply) => { routed.push({ type, asker }); reply({ selectedId: null }); return true }
    const ownerCommands = vi.spyOn(socket.ownerCommands, 'request')
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type: 'command_bar', payload: { requestId: 'one', request: { prompt: 'fixture', candidates: [] } } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    const sealedReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'command_bar_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, clear, 'remote')
    expect(routed).toEqual([])
    const sealed = { type: 'command_bar', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    // A device's session asks as no owner: the command bar refuses it (services/commandBar.ts).
    role.mockReturnValue('device')
    await dispatchDown(socket, sealed, 'remote')
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    expect(routed).toEqual([
      { type: 'command_bar', asker: { local: false, owner: false, connection: 'remote', requestId: 'one' } },
      { type: 'command_bar', asker: { local: false, owner: true, connection: 'remote', requestId: 'one' } },
    ])
    expect(ownerCommands).not.toHaveBeenCalled()
    expect(sealedReply).toHaveBeenCalledWith('remote', 'command_bar_result', 'one', { selectedId: null })
    await socket.stop()
  })

  it.each(['route_task', 'route_send'])('requires a sealed owner session for %s', async type => {
    const socket = relaySocket('token'), internals = socket as any
    const request = vi.spyOn(socket.ownerCommands, 'request').mockResolvedValue({ ok: true })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type, payload: { requestId: 'one', text: 'fixture task' } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    const sealedReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: `${type}_result`, payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, clear, 'remote')
    expect(request).not.toHaveBeenCalled()
    const sealed = { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await dispatchDown(socket, sealed, 'remote')
    expect(request).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    expect(request).toHaveBeenCalledWith('remote', type, clear.payload)
    expect(sealedReply).toHaveBeenCalledWith('remote', `${type}_result`, 'one', { ok: true })
    await socket.stop()
  })

  it('allows interactive viewers only on a sealed owner web connection or trusted loopback', async () => {
    const socket = relaySocket('token')
    const internals = socket as any
    const request = vi.fn(async () => ({ data: 'jpeg' }))
    socket.viewerStreams = { frame: vi.fn(), surface: request, closed: vi.fn(), closedAll: vi.fn() }
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const clear = { type: 'viewer_surface', payload: { requestId: 'one', surfaceId: 'surface', agentId: 'a', op: 'frame' } }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(clear)
    const reply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'viewer_surface_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, clear, 'remote')
    expect(request).not.toHaveBeenCalled()
    const sealed = { type: 'viewer_surface', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await dispatchDown(socket, sealed, 'remote')
    expect(request).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await dispatchDown(socket, sealed, 'remote')
    expect(request).toHaveBeenCalledWith('remote', clear.payload)
    expect(reply).toHaveBeenCalledWith('remote', 'viewer_surface_result', 'one', { data: 'jpeg' })
    socket.registerLocalClient('local:viewer', { sendFrame: () => true, sendBinary: () => true })
    await dispatchDown(socket, clear, 'local:viewer')
    expect(request).toHaveBeenCalledWith('local:viewer', clear.payload)
    // With nothing to render it, the surface is answered unavailable rather than left unanswered.
    const local = vi.fn(() => true)
    socket.registerLocalClient('local:none', { sendFrame: local, sendBinary: () => true })
    socket.viewerStreams = null
    await dispatchDown(socket, { ...clear, payload: { ...clear.payload, requestId: 'two' } }, 'local:none')
    await vi.waitFor(() => expect(local).toHaveBeenCalledWith({ type: 'viewer_surface_result', payload: { requestId: 'two', error: 'VIEWER_UNAVAILABLE' } }))
    await socket.unregisterLocalClient('local:viewer')
    await socket.stop()
  })

  it('hands a viewer stream\'s answers to the one connection that opened it, and ends its streams as connections go', async () => {
    const socket = relaySocket('token')
    const streams = { frame: vi.fn(), surface: vi.fn(), closed: vi.fn(), closedAll: vi.fn() }
    socket.viewerStreams = streams
    const local = vi.fn(() => true)
    socket.registerLocalClient('local:viewer', { sendFrame: local, sendBinary: () => true })
    expect(socket.sendViewerFrame('local:viewer', 'viewer_response', { streamId: 's1', status: 200 })).toBe(true)
    expect(local).toHaveBeenCalledWith({ type: 'viewer_response', payload: { streamId: 's1', status: 200 } })
    // A remote connection's go through the gateway, which says whether it could take them.
    const target = vi.spyOn(gatewayOf(socket), 'target').mockReturnValue(false)
    expect(socket.sendViewerFrame('remote', 'viewer_data', { streamId: 's1', data: 'AA==' })).toBe(false)
    expect(target).toHaveBeenCalledWith('remote', 'viewer_data', { streamId: 's1', data: 'AA==' })
    await socket.unregisterLocalClient('local:viewer')
    expect(streams.closed).toHaveBeenCalledWith('local:viewer')
    socket.fromGateway.client('r1', { role: 'web', label: null, identity: 'PUB', direct: false })
    socket.fromGateway.client('r1', null)
    expect(streams.closed).toHaveBeenCalledWith('r1')
    await socket.fromGateway.disconnected('r2')
    expect(streams.closed).toHaveBeenCalledWith('r2')
    socket.fromGateway.linkDown()
    expect(streams.closedAll).toHaveBeenCalledTimes(1)
    await socket.stop()
    expect(streams.closedAll).toHaveBeenCalledTimes(2)
  })

  it('requires encryption and a web-role session remotely, while permitting trusted local clients', async () => {
    const socket = relaySocket('token')
    const internals = socket as any
    const handle = vi.fn()
    socket.viewerStreams = { frame: handle, surface: vi.fn(), closed: vi.fn(), closedAll: vi.fn() }
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const frame = { type: 'viewer_request', payload: { streamId: 'v', agentId: 'a' } }
    const unwrap = vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(frame)
    await dispatchDown(socket, frame, 'remote')
    expect(unwrap).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
    const encrypted = { type: 'viewer_request', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await dispatchDown(socket, encrypted, 'remote')
    expect(handle).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await dispatchDown(socket, encrypted, 'remote')
    expect(handle).toHaveBeenCalledWith('remote', 'viewer_request', frame.payload)
    socket.registerLocalClient('local:viewer', { sendFrame: () => true, sendBinary: () => true })
    await dispatchDown(socket, frame, 'local:viewer')
    expect(handle).toHaveBeenCalledWith('local:viewer', 'viewer_request', frame.payload)
    handle.mockClear()
    await dispatchDown(socket, { type: 'viewer_arbitrary', payload: {} }, 'local:viewer')
    expect(handle).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:viewer')
    await socket.stop()
  })
})

const wsMock = vi.hoisted(() => {
  const instances: MockWebSocket[] = []

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = MockWebSocket.CONNECTING
    sent: string[] = []
    failNextSend: Error | null = null
    /** Peer stopped answering pings (a half-open TCP link, a laptop coming back from sleep). */
    silent = false
    pings = 0
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(readonly url: string, readonly protocols: string[], readonly options?: { handshakeTimeout?: number }) {
      instances.push(this)
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(cb)
      this.handlers.set(event, list)
      return this
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        const list = this.handlers.get(event) ?? []
        this.handlers.set(event, list.filter((fn) => fn !== wrapped))
        cb(...args)
      }
      return this.on(event, wrapped)
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args)
    }

    open(): void {
      this.readyState = MockWebSocket.OPEN
      this.emit('open')
    }

    message(value: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(value)))
    }

    send(data: string, cb?: (err?: Error) => void): void {
      if (this.failNextSend) {
        const err = this.failNextSend
        this.failNextSend = null
        cb?.(err)
        return
      }
      this.sent.push(data)
      cb?.()
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED
      this.emit('close', 1006)
    }

    /** What `ws` does when `handshakeTimeout` elapses: abort the upgrade, then report the socket gone. */
    handshakeTimeout(): void {
      this.emit('error', new Error('Opening handshake has timed out'))
      this.close()
    }

    /** What `ws` does when the upgrade is answered with an HTTP status: 'error', then 'close'. */
    refused(status: number): void {
      this.emit('error', new Error(`Unexpected server response: ${status}`))
      this.close()
    }

    terminate(): void {
      this.close()
    }

    ping(): void {
      this.pings++
      if (!this.silent) this.emit('pong')
    }

    /** The backend's own liveness ping (every 25s from `trackSocketLiveness`). */
    peerPing(): void {
      this.emit('ping')
    }
  }

  return { instances, MockWebSocket }
})

vi.mock('ws', () => ({ WebSocket: wsMock.MockWebSocket }))
// Grid's set-up, which the models service asks for before a move onto a grid model: set up already here,
// as on a machine that has used grid before. Never a real install or sign-in from a spec.
vi.mock('./lib/gridAttach.js', async (real) => ({
  ...await real<object>(),
  createGridAccess: () => ({ ensure: async () => ({ status: 'converged', name: null, detail: 'set up already' }) }),
}))
// Never the person's real ~/.claude.json or ~/.codex/config.toml: creating an agent records folder trust,
// and an unmocked run of these specs used to write test paths into the developer's own config.
const claudeTrust = vi.hoisted(() => ({
  claudeTrusts: vi.fn((_path: string) => false), codexTrusts: vi.fn((_path: string, _profile?: string | null) => false),
  preTrustClaudeProject: vi.fn((_path: string) => 'trusted' as const), preTrustCodexProject: vi.fn((_path: string, _profile?: string | null) => 'trusted' as const),
}))
vi.mock('./engines/launchPrep.js', async (real) => ({
  ...await real<object>(),
  folderTrust: (engine: string, profile?: string | null) => engine === 'claude'
    ? { trusts: (path: string) => claudeTrust.claudeTrusts(path), record: (path: string) => claudeTrust.preTrustClaudeProject(path) }
    : engine === 'codex' ? { trusts: (path: string) => claudeTrust.codexTrusts(path, profile), record: (path: string) => claudeTrust.preTrustCodexProject(path, profile) } : null,
}))

function parseSent(ws: InstanceType<typeof wsMock.MockWebSocket>): Array<Record<string, unknown>> {
  return ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
}

/** A relay down-frame as a paired client sends it: sealed. The socket's E2EE session is stubbed to open
 *  it back to `payload`, so the test exercises the RPC rather than the crypto (core.test.ts does that). */
function sealedDown(socket: BackendSocket, connId: string, type: string, payload: Record<string, unknown>) {
  const e2ee = gatewayOf(socket).e2ee
  if (!vi.isMockFunction(e2ee.unwrapDown)) {
    vi.spyOn(e2ee, 'unwrapDown').mockImplementation((_connId: unknown, f: any) => ({ ...f, payload: f.payload.__e2e.clear }))
  }
  return { t: 'down', connId, frame: { type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture', clear: payload } } } }
}

/** The models service (services/models.ts) answering the socket's models requests through a service host,
 *  as the daemon runs it: its core reads the grid name and this machine's name off the socket. */
function serveModels(socket: BackendSocket, over: Parameters<typeof fakeCore>[0] = {}) {
  const ports = emptyPorts()
  const host = createServiceHost(ports, { log: () => {} })
  const core = fakeCore({
    dataDir: process.env.ADAPTER_DATA_DIR,
    ...over,
    account: { privateGridName: async () => socket.gridName(), machineName: () => socket.machineName(), ...over.account },
    clients: { gridModelsChanged: () => { void socket.pushGridModels() }, ...over.clients },
  })
  host.start('models', startModels, core, MODELS_FALLBACKS, MODELS_REQUESTS)
  socket.serviceRouter = (type, payload, asker, reply) => host.route(type, payload, asker, reply)
  socket.models = () => ports.models ?? MODELS_OFF
  return host
}

/** The machine monitor (services/monitor.ts) in `host`, reading this machine as the daemon does unless a
 *  spec says otherwise; its totals through the module, so a spy on it is what answers. */
function serveMonitor(host: ReturnType<typeof createServiceHost>, over: Partial<MonitorDeps> = {}) {
  host.start('monitor', (core, ports) => startMonitor(core, ports, {
    machine: () => machineResources.readMachineResources(),
    resources: createHarnessResourcesReader(() => registry.advertised()),
    storage: createHarnessStorageReader(),
    ...over,
  }), fakeCore(), MONITOR_FALLBACKS, MONITOR_REQUESTS)
  return host
}

/** The project and folder readers (services/projects.ts) answering `socket`, over the registry as the
 *  daemon's core API reads it, so a spec's spies on the registry are what they see. */
function serveProjects(socket: BackendSocket) {
  return serveOn(socket, (host) => host.serve('projects', startProjects, fakeCore({
    agents: { live: () => registry.list(), resolve: (id: string) => registry.resolve(id) },
  }), PROJECTS_REQUESTS))
}

/** A socket whose service requests go to the services `serve` starts in a host of their own. */
function serveOn(socket: BackendSocket, serve: (host: ReturnType<typeof createServiceHost>) => void) {
  const host = createServiceHost(emptyPorts(), { log: () => {} })
  serve(host)
  socket.serviceRouter = (type, payload, asker, reply) => host.route(type, payload, asker, reply)
  return host
}

/** The session a requester holds whenever its sealed request was opened. Replies of a sealed type go back
 *  sealed to it; this stub seals them transparently, so a test reads the reply as the client does, opened. */
function withSession(socket: BackendSocket, connId: string): void {
  vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockImplementation((id) => id === connId)
  vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockImplementation((_id, type, requestId, payload) => ({ type, payload: { requestId, ...payload } }))
}

describe('BackendSocket outbound queue', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('queues web and device frames before open and flushes them in FIFO order', async () => {
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]

    socket.send({ type: 'turn_summary_pending', dbSessionId: 's1', payload: { sessionId: 's1' } })
    socket.sendCommander({ type: 'commander_event', agentId: 's1', dbSessionId: 's1', payload: { kind: 'done', text: 'done' } })
    expect(ws.sent).toHaveLength(0)

    ws.open()
    const sent = parseSent(ws)
    expect(sent).toHaveLength(2)
    expect((sent[0].frame as { type?: string }).type).toBe('turn_summary_pending')
    expect((sent[1].frame as { type?: string }).type).toBe('commander_event')
    expect(sent[1]).toMatchObject({ webEligible: false, commanderEligible: true })

    await socket.stop()
  })

  it('sends a frame though the orchestrator watching the frames cannot read its state', async () => {
    // A full disk: reading the orchestrator's state makes its folder, and that threw out of every send,
    // so a turn's end never reached a window (e2e/diskfull.e2e.ts).
    const socket = relaySocket('token')
    socket.onFrameSent = () => { throw new Error('ENOSPC: no space left on device, mkdir') }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    socket.send({ type: 'turn_ended', dbSessionId: 's1', payload: { sessionId: 's1' } })
    expect(parseSent(ws).map((sent) => (sent.frame as { type?: string }).type)).toContain('turn_ended')
    await socket.stop()
  })

  it('signed out, seals and queues nothing for a cloud link that never opens, and still serves its windows', async () => {
    const socket = relaySocket('token')
    const internal = { e2ee: gatewayOf(socket).e2ee, get queue() { return upstreamOf(socket).queue } }
    const frames: Array<{ type?: unknown }> = []
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    try {
      // Sent at start-up, before the daemon has looked for a session: queued, as for any daemon.
      socket.send({ type: 'turn_started', dbSessionId: 's1', payload: { sessionId: 's1' } })
      expect(internal.queue).toHaveLength(1)
      const wrapUp = vi.spyOn(internal.e2ee, 'wrapUp')
      const wrapCommander = vi.spyOn(internal.e2ee, 'wrapCommander')
      socket.serveThisComputerOnly()
      expect(internal.queue).toHaveLength(0)
      for (let i = 0; i < 100; i++) socket.send({ type: 'text_delta', dbSessionId: 's1', payload: { content: `word ${i}` } })
      socket.sendCommander({ type: 'commander_event', agentId: 's1', dbSessionId: 's1', payload: { kind: 'done', text: 'done' } })
      socket.sendUser({ type: 'notification', payload: {} })
      expect(wrapUp).not.toHaveBeenCalled()
      expect(wrapCommander).not.toHaveBeenCalled()
      expect(internal.queue).toHaveLength(0)
      expect(frames.filter((frame) => frame.type === 'text_delta')).toHaveLength(100)
    } finally {
      await socket.unregisterLocalClient('local:window')
      await socket.stop()
    }
  })

  it('bounds the opening handshake and reconnects when it times out', async () => {
    // A connect attempt whose TCP side came up but whose upgrade was never answered used to sit in
    // CONNECTING forever: no 'open', so no heartbeat to terminate it, and `this.ws` set, so every
    // later connect() returned early. The daemon then showed "cloud reconnecting…" until restarted.
    vi.useFakeTimers()
    const socket = relaySocket('token')
    socket.connect()
    const ws1 = wsMock.instances[0]
    expect(ws1.options?.handshakeTimeout).toBe(15_000)
    expect(ws1.readyState).toBe(wsMock.MockWebSocket.CONNECTING)

    // Still connecting: a second connect() must not open a competing socket …
    socket.connect()
    expect(wsMock.instances).toHaveLength(1)

    // … but once the handshake is abandoned, the ordinary backoff schedules a fresh attempt.
    ws1.handshakeTimeout()
    expect(socket.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wsMock.instances).toHaveLength(2)
    const ws2 = wsMock.instances[1]
    expect(ws2.options?.handshakeTimeout).toBe(15_000)
    ws2.open()
    expect(socket.isConnected()).toBe(true)

    await socket.stop()
  })

  it('gives a silent peer the whole deadline, not one missed pong, before terminating', async () => {
    // The old heartbeat killed the link the first time a ping went unanswered (20–40s), which is
    // what every macOS DarkWake looked like from inside the daemon: the pre-sleep ping's pong never
    // came, so the first tick after wake terminated a link that was about to work again.
    vi.useFakeTimers()
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.silent = true

    await vi.advanceTimersByTimeAsync(IDLE_DEADLINE_MS - 1_000)
    expect(socket.isConnected()).toBe(true)
    expect(ws.pings).toBeGreaterThanOrEqual(2) // it kept asking the whole time
    expect(wsMock.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wsMock.instances).toHaveLength(2) // and re-entered the ordinary backoff

    await socket.stop()
  })

  it('counts data and the backend\'s own pings as proof of life, not only pongs', async () => {
    // A backend busy streaming data can answer a control-frame ping late; the data itself is the
    // stronger proof, and the backend pings this socket every 25s on its own.
    vi.useFakeTimers()
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.silent = true

    await vi.advanceTimersByTimeAsync(40_000)
    ws.message({ t: 'down', connId: 'c1', frame: { type: 'noop' } })
    await vi.advanceTimersByTimeAsync(40_000) // 80s in, 40s since the last frame
    expect(socket.isConnected()).toBe(true)
    ws.peerPing()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(socket.isConnected()).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE_DEADLINE_MS)
    expect(socket.isConnected()).toBe(false)

    await socket.stop()
  })

  describe('a 401 on the upgrade', () => {
    // A stub in the shape the socket needs: the first token is what the backend refuses, and the
    // refresh answers with whatever the case under test says.
    function authStub(refresh: () => Promise<string>): { auth: AuthSessionManager; calls: Array<{ force?: boolean; failedToken?: string }> } {
      const calls: Array<{ force?: boolean; failedToken?: string }> = []
      let current = 'stale-token'
      const auth = {
        accessToken: async (opts: { force?: boolean; failedToken?: string } = {}) => {
          if (opts.force) { calls.push(opts); current = await refresh() }
          return current
        },
      } as unknown as AuthSessionManager
      return { auth, calls }
    }

    it('refreshes the token, reports the link down meanwhile, and reconnects with the new token', async () => {
      vi.useFakeTimers()
      const statuses: boolean[] = []
      const { auth, calls } = authStub(async () => 'fresh-token')
      const socket = relaySocket('0123456789abcdef0123456789abcdef', auth, (connected) => statuses.push(connected))
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      const ws1 = wsMock.instances[0]
      expect(ws1.protocols).toEqual(['stale-token'])
      ws1.open()

      ws1.refused(401)
      await vi.advanceTimersByTimeAsync(0)
      // The socket is gone the ordinary way: status says so, no session was wiped.
      expect(statuses).toEqual([true, false])
      expect(calls).toEqual([{ force: true, failedToken: 'stale-token' }])
      expect(revoked).not.toHaveBeenCalled()
      // And the refresh, not a backoff timer, opened the next socket — with the new token.
      expect(wsMock.instances).toHaveLength(2)
      expect(wsMock.instances[1].protocols).toEqual(['fresh-token'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wsMock.instances).toHaveLength(2) // no second dial racing the first
      await socket.stop()
    })

    it('keeps the session and backs off when the refresh merely fails', async () => {
      vi.useFakeTimers()
      const { auth } = authStub(async () => { throw new AuthSessionError('service unavailable', 'UNAVAILABLE') })
      const socket = relaySocket('0123456789abcdef0123456789abcdef', auth)
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      wsMock.instances[0].open()
      wsMock.instances[0].refused(401)
      await vi.advanceTimersByTimeAsync(0)
      expect(revoked).not.toHaveBeenCalled()
      expect(wsMock.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wsMock.instances).toHaveLength(2) // the ordinary backoff, session intact
      await socket.stop()
    })

    it('signs out only when the refresh token itself is rejected', async () => {
      vi.useFakeTimers()
      const { auth } = authStub(async () => { throw new AuthSessionError('refresh token is invalid', 'INVALID_REFRESH') })
      const socket = relaySocket('0123456789abcdef0123456789abcdef', auth)
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      wsMock.instances[0].open()
      wsMock.instances[0].refused(401)
      await vi.advanceTimersByTimeAsync(0)
      expect(revoked).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wsMock.instances).toHaveLength(1)
      await socket.stop()
    })
  })

  it('keeps a frame queued when ws.send reports an error and retries after reconnect', async () => {
    vi.useFakeTimers()
    const socket = relaySocket('token')
    socket.connect()
    const ws1 = wsMock.instances[0]
    ws1.open()
    ws1.failNextSend = new Error('boom')

    // A frame the gateway targets at one relayed connection (its own sends: the handshake, a rekey).
    ;(gatewayOf(socket) as any).sendTo('conn-1', { type: 'e2e_rekey', payload: { n: 1 } })
    expect(ws1.sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    const ws2 = wsMock.instances[1]
    ws2.open()
    const sent = parseSent(ws2)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'up', targetConnId: 'conn-1' })

    await socket.stop()
  })

  it('routes e2e control frames to the handshake manager instead of the RPC fallback', async () => {
    const socket = relaySocket('token')
    const handle = vi.spyOn(gatewayOf(socket).e2ee, 'handleFrame').mockReturnValue(true)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    const frame = {
      type: 'e2e_status',
      payload: { requestId: 'status-1' },
    }
    ws.message({ t: 'down', connId: 'web-1', frame })

    await vi.waitFor(() => expect(handle).toHaveBeenCalledWith('web-1', frame))
    expect(parseSent(ws).some((item) =>
      (item.frame as { type?: string } | undefined)?.type === 'e2e_status_result',
    )).toBe(false)
    await socket.stop()
  })

  it('serves the opaque runtime catalog through the existing models_list RPC', async () => {
    const socket = relaySocket('token')
    serveModels(socket, { agents: { runtimeModels: async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' },
    ] } })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'models_list', payload: { requestId: 'models-1' },
    })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'models_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'models_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      const result = parseSent(ws).find((item) => (item.frame as { type?: string })?.type === 'models_list_result')
      expect(result).toMatchObject({
        targetConnId: 'web-1',
        frame: { payload: { __e2e: { ct: 'ciphertext' } } },
      })
    })
    expect(wrapReply).toHaveBeenCalledWith('web-1', 'models_list_result', 'models-1', {
      models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' }],
    })
    await socket.stop()
  })

  it('hands a request a service declared to the service router with who asked, and seals its answer to the requester', async () => {
    const socket = relaySocket('token')
    const routed: Array<{ type: string; payload: Record<string, unknown>; asker: unknown }> = []
    socket.serviceRouter = (type, payload, asker, reply) => {
      routed.push({ type, payload, asker })
      if (type !== 'session_search') return false
      reply({ hits: [], indexed: 3, pending: 0, ready: true, tookMs: 1 })
      return true
    }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const unwrap = vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown')
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const role = vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockImplementation((_connId, type) => ({
      type, payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    }))
    const envelope = { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } }
    const ask = (type: string, payload: Record<string, unknown>) => {
      unwrap.mockReturnValueOnce({ type, payload })
      ws.message({ t: 'down', connId: 'web-1', frame: { type, payload: envelope } })
    }

    // The owner's paired app, over the relay: sealed back to it, under its own request id.
    ask('session_search', { requestId: 's-1', query: 'dial scroll', limit: 12 })
    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'session_search_result', 's-1', { hits: [], indexed: 3, pending: 0, ready: true, tookMs: 1 })
    })
    expect(routed[0]).toEqual({ type: 'session_search', payload: { requestId: 's-1', query: 'dial scroll', limit: 12 }, asker: { local: false, owner: true, connection: 'web-1', requestId: 's-1' } })

    // A device's session may not act as the owner, and the service is told so.
    role.mockReturnValue('device')
    ask('session_search', { requestId: 's-2', query: 'dial' })
    await vi.waitFor(() => expect(routed).toHaveLength(2))
    expect(routed[1].asker).toEqual({ local: false, owner: false, connection: 'web-1', requestId: 's-2' })

    // A type no service declared is the socket's own: an unknown one is refused at once, in the clear,
    // as a reply that carries nothing is.
    role.mockReturnValue('web')
    ask('nobody_answers', { requestId: 'n-1' })
    await vi.waitFor(() => expect(parseSent(ws)).toContainEqual({ t: 'up', targetConnId: 'web-1', frame: { type: 'nobody_answers_result', payload: { requestId: 'n-1', error: 'UNSUPPORTED' } } }))
    expect(routed.at(-1)?.type).toBe('nobody_answers')

    // A process on this machine asks as itself, and as the owner.
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:app', { sendFrame: (frame) => { frames.push(frame as Record<string, unknown>); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:app', { type: 'session_search', payload: { requestId: 'l-1', query: 'dial' } })
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'session_search_result' })))
    expect(routed.at(-1)?.asker).toEqual({ local: true, owner: true, connection: 'local:app', requestId: 'l-1' })
    await socket.stop()
  })

  it('tells the services when a connection that may have asked them closes: a window, a remote client, the relay and its clients', async () => {
    const socket = relaySocket('token')
    const closed: string[] = []
    socket.onConnectionClosed = (connId) => { closed.push(connId) }
    socket.registerLocalClient('local:window', { sendFrame: () => true, sendBinary: () => true })
    await socket.unregisterLocalClient('local:window')
    const client = { role: 'web' as const, label: null, identity: 'id', direct: false }
    for (const connId of ['web-1', 'web-2', 'web-3']) socket.fromGateway.client(connId, client)
    socket.fromGateway.client('web-1', null)
    // One the gateway never announced is no connection of the socket's.
    socket.fromGateway.client('web-unknown', null)
    await socket.fromGateway.disconnected('web-2')
    // The relay gone: every remote client it still had went with it, and no window on this computer did.
    socket.registerLocalClient('local:stays', { sendFrame: () => true, sendBinary: () => true })
    socket.fromGateway.linkDown()
    expect(closed).toEqual(['local:window', 'web-1', 'web-2', 'web-3'])
    await socket.stop()
  })

  it('answers a request whose service is unavailable SERVICE_UNAVAILABLE, retryable, and goes on', async () => {
    const socket = relaySocket('token')
    // A request whose work reaches a service through its port, whose fallback is to fail (core/serviceHost.ts).
    bindTerminalRequests(socket, { applyTheme: () => { throw new ServiceUnavailableError('models', new Error('disk I/O error')) } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:app', { sendFrame: (frame) => { frames.push(frame as Record<string, unknown>); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:app', { type: 'theme_set', payload: { requestId: 't-1', foreground: '#ffffff', background: '#000000' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'theme_set_result', payload: { requestId: 't-1', error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true } }))
    expect(warn).toHaveBeenCalledWith('[backend] theme_set: the models service is unavailable')
    await socket.stop()
  })

  it('answers terminal_info, which the terminal streams pass over, and leaves every other terminal frame to them', async () => {
    const socket = relaySocket('token')
    bindTerminalRequests(socket)
    // As in the daemon: a stream manager that takes its own frames and passes over the rest.
    const handleFrame = vi.fn(async (_connId: string, type: string) => type !== 'terminal_info' && type !== 'terminal_unknown')
    socket.setTerminalStreamManager({ handleFrame, closeConnection: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as unknown as TerminalStreamManager)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:hn', { sendFrame: (frame) => { frames.push(frame as Record<string, unknown>); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:hn', { type: 'terminal_info', payload: { requestId: 'i-1', agentId: 'no-such-agent' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'terminal_info_result', payload: { requestId: 'i-1', error: 'AGENT_NOT_FOUND' } }))
    expect(handleFrame).toHaveBeenCalledWith('local:hn', 'terminal_info', expect.objectContaining({ agentId: 'no-such-agent' }))
    // A terminal frame the streams take, or one nobody knows, is not answered here.
    socket.handleLocalFrame('local:hn', { type: 'terminal_resize', payload: { requestId: 'r-1', streamId: 's' } })
    socket.handleLocalFrame('local:hn', { type: 'terminal_unknown', payload: { requestId: 'u-1' } })
    await vi.waitFor(() => expect(handleFrame).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(frames.filter((frame) => frame.type !== 'terminal_info_result')).toEqual([])
    await socket.stop()
  })

  it('drops a reply for a window that has gone: no other window hears it, and nothing of it is queued for the relay', async () => {
    // A window that closes with requests in flight has them carried out, and their replies used to fall
    // through to the broadcast: a plaintext one to every other window and, unsealed, to the relay; a
    // sealed type to the relay as a targeted error (e2e/windows.e2e.ts). One answer of each kind.
    const socket = relaySocket('token')
    const answers = new Map<string, (result: Record<string, unknown>) => void>()
    socket.serviceRouter = (type, payload, _asker, reply) => {
      if (type !== 'terminal_info' && type !== 'session_search') return false
      answers.set(String(payload.requestId), reply)
      return true
    }
    // Signed out, as on a computer nobody signed in to: whatever is meant for the relay waits in the queue.
    socket.connect()
    const ws = wsMock.instances[0]
    const stays: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:stays', { sendFrame: (frame) => { stays.push(frame as Record<string, unknown>); return true }, sendBinary: () => true })
    socket.registerLocalClient('local:gone', { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame('local:gone', { type: 'terminal_info', payload: { requestId: 'gone-info', agentId: 'a1' } })
    socket.handleLocalFrame('local:gone', { type: 'session_search', payload: { requestId: 'gone-search', query: 'dial' } })
    socket.handleLocalFrame('local:stays', { type: 'terminal_info', payload: { requestId: 'stays-info', agentId: 'a1' } })
    await vi.waitFor(() => expect(answers.size).toBe(3))
    await socket.unregisterLocalClient('local:gone')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const wasOn = env.LOG_FRAMES
    env.LOG_FRAMES = true
    try {
      answers.get('gone-info')!({ command: 'node', path: '/work/app', pid: 4242, tty: '/dev/ttys001' })
      answers.get('gone-search')!({ hits: [], indexed: 0, pending: 0, ready: true, tookMs: 1 })
    } finally {
      env.LOG_FRAMES = wasOn
    }
    answers.get('stays-info')!({ command: 'node', path: '/work/app', pid: 4242, tty: '/dev/ttys001' })
    // The window that stayed hears its own answer and nothing else.
    expect(stays.map((frame) => (frame.payload as { requestId?: unknown } | undefined)?.requestId).filter(Boolean)).toEqual(['stays-info'])
    // The gone window's answers are said once, in the diagnostic log, and go nowhere: not into the
    // relay's queue, and not up the link once it opens.
    expect(log.mock.calls.filter(([line]) => String(line).includes('has gone'))).toHaveLength(1)
    expect(JSON.stringify(upstreamOf(socket).queue)).not.toContain('gone-')
    ws.open()
    expect(JSON.stringify(parseSent(ws))).not.toContain('gone-')
    // A request from the relay is still answered on the relay, sealed to the session that asked.
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockImplementation((connId) => connId === 'web-1')
    vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockImplementation((_connId, type) => ({ type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } } }))
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValueOnce({ type: 'terminal_info', payload: { requestId: 'relay-info', agentId: 'a1' } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'terminal_info', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } } })
    await vi.waitFor(() => expect(answers.has('relay-info')).toBe(true))
    answers.get('relay-info')!({ error: 'AGENT_NOT_FOUND' })
    expect(parseSent(ws)).toContainEqual({ t: 'up', targetConnId: 'web-1', frame: { type: 'terminal_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } } } })
    await socket.stop()
  })

  it('answers a request from the relay to the requester alone: no other web client and no window gets a copy', async () => {
    // Each app takes a reply by its own request id; a broadcast handed every web client of the machine
    // and every window on it an answer only one of them had asked for.
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const window: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame as Record<string, unknown>); return true }, sendBinary: () => true })
    // A paired client's request, sealed, of a type whose answer carries nothing: answered in the clear.
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValueOnce({ type: 'nobody_answers', payload: { requestId: 'r-1' } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'nobody_answers', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } } })
    const answers = () => parseSent(ws).filter((item) => (item.frame as { type?: string })?.type === 'nobody_answers_result')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()).toEqual([{ t: 'up', targetConnId: 'web-1', frame: { type: 'nobody_answers_result', payload: { requestId: 'r-1', error: 'UNSUPPORTED' } } }])
    expect(window.filter((frame) => frame.type === 'nobody_answers_result')).toEqual([])
    // The backend's own request has no connection to be answered on: it still hears its answer on the bus.
    ws.message({ t: 'down', connId: '', frame: { type: 'voice_route', payload: { requestId: 'b-1', transcript: 'route this' } } })
    await vi.waitFor(() => expect(parseSent(ws)).toContainEqual({ t: 'up', frame: { type: 'voice_route_result', payload: { requestId: 'b-1', error: 'E2EE_REQUIRED' } } }))
    await socket.stop()
  })

  it('seals what a pane runs to a requester that holds a session, and to it alone', async () => {
    // A pane's folder, pid and tty used to go to every web client in the clear. Every client that holds a
    // session opens a sealed payload of any type.
    const socket = relaySocket('token')
    // `terminal_info` is the core's (core/terminals/requests.ts), bound here as the daemon binds it.
    bindTerminalRequests(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockImplementation((connId) => connId === 'web-1')
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockImplementation((_connId, type) => ({ type, payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } } }))
    const unwrap = vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown')
    const ask = (connId: string, type: string, payload: Record<string, unknown>) => {
      unwrap.mockReturnValueOnce({ type, payload })
      ws.message({ t: 'down', connId, frame: { type, payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } } })
    }
    const answers = () => parseSent(ws).filter((item) => (item.frame as { type?: unknown })?.type === 'terminal_info_result')
    ask('web-1', 'terminal_info', { requestId: 'info-1', agentId: 'no-such-agent' })
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(wrap).toHaveBeenCalledWith('web-1', 'terminal_info_result', 'info-1', { error: 'AGENT_NOT_FOUND' })
    const sealed = { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } }
    expect(answers()).toEqual([
      { t: 'up', targetConnId: 'web-1', frame: { type: 'terminal_info_result', payload: sealed } },
    ])
    // A requester whose session went away meanwhile gets the bare refusal a refused request gets, never
    // the answer in the clear.
    ask('web-2', 'terminal_info', { requestId: 'info-2', agentId: 'no-such-agent' })
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(answers()[1]).toEqual({ t: 'up', targetConnId: 'web-2', frame: { type: 'terminal_info_result', payload: { requestId: 'info-2', error: 'E2EE_REQUIRED' } } })
    // Only the reply: the request keeps the rule it had, since an older daemon reads a sealed one as empty.
    expect(encryptDownFrame('terminal_info')).toBe(false)
    expect(encryptDownFrameFor('terminal_info', { strictDown: true })).toBe(false)
    expect(encryptRpcResult('terminal_info_result')).toBe(true)
    await socket.stop()
  })

  it.each(['dsh_list', 'dsh_install', 'dsh_update', 'dsh_remove', 'engines_probe', 'grid_models_list', 'claude_login_status', 'agent_retarget', 'remote_terminal_handoff'])(
    'seals the %s answer to a requester that holds a session, and to it alone', async (type) => {
      // What a machine tells the client that asked about it went to every web client in the clear.
      const socket = relaySocket('token')
      socket.connect()
      const ws = wsMock.instances[0]
      ws.open()
      vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
      const sealed = { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } }
      const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockImplementation((_connId, resultType) => ({ type: resultType, payload: sealed }))
      ;(socket as unknown as { emitReply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void })
        .emitReply('web-1', type, 'r-1', { account: 'this-computer' })
      expect(wrap).toHaveBeenCalledWith('web-1', `${type}_result`, 'r-1', { account: 'this-computer' })
      expect(parseSent(ws).filter((item) => (item.frame as { type?: unknown })?.type === `${type}_result`))
        .toEqual([{ t: 'up', targetConnId: 'web-1', frame: { type: `${type}_result`, payload: sealed } }])
      expect(JSON.stringify(parseSent(ws))).not.toContain('this-computer')
      await socket.stop()
    })

  it('hands theme_set to the host-theme sink and acknowledges it to the requester', async () => {
    const socket = relaySocket('token')
    const received: unknown[] = []
    bindTerminalRequests(socket, { applyTheme: (theme) => { received.push(theme) } })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const unwrap = vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown')
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'theme_set_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    const envelope = { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } }

    unwrap.mockReturnValueOnce({
      type: 'theme_set', payload: { requestId: 't-1', background: '#171B29', foreground: '#f5f5f5' },
    })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'theme_set', payload: envelope } })
    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'theme_set_result', 't-1', { applied: true })
    })
    // Normalised to lowercase, and a full pair — never half a style.
    expect(received).toEqual([{ background: '#171b29', foreground: '#f5f5f5' }])

    // A malformed colour is refused, not half-applied.
    unwrap.mockReturnValueOnce({ type: 'theme_set', payload: { requestId: 't-2', background: 'dark' } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'theme_set', payload: envelope } })
    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'theme_set_result', 't-2', { error: 'BAD_THEME' })
    })
    expect(received).toHaveLength(1)
    await socket.stop()
  })

  it('answers usage_read with this machine\'s own readings, wrapped for the requester', async () => {
    // What goes back names what the person spends and on whose account, so it must leave encrypted.
    // The usage service answers it (services/usage.ts), with a reader that never touches a real home,
    // Keychain or network.
    const socket = relaySocket('token')
    const readings = [
      {
        provider: 'claude' as const,
        account: 'k1',
        outcome: 'answered' as const,
        httpStatus: 200,
        body: { seven_day: { utilization: 42 } },
      },
    ]
    serveOn(socket, (host) => host.serve('usage', (core) => startUsage(core, { read: async () => readings }), fakeCore(), USAGE_REQUESTS))
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'usage_read', payload: { requestId: 'usage-1' },
    })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'usage_read_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'usage_read', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'usage_read_result', 'usage-1', { providers: readings })
    })
    await socket.stop()
  })

  it('returns project previews only to the requesting encrypted connection', async () => {
    vi.spyOn(registry, 'list').mockReturnValue([{ cwd: '/remote/workspace' }] as RegisteredSession[])
    const preview = { path: '/remote/workspace', readme: 'Private project README', branch: 'main', files: ['README.md'], contributors: [] }
    const read = vi.spyOn(projectPreview, 'projectPreview').mockResolvedValue(preview)
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'project_preview', payload: {
      requestId: 'preview-1', path: '/remote/workspace',
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'project_preview_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'project_preview', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'project_preview_result', 'preview-1', preview))
    expect(read).toHaveBeenCalledWith('/remote/workspace', ['/remote/workspace'])
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'project_preview_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    } }))
    expect(JSON.stringify(parseSent(ws))).not.toContain('Private project README')
    await socket.stop()
  })

  it.each([false, true])('returns refreshed=%s Git branch choices only to the requesting encrypted connection', async refresh => {
    const preview = { isGit: true, root: '/remote/workspace', branch: 'main', branches: [{ ref: 'refs/heads/private-branch', name: 'private-branch', remote: false }] }
    const read = vi.spyOn(gitProject, 'readGitProject').mockResolvedValue(preview)
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'git_project_info', payload: {
      requestId: 'preview-1', path: '/remote/workspace', refresh,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'git_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'git_project_info', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'git_project_info_result', 'preview-1', preview))
    // The fence travels with the request — no registered agents here, so it is the home folder alone.
    expect(read).toHaveBeenCalledWith('/remote/workspace', { refresh, knownRoots: [] })
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'git_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    } }))
    expect(JSON.stringify(parseSent(ws))).not.toContain('private-branch')
    await socket.stop()
  })

  it.each([false, true])('answers scm_project_info (refresh=%s) through the SCM seam, to the requesting encrypted connection only', async refresh => {
    const preview = { kind: 'git' as const, git: { isGit: true, root: '/remote/workspace', branch: 'main', branches: [{ ref: 'refs/heads/private-branch', name: 'private-branch', remote: false }] } }
    const detect = vi.spyOn(scmProjects, 'detectScmProject').mockResolvedValue(preview)
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'scm_project_info', payload: {
      requestId: 'preview-2', path: '/remote/workspace', refresh,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'scm_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'scm_project_info', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'scm_project_info_result', 'preview-2', preview))
    // The same fence git_project_info passes: no registered agents here, so the home folder alone.
    expect(detect).toHaveBeenCalledWith('/remote/workspace', { refresh, knownRoots: [] })
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'scm_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    } }))
    expect(JSON.stringify(parseSent(ws))).not.toContain('private-branch')
    await socket.stop()
  })

  it('answers scm_project_info for a malformed path as the git probe does, correlated', async () => {
    const read = vi.spyOn(gitProject, 'readGitProject')
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'scm_project_info', payload: {
      requestId: 'scm-error', path: 42,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'scm_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-error' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'scm_project_info', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'scm_project_info_result', 'scm-error', { kind: 'none', error: 'INVALID_PATH' }))
    expect(read).toHaveBeenCalledWith('', { refresh: false, knownRoots: [] })
    await socket.stop()
  })

  it('returns PR status only to the requesting encrypted connection', async () => {
    const preview = { status: 'found' as const, number: 12, state: 'Merged' as const, url: 'https://github.com/private/repo/pull/12' }
    vi.spyOn(registry, 'resolve').mockReturnValue({ cwd: '/remote/workspace' } as RegisteredSession)
    const read = vi.spyOn(gitPullRequest, 'readGitPullRequest').mockResolvedValue(preview)
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'git_pull_request', payload: {
      requestId: 'preview-1', agentId: 'agent1',
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'git_pull_request_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'git_pull_request', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'git_pull_request_result', 'preview-1', preview))
    expect(read).toHaveBeenCalledWith('/remote/workspace')
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'git_pull_request_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    } }))
    expect(JSON.stringify(parseSent(ws))).not.toContain('github.com/private')
    await socket.stop()
  })

  it('keeps session work paths and PR history inside the requesting encrypted reply', async () => {
    const history = { status: 'unavailable' as const, context: null, gitContext: {
      state: 'uncertain' as const, current: null, observedAt: null, locations: [], pullRequests: [], truncated: false,
    }, history: { branches: [{ cwd: '/private/worktree', remote: null, branch: 'private-fix', at: '2026-09-27' }], pullRequests: [], truncated: false }, lookups: [], nextOffset: null }
    vi.spyOn(registry, 'resolve').mockReturnValue({ cwd: '/remote/workspace' } as RegisteredSession)
    vi.spyOn(sessionGitPullRequest, 'readSessionGitPullRequest').mockResolvedValue(history)
    const socket = relaySocket('token'); serveProjects(socket); socket.connect()
    const ws = wsMock.instances[0]; ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'git_pull_request', payload: {
      requestId: 'history-1', agentId: 'agent1', history: true,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'git_pull_request_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-history' } } })
    ws.message({ t: 'down', connId: 'viewer-a', frame: { type: 'git_pull_request', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } } } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'git_pull_request_result', 'history-1', history))
    expect(JSON.stringify(parseSent(ws))).not.toContain('/private/worktree')
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: { type: 'git_pull_request_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-history' } } } }))
    await socket.stop()
  })

  it('returns a correlated Git error when discovery rejects or the path is malformed', async () => {
    const read = vi.spyOn(gitProject, 'readGitProject').mockRejectedValue(new Error('unavailable'))
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'git_project_info', payload: {
      requestId: 'git-error', path: 42,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'git_project_info_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-error' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'git_project_info', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'git_project_info_result', 'git-error', { error: 'UNAVAILABLE' }))
    expect(read).toHaveBeenCalledWith('', { refresh: false, knownRoots: [] })
    await socket.stop()
  })

  it('serves media only to the requesting encrypted connection', async () => {
    vi.spyOn(registry, 'resolve').mockReturnValue({ cwd: '/remote/workspace' } as RegisteredSession)
    const media = { media: true as const, filename: 'preview.png', offset: 0, totalBytes: 3,
      revision: 'a'.repeat(64), contentBase64: 'AQID' }
    const read = vi.spyOn(mediaPreview, 'readMediaPreviewChunk').mockResolvedValue(media)
    const socket = relaySocket('token')
    serveProjects(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_read_file', payload: {
      requestId: 'media-1', agentId: 'agent-b', path: '/tmp/preview.png', media: true, offset: 0,
    } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agent_read_file_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-media' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'agent_read_file', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'agent_read_file_result', 'media-1', media))
    expect(read).toHaveBeenCalledWith('/remote/workspace', '/tmp/preview.png', 0, undefined)
    const sent = parseSent(ws)
    expect(sent).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'agent_read_file_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-media' } },
    } }))
    expect(JSON.stringify(sent)).not.toContain('AQID')
    await socket.stop()
  })

  it('refuses a plaintext media request before reading any file', async () => {
    const read = vi.spyOn(mediaPreview, 'readMediaPreviewChunk')
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: 'unpaired-viewer', frame: {
      type: 'agent_read_file', payload: { requestId: 'media-unsafe', agentId: 'agent-b', path: '/tmp/preview.png', media: true, offset: 0 },
    } })
    await vi.waitFor(() => expect(parseSent(ws)).toContainEqual(expect.objectContaining({
      targetConnId: 'unpaired-viewer', frame: expect.objectContaining({ payload: { requestId: 'media-unsafe', error: 'E2EE_REQUIRED' } }),
    })))
    expect(read).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('includes engine session correlation in the web agent list', async () => {
    const session: RegisteredSession = {
      schemaVersion: 2,
      active: true,
      agentId: 'agent-1',
      sessionId: 'session-1',
      boundAt: 1,
      engine: 'codex',
      transcriptPath: null,
      projectDir: 'workspace',
      cwd: '/tmp/workspace',
      runtimes: [],
      primaryRuntimeKey: '',
      tmuxPane: '',
      source: null,
      title: 'Agent one',
      model: null,
      cliVersion: null,
      processIdentity: null,
      registeredAt: 1,
      touchedAt: 1,
      lastHookAt: 1,
      lastTranscriptAt: 1,
    }
    vi.spyOn(registry, 'advertised').mockReturnValue([session])
    vi.spyOn(registry, 'terminalAvailable').mockReturnValue(true)
    const socket = relaySocket('token')
    bindAgentList(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'agents_list', payload: { requestId: 'agents-1' },
    })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agents_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'agents_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'agents_list_result', 'agents-1', {
        agents: [expect.objectContaining({
          id: 'agent-1', sessionId: 'session-1', engine: 'codex',
          terminal: expect.objectContaining({ available: true }),
        })],
      })
    })
    await socket.stop()
  })

  it('filters and compacts the runtime catalog for a device agent', async () => {
    const socket = relaySocket('token')
    const provider = vi.fn(async (_sessionId?: string) => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' },
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto', displayName: 'GPT-5.6 Sol / Auto' },
      { id: 'runtime-v1:s1:codex:o3@medium', displayName: 'o3 / Medium' },
      { id: 'runtime-v1:s1:codex:o3@auto', displayName: 'o3 / Auto' },
    ])
    serveModels(socket, { agents: { runtimeModels: provider } })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'models_list',
      payload: {
        requestId: 'models-compact',
        agentId: 's1',
        compact: true,
        pickerMode: 'model',
        selectedModel: 'runtime-v1:s1:codex:gpt-5.6-sol@high',
      },
    })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'models_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'device-1',
      frame: { type: 'models_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('device-1', 'models_list_result', 'models-compact', {
        models: [
          { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' },
          { id: 'runtime-v1:s1:codex:o3@auto' },
        ],
      })
    })
    expect(provider).toHaveBeenCalledWith('s1')
    await socket.stop()
  })

  it('fails a plaintext runtime catalog request closed before reading local data', async () => {
    const socket = relaySocket('token')
    const provider = vi.fn(async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'sensitive' },
    ])
    serveModels(socket, { agents: { runtimeModels: provider } })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({
      t: 'down', connId: 'unpaired-web',
      frame: { type: 'models_list', payload: { requestId: 'plaintext-models' } },
    })

    await vi.waitFor(() => {
      const result = parseSent(ws).find((item) => (item.frame as { type?: string })?.type === 'models_list_result')
      expect(result).toMatchObject({
        targetConnId: 'unpaired-web',
        frame: { payload: { requestId: 'plaintext-models', error: 'E2EE_REQUIRED' } },
      })
    })
    expect(provider).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('serves authenticated local RPCs in cleartext without weakening cloud E2EE', async () => {
    const socket = relaySocket('token')
    serveModels(socket, { agents: { runtimeModels: async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' },
    ] } })
    const frames: Array<Record<string, unknown>> = []
    expect(socket.registerLocalClient('local:test', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })).toBe(true)

    socket.handleLocalFrame('local:test', {
      type: 'models_list', payload: { requestId: 'harness-computes' },
    })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'models_list_result',
      payload: {
        requestId: 'harness-computes',
        models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' }],
      },
    }))

    await socket.unregisterLocalClient('local:test')
    await socket.stop()
  })

  it('refuses a trust-group roster swap that is not over an E2EE session (a local client has no identity)', async () => {
    const socket = relaySocket('token')
    const handle = vi.fn(() => ({}))
    gatewayOf(socket).groupSync = { handle }
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:group', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:group', { type: 'group_sync', payload: { requestId: 'g1', members: [] } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'group_sync_result', payload: { requestId: 'g1', error: 'UNSUPPORTED' } }))
    expect(handle).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:group')
    await socket.stop()
  })

  it('serves machine stats locally without blocking the next RPC while sampling', async () => {
    let finish!: (value: machineResources.MachineResources) => void
    const read = vi.spyOn(machineResources, 'readMachineResources').mockImplementation(
      () => new Promise(resolve => { finish = resolve }),
    )
    const socket = relaySocket('token')
    serveMonitor(serveModels(socket))
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:stats', {
      sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true,
    })
    socket.handleLocalFrame('local:stats', { type: 'machine_resources', payload: { requestId: 'stats' } })
    socket.handleLocalFrame('local:stats', { type: 'models_list', payload: { requestId: 'models' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'models_list_result', payload: { requestId: 'models', models: [] },
    }))
    expect(read).toHaveBeenCalledTimes(1)
    expect(frames.some(frame => frame.type === 'machine_resources_result')).toBe(false)
    finish({ cpuPercent: 18, memoryUsedBytes: 10, memoryTotalBytes: 32 })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'machine_resources_result',
      payload: { requestId: 'stats', cpuPercent: 18, memoryUsedBytes: 10, memoryTotalBytes: 32 },
    }))
    read.mockRejectedValueOnce(new Error('unavailable'))
    socket.handleLocalFrame('local:stats', { type: 'machine_resources', payload: { requestId: 'retry' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'machine_resources_result', payload: { requestId: 'retry', error: 'UNAVAILABLE' },
    }))
    await socket.unregisterLocalClient('local:stats')
    await socket.stop()
  })

  it('returns remote machine stats only in a targeted encrypted reply', async () => {
    const reading = { cpuPercent: 18, memoryUsedBytes: 10, memoryTotalBytes: 32 }
    vi.spyOn(machineResources, 'readMachineResources').mockResolvedValue(reading)
    const socket = relaySocket('token')
    serveOn(socket, (host) => serveMonitor(host))
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'machine_resources', payload: { requestId: 'stats' },
    })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const sealed = { type: 'machine_resources_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } }
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue(sealed)
    ws.message({
      t: 'down', connId: 'paired',
      frame: { type: 'machine_resources', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('paired', 'machine_resources_result', 'stats', reading))
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'paired', frame: sealed }))
    expect(ws.sent.some(frame => frame.includes('memoryUsedBytes'))).toBe(false)
    await socket.stop()
  })

  it('serves per-session resource readings without blocking input or sampling system totals', async () => {
    const system = vi.spyOn(machineResources, 'readMachineResources')
    const socket = relaySocket('token')
    let finish!: (value: { sampledAt: string; agents: [] }) => void
    serveMonitor(serveModels(socket), { resources: vi.fn(() => new Promise<{ sampledAt: string; agents: [] }>(resolve => { finish = resolve })) })
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:monitor', {
      sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true,
    })
    socket.handleLocalFrame('local:monitor', { type: 'machine_resources', payload: { requestId: 'resources', harnesses: true } })
    socket.handleLocalFrame('local:monitor', { type: 'models_list', payload: { requestId: 'models' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'models_list_result', payload: { requestId: 'models', models: [] } }))
    expect(system).not.toHaveBeenCalled()
    const reading = { sampledAt: '2026-09-30T12:00:00Z', agents: [] as [] }
    finish(reading)
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'machine_resources_result', payload: { requestId: 'resources', harnesses: reading } }))
    await socket.unregisterLocalClient('local:monitor')
    await socket.stop()
  })

  it('rejects unpaired plaintext stats requests before sampling the machine', async () => {
    const read = vi.spyOn(machineResources, 'readMachineResources')
    const socket = relaySocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({
      t: 'down', connId: 'unpaired',
      frame: { type: 'machine_resources', payload: { requestId: 'stats' } },
    })
    await vi.waitFor(() => expect(parseSent(ws)).toContainEqual(expect.objectContaining({
      targetConnId: 'unpaired',
      frame: { type: 'machine_resources_result', payload: { requestId: 'stats', error: 'E2EE_REQUIRED' } },
    })))
    expect(read).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('never holds a connection\'s next request for a service still answering one', async () => {
    const socket = relaySocket('token')
    const models = serveModels(socket)
    let answerCatalog!: (result: Record<string, unknown>) => void
    socket.serviceRouter = (type, payload, asker, reply) => {
      if (type !== 'dsh_list') return models.route(type, payload, asker, reply)
      answerCatalog = reply
      return true
    }
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:catalog', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:catalog', { type: 'dsh_list', payload: { requestId: 'catalog' } })
    socket.handleLocalFrame('local:catalog', { type: 'models_list', payload: { requestId: 'models' } })
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'models_list_result')).toBe(true))
    expect(frames.some(frame => frame.type === 'dsh_list_result')).toBe(false)
    answerCatalog({ dsh: [] })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'dsh_list_result', payload: { requestId: 'catalog', dsh: [] } }))
    await socket.unregisterLocalClient('local:catalog')
    await socket.stop()
  })

  it('does not let a slow engines_probe block agent_create on the same connection', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:create', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    let finishProbe!: () => void
    socket.engineProbeProvider = () => new Promise((resolve) => { finishProbe = () => resolve([]) })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId: 'pending-1', sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    socket.onCreateAgent = async () => ({ ok: true, session: pending })

    socket.handleLocalFrame('local:create', {
      type: 'engines_probe', payload: { requestId: 'probe-1', engines: ['claude'] },
    })
    socket.handleLocalFrame('local:create', {
      type: 'agent_create', payload: { requestId: 'create-1', engine: 'claude', cwd: '/tmp/work' },
    })

    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
      type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'create-1' }),
    })))
    expect(frames.some((frame) => frame.type === 'engines_probe_result')).toBe(false)
    finishProbe()
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'engines_probe_result')).toBe(true))
    await socket.unregisterLocalClient('local:create')
    await socket.stop()
  })

  it('opens a harness on a conversation Harness did not start, and refuses what a resume cannot take', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:resume', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const inputs: Array<{ resumeSessionId?: string | null; takeOver?: string | null; cwd: string }> = []
    socket.onCreateAgent = async (input) => {
      inputs.push(input)
      return { ok: false, error: 'SESSION_OPEN_ELSEWHERE', detail: 'It is open in another terminal or app.' }
    }
    const create = (requestId: string, extra: Record<string, unknown>) => socket.handleLocalFrame('local:resume', {
      type: 'agent_create', payload: { requestId, engine: 'codex', cwd: '/work/cohorts', ...extra },
    })
    const reply = (requestId: string) => frames.find((frame) => (frame.payload as { requestId?: string }).requestId === requestId)?.payload
    create('ok', { resumeSessionId: '01a0c4ad-de5e-7000-8000-000000000001' })
    await vi.waitFor(() => expect(reply('ok')).toBeDefined())
    expect(inputs[0]).toMatchObject({ resumeSessionId: '01a0c4ad-de5e-7000-8000-000000000001', cwd: '/work/cohorts' })
    // What cli.ts said about it reaches the client as it was said.
    expect(reply('ok')).toMatchObject({ error: 'SESSION_OPEN_ELSEWHERE', detail: 'It is open in another terminal or app.' })
    // Taken over from the terminal that has it: how, passed on as asked.
    create('wait', { resumeSessionId: '01a0c4ad-de5e-7000-8000-000000000001', takeOver: 'wait' })
    await vi.waitFor(() => expect(reply('wait')).toBeDefined())
    expect(inputs[1]).toMatchObject({ takeOver: 'wait' })
    create('shape', { resumeSessionId: '../../etc/passwd' })
    create('prompt', { resumeSessionId: '01a0c4ad-de5e-7000-8000-000000000001', prompt: 'and then this' })
    create('how', { resumeSessionId: '01a0c4ad-de5e-7000-8000-000000000001', takeOver: 'forcefully' })
    create('what', { takeOver: 'now' })
    await vi.waitFor(() => expect(reply('what')).toBeDefined())
    for (const id of ['shape', 'prompt', 'how', 'what']) expect(reply(id)).toMatchObject({ error: 'INVALID_SESSION' })
    expect(inputs).toHaveLength(2)
    await socket.unregisterLocalClient('local:resume')
    await socket.stop()
  })

  it('creates with approvals bypassed unless the client turns that off', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:bypass', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending = (agentId: string): RegisteredSession => ({
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId, sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    })
    const create = vi.fn(async (input: { bypassPermission: boolean; permissionMode: string | null }) => ({ ok: true as const, session: pending(`b-${create.mock.calls.length}`) }))
    socket.onCreateAgent = create
    const ask = (requestId: string, extra: Record<string, unknown>) => socket.handleLocalFrame('local:bypass', {
      type: 'agent_create', payload: { requestId, engine: 'claude', cwd: '/tmp/work', ...extra },
    })
    try {
      ask('unsaid', {})
      ask('on', { bypassPermission: true })
      ask('off', { bypassPermission: false })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3))
      expect(create.mock.calls.map(([input]) => input.bypassPermission)).toEqual([true, true, false])

      // A mode decides, whatever bypassPermission says; one the engine lacks is refused.
      ask('plan', { permissionMode: 'plan', bypassPermission: true })
      ask('full', { permissionMode: 'full', bypassPermission: false })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(5))
      expect(create.mock.calls.slice(3).map(([input]) => [input.permissionMode, input.bypassPermission]))
        .toEqual([['plan', false], ['full', true]])
      ask('bogus', { permissionMode: 'readOnly' })
      ask('shape', { permissionMode: 7 })
      await vi.waitFor(() => expect(frames.filter((frame) => (frame.payload as { error?: string } | undefined)?.error === 'INVALID_PERMISSION_MODE')).toHaveLength(2))
      expect(create).toHaveBeenCalledTimes(5)
    } finally {
      await socket.unregisterLocalClient('local:bypass')
      await socket.stop()
    }
  })

  it('creates a terminal with no folder at home, and refuses it a grid or a project to prepare', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:terminal', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'ready' }, terminalHost: true,
      agentId: 'term-1', sessionId: '', boundAt: null, engine: 'terminal',
      transcriptPath: null, projectDir: 'nqhieu84', cwd: homedir(),
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    const create = vi.fn(async (_input: { engine: string; cwd: string }) => ({ ok: true as const, session: pending }))
    socket.onCreateAgent = create
    const ask = (requestId: string, payload: Record<string, unknown>) => socket.handleLocalFrame('local:terminal', {
      type: 'agent_create', payload: { requestId, engine: 'terminal', ...payload },
    })
    const errorOf = (requestId: string) => (frames.find((frame) => frame.type === 'agent_create_result'
      && (frame.payload as { requestId?: string }).requestId === requestId)?.payload as { error?: string } | undefined)?.error
    try {
      ask('home', {})
      ask('folder', { cwd: '/tmp/work' })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
      expect(create.mock.calls.map(([input]) => [input.engine, input.cwd])).toEqual([['terminal', homedir()], ['terminal', '/tmp/work']])
      ask('relative', { cwd: 'work' })
      ask('grid', { grid: { networkId: 'n', networkName: 'net', baseUrl: 'https://grid.example', apiKey: 'k' } })
      ask('prompt', { prompt: 'hello' })
      await vi.waitFor(() => expect(['relative', 'grid', 'prompt'].map(errorOf)).toEqual(['INVALID_CWD', 'INVALID_GRID', 'PROMPT_UNSUPPORTED']))
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      await socket.unregisterLocalClient('local:terminal')
      await socket.stop()
    }
  })

  it('recovers a delayed creation on the same connection without starting another agent', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:receipt', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId: 'receipt-agent', sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%receipt' }], primaryRuntimeKey: 'tmux/%receipt', tmuxPane: '%receipt',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    const lookup = vi.spyOn(registry, 'byAgent').mockReturnValue(pending)
    let finish!: () => void
    const create = vi.fn(() => new Promise<{ ok: true; session: RegisteredSession }>((resolve) => {
      finish = () => resolve({ ok: true, session: pending })
    }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    const ask = (type: string, requestId: string, choices = {}) => socket.handleLocalFrame('local:receipt', {
      type, payload: { requestId, creationId, ...choices },
    })
    try {
      ask('agent_create', 'first', { engine: 'claude', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      ask('agent_create_status', 'while-pending')
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_create_status_result', payload: { requestId: 'while-pending', creationId, state: 'pending' },
      }))
      // New transport request id, same deliberate creation intent.
      ask('agent_create', 'retry', { engine: 'claude', cwd: '/tmp/work' })
      finish()
      for (const requestId of ['first', 'retry']) {
        await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
          type: 'agent_create_result', payload: expect.objectContaining({ requestId, creationId, state: 'created', agent: expect.objectContaining({ id: pending.agentId }) }),
        })))
      }
      expect(create).toHaveBeenCalledTimes(1)
      ask('agent_create_status', 'recovered')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_status_result', payload: expect.objectContaining({ requestId: 'recovered', creationId, state: 'created', agent: expect.objectContaining({ id: pending.agentId }) }),
      })))
      ask('agent_create', 'changed', { engine: 'codex', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'changed', error: 'CREATION_CONFLICT' }),
      })))
      lookup.mockReturnValue(undefined)
      ask('agent_create', 'deleted', { engine: 'claude', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'deleted', creationId, state: 'unavailable' }),
      })))
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      finish?.()
      await socket.unregisterLocalClient('local:receipt')
      await socket.stop()
    }
  })

  it('explains invalid repository choices without echoing credentials or preparing a folder', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:invalid-project', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    const prepare = vi.spyOn(projectFolder, 'prepareProjectFolder')
    const create = vi.fn()
    socket.onCreateAgent = create
    try {
      socket.handleLocalFrame('local:invalid-project', { type: 'agent_create', payload: {
        requestId: 'invalid', creationId: randomUUID(), engine: 'codex', projectSource: 'remote',
        repositoryUrl: 'https://private-token@github.com/owner/repo',
      } })
      await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_create_result', payload: {
        requestId: 'invalid', error: 'INVALID_REPOSITORY',
        detail: 'Enter a GitHub HTTPS or SSH URL, or owner/repository.',
      } }))
      expect(JSON.stringify(frames)).not.toContain('private-token')
      expect(prepare).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally {
      await socket.unregisterLocalClient('local:invalid-project')
      await socket.stop()
    }
  })

  it.each([
    { projectSource: 'remote', repositoryUrl: 'owner/repo' },
    { projectSource: 'worktree', gitSource: '/remote/repo', branchRef: 'refs/heads/main' },
    { projectSource: 'branch', gitSource: '/remote/repo', branchRef: 'refs/heads/feature' },
  ])('prepares $projectSource once under its creation receipt and retains its folder after a refused launch', async (project) => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:project', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    let finish!: (folder: string) => void
    const prepare = vi.spyOn(projectFolder, 'prepareProjectFolder').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const create = vi.fn(async () => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    const payload = { creationId, engine: 'claude', ...project }
    const ask = (type: string, requestId: string, choices = payload) => socket.handleLocalFrame('local:project', { type, payload: { requestId, ...choices } })
    try {
      ask('agent_create', 'first')
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
      ask('agent_create', 'retry')
      ask('agent_create_status', 'pending')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'pending', state: 'pending' }) })))
      expect(create).not.toHaveBeenCalled()
      finish('/remote/Harness Projects/repo')
      for (const requestId of ['first', 'retry']) {
        await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId, state: 'failed', preparedFolder: '/remote/Harness Projects/repo', failure: { code: 'TMUX_UNAVAILABLE' } }) })))
      }
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: '/remote/Harness Projects/repo' }))
      expect(prepare).toHaveBeenCalledTimes(1)
      ask('agent_create', 'changed', { ...payload, engine: 'codex' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'changed', error: 'CREATION_CONFLICT' }) })))
      expect(prepare).toHaveBeenCalledTimes(1)
      ask('agent_create_status', 'saved')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'saved', preparedFolder: '/remote/Harness Projects/repo' }) })))
    } finally {
      finish?.('/remote/Harness Projects/repo')
      await socket.unregisterLocalClient('local:project')
      await socket.stop()
    }
  })

  it.each([
    { name: 'a new empty folder', project: { projectSource: 'new' }, sourceTrusted: false, trusts: true },
    { name: 'a clone', project: { projectSource: 'remote', repositoryUrl: 'owner/repo' }, sourceTrusted: false, trusts: false },
    { name: 'the person\'s own repo (branch)', project: { projectSource: 'branch', gitSource: '/work/repo', branchRef: 'refs/heads/feature' }, sourceTrusted: true, trusts: false },
    { name: 'a worktree of an untrusted repo', project: { projectSource: 'worktree', gitSource: '/work/repo', branchRef: 'refs/heads/main' }, sourceTrusted: false, trusts: false },
    { name: 'a worktree of a repo Claude already trusts', project: { projectSource: 'worktree', gitSource: '/work/repo', branchRef: 'refs/heads/main' }, sourceTrusted: true, trusts: true },
  ])('records Claude trust for $name: $trusts', async ({ project, sourceTrusted, trusts }) => {
    // Only a folder the daemon made empty, or a worktree of a repo already trusted, is trusted for the person.
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:trust', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    vi.spyOn(projectFolder, 'prepareProjectFolder').mockResolvedValue('/work/prepared')
    vi.mocked(claudeTrust.claudeTrusts).mockReturnValue(sourceTrusted)
    vi.mocked(claudeTrust.preTrustClaudeProject).mockClear()
    socket.onCreateAgent = vi.fn(async () => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    try {
      socket.handleLocalFrame('local:trust', { type: 'agent_create', payload: { requestId: 'r', creationId: randomUUID(), engine: 'claude', ...project } })
      await vi.waitFor(() => expect(socket.onCreateAgent).toHaveBeenCalled())
      if (trusts) expect(claudeTrust.preTrustClaudeProject).toHaveBeenCalledExactlyOnceWith('/work/prepared')
      else expect(claudeTrust.preTrustClaudeProject).not.toHaveBeenCalled()
      if (project.projectSource === 'worktree') expect(claudeTrust.claudeTrusts).toHaveBeenCalledWith('/work/repo')
    } finally {
      await socket.unregisterLocalClient('local:trust')
      await socket.stop()
    }
  })

  it.each([
    { name: 'an empty workspace the app just made', contents: [] as string[], nested: false, trusts: true },
    { name: 'a workspace that already has something', contents: ['Makefile'], nested: false, trusts: false },
    { name: 'an empty folder outside the projects root', contents: [] as string[], nested: true, trusts: false },
  ])('records Claude trust for $name: $trusts', async ({ contents, nested, trusts }) => {
    // A plain cwd on the LOCAL machine is the desktop handing over a workspace it just made. Trust is
    // recorded only on evidence (the readdir) and only directly inside the projects root: trust inherits
    // downward, so an empty folder the person merely browsed to would cover everything cloned under it.
    const root = mkdtempSync(join(tmpdir(), 'harness-root-'))
    const dir = nested ? join(root, 'a', 'b') : join(root, 'workspace')
    mkdirSync(dir, { recursive: true })
    for (const item of contents) writeFileSync(join(dir, item), 'x')
    vi.spyOn(projectFolder, 'projectsRoot').mockReturnValue(root)
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    socket.registerLocalClient('local:cwd-trust', { sendFrame: () => true, sendBinary: () => true })
    vi.mocked(claudeTrust.preTrustClaudeProject).mockClear()
    socket.onCreateAgent = vi.fn(async () => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    try {
      socket.handleLocalFrame('local:cwd-trust', { type: 'agent_create', payload: { requestId: 'r', creationId: randomUUID(), engine: 'claude', cwd: dir } })
      await vi.waitFor(() => expect(socket.onCreateAgent).toHaveBeenCalled())
      if (trusts) expect(claudeTrust.preTrustClaudeProject).toHaveBeenCalledExactlyOnceWith(dir)
      else expect(claudeTrust.preTrustClaudeProject).not.toHaveBeenCalled()
    } finally {
      await socket.unregisterLocalClient('local:cwd-trust')
      await socket.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does NOT record Claude trust for an empty workspace named by a relayed frame', async () => {
    // agent_create is not backend-only, so a relay frame is E2EE-unwrapped and reaches the same pre-trust
    // path. Everything else about this frame would qualify — the folder is empty AND in the projects root —
    // so the LOCAL gate is the only thing refusing it.
    const root = mkdtempSync(join(tmpdir(), 'harness-root-'))
    const dir = join(root, 'workspace')
    mkdirSync(dir)
    vi.spyOn(projectFolder, 'projectsRoot').mockReturnValue(root)
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const internals = socket as unknown as {
      e2ee: { unwrapDown: (connId: string, frame: unknown) => unknown }
      dispatchDown: (frame: unknown, connId: string, transport: string) => Promise<void>
    }
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({
      type: 'agent_create', payload: { requestId: 'r', creationId: randomUUID(), engine: 'claude', cwd: dir },
    })
    vi.mocked(claudeTrust.preTrustClaudeProject).mockClear()
    socket.onCreateAgent = vi.fn(async () => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    try {
      await dispatchDown(socket, { type: 'agent_create', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }, 'web-1', 'relay')
      // The create ran, so the pre-trust branch was reached and declined — not skipped earlier by the gate.
      await vi.waitFor(() => expect(socket.onCreateAgent).toHaveBeenCalled())
      expect(claudeTrust.preTrustClaudeProject).not.toHaveBeenCalled()
    } finally {
      await socket.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hands the launch the SCM record the prepared workspace reported, and none for a folder no SCM made', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:scm', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    const prepare = vi.spyOn(projectFolder, 'prepareProjectFolder').mockImplementation(async (project, options) => {
      if (project.source === 'worktree') options?.onPrepared?.({ cwd: '/remote/harnesses/worktrees/repo/brave-otter', scmLaunchRecord: { kind: 'git' } })
      return project.source === 'worktree' ? '/remote/harnesses/worktrees/repo/brave-otter' : '/remote/harnesses/codex-2026-09-24-12-00'
    })
    const create = vi.fn(async (_input: Record<string, unknown>) => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    socket.onCreateAgent = create
    const ask = (requestId: string, choices: Record<string, unknown>) =>
      socket.handleLocalFrame('local:scm', { type: 'agent_create', payload: { requestId, creationId: randomUUID(), engine: 'claude', ...choices } })
    try {
      ask('worktree', { projectSource: 'worktree', gitSource: '/remote/repo', branchRef: 'refs/heads/main' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'worktree', state: 'failed' }) })))
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/remote/harnesses/worktrees/repo/brave-otter', scmLaunchRecord: { kind: 'git' } }))
      ask('new', { projectSource: 'new' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'new', state: 'failed' }) })))
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/remote/harnesses/codex-2026-09-24-12-00', scmLaunchRecord: null }))
      // A create that names its own folder prepared nothing, and says nothing about an SCM.
      ask('cwd', { cwd: '/remote/own' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'cwd' }) })))
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/remote/own' }))
      expect(create.mock.lastCall?.[0]).not.toHaveProperty('scmLaunchRecord')
      expect(prepare).toHaveBeenCalledTimes(2)
    } finally {
      await socket.unregisterLocalClient('local:scm')
      await socket.stop()
    }
  })

  it('checks an unknown creation without spawning and rejects malformed creation ids before launch', async () => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:missing-receipt', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const create = vi.fn(async () => ({ ok: false as const, error: 'CWD_NOT_FOUND' }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    try {
      socket.handleLocalFrame('local:missing-receipt', {
        type: 'agent_create_status', payload: { requestId: 'missing', creationId },
      })
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_create_status_result', payload: { requestId: 'missing', creationId, state: 'missing' },
      }))
      socket.handleLocalFrame('local:missing-receipt', {
        type: 'agent_create', payload: { requestId: 'invalid', creationId: '../bad', engine: 'claude', cwd: '/tmp/work' },
      })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'invalid', error: 'INVALID_CREATION_ID' }),
      })))
      expect(create).not.toHaveBeenCalled()
    } finally {
      await socket.unregisterLocalClient('local:missing-receipt')
      await socket.stop()
    }
  })

  it.each([
    ['CWD_NOT_FOUND', 'failed'],
    ['SPAWN_FAILED', 'unconfirmed'],
    ['REGISTRATION_FAILED', 'unconfirmed'],
  ])('does not relaunch a recorded %s outcome', async (error, state) => {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:refusal', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const create = vi.fn(async () => ({ ok: false as const, error }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    try {
      for (const requestId of ['initial', 'retry']) {
        socket.handleLocalFrame('local:refusal', {
          type: 'agent_create', payload: { requestId, creationId, engine: 'claude', cwd: '/tmp/work' },
        })
        await vi.waitFor(() => expect(frames).toContainEqual({
          type: 'agent_create_result',
          payload: { requestId, creationId, state, ...(state === 'failed' ? { failure: { code: error } } : {}) },
        }))
      }
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      await socket.unregisterLocalClient('local:refusal')
      await socket.stop()
    }
  })

  it('sends a device focus request to one desktop window only', async () => {
    const socket = relaySocket('token')
    const first = vi.fn(() => true), second = vi.fn(() => true)
    const frame = { type: 'device_focus', payload: { agentId: 'first' } }
    expect(socket.sendFirstLocal(frame)).toBe(false)
    socket.registerLocalClient('local:first', { sendFrame: first, sendBinary: () => true })
    socket.registerLocalClient('local:second', { sendFrame: second, sendBinary: () => true })
    first.mockClear(); second.mockClear()
    expect(socket.sendFirstLocal(frame)).toBe(true)
    expect(first).toHaveBeenCalledExactlyOnceWith(frame)
    expect(second).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:first')
    await socket.unregisterLocalClient('local:second')
    await socket.stop()
  })

  it('hands a blocked agent to the window without putting the question on the cloud leg', async () => {
    const socket = relaySocket('token')
    expect(socket.hasLocalClient()).toBe(false)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:window', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    // The watcher's whole gate: polling a pane for a dialog is waste with nobody rendering it, and
    // "nobody" used to mean "no device" — which is what kept the window in the dark.
    expect(socket.hasLocalClient()).toBe(true)

    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const asked = {
      type: 'commander_question',
      agentId: 'a1',
      dbSessionId: 's1',
      payload: { requestId: 'q_1', questions: [{ key: 'Which theme?', q: 'Which theme?', options: ['Blue', 'Red'], multi: false }] },
    }
    socket.sendLocal(asked)

    // The window reads it in the clear, which is what loopback is for...
    expect(frames).toContainEqual(asked)
    // ...and it never reaches the relay. `commander_question` is deliberately NOT in ENCRYPTED_UP_TYPES,
    // so `send()` here would have travelled the cloud leg as plaintext question text and option labels.
    expect(parseSent(ws).some((item) => (item.frame as { type?: string })?.type === 'commander_question')).toBe(false)

    await socket.unregisterLocalClient('local:window')
    expect(socket.hasLocalClient()).toBe(false)
    await socket.stop()
  })

  it('routes local terminal binary directly and preserves local streams when cloud disconnects', async () => {
    vi.useFakeTimers()
    const socket = relaySocket('token')
    const handleBinary = vi.fn(async () => undefined)
    const closeConnection = vi.fn(async () => undefined)
    const closeConnectionsWhere = vi.fn(async (
      _predicate: (connId: string) => boolean,
      _reason: string,
      _notify?: boolean,
    ) => undefined)
    const stop = vi.fn(async () => undefined)
    socket.setTerminalStreamManager({
      handleBinary,
      closeConnection,
      closeConnectionsWhere,
      stop,
    } as unknown as TerminalStreamManager)
    const binary: Uint8Array[] = []
    socket.registerLocalClient('local:terminal', {
      sendFrame: () => true,
      sendBinary: (frame) => { binary.push(frame); return true },
    })
    const clear = {
      kind: TerminalBinaryKind.input,
      streamId: '00112233-4455-6677-8899-aabbccddeeff',
      seq: 1,
      bytes: Uint8Array.of(1, 2),
      compressed: false,
    }
    await socket.handleLocalBinary('local:terminal', clear)
    expect(handleBinary).toHaveBeenCalledWith('local:terminal', clear)
    expect(socket.sendTerminalBinaryTo('local:terminal', clear)).toBe(true)
    expect(decodeTerminalLocal(binary[0])).toEqual(clear)

    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.close()
    expect(closeConnectionsWhere).toHaveBeenCalledOnce()
    const predicate = closeConnectionsWhere.mock.calls[0][0] as (connId: string) => boolean
    expect(predicate('web-1')).toBe(true)
    expect(predicate('local:terminal')).toBe(false)

    await socket.unregisterLocalClient('local:terminal')
    expect(closeConnection).toHaveBeenCalledWith('local:terminal', 'local client disconnected', false)
    await socket.stop()
  })

  it('reports the window itself: open when it attaches, ping once a minute while it stays, nothing while offline', async () => {
    vi.useFakeTimers()
    const socket = relaySocket('token')
    const sink = { sendFrame: () => true, sendBinary: () => true }
    const kinds = (ws: InstanceType<typeof wsMock.MockWebSocket>) => parseSent(ws)
      .filter((m) => (m.frame as { type?: string } | undefined)?.type === 'app_presence')
      .map((m) => (m.frame as { payload: { kind: string } }).payload.kind)

    // A window attaching to a not-yet-dialed daemon (the cold start): nothing can be sent yet, and
    // nothing is queued behind real frames — but the session is owed to the link that comes up.
    expect(socket.registerLocalClient('local:1', sink)).toBe(true)
    socket.connect()
    const ws = wsMock.instances[0]
    expect(kinds(ws)).toEqual([])
    ws.open()
    expect(kinds(ws)).toEqual(['open'])

    // While the window stays: once a minute on the app-ping tick, not once a tick.
    vi.advanceTimersByTime(45_000)
    expect(kinds(ws)).toEqual(['open'])
    vi.advanceTimersByTime(15_000)
    expect(kinds(ws)).toEqual(['open', 'ping'])

    // A second window is a session in its own right — up at once, floor or not.
    expect(socket.registerLocalClient('local:2', sink)).toBe(true)
    expect(kinds(ws)).toEqual(['open', 'ping', 'open'])
    // Registering the same window twice is refused, and says nothing.
    expect(socket.registerLocalClient('local:2', sink)).toBe(false)
    expect(kinds(ws)).toHaveLength(3)

    // Every window gone: the tick falls silent.
    await socket.unregisterLocalClient('local:1')
    await socket.unregisterLocalClient('local:2')
    vi.advanceTimersByTime(120_000)
    expect(kinds(ws)).toHaveLength(3)

    // A window that came and went while the link was down was never a session the backend can hear
    // about — the next link is told nothing. Both remaining windows gone first, so the count is clean.
    ws.close()
    expect(socket.registerLocalClient('local:3', sink)).toBe(true)
    await socket.unregisterLocalClient('local:3')
    vi.advanceTimersByTime(60_000)
    const ws2 = wsMock.instances[1]
    ws2.open()
    vi.advanceTimersByTime(15_000)
    expect(kinds(ws2)).toEqual([])

    // Bookkeeping about the person, for the backend alone: never fanned out to a client.
    expect(parseSent(ws).find((m) => (m.frame as { type?: string } | undefined)?.type === 'app_presence'))
      .toMatchObject({ t: 'up', webEligible: false, commanderEligible: false })

    await socket.stop()
  })

  it('reports the TUI as its own surface, and a tool as no one', async () => {
    vi.useFakeTimers()
    const socket = relaySocket('token')
    const sink = { sendFrame: () => true, sendBinary: () => true }
    const presence = (ws: InstanceType<typeof wsMock.MockWebSocket>) => parseSent(ws)
      .filter((m) => (m.frame as { type?: string } | undefined)?.type === 'app_presence')
      .map((m) => (m.frame as { payload: Record<string, unknown> }).payload)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // A tool (`harness pair`, the MCP server) is not a person at a window: nothing, now or on the tick.
    expect(socket.registerLocalClient('local:tool', sink, { tool: true })).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(presence(ws)).toEqual([])

    // The TUI names its surface; the desktop app's frame stays exactly as it was.
    expect(socket.registerLocalClient('local:tui', sink, { surface: 'tui' })).toBe(true)
    expect(socket.registerLocalClient('local:app', sink)).toBe(true)
    expect(presence(ws)).toEqual([{ kind: 'open', surface: 'tui' }, { kind: 'open' }])

    // Each pings for itself while it stays — and only it, once the other has gone.
    vi.advanceTimersByTime(60_000)
    expect(presence(ws).slice(2)).toEqual([{ kind: 'ping' }, { kind: 'ping', surface: 'tui' }])
    await socket.unregisterLocalClient('local:app')
    vi.advanceTimersByTime(60_000)
    expect(presence(ws).slice(4)).toEqual([{ kind: 'ping', surface: 'tui' }])

    await socket.stop()
  })

  it('reports commander presence only when it crosses zero', async () => {
    const socket = relaySocket('token')
    const changes: boolean[] = []
    socket.onCommanderPresenceChanged = (connected) => changes.push(connected)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    const clients = (commander: number) => ws.message({
      t: 'down', connId: '', frame: { type: '__clients', payload: { commander } },
    })
    clients(1)
    clients(2)
    clients(0)
    clients(0)
    clients(1)
    await vi.waitFor(() => expect(changes).toEqual([true, false, true]))

    await socket.stop()
    expect(changes).toEqual([true, false, true, false])
  })

  // "The device is gone" reaches us two ways: the backend says so (`__clients` → 0), or our own link to
  // the backend dies and we can no longer know. Both have to release the device's E2EE session — the
  // dashboard's device dot reads `deviceE2eeConnected()`, so a session left behind reports a device that
  // may have been gone for hours.
  it('drops the device E2EE session when the count reaches zero', async () => {
    const socket = relaySocket('token')
    const drop = vi.spyOn(gatewayOf(socket).e2ee, 'dropSessionsByRole')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 1 } } })
    expect(drop).not.toHaveBeenCalled()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 0 } } })
    await vi.waitFor(() => expect(drop).toHaveBeenCalledWith('device'))

    await socket.stop()
  })

  it('drops the device E2EE session when OUR backend link dies, not just when the backend says so', async () => {
    vi.useFakeTimers()
    const socket = relaySocket('token')
    const drop = vi.spyOn(gatewayOf(socket).e2ee, 'dropSessionsByRole')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 1 } } })
    drop.mockClear()

    ws.close() // transport gone — no `__clients` frame will ever tell us the device left
    expect(socket.hasCommander()).toBe(false)
    expect(drop).toHaveBeenCalledWith('device')

    await socket.stop()
  })

  it('releases E2EE and terminal state for the exact disconnected web connId', async () => {
    const socket = relaySocket('token')
    const closeConnection = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    socket.setTerminalStreamManager({
      closeConnection,
      stop,
    } as unknown as TerminalStreamManager)
    const dropSession = vi.spyOn(gatewayOf(socket).e2ee, 'dropSession')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({
      t: 'down',
      connId: 'web-terminal-1',
      frame: { type: '__client_disconnected', payload: {} },
    })

    await vi.waitFor(() => {
      expect(dropSession).toHaveBeenCalledWith('web-terminal-1')
      expect(closeConnection).toHaveBeenCalledWith(
        'web-terminal-1',
        'client connection closed',
        false,
      )
    })
    await socket.stop()
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('desk_changed relay', () => {
  // Other suites can leave closed sockets in the shared mock inventory. A
  // shuffled run must send to this test's connection, not an earlier one.
  beforeEach(() => { wsMock.instances.length = 0 })
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  it('hands the backend\'s desk_changed to the window, and only the backend\'s', async () => {
    const socket = relaySocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:desk', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'desk_changed', payload: { revision: 9 } } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'desk_changed', payload: { revision: 9 } }))
    // A local client saying it is not the backend: nothing is relayed.
    socket.handleLocalFrame('local:desk', { type: 'desk_changed', payload: { revision: 99 } })
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.filter((f) => f.type === 'desk_changed')).toHaveLength(1)
    await socket.unregisterLocalClient('local:desk')
    await socket.stop()
  })

  it('hands the backend\'s zoo_changed to the window as its own frame, and only the backend\'s', async () => {
    const socket = relaySocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:zoo', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'zoo_changed', payload: { revision: 4 } } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'zoo_changed', payload: { revision: 4 } }))
    expect(frames.some((f) => f.type === 'desk_changed')).toBe(false)
    // A local client, or a client relayed with its own connId, is not the backend: nothing is relayed.
    socket.handleLocalFrame('local:zoo', { type: 'zoo_changed', payload: { revision: 99 } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'zoo_changed', payload: { revision: 98 } } })
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.filter((f) => f.type === 'zoo_changed')).toEqual([{ type: 'zoo_changed', payload: { revision: 4 } }])
    await socket.unregisterLocalClient('local:zoo')
    await socket.stop()
  })
})

describe('agent_fork RPC', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const FORK: RegisteredSession = {
    schemaVersion: 2, active: true, agentId: 'agent-2', sessionId: '', boundAt: null, engine: 'claude',
    forkedFrom: { agentId: 'agent-1', name: 'Agent one' },
    transcriptPath: null, projectDir: 'workspace', cwd: '/tmp/workspace', runtimes: [], primaryRuntimeKey: '',
    tmuxPane: '%2', source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 2, touchedAt: 2, lastHookAt: 2, lastTranscriptAt: 2,
  }

  function localSocket(): { socket: BackendSocket; frames: Array<Record<string, unknown>> } {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:fork', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    return { socket, frames }
  }

  it('recovers a fork receipt with its handoff level without creating another agent', async () => {
    const { socket, frames } = localSocket()
    const lookup = vi.spyOn(registry, 'byAgent').mockReturnValue(FORK)
    let finish!: () => void
    const fork = vi.fn(() => new Promise<{ ok: true; session: RegisteredSession; level: 'handoff' }>((resolve) => {
      finish = () => resolve({ ok: true, session: FORK, level: 'handoff' })
    }))
    socket.onForkAgent = fork
    const creationId = randomUUID()
    const ask = (type: string, requestId: string, name = 'Separate idea') => socket.handleLocalFrame('local:fork', {
      type, payload: { requestId, creationId, agentId: 'agent-1', name, prompt: '  preserve\n  indentation  ' },
    })
    try {
      ask('agent_fork', 'first')
      await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1))
      ask('agent_create_status', 'pending')
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_create_status_result', payload: { requestId: 'pending', creationId, state: 'pending' },
      }))
      ask('agent_fork', 'retry')
      finish()
      for (const requestId of ['first', 'retry']) {
        await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
          type: 'agent_fork_result', payload: expect.objectContaining({ requestId, creationId, state: 'created', level: 'handoff', agent: expect.objectContaining({ id: FORK.agentId }) }),
        })))
      }
      expect(fork).toHaveBeenCalledWith({ agentId: 'agent-1', name: 'Separate idea', prompt: '  preserve\n  indentation  ' })
      ask('agent_create_status', 'recovered')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_status_result', payload: expect.objectContaining({ requestId: 'recovered', state: 'created', level: 'handoff' }),
      })))
      ask('agent_fork', 'changed', 'Different intent')
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_fork_result', payload: { requestId: 'changed', error: 'CREATION_CONFLICT' },
      }))
      lookup.mockReturnValue(undefined)
      ask('agent_fork', 'deleted')
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_fork_result', payload: { requestId: 'deleted', creationId, state: 'unavailable' },
      }))
      expect(fork).toHaveBeenCalledTimes(1)
    } finally {
      finish?.()
      await socket.unregisterLocalClient('local:fork')
      await socket.stop()
    }
  })

  it.each(['SPAWN_FAILED', 'REGISTRATION_FAILED', 'AGENT_BUSY'])('retains the fork outcome for %s', async (error) => {
    const { socket, frames } = localSocket()
    const fork = vi.fn(async () => ({ ok: false as const, error, detail: 'Fixture refusal' }))
    socket.onForkAgent = fork
    const creationId = randomUUID()
    const state = error === 'AGENT_BUSY' ? 'failed' : 'unconfirmed'
    try {
      for (const requestId of ['first', 'retry']) {
        socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId, creationId, agentId: 'agent-1' } })
        await vi.waitFor(() => expect(frames).toContainEqual({
          type: 'agent_fork_result', payload: { requestId, creationId, state,
            ...(state === 'failed' ? { failure: { code: error, detail: 'Fixture refusal' } } : {}) },
        }))
      }
      expect(fork).toHaveBeenCalledTimes(1)
    } finally {
      await socket.unregisterLocalClient('local:fork')
      await socket.stop()
    }
  })

  it('validates the frame before touching the daemon', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r1', error: 'MISSING_AGENT_ID' } }))
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r2', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r2', error: 'UNSUPPORTED_ON_REMOTE' } }))
    socket.onForkAgent = async () => ({ ok: true, session: FORK, level: 'native' })
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r3', agentId: 'agent-1', prompt: 'x'.repeat(2001) } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r3', error: 'PROMPT_TOO_LONG' } }))
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })

  it('hands name and prompt to the daemon and answers with the fork, its level, and who it came from', async () => {
    const { socket, frames } = localSocket()
    const seen: unknown[] = []
    socket.onForkAgent = async (input) => { seen.push(input); return { ok: true, session: FORK, level: 'native' } }
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1', agentId: 'agent-1', name: '  Agent one - fork ', prompt: 'ship it' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_fork_result')
      expect(result).toMatchObject({
        payload: { requestId: 'r1', level: 'native', agent: expect.objectContaining({ id: 'agent-2', forkedFrom: { agentId: 'agent-1', name: 'Agent one' } }) },
      })
    })
    expect(seen).toEqual([{ agentId: 'agent-1', name: 'Agent one - fork', prompt: 'ship it' }])
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })

  it('relays the daemon\'s refusal with its reason', async () => {
    const { socket, frames } = localSocket()
    socket.onForkAgent = async () => ({ ok: false, error: 'AGENT_BUSY', detail: 'Wait for it to finish, then fork.' })
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_fork_result', payload: { requestId: 'r1', error: 'AGENT_BUSY', detail: 'Wait for it to finish, then fork.' },
    }))
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })
})

describe('agent_restart RPC', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const BASE_SESSION: RegisteredSession = {
    schemaVersion: 2,
    active: true,
    agentId: 'agent-1',
    sessionId: 'session-1',
    boundAt: 1,
    engine: 'claude',
    transcriptPath: null,
    projectDir: 'workspace',
    cwd: '/tmp/workspace',
    runtimes: [],
    primaryRuntimeKey: '',
    tmuxPane: '%1',
    source: null,
    title: 'Agent one',
    model: null,
    cliVersion: null,
    processIdentity: null,
    registeredAt: 1,
    touchedAt: 1,
    lastHookAt: 1,
    lastTranscriptAt: 1,
  }

  function localSocket(): { socket: BackendSocket; frames: Array<Record<string, unknown>> } {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    bindAgentList(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:restart', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    return { socket, frames }
  }

  it('lists stopped work only on request, without exposing old routes or launch credentials', async () => {
    const { socket, frames } = localSocket()
    const saved = { ...BASE_SESSION, gridLaunch: { apiKey: 'fixture-private-key' } } as RegisteredSession
    vi.spyOn(registry, 'advertised').mockReturnValue([])
    vi.spyOn(registry, 'list').mockReturnValue([])
    vi.spyOn(stoppedAgents, 'available').mockReturnValue([saved])
    socket.handleLocalFrame('local:restart', { type: 'agents_list', payload: { requestId: 'live' } })
    socket.handleLocalFrame('local:restart', { type: 'agents_list', payload: { requestId: 'all', includeStopped: true } })
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'agents_list_result')).toHaveLength(2))
    const response = (id: string) => frames.find(frame => (frame.payload as any).requestId === id)?.payload as any
    expect(response('live').agents).toEqual([])
    expect(response('all').agents).toEqual([expect.objectContaining({ id: 'agent-1', status: 'stopped', sessionId: 'session-1', terminal: { available: false, primary: '', runtimes: [] }, tmuxPane: null, forkable: false })])
    expect(JSON.stringify(response('all'))).not.toContain('fixture-private-key')
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('adds monitor activity and readings only when explicitly requested', async () => {
    const { socket, frames } = localSocket()
    vi.spyOn(registry, 'advertised').mockReturnValue([BASE_SESSION])
    vi.spyOn(registry, 'list').mockReturnValue([BASE_SESSION])
    vi.spyOn(stoppedAgents, 'available').mockReturnValue([{ ...BASE_SESSION, agentId: 'stopped' }])
    const resources = vi.fn(async () => ({ sampledAt: new Date().toISOString(), agents: [{ agentId: 'agent-1', memoryBytes: 123, cpuPercent: 2, processCount: 1 }] }))
    bindAgentList(socket, { harnessResourcesReader: resources, monitorActivityProvider: sessionId => sessionId === BASE_SESSION.sessionId ? 'needsInput' : 'idle' })
    for (const [requestId, monitor] of [['plain', false], ['monitor', true]] as const) {
      socket.handleLocalFrame('local:restart', { type: 'agents_list', payload: { requestId, monitor, includeStopped: true } })
    }
    await vi.waitFor(() => expect(frames.filter(f => f.type === 'agents_list_result')).toHaveLength(2))
    const response = (id: string) => (frames.find(frame => (frame.payload as any).requestId === id)?.payload as any).agents
    expect(response('plain').every((agent: any) => agent.monitor === undefined)).toBe(true)
    expect(response('monitor').find((a: any) => a.id === 'agent-1').monitor).toMatchObject({ activity: 'needsInput', activityKnown: true, rssBytes: 123, cpu: 2, pid: BASE_SESSION.processIdentity?.pid ?? null })
    expect(response('monitor').find((a: any) => a.id === 'stopped').monitor).toMatchObject({ rssBytes: 0, cpu: 0, pid: null })
    expect(resources).toHaveBeenCalledOnce()
    await socket.unregisterLocalClient('local:restart'); await socket.stop()
  })

  it('rejects a stop when the reviewed conversation rotated before the command arrived', async () => {
    const { socket, frames } = localSocket()
    const stop = vi.fn(async () => {})
    bindStopRequest(socket, stop)
    vi.spyOn(registry, 'byAgent').mockReturnValue({ ...BASE_SESSION, sessionId: 'replacement' })
    socket.handleLocalFrame('local:restart', { type: 'agent_delete', payload: {
      requestId: 'stale-stop', agentId: BASE_SESSION.agentId, expectedSessionId: BASE_SESSION.sessionId,
    } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_delete_result', payload: {
      requestId: 'stale-stop', error: 'SESSION_CHANGED', detail: 'This conversation changed. Refresh and review it before stopping.',
    } }))
    expect(stop).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:restart'); await socket.stop()
  })

  it('delegates a resume-only intent and retains its original receipt', async () => {
    const { socket, frames } = localSocket()
    const creationId = `resume-${randomUUID()}`
    const handler = vi.fn(async () => ({ ok: true as const, session: BASE_SESSION, resumed: true }))
    bindLaunchRequests(socket, { resume: handler })
    vi.spyOn(registry, 'byAgent').mockReturnValue(BASE_SESSION)
    for (const requestId of ['first', 'again']) {
      socket.handleLocalFrame('local:restart', { type: 'agent_resume', payload: { requestId, agentId: 'agent-1', creationId } })
      await vi.waitFor(() => expect(frames.some(frame => (frame.payload as any).requestId === requestId)).toBe(true))
    }
    expect(handler).toHaveBeenCalledExactlyOnceWith('agent-1')
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('binds an explicit resume permission choice to its operation receipt', async () => {
    const { socket, frames } = localSocket()
    const creationId = `resume-mode-${randomUUID()}`
    const handler = vi.fn(async () => ({ ok: true as const, session: { ...BASE_SESSION, permissionMode: 'auto' }, resumed: true }))
    bindLaunchRequests(socket, { resume: handler })
    vi.spyOn(registry, 'byAgent').mockReturnValue(BASE_SESSION)
    for (const [requestId, permissionMode] of [['first', 'auto'], ['again', 'auto'], ['changed', 'ask']]) {
      socket.handleLocalFrame('local:restart', { type: 'agent_resume', payload: { requestId, agentId: 'agent-1', creationId, permissionMode } })
      await vi.waitFor(() => expect(frames.some(frame => (frame.payload as any).requestId === requestId)).toBe(true))
    }
    expect(handler).toHaveBeenCalledExactlyOnceWith('agent-1', 'auto')
    expect(frames).toContainEqual({ type: 'agent_resume_result', payload: { requestId: 'changed', error: 'CREATION_CONFLICT' } })
    await socket.unregisterLocalClient('local:restart'); await socket.stop()
  })

  it.each([7, '', 'allow', { auto: true }])('refuses invalid resume permission payload %j', async permissionMode => {
    const { socket, frames } = localSocket()
    const resume = vi.fn()
    bindLaunchRequests(socket, { resume })
    socket.handleLocalFrame('local:restart', { type: 'agent_resume', payload: { requestId: 'bad-mode', agentId: 'agent-1', permissionMode } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_resume_result', payload: { requestId: 'bad-mode', error: 'INVALID_PERMISSION_MODE' } }))
    expect(resume).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:restart'); await socket.stop()
  })

  it('replies MISSING_AGENT_ID when no agentId is given', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'MISSING_AGENT_ID' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('replies UNSUPPORTED_ON_REMOTE when no handler is wired', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'UNSUPPORTED_ON_REMOTE' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('delegates to onRestartAgent and replies with the agent projection and the resumed flag on success', async () => {
    const { socket, frames } = localSocket()
    let seenAgentId: string | undefined
    bindLaunchRequests(socket, { restart: async (agentId) => {
      seenAgentId = agentId
      return { ok: true, session: BASE_SESSION, resumed: true }
    } })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_restart_result')
      expect(result).toMatchObject({
        type: 'agent_restart_result',
        payload: {
          requestId: 'r1',
          resumed: true,
          agent: expect.objectContaining({ id: 'agent-1', sessionId: 'session-1', engine: 'claude' }),
        },
      })
    })
    expect(seenAgentId).toBe('agent-1')
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('reports a fresh (non-resumed) relaunch through the same resumed flag', async () => {
    const { socket, frames } = localSocket()
    bindLaunchRequests(socket, { restart: async () => ({ ok: true, session: BASE_SESSION, resumed: false }) })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_restart_result')
      expect(result).toMatchObject({ payload: { requestId: 'r1', resumed: false } })
    })
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('replies with error+detail on failure, matching agent_create/agent_delete\'s reply shape', async () => {
    const { socket, frames } = localSocket()
    bindLaunchRequests(socket, { restart: async () => (
      { ok: false, error: 'RESTART_FAILED', detail: 'claude did not come back up after restart' }
    ) })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result',
      payload: { requestId: 'r1', error: 'RESTART_FAILED', detail: 'claude did not come back up after restart' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('recovers a restart receipt without replacing the process again', async () => {
    const { socket, frames } = localSocket()
    const creationId = 'restart-receipt-test-0001'
    let finish!: () => void
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { ok: true as const, session: BASE_SESSION, resumed: false }
    })
    bindLaunchRequests(socket, { restart: handler })
    vi.spyOn(registry, 'byAgent').mockImplementation((id) => id === BASE_SESSION.agentId ? BASE_SESSION : undefined)
    const request = (requestId: string, type = 'agent_restart') => socket.handleLocalFrame('local:restart', { type, payload: { requestId, agentId: 'agent-1', creationId } })
    const response = (id: string) => frames.find((frame) => (frame.payload as { requestId?: string }).requestId === id)?.payload
    request('first')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    request('pending', 'agent_create_status')
    await vi.waitFor(() => expect(response('pending')).toMatchObject({ creationId, state: 'pending' }))
    request('joined')
    finish()
    await vi.waitFor(() => expect(response('joined')).toMatchObject({ creationId, state: 'created', resumed: false }))
    request('recovered', 'agent_create_status')
    await vi.waitFor(() => expect(response('recovered')).toMatchObject({ creationId, state: 'created', resumed: false }))
    request('duplicate')
    await vi.waitFor(() => expect(response('duplicate')).toMatchObject({ creationId, state: 'created' }))
    expect(handler).toHaveBeenCalledTimes(1)
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it.each(['RESTART_FAILED', 'AGENT_BUSY'])('retains %s without repeating a restart', async (error) => {
    const { socket, frames } = localSocket()
    const creationId = `restart-receipt-${error}`
    const handler = vi.fn(async () => ({ ok: false as const, error, detail: 'fixture refusal' }))
    bindLaunchRequests(socket, { restart: handler })
    for (const requestId of ['first', 'again']) {
      socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId, agentId: 'agent-1', creationId } })
      await vi.waitFor(() => expect(frames.find((frame) => (frame.payload as { requestId?: string }).requestId === requestId)?.payload).toMatchObject({ creationId, state: error === 'RESTART_FAILED' ? 'unconfirmed' : 'failed' }))
    }
    expect(handler).toHaveBeenCalledTimes(1)
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('omits detail on failure when the handler did not supply one', async () => {
    const { socket, frames } = localSocket()
    bindLaunchRequests(socket, { restart: async () => ({ ok: false, error: 'AGENT_NOT_FOUND' }) })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'AGENT_NOT_FOUND' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })
})

describe('device agent list contract', () => {
  it('keeps the engine discriminator while trimming web-only fields', () => {
    expect(deviceAgentListItem({ id: 's1', name: 'Codex agent', engine: 'codex', userId: 'secret' })).toEqual({
      id: 's1', name: 'Codex agent', engine: 'codex',
    })
  })

  it('surfaces the runtime-v1 model/effort profile so the device can render + change it', () => {
    const profile = 'runtime-v1:s1:codex:gpt-5.6-sol@high'
    expect(deviceAgentListItem({ id: 's1', name: 'A', engine: 'codex', selectedModel: profile })).toEqual({
      id: 's1', name: 'A', engine: 'codex', selectedModel: profile,
    })
    expect(deviceAgentListItem({ id: 's1', name: 'A', engine: 'claude', selectedModel: null })).toEqual({
      id: 's1', name: 'A', engine: 'claude', selectedModel: null,
    })
  })

  it('preserves Grok on the device agent contract', () => {
    expect(deviceAgentListItem({ id: 'g1', name: 'Grok agent', engine: 'grok' })).toEqual({
      id: 'g1', name: 'Grok agent', engine: 'grok',
    })
  })

  it('keeps a terminal off the device: not a row for it, and never an engine it would understand', () => {
    expect(deviceAgentRow({ id: 't1', name: 'Terminal 1', engine: 'terminal' })).toBe(false)
    expect(deviceAgentRow({ id: 'c1', name: 'Claude 1', engine: 'claude' })).toBe(true)
    expect(deviceAgentListItem({ id: 't1', name: 'Terminal 1', engine: 'terminal' })).toEqual({ id: 't1', name: 'Terminal 1' })
  })
})

describe('Grok session_get history', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('./lib/__fixtures__/grok-session.jsonl', import.meta.url)),
    'utf8',
  ).split('\n').filter(Boolean)

  it('replays the real transcript for both legacy and web-paginated requests', () => {
    const full = grokHistoryPage(fixture, false)
    const paginated = grokHistoryPage(fixture, true)

    expect(full.events).toEqual(paginated.events)
    expect(full.events[0]).toMatchObject({ type: 'user_message' })
    expect(full.events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(full).not.toHaveProperty('hasMore')
    expect(paginated).toMatchObject({ hasMore: false, oldestCursor: null })
  })
})

describe('adapter-ws dial url', () => {
  const dialUrl = (socket: BackendSocket): string => upstreamOf(socket).url

  it('carries the machine id this daemon still holds, so a revoked one gets 403 not a new machine', () => {
    const machineId = 'b'.repeat(32)

    expect(dialUrl(relaySocket(machineId, undefined, () => {}, 'computer-1')))
      .toContain(`&machine=${machineId}`)
  })

  it('omits the claim when the first argument is a test token rather than a machine id', () => {
    // Constructed without an AuthSessionManager, the first argument is a token — sending it as a
    // machine id would be a lie the backend then has to reject.
    expect(dialUrl(relaySocket('token', undefined, () => {}, 'computer-1'))).not.toContain('&machine=')
  })
})

describe('agent_retarget clearGrid', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const WIRE_GRID = {
    networkId: 'grid-abc',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-abc/relay/v1',
    apiKey: 'gridkey-abc123',
  }

  async function retarget(payload: Record<string, unknown>) {
    const seen: Array<{ agentId: string; grid: unknown }> = []
    const socket = relaySocket('token')
    socket.onRetargetAgent = async (input) => { seen.push(input); return { ok: true } }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    withSession(socket, 'web-1')
    ws.message(sealedDown(socket, 'web-1', 'agent_retarget', payload))
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0))
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'agent_retarget_result')
    await socket.stop()
    return { seen, reply }
  }

  it('passes a null grid when clearGrid is true', async () => {
    const { seen } = await retarget({ requestId: 'r', agentId: 'a1', clearGrid: true })
    expect(seen).toEqual([{ agentId: 'a1', grid: null }])
  })

  // Both is a contradiction, and answering it would mean guessing which one the client meant.
  it('refuses grid and clearGrid together', async () => {
    const { seen, reply } = await retarget({ requestId: 'r', agentId: 'a1', clearGrid: true, grid: WIRE_GRID })
    expect(reply?.payload?.error).toBe('INVALID_GRID')
    expect(seen).toHaveLength(0)
  })

  // Unchanged: a client that simply forgot the field is still an error, which is the whole reason
  // clearGrid is a separate field rather than `grid: null`.
  it('still refuses a frame with neither', async () => {
    const { seen, reply } = await retarget({ requestId: 'r', agentId: 'a1' })
    expect(reply?.payload?.error).toBe('INVALID_GRID')
    expect(seen).toHaveLength(0)
  })
})

/**
 * The desktop's retarget names a Local model and nothing else; the daemon resolves everything from
 * its own signed-in `grid`. This is that resolution through the real frame handler, against the
 * plan-driven fake `grid` — the seam `gridEnsure.spec.ts` established.
 */
describe('agent_retarget onto a Local model resolves web tools', () => {
  const { gridName: GRID_NAME, networkId, baseUrl: BASE_URL, mcpUrl: MCP_URL, token: TOKEN, plan } = fakeGridAnswers()

  let fake: FakeGrid | null = null
  afterEach(async () => {
    fake?.dispose()
    fake = null
    clearGridMcpUrlCache()
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  async function retargetOntoLocalModel(model: string) {
    const seen: Array<{ agentId: string; grid: unknown }> = []
    const socket = relaySocket('token')
    socket.onRetargetAgent = async (input) => { seen.push(input); return { ok: true } }
    // Where the move goes is the models service's: it resolves the target from this machine's own grid.
    serveModels(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    // The grid name is the backend's, pushed on connect; the daemon holds it in memory only.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: GRID_NAME } } })
    withSession(socket, 'web-1')
    ws.message(sealedDown(socket, 'web-1', 'agent_retarget', { requestId: 'r', agentId: 'a1', gridModel: model }))
    await vi.waitFor(() => expect(parseSent(ws).some((item) => (item.frame as { type?: string } | undefined)?.type === 'agent_retarget_result')).toBe(true), { timeout: 10_000 })
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'agent_retarget_result')
    await socket.stop()
    return { seen, reply }
  }

  it('yields a launch override whose MCP URL is exactly the printed url, asking `mcp config` before `info --env`', async () => {
    fake = installFakeGrid(plan)
    const { seen, reply } = await retargetOntoLocalModel('GLM-4.7-Flash')
    expect(reply?.payload).toMatchObject({ retargeted: true })
    expect(seen).toEqual([{
      agentId: 'a1',
      grid: {
        networkId,
        networkName: GRID_NAME,
        baseUrl: BASE_URL,
        apiKey: TOKEN,
        model: 'GLM-4.7-Flash',
        mcpUrl: MCP_URL,
      },
    }])
    expect(fake.verbs()).toEqual(['mcp', 'info', 'ls'])
    expect(fake.calls()[0]).toEqual(['--remote', 'mcp', 'config', GRID_NAME, '--json'])
  })

  it('still retargets, with no MCP URL, when the binary is too old for `mcp config`', async () => {
    const warned: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => { warned.push(parts.map(String).join(' ')) })
    fake = installFakeGrid({ ...plan, mcp: { exit: 2, stderr: "grid: error: invalid choice: 'mcp'\n" } })
    const { seen, reply } = await retargetOntoLocalModel('GLM-4.7-Flash')
    expect(reply?.payload).toMatchObject({ retargeted: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.grid).toMatchObject({ baseUrl: BASE_URL, apiKey: TOKEN, model: 'GLM-4.7-Flash' })
    expect(seen[0]!.grid).not.toHaveProperty('mcpUrl')
    // The reason reaches the daemon log, and nothing else — the retarget error path is untouched.
    expect(warned.join('\n')).toMatch(/web tools unavailable .* older than/)
    expect(reply?.payload).not.toHaveProperty('error')
  })
})

/**
 * `agent_create` carrying a first prompt, a name and a named agent — the fields the run-a-harness-compute
 * entry can send (it sends `name` and `agent`). All are validated at the wire, before any pane
 * exists; what reaches `onCreateAgent` is exactly what cli.ts hands to the launch and the registry.
 */
describe('agent_create with a prompt, a name and a named agent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const pending: RegisteredSession = {
    schemaVersion: 2, active: true, launch: { state: 'starting' },
    agentId: 'named-1', sessionId: '', boundAt: null, engine: 'opencode',
    transcriptPath: null, projectDir: 'home', cwd: '/home/someone', defaultName: 'Local model',
    runtimes: [{ backend: 'tmux', paneId: '%11' }], primaryRuntimeKey: 'tmux/%11', tmuxPane: '%11',
    source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }

  async function create(choices: Record<string, unknown>) {
    const socket = relaySocket('token')
    bindLaunchRequests(socket)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:named', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    const seen: unknown[] = []
    socket.onCreateAgent = async (input) => { seen.push(input); return { ok: true, session: pending } }
    try {
      socket.handleLocalFrame('local:named', { type: 'agent_create', payload: { requestId: 'r', engine: 'opencode', cwd: '/home/someone', ...choices } })
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'agent_create_result')).toBe(true))
    } finally {
      await socket.unregisterLocalClient('local:named')
      await socket.stop()
    }
    const reply = frames.find((frame) => frame.type === 'agent_create_result')?.payload as Record<string, unknown>
    return { seen, reply }
  }

  it('passes both through, trimmed, and the name becomes the row\'s defaultName', async () => {
    const { seen, reply } = await create({ prompt: '  Start a local model on this machine ', name: ' Local model ' })
    expect(seen).toEqual([expect.objectContaining({ engine: 'opencode', prompt: 'Start a local model on this machine', name: 'Local model' })])
    expect(reply).toMatchObject({ agent: expect.objectContaining({ id: 'named-1', name: 'Local model' }) })
  })

  it('sends null for both when neither was given, or when they are blank', async () => {
    expect((await create({})).seen).toEqual([expect.objectContaining({ prompt: null, name: null })])
    expect((await create({ prompt: '   ', name: '' })).seen).toEqual([expect.objectContaining({ prompt: null, name: null })])
  })

  it('refuses an over-long prompt before any pane exists', async () => {
    const { seen, reply } = await create({ prompt: 'x'.repeat(2001) })
    expect(reply).toMatchObject({ error: 'PROMPT_TOO_LONG' })
    expect(seen).toHaveLength(0)
    expect((await create({ prompt: 'x'.repeat(2000) })).seen).toHaveLength(1)
  })

  it('refuses a prompt for an engine with no documented mechanism, naming the engine', async () => {
    const { seen, reply } = await create({ engine: 'cursor', prompt: 'Start a local model on this machine' })
    expect(reply).toMatchObject({ error: 'PROMPT_UNSUPPORTED', detail: expect.stringContaining('cursor') })
    expect(seen).toHaveLength(0)
  })

  it('refuses a prompt that is not text', async () => {
    const { seen, reply } = await create({ prompt: ['Start a local model'] })
    expect(reply).toMatchObject({ error: 'INVALID_PROMPT' })
    expect(seen).toHaveLength(0)
  })

  it('passes the named agent through for opencode, and null when none was given', async () => {
    // v1 — pinned, so the answer does not depend on the OpenCode installed where the suite runs.
    vi.spyOn(opencodeVersion, 'opencodeMajorVersion').mockReturnValue(1)
    const { seen, reply } = await create({ agent: 'harness-compute', name: 'Local model' })
    expect(seen).toEqual([expect.objectContaining({ engine: 'opencode', agent: 'harness-compute', name: 'Local model', prompt: null })])
    expect(reply).toMatchObject({ agent: expect.objectContaining({ id: 'named-1' }) })
    expect((await create({})).seen).toEqual([expect.objectContaining({ agent: null })])
    expect((await create({ agent: null })).seen).toEqual([expect.objectContaining({ agent: null })])
  })

  it('refuses a named agent for opencode v2, whose TUI exits 1 on --agent, before any pane exists', async () => {
    vi.spyOn(opencodeVersion, 'opencodeMajorVersion').mockReturnValue(2)
    const { seen, reply } = await create({ agent: 'harness-compute' })
    expect(reply).toMatchObject({ error: 'AGENT_UNSUPPORTED', detail: expect.stringContaining('opencode') })
    expect(seen).toHaveLength(0)
  })

  it('refuses a named agent for an engine with no documented mechanism, naming the engine, before any pane exists', async () => {
    for (const engine of ['claude', 'codex', 'cursor']) {
      const { seen, reply } = await create({ engine, agent: 'harness-compute' })
      expect(reply).toMatchObject({ error: 'AGENT_UNSUPPORTED', detail: expect.stringContaining(engine) })
      expect(seen).toHaveLength(0)
    }
  })

  it('refuses a named agent that is not an identifier — a path, prose, blank, over-long, or not text', async () => {
    for (const agent of ['', '  ', 'local model', '../etc/passwd', 'a/b', 'x'.repeat(65), ['harness-compute'], 7]) {
      const { seen, reply } = await create({ agent })
      expect(reply).toMatchObject({ error: 'INVALID_AGENT' })
      expect(seen).toHaveLength(0)
    }
  })
})

/**
 * The picker and the Local model dialog gate on `gridName` — whether the ACCOUNT has a grid — and
 * had nothing to tell them whether the MACHINE has a `grid` to run at all. A user with no CLI got a
 * dialog that started an agent, which died at the skill's second step. The answer travels beside
 * the list, as `localModelEngines` does, and says which grid it is: the managed runtime, one found
 * on PATH, or none.
 */
describe('grid_models_list says whether this machine has a grid CLI', () => {
  const { gridName: GRID_NAME, plan } = fakeGridAnswers()

  let fake: FakeGrid | null = null
  afterEach(async () => {
    fake?.dispose()
    fake = null
    wsMock.instances.length = 0
  })

  async function listModels(): Promise<Record<string, unknown> | undefined> {
    const socket = relaySocket('token')
    serveModels(socket)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: GRID_NAME } } })
    withSession(socket, 'web-1')
    ws.message(sealedDown(socket, 'web-1', 'grid_models_list', { requestId: 'r' }))
    await vi.waitFor(() => expect(parseSent(ws).some((item) => (item.frame as { type?: string } | undefined)?.type === 'grid_models_list_result')).toBe(true), { timeout: 10_000 })
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'grid_models_list_result')
    await socket.stop()
    return reply?.payload
  }

  it('names the grid it would run — the fixture is a developer override, so `path`', async () => {
    fake = installFakeGrid(plan)

    expect(await listModels()).toMatchObject({ gridName: GRID_NAME, gridCli: 'path' })
  })
})

describe('a move onto a grid model asks models where it goes', () => {
  /** A daemon whose models is a stub, asked over a local frame. Where the move goes, grid's set-up before
   *  it and the prewarm after it are the models service's (services/models.spec.ts). */
  function daemon(moveTarget: ModelsPort['moveTarget'] | null) {
    const socket = relaySocket('token')
    const moved = vi.fn()
    if (moveTarget) socket.models = () => ({ annotation: () => null, lists: () => Promise.reject(new Error('no lists')), moveTarget, moved })
    const retargeted = vi.fn(async (_request: { agentId: string; grid: unknown }) => ({ ok: true as const }))
    socket.onRetargetAgent = retargeted
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:grid', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    let asked = 0
    const ask = async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const requestId = `${type}-${++asked}`
      socket.handleLocalFrame('local:grid', { type, payload: { requestId, ...payload } })
      const answer = (): Record<string, unknown> | undefined => frames
        .map((frame) => frame.payload as Record<string, unknown> | undefined)
        .find((body) => body?.requestId === requestId)
      await vi.waitFor(() => expect(answer()).toBeDefined())
      return answer()!
    }
    return { socket, moved, retargeted, ask, done: async () => { await socket.unregisterLocalClient('local:grid'); await socket.stop() } }
  }
  const TARGET = { networkId: 'net-1', networkName: 'team-grid-0000aaaa', baseUrl: 'https://fixture.invalid/g/net-1/relay/v1', apiKey: 'fixture-key', model: 'Shared-Model' }

  it('moves onto what models resolved, from the grid the model was picked from, and has models start it', async () => {
    const moveTarget = vi.fn(async () => ({ target: TARGET }))
    const d = daemon(moveTarget)
    expect(await d.ask('agent_retarget', { agentId: 'a1', gridModel: 'Shared-Model', gridName: ' team-grid-0000aaaa ' })).toEqual({ requestId: 'agent_retarget-1', retargeted: true })
    expect(moveTarget).toHaveBeenCalledWith({ gridName: 'team-grid-0000aaaa', model: 'Shared-Model' })
    expect(d.retargeted).toHaveBeenCalledWith({ agentId: 'a1', grid: TARGET })
    expect(d.moved).toHaveBeenCalledWith(TARGET)
    // The account's own grid when the picker names none.
    await d.ask('agent_retarget', { agentId: 'a1', gridModel: 'Own-Model' })
    expect(moveTarget).toHaveBeenLastCalledWith({ gridName: null, model: 'Own-Model' })
    await d.done()
  })

  it('says why it cannot move, in models\' words, and moves nothing', async () => {
    const d = daemon(async () => ({ detail: 'no grid on this computer' }))
    expect(await d.ask('agent_retarget', { agentId: 'a1', gridModel: 'Shared-Model', gridName: 'team-grid-0000aaaa' }))
      .toMatchObject({ error: 'GRID_UNAVAILABLE', detail: 'no grid on this computer' })
    expect(d.retargeted).not.toHaveBeenCalled()
    expect(d.moved).not.toHaveBeenCalled()
    await d.done()
  })

  it('with models down or off, the move answers GRID_UNAVAILABLE at once', async () => {
    for (const down of [async () => { throw new Error('models is down') }, null]) {
      const d = daemon(down)
      expect(await d.ask('agent_retarget', { agentId: 'a1', gridModel: 'Own-Model' }))
        .toMatchObject({ error: 'GRID_UNAVAILABLE', detail: 'Models are unavailable. Try again.' })
      expect(d.retargeted).not.toHaveBeenCalled()
      await d.done()
    }
  })

  it('a move onto an API, or back onto the own login, asks models nothing', async () => {
    const moveTarget = vi.fn()
    const d = daemon(moveTarget)
    expect(await d.ask('agent_retarget', { agentId: 'a1', clearGrid: true })).toMatchObject({ retargeted: true })
    expect(moveTarget).not.toHaveBeenCalled()
    expect(d.moved).not.toHaveBeenCalled()
    await d.done()
  })
})

describe('the models lists pushed to the windows', () => {
  it('pushes each window the list in the form it asked for, as models built it; nothing while models is off or failing', async () => {
    const socket = relaySocket('token')
    const rows: Array<Record<string, unknown>> = []
    const plain: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:rows', { sendFrame: (frame) => { rows.push(frame); return true }, sendBinary: () => true })
    socket.registerLocalClient('local:plain', { sendFrame: (frame) => { plain.push(frame); return true }, sendBinary: () => true })
    // A window that draws row state says so when it asks for the list.
    socket.handleLocalFrame('local:rows', { type: 'grid_models_list', payload: { requestId: 'r1', rowState: true } })
    await vi.waitFor(() => expect(rows.some((frame) => frame.type === 'grid_models_list_result')).toBe(true))
    rows.length = 0
    plain.length = 0

    await socket.pushGridModels()
    socket.models = () => ({ ...MODELS_OFF, lists: async () => ({ plain: { form: 'plain' }, rowState: { form: 'rows' } }) })
    await socket.pushGridModels()
    expect(rows).toEqual([{ type: 'grid_models_changed', payload: { form: 'rows' } }])
    expect(plain).toEqual([{ type: 'grid_models_changed', payload: { form: 'plain' } }])
    socket.models = () => MODELS_OFF
    await socket.pushGridModels()
    expect(rows).toHaveLength(1)
    await socket.unregisterLocalClient('local:rows')
    await socket.unregisterLocalClient('local:plain')
    await socket.stop()
  })

  it('carries models\' note on the grid an agent is on in every frame it builds, and none while models is off', async () => {
    const socket = relaySocket('token')
    const grid = { baseUrl: 'https://fixture.invalid/g/n1/relay/v1', model: 'm' }
    const agent = { agentId: 'a-note', sessionId: 's-note', engine: 'claude', cwd: '/tmp', runtimes: [], registeredAt: 1, active: true, grid } as unknown as RegisteredSession
    expect((await socket.toProject(agent)).grid).toEqual(grid)
    socket.models = () => ({ ...MODELS_OFF, annotation: () => ({ state: 'asleep' as const }) })
    expect((await socket.toProject(agent)).grid).toEqual({ ...grid, state: 'asleep' })
    expect((await socket.toStoppedProject(agent)).grid).toEqual({ ...grid, state: 'asleep' })
    await socket.stop()
  })

  it('answers the grid commands\' handshake itself, so a Grid harness never reads models being down as "update Harness"', async () => {
    const socket = relaySocket('token')
    socket.models = () => MODELS_OFF
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:grid', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:grid', { type: 'grid_fleet_capabilities', payload: { requestId: 'c1' } })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'grid_fleet_capabilities_result')).toBe(true))
    expect(frames.find((frame) => frame.type === 'grid_fleet_capabilities_result')!.payload)
      .toMatchObject({ requestId: 'c1', protocol: 1, maxTimeoutMs: 30 * 60_000, thinkingControl: true, gridCli: expect.any(String) })
    await socket.unregisterLocalClient('local:grid')
    await socket.stop()
  })
})

describe('the connect burst with no network', () => {
  afterEach(() => { wsMock.instances.length = 0 })

  it('a grid_models_list that never answers does not hold agents_list or usage_read behind it', async () => {
    // Measured 2026-09-18, wifi off, daemon restarted: the desktop asks grid_models_list,
    // terminal_capabilities and agents_list in one breath on every connect. grid_models_list waited
    // on a grid reconcile that could not finish, and the ordered per-connection chain held the other
    // two behind it past the app's 10s timeout — on which the app forced a reconnect and asked all
    // three again, for as long as the wifi stayed off. The terminal on the same computer read
    // "offline" the whole time.
    const socket = relaySocket('token')
    bindAgentList(socket)
    // A grid name that never comes, as a grid read that never lands; and a vendor that never answers, asked
    // of the usage service beside models.
    serveModels(socket, { account: { privateGridName: () => new Promise<null>(() => {}) } }).serve('usage', (core) => startUsage(core, { read: () => new Promise(() => {}) }), fakeCore(), USAGE_REQUESTS)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:burst', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })

    socket.handleLocalFrame('local:burst', { type: 'grid_models_list', payload: { requestId: 'grid' } })
    socket.handleLocalFrame('local:burst', { type: 'usage_read', payload: { requestId: 'usage' } })
    socket.handleLocalFrame('local:burst', { type: 'agents_list', payload: { requestId: 'agents' } })

    await vi.waitFor(() => expect(frames.some((f) => f.type === 'agents_list_result')).toBe(true))
    expect(frames.some((f) => f.type === 'grid_models_list_result')).toBe(false)
    expect(frames.some((f) => f.type === 'usage_read_result')).toBe(false)
    await socket.unregisterLocalClient('local:burst')
    await socket.stop()
  })
})

describe('machine_meta carries the grid name without clobbering it on rename', () => {
  afterEach(() => { wsMock.instances.length = 0 })

  it('keeps the grid name when a later rename frame omits gridName, and clears it only on an explicit null', async () => {
    const socket = relaySocket('token')
    // Frames are processed through a queue, so `onMachineMeta` is how a test knows one has landed.
    const namesSeen: Array<string | null> = []
    socket.onMachineMeta = (n) => { namesSeen.push(n) }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // Connect frame: name and grid together.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(socket.gridName()).toBe('someone-7f3a91c4'))

    // A rename pushes `{ name }` alone — it must NOT wipe the grid name (the bug that left the picker
    // empty the moment a machine was renamed). Wait until the rename is observably processed, then
    // confirm the grid name survived it.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'renamed' } } })
    await vi.waitFor(() => expect(namesSeen).toContain('renamed'))
    expect(socket.gridName()).toBe('someone-7f3a91c4')

    // An explicit null is the account genuinely having no grid, and does clear it.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'renamed', gridName: null } } })
    await vi.waitFor(() => expect(socket.gridName()).toBeNull())

    await socket.stop()
  })

  it("keeps the machine's own name, for the models it serves — a rename updates it, a frame without one does not", async () => {
    const socket = relaySocket('token')
    const namesSeen: Array<string | null> = []
    socket.onMachineMeta = (n) => { namesSeen.push(n) }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    expect(socket.machineName()).toBeNull()
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: ' M2 ', gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(socket.machineName()).toBe('M2'))
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'Studio' } } })
    await vi.waitFor(() => expect(socket.machineName()).toBe('Studio'))
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(namesSeen).toHaveLength(3))
    expect(socket.machineName()).toBe('Studio')
    await socket.stop()
  })

  it('refuses a machine_meta that arrived over the LOCAL socket — only the backend may name the grid', async () => {
    const socket = relaySocket('token')
    const namesSeen: Array<string | null> = []
    socket.onMachineMeta = (n) => { namesSeen.push(n) }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // The backend's own frame sets it, as always.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(socket.gridName()).toBe('someone-7f3a91c4'))

    // Now the same frame from a process on this machine, through the local socket — the shape of the
    // leftover script that once redirected this account's agents onto a grid of its choosing.
    const local = 'local:1'
    socket.registerLocalClient(local, { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame(local, { type: 'machine_meta', payload: { name: 'hijacked', gridName: 'attacker-deadbeef' } })

    // Give the queue a turn: the frame must be dropped whole, so neither half of it lands.
    await new Promise((r) => setTimeout(r, 50))
    expect(socket.gridName()).toBe('someone-7f3a91c4')
    expect(namesSeen).not.toContain('hijacked')

    await socket.stop()
  })

  it('refuses a machine_revoked over the LOCAL socket — one frame would otherwise sign this computer out', async () => {
    const socket = relaySocket('token')
    let revoked = 0
    socket.onRevoked = () => { revoked += 1 }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // `onRevoked` clears the stored SSO session and exits the daemon, so accepting this from a local
    // process is a one-frame forced sign-out and denial of service.
    const local = 'local:1'
    socket.registerLocalClient(local, { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame(local, { type: 'machine_revoked', payload: {} })
    await new Promise((r) => setTimeout(r, 50))
    expect(revoked).toBe(0)

    // The backend's own frame still works — the gate is about the sender, not the frame.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: {} } })
    await vi.waitFor(() => expect(revoked).toBe(1))

    await socket.stop()
  })

  it('says whose key a device-key-log removal spent before signing out, and nothing for a plain revoke', async () => {
    const socket = relaySocket('token')
    const order: string[] = []
    gatewayOf(socket).onDeviceRemoved = (pub) => { order.push(`removed:${pub}`) }
    socket.onRevoked = () => { order.push('revoked') }
    socket.connect()
    const ws = wsMock.instances.at(-1)!
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: { reason: 'device_removed', pub: 'PUB' } } })
    await vi.waitFor(() => expect(order).toEqual(['removed:PUB', 'revoked']))
    await socket.stop()

    const plain = relaySocket('token')
    let removed = 0
    gatewayOf(plain).onDeviceRemoved = () => { removed += 1 }
    plain.onRevoked = () => {}
    plain.connect()
    const ws2 = wsMock.instances.at(-1)!
    ws2.open()
    ws2.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: {} } })
    await new Promise((r) => setTimeout(r, 50))
    expect(removed).toBe(0)
    await plain.stop()
  })

  it('keeps running when the removed key is ANOTHER key under this machine id (an earlier install it waits behind)', async () => {
    // A reinstall that kept the computer id finds its machine id held by the old install's key
    // (device_conflict). Removing that key makes the backend send `machine_revoked` to the machine id —
    // which this daemon now answers for. That removal is what lets this key register, not a sign-out.
    const socket = relaySocket('token')
    const seen: string[] = []
    gatewayOf(socket).isOwnDeviceKey = (pub) => pub === 'MINE'
    gatewayOf(socket).onDeviceRemoved = (pub) => { seen.push(`removed:${pub}`) }
    socket.onRevoked = () => { seen.push('revoked') }
    gatewayOf(socket).onDeviceKeysChanged = () => { seen.push('reread') }
    socket.connect()
    const ws = wsMock.instances.at(-1)!
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: { reason: 'device_removed', pub: 'OLD_INSTALL' } } })
    await vi.waitFor(() => expect(seen).toEqual(['reread']))
    // Still linked: a later frame for its OWN key signs it out as before.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: { reason: 'device_removed', pub: 'MINE' } } })
    await vi.waitFor(() => expect(seen).toEqual(['reread', 'removed:MINE', 'revoked']))
    await socket.stop()

    // A plain revoke (the machine deleted) still ends the sign-in whatever the key.
    const plain = relaySocket('token')
    let revoked = 0
    gatewayOf(plain).isOwnDeviceKey = () => false
    plain.onRevoked = () => { revoked += 1 }
    plain.connect()
    const ws2 = wsMock.instances.at(-1)!
    ws2.open()
    ws2.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: {} } })
    await vi.waitFor(() => expect(revoked).toBe(1))
    await plain.stop()
  })
})

/** The read-only hardware line for the run-a-harness-compute dialog, answered next to `grid_models_list`. */

describe('Autonomous direct isolation from existing relay/browser behavior', () => {
  it('permits offline PAKE only for the exact live direct pending connection', async () => {
    const backend = relaySocket('direct-offline-test')
    const send = vi.fn()
    gatewayOf(backend).attachDirectDevice('autonomous-direct:test', send)
    const pairId = Buffer.alloc(16, 1).toString('base64')
    gatewayOf(backend).e2ee.handleFrame('browser', { type: 'e2e_pair_intent', payload: { pairId, role: 'web', label: 'Browser' } })
    expect(await gatewayOf(backend).pair('K7P4X9')).toEqual({ ok: false, error: 'BACKEND_DOWN' })
    await gatewayOf(backend).receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_intent', payload: { pairId, role: 'device', label: 'Autonomous device' } }, true)
    const paired = gatewayOf(backend).pair('K7P4X9')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e_pake' }))
    await gatewayOf(backend).receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_cancel', payload: { pairId } }, true)
    expect(await paired).toEqual({ ok: false, error: 'CANCELLED' })
    gatewayOf(backend).detachDirectDevice('autonomous-direct:test')
  })
  it('never dispatches setup/password/admin/terminal frames from a discovered endpoint', async () => {
    const backend = relaySocket('direct-whitelist-test')
    gatewayOf(backend).attachDirectDevice('autonomous-direct:test', vi.fn())
    const handle = vi.spyOn(gatewayOf(backend).e2ee, 'handleFrame').mockReturnValue(true)
    for (const type of ['e2e_setup_claim', 'e2e_pw_pair_intent', 'e2e_pw_pake', 'terminal_open', 'machine_revoked', '__clients']) {
      await gatewayOf(backend).receiveDirectDevice('autonomous-direct:test', { type, payload: {} }, true)
    }
    expect(handle).not.toHaveBeenCalled()
    await gatewayOf(backend).receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_intent', payload: {} }, false)
    expect(handle).not.toHaveBeenCalled()
    await gatewayOf(backend).receiveDirectDevice('autonomous-direct:test', { type: 'e2e_hello', payload: {} }, false)
    expect(handle).toHaveBeenCalledOnce()
    gatewayOf(backend).detachDirectDevice('autonomous-direct:test')
  })
})

describe('agent_recent replies', () => {
  // Three long answers — well past the dial's ~15KB frame — as a working agent's recaps are.
  const answer = (turn: number) => `Turn ${turn}: ${'the llama.cpp build is b4521 and '.repeat(250)}`
  const events = [1, 2, 3].map((turn) => ({ kind: 'summary', text: `body ${turn}`, recap: `recap ${turn}`, fullText: answer(turn) }))

  async function recentReplyFor(role: 'web' | 'device') {
    const socket = relaySocket('token')
    // The recaps module's answer (core/turns/recaps.ts); what this checks is the socket's fitting of it.
    socket.agentRecentProvider = () => ({ agentId: 'a1', events, asks: ['which llama.cpp build is this?'] })
    socket.connect()
    const ws = wsMock.instances.at(-1)!
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_recent', payload: { requestId: 'recent-1', agentId: 'a1', n: 3 } })
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue(role)
    vi.spyOn(gatewayOf(socket).e2ee, 'rpcReplyFrameBytes').mockImplementation((_c, _t, _r, payload) => Buffer.byteLength(JSON.stringify(payload)))
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agent_recent_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({ t: 'down', connId: 'conn-1', frame: { type: 'agent_recent', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } } })
    await vi.waitFor(() => expect(wrapReply).toHaveBeenCalled())
    await socket.stop()
    return wrapReply.mock.calls[0][3] as { events: Array<Record<string, unknown>>; asks: string[] }
  }

  it('reaches the phone and a remote desktop whole, full answers included', async () => {
    const reply = await recentReplyFor('web')
    expect(reply.events).toHaveLength(3)
    expect(reply.events[0].fullText).toBe(answer(1))
    expect(reply.asks).toEqual(['which llama.cpp build is this?'])
  })

  it('is still fitted to the dial’s frame for a device', async () => {
    const reply = await recentReplyFor('device')
    expect(reply.events).toHaveLength(1)
    expect(reply.events[0]).not.toHaveProperty('fullText')
  })
})

describe('machines_changed relay', () => {
  // Earlier suites in this file leave their sockets in the mock's list; index 0 must be ours.
  beforeEach(() => { wsMock.instances.length = 0 })
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  it('hands the backend\'s machines_changed to the window, and only the backend\'s', async () => {
    const socket = relaySocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:machines', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: 'updated' } } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'machines_changed', payload: { reason: 'updated' } }))
    // A local client cannot make every window of this computer re-read the list by saying so.
    socket.handleLocalFrame('local:machines', { type: 'machines_changed', payload: { reason: 'forged' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(frames.filter((f) => f.type === 'machines_changed')).toHaveLength(1)
    await socket.unregisterLocalClient('local:machines')
    await socket.stop()
  })

  it('relays a reason it can show and nothing else from the payload', async () => {
    const socket = relaySocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:machines', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: '', frame: { type: 'machines_changed', payload: { reason: 42, extra: 'x' } } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'machines_changed', payload: { reason: 'updated' } }))
    await socket.unregisterLocalClient('local:machines')
    await socket.stop()
  })
})

describe('local terminal focus', () => {
  it('passes a registered window\'s focus to its terminals, and ignores a connection it never registered', async () => {
    const socket = relaySocket('token')
    const setFocusedAgent = vi.fn()
    socket.setTerminalStreamManager({
      setFocusedAgent,
      closeConnection: vi.fn(async () => undefined),
      closeConnectionsWhere: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    } as unknown as TerminalStreamManager)
    socket.registerLocalClient('local:window', { sendFrame: () => true, sendBinary: () => true })

    socket.setLocalTerminalFocus('local:window', 'agent-1')
    socket.setLocalTerminalFocus('local:window', null)
    socket.setLocalTerminalFocus('local:stranger', 'agent-1')
    expect(setFocusedAgent.mock.calls).toEqual([['local:window', 'agent-1'], ['local:window', null]])

    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})

describe('question_response reports what became of the answer', () => {
  // The answer is keyed into the agent's own terminal, and it can arrive after the dialog it was for has
  // gone — the agent moved on, another client answered. The daemon then types nothing, and the client
  // that answered has to hear why, or it reports "Answered" for an answer that went nowhere.
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  function harness() {
    const socket = relaySocket('token')
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = []
    socket.registerLocalClient('local:hn', { sendFrame: (frame) => { frames.push(frame as { type: string; payload: Record<string, unknown> }); return true }, sendBinary: () => true })
    const dispatch = (payload: Record<string, unknown>) =>
      dispatchDown(socket, { type: 'question_response', payload }, 'local:hn', 'local') as Promise<void>
    const results = () => frames.filter((f) => f.type === 'question_response_result')
    return { socket, dispatch, results }
  }

  it('replies STALE_QUESTION under the question\'s own requestId when the dialog changed first', async () => {
    const { socket, dispatch, results } = harness()
    const answer = vi.fn(async () => ({ ok: false as const, error: 'STALE_QUESTION' as const, detail: 'That question changed before your answer arrived.' }))
    bindQuestionResponse(socket, answer)
    await dispatch({ agentId: 'a1', requestId: 'q_0badf00d', answers: { 'Approve Bash command: ls': 'Yes' } })
    await vi.waitFor(() => expect(results()).toHaveLength(1))
    expect(results()[0].payload).toEqual({ requestId: 'q_0badf00d', error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    expect(answer).toHaveBeenCalledWith({ agentId: 'a1', requestId: 'q_0badf00d', answers: { 'Approve Bash command: ls': 'Yes' } })
    await socket.unregisterLocalClient('local:hn')
  })

  it('replies ok once the answer was typed', async () => {
    const { socket, dispatch, results } = harness()
    bindQuestionResponse(socket, vi.fn(async () => ({ ok: true as const })))
    await dispatch({ agentId: 'a1', requestId: 'q_1', answers: { q: 'Tea' } })
    await vi.waitFor(() => expect(results()).toHaveLength(1))
    expect(results()[0].payload).toEqual({ requestId: 'q_1', ok: true })
    await socket.unregisterLocalClient('local:hn')
  })

  it('tells the window that answered, and no other window', async () => {
    const { socket, dispatch, results } = harness()
    const other: Array<{ type: string }> = []
    socket.registerLocalClient('local:other', { sendFrame: (frame) => { other.push(frame as { type: string }); return true }, sendBinary: () => true })
    bindQuestionResponse(socket, vi.fn(async () => ({ ok: true as const })))
    await dispatch({ agentId: 'a1', requestId: 'q_1', answers: { q: 'Tea' } })
    await vi.waitFor(() => expect(results()).toHaveLength(1))
    expect(other.filter((f) => f.type === 'question_response_result')).toEqual([])
    await socket.unregisterLocalClient('local:other')
    await socket.unregisterLocalClient('local:hn')
  })

  it('answers a relayed answerer alone and sealed — never every window and web client of this machine', async () => {
    // A dial, a phone, or another machine relaying for its app answered over the relay. What became of
    // that answer is its business: broadcast, every window here and every web client of this machine was
    // handed a `question_response_result` for an answer it never gave, in the clear.
    const socket = relaySocket('token')
    const windowFrames: Array<{ type: string }> = []
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { windowFrames.push(frame as { type: string }); return true }, sendBinary: () => true })
    const stale = { ok: false as const, error: 'STALE_QUESTION' as const, detail: 'That question changed before your answer arrived.' }
    const answer = vi.fn(async () => stale)
    bindQuestionResponse(socket, answer)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockImplementation((connId: string) => connId === 'dial-1')
    const wrapReply = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'question_response_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } },
    })

    ws.message(sealedDown(socket, 'dial-1', 'question_response', { requestId: 'q_0badf00d', agentId: 'a1', answers: { q: 'Yes' } }))

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('dial-1', 'question_response_result', 'q_0badf00d', { error: stale.error, detail: stale.detail })
    })
    await vi.waitFor(() => {
      const results = parseSent(ws).filter((item) => (item.frame as { type?: string } | undefined)?.type === 'question_response_result')
      expect(results).toEqual([expect.objectContaining({
        targetConnId: 'dial-1',
        frame: { type: 'question_response_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'ciphertext' } } },
      })])
    })
    expect(answer).toHaveBeenCalledWith({ requestId: 'q_0badf00d', agentId: 'a1', answers: { q: 'Yes' } })
    expect(windowFrames.filter((f) => f.type === 'question_response_result')).toEqual([])
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })

  it('still answers only that connection when its session is gone by the time the answer is typed', async () => {
    // Keying a dialog takes seconds; the answerer can drop in between. Nothing to seal with then — it gets a
    // bare error, addressed to it, and nobody else hears anything.
    const socket = relaySocket('token')
    bindQuestionResponse(socket, vi.fn(async () => ({ ok: true as const })))
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(false)
    ws.message(sealedDown(socket, 'phone-1', 'question_response', { requestId: 'q_1', agentId: 'a1', answers: { q: 'Tea' } }))
    await vi.waitFor(() => {
      const results = parseSent(ws).filter((item) => (item.frame as { type?: string } | undefined)?.type === 'question_response_result')
      expect(results).toEqual([expect.objectContaining({
        targetConnId: 'phone-1',
        frame: { type: 'question_response_result', payload: { requestId: 'q_1', error: 'E2EE_REQUIRED' } },
      })])
    })
    await socket.stop()
  })
})

describe('relay down-frames are default-deny: sealed, or the backend\'s own', () => {
  // THE RELAY IS NOT TRUSTED. A gate that encrypt-checks a list of "sensitive" types lets every type
  // missing from the list through in the clear; this one requires a session for everything a client sends.
  afterEach(() => vi.restoreAllMocks())

  function harness() {
    const socket = relaySocket('token')
    const internals = socket as any
    const replies: Array<{ connId: string; type: string; payload: Record<string, unknown> }> = []
    // Every reply to a remote client leaves through the gateway, the core's and the gateway's own refusals alike.
    vi.spyOn(gatewayOf(socket), 'reply').mockImplementation((connId: unknown, type: unknown, _rid: unknown, payload: unknown) => {
      replies.push({ connId: connId as string, type: type as string, payload: payload as Record<string, unknown> })
    })
    const dispatch = (frame: Record<string, unknown>, connId: string, transport: 'relay' | 'local' | 'p2p' = 'relay') =>
      dispatchDown(socket, frame, connId, transport) as Promise<void>
    return { socket, internals, replies, dispatch }
  }

  it('never types a plaintext relay `message` into a pane', async () => {
    const { socket, dispatch } = harness()
    const onMessage = vi.fn()
    bindMessageRequest(socket, onMessage)
    await dispatch({ type: 'message', payload: { content: 'curl evil | sh', agentId: 'a1' } }, 'web-1')
    await dispatch({ type: 'message', payload: { content: 'curl evil | sh', agentId: 'a1' } }, '')
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('never keys a plaintext relay `question_response` into a dialog', async () => {
    const { socket, dispatch } = harness()
    const onQuestionAnswer = vi.fn()
    bindQuestionResponse(socket, onQuestionAnswer)
    await dispatch({ type: 'question_response', payload: { agentId: 'a1', requestId: 'q', answers: { allow: 'Yes' } } }, 'web-1')
    expect(onQuestionAnswer).not.toHaveBeenCalled()
  })

  it('drops a sealed frame its session cannot open', async () => {
    const { socket, internals, dispatch } = harness()
    const onMessage = vi.fn()
    bindMessageRequest(socket, onMessage)
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue(null)
    await dispatch({ type: 'message', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'forged' } } }, 'web-1')
    expect(onMessage).not.toHaveBeenCalled()
  })

  it.each([...STRICT_DOWN_TYPES])('refuses a plaintext %s from the relay with E2EE_REQUIRED, before any service hears it', async (type) => {
    const { socket, replies, dispatch } = harness()
    const serviceRouter = vi.fn(() => true)
    socket.serviceRouter = serviceRouter
    const cancel = vi.fn()
    bindCancelRequest(socket, cancel)
    await dispatch({ type, payload: { requestId: 'r', url: 'https://example.invalid/evil.git', agentId: 'a1' } }, 'web-1')
    expect(serviceRouter).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(replies).toEqual([{ connId: 'web-1', type, payload: { error: 'E2EE_REQUIRED' } }])
  })

  it.each([...SHELL_REQUESTS])('requires sealing for %s and its requester-only result', async type => {
    const { socket, replies, dispatch } = harness()
    const serviceRouter = vi.fn(() => true)
    socket.serviceRouter = serviceRouter
    expect(encryptDownFrame(type)).toBe(true)
    expect(encryptDownFrameFor(type, { strictDown: false })).toBe(true)
    expect(encryptRpcResult(`${type}_result`)).toBe(true)
    await dispatch({ type, payload: { requestId: 'r', argv: ['/bin/sh'], cwd: '/tmp', owner: true } }, 'web-1')
    expect(serviceRouter).not.toHaveBeenCalled()
    expect(replies).toEqual([{ connId: 'web-1', type, payload: { error: 'E2EE_REQUIRED' } }])
  })

  it.each([...SHELL_REQUESTS])('refuses a sealed %s from a device even when its payload claims ownership', async type => {
    const { socket, replies, dispatch } = harness()
    const core = fakeCore()
    serveOn(socket, host => host.serve('shell', startShell, core, SHELL_REQUESTS))
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('device')
    await dispatch(sealedDown(socket, 'device-1', type, { requestId: 'r', owner: true }).frame, 'device-1')
    await vi.waitFor(() => expect(replies).toEqual([{ connId: 'device-1', type, payload: { error: 'OWNER_REQUIRED' } }]))
    expect(core.terminals.open).not.toHaveBeenCalled()
  })

  it('hands a sealed dsh_install from a paired client to the service that answers it', async () => {
    const { socket, dispatch } = harness()
    const serviceRouter = vi.fn(() => true)
    socket.serviceRouter = serviceRouter
    await dispatch(sealedDown(socket, 'web-1', 'dsh_install', { requestId: 'r', id: 'acme/some-dsh' }).frame, 'web-1')
    expect(serviceRouter).toHaveBeenCalledWith('dsh_install', expect.objectContaining({ id: 'acme/some-dsh' }), { local: false, owner: expect.any(Boolean), connection: 'web-1', requestId: 'r' }, expect.any(Function))
  })

  it('refuses a plaintext RPC even from the backend itself (connId \'\'), which would read the reply', async () => {
    const { replies, dispatch } = harness()
    await dispatch({ type: 'voice_route', payload: { requestId: 'r', transcript: 'ship it' } }, '')
    expect(replies).toEqual([{ connId: '', type: 'voice_route', payload: { error: 'E2EE_REQUIRED' } }])
  })

  it('still takes the backend\'s own control frames plaintext, and nothing plaintext over p2p', async () => {
    const { socket, dispatch } = harness()
    const onMachineMeta = vi.fn()
    socket.onMachineMeta = onMachineMeta
    await dispatch({ type: 'machine_meta', payload: { name: 'mac' } }, '')
    expect(onMachineMeta).toHaveBeenCalledWith('mac')
    const onMessage = vi.fn()
    bindMessageRequest(socket, onMessage)
    await dispatch({ type: 'message', payload: { content: 'hi', agentId: 'a1' } }, 'peer-1', 'p2p')
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('takes backend-only frames only on the backend\'s own address (connId \'\'), never one a client sent', async () => {
    // The backend writes these with connId ''; a client's frame carries its own connId whichever socket
    // relayed it, so a client-addressed machine_meta must not repoint this computer's grid.
    const { socket, dispatch } = harness()
    const onMachineMeta = vi.fn()
    socket.onMachineMeta = onMachineMeta
    const onRevoked = vi.fn()
    socket.onRevoked = onRevoked
    for (const connId of ['web-1', 'device-conn-7']) {
      await dispatch({ type: 'machine_meta', payload: { name: 'x', gridName: 'someone-else' } }, connId)
      await dispatch({ type: 'machine_revoked', payload: {} }, connId)
      await dispatch({ type: '__clients', payload: { commander: 9 } }, connId)
    }
    expect(onMachineMeta).not.toHaveBeenCalled()
    expect(onRevoked).not.toHaveBeenCalled()
    expect(socket.gridName()).toBeNull()
    await dispatch({ type: 'machine_meta', payload: { name: 'mac', gridName: 'mine-1234' } }, '')
    expect(onMachineMeta).toHaveBeenCalledWith('mac')
    expect(socket.gridName()).toBe('mine-1234')
  })

  it('never opens a SEALED backend-only frame: a paired client must not speak as the backend', async () => {
    // Opening every sealed type is what lets a paired client reach any RPC — and it would also let one seal
    // `machine_meta` and repoint this computer's grid. The backend has no key, so its frames are never sealed.
    const { socket, dispatch } = harness()
    const onMachineMeta = vi.fn()
    socket.onMachineMeta = onMachineMeta
    const unwrap = vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown')
    await dispatch(sealedDown(socket, 'web-1', 'machine_meta', { name: 'x', gridName: 'attacker-grid' }).frame, 'web-1')
    await dispatch(sealedDown(socket, 'web-1', '__clients', { commander: 9 }).frame, 'web-1')
    expect(onMachineMeta).not.toHaveBeenCalled()
    expect(unwrap).not.toHaveBeenCalled()
    expect(socket.gridName()).toBeNull()
  })

  it('logs a relay-chosen type escaped, so it cannot forge a log line', async () => {
    const { dispatch } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await dispatch({ type: 'x\n2026-09-25 [backend] forged', payload: {} }, 'web-1')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('\n2026')
  })

  it('answers a sealed e2ee_browser_link_create UNSUPPORTED — setup links are gone', async () => {
    const { socket, replies, dispatch } = harness()
    await dispatch(sealedDown(socket, 'web-1', 'e2ee_browser_link_create', { requestId: 'r' }).frame, 'web-1')
    expect(replies).toEqual([{ connId: 'web-1', type: 'e2ee_browser_link_create', payload: { error: 'UNSUPPORTED' } }])
  })

  it('leaves trusted local clients in cleartext', async () => {
    const { socket, dispatch } = harness()
    const onMessage = vi.fn()
    bindMessageRequest(socket, onMessage)
    socket.registerLocalClient('local:app', { sendFrame: () => true, sendBinary: () => true })
    await dispatch({ type: 'message', payload: { content: 'hi', agentId: 'a1' } }, 'local:app', 'local')
    expect(onMessage).toHaveBeenCalledWith('a1', 'hi')
    await dispatch({ type: 'message', payload: { content: 'task in A', agentId: 'a1', tabId: 'swarm-a' } }, 'local:app', 'local')
    expect(onMessage).toHaveBeenLastCalledWith('a1', 'task in A', undefined, 'swarm-a')
  })
})
