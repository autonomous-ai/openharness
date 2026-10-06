// The production cable -> host -> reviewed queue -> terminal coordinator composition.
// Only STT and the terminal boundary are substitutes; there is no serial port, network or agent.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { ReviewedInput } from '../lib/reviewedInput.js'
import { AutonomousDeviceInput } from '../lib/autonomous-device/input.js'
import { SessionInputController } from '../lib/sessionInput.js'
import { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import type { TerminalBackend } from '../lib/terminalBackend.js'
import { terminalRouteKey } from '../lib/terminalRuntime.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, type CablePort } from './cableSession.js'
import { DaemonCableHost } from './cableHost.js'
import { DialLog } from './dialLog.js'

const data = vi.hoisted(() => ({ rows: [] as RegisteredSession[] }))
vi.mock('../lib/registry.js', () => ({
  registry: { advertised: () => [...data.rows], list: () => [...data.rows], active: () => data.rows.filter(r => r.active) },
  projectDisplayName: (row: RegisteredSession) => row.agentId,
}))

class Port implements CablePort {
  path = '/dev/reviewed-fixture'; isOpen = true
  sent: Record<string, unknown>[] = []
  private decoder = new CableDecoder()
  constructor(private incoming: (bytes: Buffer) => void, private closed: (reason: string) => void) {}
  async write(bytes: Uint8Array) {
    this.decoder.feed(Buffer.from(bytes), frame => {
      if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')))
    })
  }
  say(message: Record<string, unknown>) { this.incoming(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message))))) }
  pcm() { this.incoming(Buffer.from(encodeCableFrame(CableType.Pcm, Buffer.alloc(320)))) }
  async close(reason = 'fixture closed') { if (this.isOpen) { this.isOpen = false; this.closed(reason) } }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const runtime = { backend: 'tmux' as const, paneId: '%1' }
  const row = { agentId: 'exact-agent', sessionId: 'exact-session', engine: 'claude', active: true,
    registeredAt: 1, runtimes: [runtime], primaryRuntimeKey: terminalRouteKey(runtime),
    processIdentity: { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' } } as RegisteredSession
  data.rows = [row]
  const input = new SessionInputController({ getSession: () => row, validateRuntime: async () => true,
    inject: vi.fn(), sendKey: vi.fn(), onError: vi.fn() })
  const writer = new AutonomousDeviceInput({ getSession: () => row, validateRuntime: async () => true,
    inject: vi.fn(), sendKey: vi.fn(), capture: async () => '', acquireControl: id => input.acquireControl(id, { forAnswer: true }),
    acquireReviewedControl: id => input.acquireControl(id), legacySubmit: vi.fn(), legacyCancel: () => false,
    onDelivery: vi.fn(), onInputStatus: vi.fn() })
  const backend = { name: 'tmux', instanceId: 'tmux:default',
    validateReviewed: vi.fn(async () => ({ state: 'alive' })), submitText: vi.fn(),
    capture: vi.fn(async () => ({ state: 'succeeded', value: '────────────\n❯\n────────────\n? for shortcuts' })),
    submitReviewed: vi.fn(async (_runtime, _text, guard) => await guard('before-paste') && await guard('before-enter')
      ? { state: 'succeeded', dispatch: 'executed' } : { state: 'failed', dispatch: 'not_started', reason: 'changed' }),
  } as unknown as TerminalBackend
  const service = new ReviewedInput({ session: id => data.rows.find(r => r.agentId === id),
    terminals: new TerminalBackendCoordinator([backend], ['tmux']), acquire: id => writer.acquireReviewed(id),
    isTurnOpen: () => false, waitMs: 100 })
  const legacy = vi.fn()
  const host = new DaemonCableHost({ machineName: () => 'Fixture', machineId: () => 'local', computerId: () => 'fixture',
    sendTurn: legacy, prepareReviewed: (id, intent) => service.prepare(id, intent), stopTurn: vi.fn(), answer: vi.fn(),
    recent: () => [], recentAsks: () => [], log: vi.fn() })
  host.setSwarms({ active: 'tab', swarms: [{ id: 'tab', name: 'Fixture', agentIds: [row.agentId], panes: 1 }], tiles: [] })
  host.setDesk([row.agentId]); await host.listAgents()
  const transcribe = vi.spyOn(host, 'transcribe').mockResolvedValue('Original words.')
  vi.spyOn(host, 'route').mockRejectedValue(new Error('must not route'))
  const directory = await mkdtemp(join(tmpdir(), 'reviewed-cable-'))
  let port!: Port
  const openPort = vi.fn(async (incoming: (bytes: Buffer) => void, closed: (reason: string) => void) => port = new Port(incoming, closed))
  const session = new CableSession(host, new DialLog(directory), openPort)
  cleanups.push(async () => { await session.stop(); await rm(directory, { recursive: true, force: true }) })
  session.start(); await vi.waitFor(() => expect(port).toBeDefined())
  return { row, backend, service, host, legacy, transcribe, session, port, writer, input, openPort, currentPort: () => port }
}
let sequence = 0
async function recorded(port: Port, fields: Record<string, unknown>, review = true) {
  const uploadId = `review-${++sequence}`
  port.say({ t: 'voice.begin', uploadId, ...fields }); port.pcm(); port.say({ t: 'voice.end', uploadId, review })
  await vi.waitFor(() => expect(port.sent.some(m => m.uploadId === uploadId && ['voice.draft', 'voice.error', 'voice.transcript'].includes(m.t as string))).toBe(true))
  return port.sent.find(m => m.uploadId === uploadId && m.t !== 'voice.quota')!
}
async function command(port: Port, page: Record<string, unknown>, op: string) {
  const requestId = `command-${++sequence}`
  port.say({ t: 'draft.command', draftId: page.id, revision: page.revision, requestId, op })
  await vi.waitFor(() => expect(port.sent.some(m => m.requestId === requestId)).toBe(true))
  return port.sent.find(m => m.requestId === requestId)!
}

describe('reviewed Goal/Loop production cable composition', () => {
  it.each(['goal', 'loop'])('pins and edits %s without routing or slash adaptation, then submits once', async cmd => {
    const f = await fixture()
    let page = await recorded(f.port, { agentId: f.row.agentId, cmd })
    expect(page).toMatchObject({ t: 'voice.draft', agentId: f.row.agentId, text: 'Original words.' })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
    f.transcribe.mockResolvedValueOnce('Reviewed words.')
    page = await recorded(f.port, { draftId: page.id, draftRevision: page.revision, draftOp: 'replace' }, false)
    // The later list/focus is not the owner of this prepared operation.
    f.host.setDesk([])
    expect(await command(f.port, page, 'send')).toMatchObject({ sent: true })
    expect(await command(f.port, page, 'send')).toMatchObject({ sent: true })
    expect(f.backend.submitReviewed).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.backend.submitReviewed!).mock.calls[0].slice(0, 2)).toEqual([{ backend: 'tmux', paneId: '%1' }, `/${cmd} Reviewed words.`])
    expect(f.legacy).not.toHaveBeenCalled(); expect(f.host.route).not.toHaveBeenCalled()
    expect(f.host.lastRouted()?.agentId).toBe('exact-agent')
  })
  it('captures the identity at voice.begin and refuses replacement while STT is in flight', async () => {
    const f = await fixture()
    let finish!: (words: string) => void
    f.transcribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const recording = recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.row.engine = 'codex'; finish('Never silently change goal engine.')
    expect(await recording).toMatchObject({ t: 'voice.error' })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled()
  })
  it('refuses a same-engine restart during review and retains the failed draft receipt', async () => {
    const f = await fixture(), page = await recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' })
    f.row.processIdentity!.pid++
    expect(await command(f.port, page, 'send')).toMatchObject({ ok: false, active: true, locked: true, text: 'Original words.' })
    expect(await command(f.port, page, 'send')).toMatchObject({ ok: false, locked: true })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled()
  })
  it('waits for the real terminal receipt and retains uncertainty without replay', async () => {
    const f = await fixture(), page = await recorded(f.port, { agentId: f.row.agentId, cmd: 'loop' })
    let finish!: () => void
    vi.mocked(f.backend.submitReviewed!).mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ state: 'unknown', dispatch: 'possibly_executed', reason: 'lost receipt' })
    }))
    const sending = command(f.port, page, 'send')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(f.port.sent.some(m => m.sent === true)).toBe(false)
    finish()
    expect(await sending).toMatchObject({ ok: false, active: true, locked: true, error: expect.stringContaining('Check the terminal') })
    await command(f.port, page, 'send')
    expect(f.backend.submitReviewed).toHaveBeenCalledOnce(); expect(f.legacy).not.toHaveBeenCalled()
    expect(f.host.lastRouted()).toBeUndefined()
  })
  it('cancels queued delivery on cable loss without a late send or receipt on a new connection', async () => {
    const f = await fixture(), page = await recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' })
    f.input.setTurnOpen('exact-agent', true)
    f.port.say({ t: 'draft.command', draftId: page.id, revision: page.revision, requestId: 'lost-send', op: 'send' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await f.port.close(); f.input.setTurnOpen('exact-agent', false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
    expect(f.port.sent.some(m => m.requestId === 'lost-send')).toBe(false)
  })
  it('revokes queued delivery before a replacement opener resolves when old close is delayed', async () => {
    const f = await fixture()
    f.port.say({ t: 'hello', product: 'harness', mac: '28:84:85:90:5F:78', fw: 'fixture' })
    const page = await recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' })
    f.input.setTurnOpen('exact-agent', true)
    f.port.say({ t: 'draft.command', draftId: page.id, revision: page.revision, requestId: 'delayed-close-send', op: 'send' })
    await new Promise(resolve => setTimeout(resolve, 10))
    f.port.isOpen = false // the native read loop has not yet delivered onClosed
    let finish!: (port: Port) => void
    const next = new Port(() => {}, () => {})
    f.openPort.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    f.session['openAt'] = 0
    const opening = f.session['tryOpen']()
    f.input.setTurnOpen('exact-agent', false)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
    const state = await f.session['voiceDraft'].command(String(page.id), Number(page.revision), 'state', 0,
      { mac: '28:84:85:90:5F:78', machineId: 'local' })
    expect(state).toMatchObject({ active: true, locked: true, canSend: false, error: expect.stringContaining('was not sent') })
    // A late close from the previous reader cannot revoke the new attempt.
    f.port['closed']('delayed old close')
    finish(next); await opening
    expect(f.session['link']).toBe(next)
  })
  it('fails closed for unsupported/absent preparation and keeps unreviewed legacy delivery unchanged', async () => {
    const f = await fixture()
    f.row.engine = 'codex'
    expect(await recorded(f.port, { agentId: f.row.agentId, cmd: 'loop' })).toMatchObject({ t: 'voice.error' })
    expect(f.transcribe).not.toHaveBeenCalled()
    vi.spyOn(f.host, 'prepareReviewed').mockResolvedValue({ ok: false, error: 'Unavailable' })
    expect(await recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' })).toMatchObject({ t: 'voice.error' })
    expect(await recorded(f.port, { agentId: f.row.agentId, cmd: 'goal' }, false)).toMatchObject({ t: 'voice.transcript' })
    expect(f.legacy).toHaveBeenCalledExactlyOnceWith('exact-agent', '/goal Original words.')
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
  })
})
