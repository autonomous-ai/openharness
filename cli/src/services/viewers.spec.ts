import type { ViewersRuntime, ViewersRuntimeSlot } from './viewers.js'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { emptyPorts, VIEWERS_FOLLOW, type AgentLife, type ViewersPort } from '../core/api.js'
import { catalogEntry } from '../dsh/catalog.js'
import { installedDsh } from '../dsh/installed.js'
import { dshViewerName } from '../dsh/manifest.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startViewers, viewerStreamEndpoint } from './viewers.js'
import { createServiceClientStreams } from './clientStreams.js'
import { CLIENT_STREAMS } from '../lib/clientStreamContract.js'

const built = vi.hoisted(() => ({ ledger: [] as any[], viewers: [] as any[], verdicts: [] as any[], order: [] as string[], forwarders: [] as any[], surfaces: [] as any[] }))
// The streams and the rendered surfaces are tested where they live (lib/viewerForwarder.spec.ts,
// lib/interactiveViewer.spec.ts); here, only that the service hands them what it holds.
vi.mock('../lib/viewerForwarder.js', () => ({
  ViewerForwarder: class {
    handle = vi.fn()
    refresh = vi.fn()
    closeConnection = vi.fn()
    closeAll = vi.fn()
    constructor(readonly deps: any) { built.forwarders.push(this) }
  },
}))
vi.mock('../lib/interactiveViewer.js', () => ({
  InteractiveViewers: class {
    request = vi.fn(async () => ({ data: 'jpeg' }))
    refresh = vi.fn()
    closeConnection = vi.fn()
    closeAll = vi.fn()
    constructor(readonly target: (agentId: string) => string | null) { built.surfaces.push(this) }
  },
}))
vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn() }))
vi.mock('../dsh/catalog.js', () => ({ catalogEntry: vi.fn() }))
vi.mock('../dsh/manifest.js', () => ({ dshVerdictPath: vi.fn(() => '.harness/verdict.json'), dshViewerName: vi.fn(() => 'Blender view') }))
vi.mock('../dsh/viewerLedger.js', () => ({
  ViewerLedger: class {
    constructor(readonly deps: { log: (line: string) => void }) { built.ledger.push(this) }
    reapOrphans() { built.order.push('reap') }
  },
}))
vi.mock('../dsh/viewer.js', () => ({
  DshViewerManager: class {
    start = vi.fn(async () => {})
    stop = vi.fn(async () => {})
    stopAll = vi.fn(async () => { built.order.push('viewers stopped') })
    forwardingUrl = vi.fn((agentId: string) => `http://127.0.0.1:9/${agentId}`)
    setVerdictArtifact = vi.fn()
    setVerdictPreview = vi.fn()
    constructor(readonly deps: any) { built.order.push('viewers'); built.viewers.push(this) }
  },
}))
vi.mock('../dsh/verdict.js', () => ({
  DshVerdictWatcher: class {
    watch = vi.fn()
    unwatch = vi.fn()
    stop = vi.fn(async () => { built.order.push('verdicts stopped') })
    constructor(readonly deps: any) { built.verdicts.push(this) }
  },
}))

const blender = { id: 'blender', manifest: { name: 'Blender', viewer: { command: 'serve' } } }
const agent = (over: Partial<RegisteredSession> = {}) =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', dsh: 'blender', cwd: '/work/scene', ...over }) as RegisteredSession

function setup(live: RegisteredSession | null = agent(), terminalAvailable = true) {
  built.ledger.length = 0; built.viewers.length = 0; built.verdicts.length = 0; built.order.length = 0; built.forwarders.length = 0; built.surfaces.length = 0
  // What the core tells the service of agents (core/agentLife.ts), as it follows them.
  let heard: (event: AgentLife) => void = () => {}
  const unfollow = vi.fn()
  const follow = vi.fn((listener: (event: AgentLife) => void) => { heard = listener; return unfollow })
  const core = fakeCore({
    agents: { byAgent: vi.fn(() => live ?? undefined), terminalAvailable: vi.fn(() => terminalAvailable), sync: vi.fn(), publishFrame: vi.fn(), follow },
  })
  const ports: ViewersRuntimeSlot = { viewers: null }
  startViewers(core, ports)
  const published = (session: RegisteredSession = agent()) => { heard({ kind: 'running', session }); return vi.mocked(core.agents.publishFrame!).mock.calls.at(-1)?.[1] }
  return { published, core, port: ports.viewers as ViewersRuntime, ledger: built.ledger[0], viewers: built.viewers[0], verdicts: built.verdicts[0], forwarder: built.forwarders[0], surfaces: built.surfaces[0],
    follow, unfollow, attach: (session: RegisteredSession) => heard({ kind: 'running', session }), detach: (agentId: string) => heard({ kind: 'ended', agentId }), heard: (event: AgentLife) => heard(event) }
}

describe('the DSH viewers service', () => {
  it('ends publication before stopping a viewer and resumes without waiting for its watch to close', async () => {
    const { attach, detach, viewers, core } = setup()
    const old = { ...agent(), frameEpoch: 'run-1' }, next = { ...agent(), frameEpoch: 'run-2' }
    attach(old)
    let finish!: () => void
    viewers.stop.mockImplementationOnce(() => {
      viewers.deps.onUrl('a1', null)
      return new Promise<void>(resolve => { finish = resolve })
    })
    vi.mocked(core.agents.publishFrame!).mockClear()
    detach('a1')
    expect(core.agents.publishFrame).not.toHaveBeenCalled()
    attach(next)
    expect(viewers.start).toHaveBeenCalledTimes(2)
    viewers.deps.onUrl('a1', 'http://127.0.0.1:8000')
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, expect.objectContaining({ viewerUrl: 'http://127.0.0.1:8000' }))
    finish()
    viewers.stop.mockRejectedValueOnce(new Error('stop failed'))
    detach('a1')
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith('[viewers] VIEWER_STOP_FAILED · Error'))
  })
  it('a new core lease keeps the running viewer and republishes its URL under the new lease', () => {
    const { attach, viewers, verdicts, core } = setup()
    const old = { ...agent(), frameEpoch: 'old-core:1' }, next = { ...agent(), frameEpoch: 'new-core:1' }
    attach(old)
    viewers.deps.onUrl('a1', 'http://127.0.0.1:8000')
    vi.mocked(core.agents.publishFrame!).mockClear()
    attach(next)
    expect(viewers.stop).not.toHaveBeenCalled()
    expect(verdicts.unwatch).not.toHaveBeenCalled()
    expect(core.agents.publishFrame).toHaveBeenCalledTimes(1)
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, expect.objectContaining({ viewerUrl: 'http://127.0.0.1:8000' }))
    // What the same producer says next goes out under the new lease too.
    viewers.deps.onUrl('a1', 'http://127.0.0.1:8001')
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, expect.objectContaining({ viewerUrl: 'http://127.0.0.1:8001' }))
    // Another folder is the manager's to replace (dsh/viewer.ts): it is asked with the new one.
    attach({ ...next, cwd: '/work/other' })
    expect(viewers.start).toHaveBeenLastCalledWith('a1', blender, '/work/other')
    expect(viewers.stop).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(installedDsh).mockReturnValue(blender as never)
    vi.mocked(catalogEntry).mockReturnValue(undefined)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('stops the viewers an earlier daemon left running before it starts any of its own', () => {
    const { ledger, viewers, verdicts } = setup()
    expect(built.order).toEqual(['reap', 'viewers'])
    expect(viewers.deps.ledger).toBe(ledger)
    for (const log of [ledger.deps.log, viewers.deps.log, verdicts.deps.log]) log('[dsh] line')
    expect(console.log).toHaveBeenCalledTimes(3)
  })

  describe('an agent\'s frame', () => {
    it('names its harness and its viewer, with no viewer or verdict until they arrive', () => {
      const { published } = setup()
      expect(published(agent())).toEqual({ dsh: 'blender', dshName: 'Blender', viewerUrl: null, viewerName: 'Blender view', verdict: null })
      const [manifest, nameOf] = vi.mocked(dshViewerName).mock.calls[0]
      expect(manifest).toBe(blender.manifest)
      expect(nameOf('blender')).toBe('Blender')
      vi.mocked(installedDsh).mockReturnValueOnce(undefined)
      vi.mocked(catalogEntry).mockReturnValueOnce({ name: 'Shelf name' } as never)
      expect(nameOf('other')).toBe('Shelf name')
    })

    it('carries the catalog\'s name, or none, for a harness this machine does not have', () => {
      const { published } = setup()
      vi.mocked(installedDsh).mockReturnValue(undefined)
      vi.mocked(catalogEntry).mockReturnValueOnce({ name: 'Blender (store)' } as never)
      expect(published(agent())).toEqual({ dsh: 'blender', dshName: 'Blender (store)', viewerUrl: null, viewerName: null, verdict: null })
      expect(published(agent())).toMatchObject({ dshName: null })
    })

    it('has nothing to say for an agent without a harness', () => {
      expect(setup().published(agent({ dsh: undefined }))).toEqual({})
    })
  })

  describe('news from a viewer or a verdict', () => {
    it('a viewer URL is forwarded to the windows and pushed on the frame of an agent whose terminal is attached', () => {
      const { core, published, viewers, attach } = setup()
      attach(agent())
      viewers.deps.onUrl('a1', 'http://127.0.0.1:7000')
      expect(core.clients.viewerChanged).toHaveBeenCalledWith('a1')
      expect(core.agents.publishFrame).toHaveBeenCalledWith(agent(), expect.objectContaining({ viewerUrl: 'http://127.0.0.1:7000' }))
      expect(published(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7000' })
    })

    it('a verdict points the viewer at its artifact, or at none', () => {
      const { core, published, viewers, verdicts, attach } = setup()
      attach(agent())
      const verdict = { status: 'pass', artifact: 'render.png', preview: 'http://127.0.0.1:5173/' }
      verdicts.deps.onChange('a1', verdict)
      expect(viewers.setVerdictArtifact).toHaveBeenCalledWith('a1', 'render.png')
      expect(viewers.setVerdictPreview).toHaveBeenCalledWith('a1', 'http://127.0.0.1:5173/')
      expect(published(agent())).toMatchObject({ verdict })
      verdicts.deps.onChange('a1', null)
      expect(viewers.setVerdictArtifact).toHaveBeenLastCalledWith('a1', null)
      expect(viewers.setVerdictPreview).toHaveBeenLastCalledWith('a1', null)
      expect(core.agents.publishFrame).toHaveBeenLastCalledWith(agent(), expect.objectContaining({ verdict: null }))
    })

    it('never takes this daemon\'s own API port for an agent\'s preview', () => {
      const { viewers } = setup()
      expect(viewers.deps.reservedPorts()).toEqual([env.PORT])
    })

    it('waits for the terminal before pushing a frame, which would otherwise read as "agent gone"', () => {
      const detached = setup(agent(), false)
      detached.viewers.deps.onUrl('a1', 'http://127.0.0.1:7000')
      expect(detached.core.agents.sync).not.toHaveBeenCalled()
      const gone = setup(null)
      gone.verdicts.deps.onChange('a1', null)
      expect(gone.core.agents.sync).not.toHaveBeenCalled()
    })
  })

  describe('attaching and detaching', () => {
    // A look at each agent with a harness, and its end, as every service that follows agents hears them.
    it('follows the agents with a harness, and stops following as it stops', async () => {
      const { follow, unfollow, port, viewers, verdicts, heard } = setup()
      expect(follow).toHaveBeenCalledWith(expect.any(Function), VIEWERS_FOLLOW)
      // What else agents do is not the viewers' business.
      heard({ kind: 'stopped', agentId: 'a1' })
      heard({ kind: 'purged', agentId: 'a1', sessionIds: ['s1'] })
      heard({ kind: 'taken', from: 'a1', to: 'a2' })
      expect(viewers.start).not.toHaveBeenCalled()
      expect(verdicts.unwatch).not.toHaveBeenCalled()
      await port.stop()
      expect(unfollow).toHaveBeenCalled()
    })

    it('watches the verdict file in the agent\'s folder and starts its viewer', () => {
      const { port, published, viewers, verdicts, attach, detach } = setup()
      attach(agent())
      expect(verdicts.watch).toHaveBeenCalledWith('a1', join('/work/scene', '.harness/verdict.json'))
      expect(viewers.start).toHaveBeenCalledWith('a1', blender, '/work/scene')
    })

    it('watches only the verdict of a harness with no viewer', () => {
      const { port, published, viewers, verdicts, attach, detach } = setup()
      vi.mocked(installedDsh).mockReturnValueOnce({ id: 'cad', manifest: { name: 'CAD' } } as never)
      attach(agent({ dsh: 'cad' }))
      expect(verdicts.watch).toHaveBeenCalled()
      expect(viewers.start).not.toHaveBeenCalled()
    })

    it('says once per harness when it is not installed, and attaches nothing', () => {
      const { port, verdicts, attach, detach } = setup()
      vi.mocked(installedDsh).mockReturnValue(undefined)
      attach(agent())
      attach(agent({ agentId: 'a2' }))
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender is not installed on this machine · agent a1 runs as plain claude (no viewer, no verdict)')
      expect(verdicts.watch).not.toHaveBeenCalled()
    })

    it('attaches nothing for an agent with no harness or no folder', () => {
      const { port, verdicts, attach, detach } = setup()
      attach(agent({ dsh: undefined }))
      attach(agent({ cwd: undefined }))
      // A frame may still name the installed harness; no watch is started without a folder.
      expect(verdicts.watch).not.toHaveBeenCalled()
    })

    it('says why a viewer failed to start', async () => {
      const { port, viewers, attach, detach } = setup()
      viewers.start.mockRejectedValueOnce(new Error('port in use')).mockRejectedValueOnce('no python')
      attach(agent())
      attach(agent())
      await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2))
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender viewer failed to start · Error')
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender viewer failed to start · string')
    })

    it('detaching stops the watch and the viewer and forgets what the frame said', async () => {
      const { port, published, viewers, verdicts, attach, detach } = setup()
      viewers.deps.onUrl('a1', 'http://127.0.0.1:7000')
      detach('a1')
      expect(verdicts.unwatch).toHaveBeenCalledWith('a1')
      expect(viewers.stop).toHaveBeenCalledWith('a1')
      await vi.waitFor(() => expect(published(agent())).toMatchObject({ viewerUrl: null }))
    })
  })

  it('forwards the windows to the viewer, and stops every viewer and then every watch', async () => {
    const { port, viewers, forwarder, surfaces } = setup()
    expect(port.forwardingUrl('a1')).toBe('http://127.0.0.1:9/a1')
    expect(viewers.forwardingUrl).toHaveBeenCalledWith('a1')
    await port.stop()
    expect(built.order.slice(-2)).toEqual(['viewers stopped', 'verdicts stopped'])
    // No client is left streaming from a viewer that is going.
    expect(forwarder.closeAll).toHaveBeenCalled()
    expect(surfaces.closeAll).toHaveBeenCalled()
  })

  describe('a viewer served to a client over its connection', () => {
    it('routes the private grant through the actual component endpoint and closes only its refused forwarding stream', () => {
      const { core, port, forwarder, surfaces } = setup()
      const notice = vi.fn(), bridge = createServiceClientStreams(CLIENT_STREAMS.find(spec => spec.service === 'viewers')!, () => viewerStreamEndpoint(port))
      core.clients.streamFrame = bridge.frame
      bridge.connected({ query: async () => ({ ok: true }), notice })
      bridge.event({ kind: 'client_stream', grant: 'private-grant', connection: 'c1', type: 'viewer_request',
        payload: { streamId: 'private-grant', agentId: 'a1', path: '/' }, asker: { local: true, owner: true } })
      expect(forwarder.handle).toHaveBeenCalledExactlyOnceWith('c1', 'viewer_request', { streamId: 'private-grant', agentId: 'a1', path: '/' })
      expect(forwarder.deps.send('c1', 'viewer_response', { streamId: 'private-grant', status: 200 })).toBe(true)
      expect(notice).toHaveBeenCalledWith('client_stream', { grant: 'private-grant', type: 'viewer_response', payload: { streamId: 'private-grant', status: 200 } })
      bridge.event({ kind: 'client_stream_refused', grant: 'private-grant' })
      expect(forwarder.handle).toHaveBeenLastCalledWith('c1', 'viewer_close', { streamId: 'private-grant', error: 'Viewer connection closed' })
      bridge.event({ kind: 'client_stream_refused', grant: 'unknown-grant' })
      expect(forwarder.handle).toHaveBeenCalledTimes(2)
      expect(forwarder.deps.send('c1', 'viewer_data', { streamId: 'private-grant', data: 'AA==' })).toBe(false)
      bridge.event({ kind: 'client_stream_control', grant: null, payload: { route: 'direct' } })
      expect(bridge.binary(Uint8Array.of(1))).toBe(false)
      bridge.closed('c1')
      expect(forwarder.closeConnection).toHaveBeenCalledWith('c1')
      expect(surfaces.closeConnection).toHaveBeenCalledWith('c1')
      bridge.disconnected()
      expect(forwarder.closeAll).toHaveBeenCalledOnce()
      expect(surfaces.closeAll).toHaveBeenCalledOnce()
    })

    it('streams from the agent\'s viewer, and answers the one connection that asked through the core', () => {
      const { core, port, forwarder } = setup()
      expect(port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(true)
      expect(forwarder.handle).toHaveBeenCalledWith('c1', 'viewer_request', { streamId: 's1' })
      // Only the viewer this service allocated, as the windows' pane forwards to it.
      expect(forwarder.deps.target('a1')).toBe('http://127.0.0.1:9/a1')
      vi.mocked(core.clients.streamFrame).mockReturnValueOnce(true)
      expect(forwarder.deps.send('c1', 'viewer_response', { streamId: 's1' })).toBe(true)
      expect(core.clients.streamFrame).toHaveBeenCalledWith('c1', 'viewer_response', { streamId: 's1' })
    })

    it('renders a frame of it for a client, from the same viewer', async () => {
      const { port, surfaces } = setup()
      await expect(port.surface('c1', { surfaceId: 'v' })).resolves.toEqual({ data: 'jpeg' })
      expect(surfaces.request).toHaveBeenCalledWith('c1', { surfaceId: 'v' })
      expect(surfaces.target('a1')).toBe('http://127.0.0.1:9/a1')
    })

    it('closes a connection\'s streams and surfaces when it goes, and every one when the link does', () => {
      const { port, forwarder, surfaces } = setup()
      port.closed('c1')
      expect(forwarder.closeConnection).toHaveBeenCalledWith('c1')
      expect(surfaces.closeConnection).toHaveBeenCalledWith('c1')
      expect(forwarder.closeAll).not.toHaveBeenCalled()
      port.closed()
      expect(forwarder.closeAll).toHaveBeenCalled()
      expect(surfaces.closeAll).toHaveBeenCalled()
    })

    it('stops forwarding to a viewer that moved or stopped, before another process can take its port', () => {
      const { viewers, forwarder, surfaces } = setup()
      viewers.deps.onUrl('a1', null)
      expect(forwarder.refresh).toHaveBeenCalledWith('a1')
      expect(surfaces.refresh).toHaveBeenCalledWith('a1')
    })
  })
})
