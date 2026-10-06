import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type ViewersPort } from '../core/api.js'
import { catalogEntry } from '../dsh/catalog.js'
import { installedDsh } from '../dsh/installed.js'
import { dshViewerName } from '../dsh/manifest.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startViewers } from './viewers.js'

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
  const core = fakeCore({
    agents: { byAgent: vi.fn(() => live ?? undefined), terminalAvailable: vi.fn(() => terminalAvailable), sync: vi.fn() },
  })
  const ports = emptyPorts()
  startViewers(core, ports)
  return { core, port: ports.viewers as ViewersPort, ledger: built.ledger[0], viewers: built.viewers[0], verdicts: built.verdicts[0], forwarder: built.forwarders[0], surfaces: built.surfaces[0] }
}

describe('the DSH viewers service', () => {
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
      const { port } = setup()
      expect(port.frameContext(agent())).toEqual({ id: 'blender', name: 'Blender', viewerUrl: null, viewerName: 'Blender view', verdict: null })
      const [manifest, nameOf] = vi.mocked(dshViewerName).mock.calls[0]
      expect(manifest).toBe(blender.manifest)
      expect(nameOf('blender')).toBe('Blender')
      vi.mocked(installedDsh).mockReturnValueOnce(undefined)
      vi.mocked(catalogEntry).mockReturnValueOnce({ name: 'Shelf name' } as never)
      expect(nameOf('other')).toBe('Shelf name')
    })

    it('carries the catalog\'s name, or none, for a harness this machine does not have', () => {
      const { port } = setup()
      vi.mocked(installedDsh).mockReturnValue(undefined)
      vi.mocked(catalogEntry).mockReturnValueOnce({ name: 'Blender (store)' } as never)
      expect(port.frameContext(agent())).toEqual({ id: 'blender', name: 'Blender (store)', viewerUrl: null, viewerName: null, verdict: null })
      expect(port.frameContext(agent())).toMatchObject({ name: null })
    })

    it('has nothing to say for an agent without a harness', () => {
      expect(setup().port.frameContext(agent({ dsh: undefined }))).toBeNull()
    })
  })

  describe('news from a viewer or a verdict', () => {
    it('a viewer URL is forwarded to the windows and pushed on the frame of an agent whose terminal is attached', () => {
      const { core, port, viewers } = setup()
      viewers.deps.onUrl('a1', 'http://127.0.0.1:7000')
      expect(core.clients.viewerChanged).toHaveBeenCalledWith('a1')
      expect(core.agents.sync).toHaveBeenCalledWith(agent())
      expect(port.frameContext(agent())).toMatchObject({ viewerUrl: 'http://127.0.0.1:7000' })
    })

    it('a verdict points the viewer at its artifact, or at none', () => {
      const { core, port, viewers, verdicts } = setup()
      const verdict = { status: 'pass', artifact: 'render.png' }
      verdicts.deps.onChange('a1', verdict)
      expect(viewers.setVerdictArtifact).toHaveBeenCalledWith('a1', 'render.png')
      expect(port.frameContext(agent())).toMatchObject({ verdict })
      verdicts.deps.onChange('a1', null)
      expect(viewers.setVerdictArtifact).toHaveBeenLastCalledWith('a1', null)
      expect(core.agents.sync).toHaveBeenCalledTimes(2)
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
    it('watches the verdict file in the agent\'s folder and starts its viewer', () => {
      const { port, viewers, verdicts } = setup()
      port.attach(agent())
      expect(verdicts.watch).toHaveBeenCalledWith('a1', join('/work/scene', '.harness/verdict.json'))
      expect(viewers.start).toHaveBeenCalledWith('a1', blender, '/work/scene')
    })

    it('watches only the verdict of a harness with no viewer', () => {
      const { port, viewers, verdicts } = setup()
      vi.mocked(installedDsh).mockReturnValueOnce({ id: 'cad', manifest: { name: 'CAD' } } as never)
      port.attach(agent({ dsh: 'cad' }))
      expect(verdicts.watch).toHaveBeenCalled()
      expect(viewers.start).not.toHaveBeenCalled()
    })

    it('says once per harness when it is not installed, and attaches nothing', () => {
      const { port, verdicts } = setup()
      vi.mocked(installedDsh).mockReturnValue(undefined)
      port.attach(agent())
      port.attach(agent({ agentId: 'a2' }))
      expect(console.warn).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender is not installed on this machine · agent a1 runs as plain claude (no viewer, no verdict)')
      expect(verdicts.watch).not.toHaveBeenCalled()
    })

    it('attaches nothing for an agent with no harness or no folder', () => {
      const { port, verdicts } = setup()
      port.attach(agent({ dsh: undefined }))
      port.attach(agent({ cwd: undefined }))
      expect(installedDsh).not.toHaveBeenCalled()
      expect(verdicts.watch).not.toHaveBeenCalled()
    })

    it('says why a viewer failed to start', async () => {
      const { port, viewers } = setup()
      viewers.start.mockRejectedValueOnce(new Error('port in use')).mockRejectedValueOnce('no python')
      port.attach(agent())
      port.attach(agent())
      await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(2))
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender viewer failed to start · port in use')
      expect(console.warn).toHaveBeenCalledWith('[dsh] blender viewer failed to start · no python')
    })

    it('detaching stops the watch and the viewer and forgets what the frame said', () => {
      const { port, viewers, verdicts } = setup()
      viewers.deps.onUrl('a1', 'http://127.0.0.1:7000')
      port.detach('a1')
      expect(verdicts.unwatch).toHaveBeenCalledWith('a1')
      expect(viewers.stop).toHaveBeenCalledWith('a1')
      expect(port.frameContext(agent())).toMatchObject({ viewerUrl: null })
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
    it('streams from the agent\'s viewer, and answers the one connection that asked through the core', () => {
      const { core, port, forwarder } = setup()
      expect(port.stream('c1', 'viewer_request', { streamId: 's1' })).toBe(true)
      expect(forwarder.handle).toHaveBeenCalledWith('c1', 'viewer_request', { streamId: 's1' })
      // Only the viewer this service allocated, as the windows' pane forwards to it.
      expect(forwarder.deps.target('a1')).toBe('http://127.0.0.1:9/a1')
      vi.mocked(core.clients.viewerFrame).mockReturnValueOnce(true)
      expect(forwarder.deps.send('c1', 'viewer_response', { streamId: 's1' })).toBe(true)
      expect(core.clients.viewerFrame).toHaveBeenCalledWith('c1', 'viewer_response', { streamId: 's1' })
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
