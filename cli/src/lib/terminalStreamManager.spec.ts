import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { TerminalStreamManager, clientDescriptorFrom, terminalEngineCapabilities, UPLOAD_CHUNK_BYTES } from './terminalStreamManager.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionPossiblyExecuted,
  terminalActionNotStarted,
  type TerminalActionResult,
  type TerminalStreamHandle,
  type TerminalStreamSink,
} from './terminalTypes.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { TerminalBinaryKind, TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES, type TerminalBinaryClear } from './terminalBinary.js'
import { createPasteClipboard } from '../services/pasteClipboard.js'
import type { PasteClipboardResult as OsClipboardImageResult } from '../core/api.js'
import type { PasteBegin, PastePort } from '../core/api.js'
import { MoveGate } from './hostMove/gate.js'
import { BackendSocket } from '../backendSocket.js'
import { PasteArtifactCleanupUnconfirmed } from './pasteArtifact.js'

const writeImageToOsClipboard = vi.fn<(path: string, bytes: Uint8Array) => Promise<OsClipboardImageResult>>()
const writePasteImageFile = vi.fn<(bytes: Uint8Array) => Promise<string>>()
const writePasteDropFile = vi.fn<(filename: string, bytes: Uint8Array) => Promise<string>>()

class FakeStream implements TerminalStreamHandle {
  readonly runtime = { backend: 'tmux' as const, paneId: '%1' }
  writes: Uint8Array[] = []
  pastes: string[] = []
  sizes: Array<{ cols: number; rows: number }> = []
  scrolls: Array<{ direction: 'up' | 'down'; lines: number }> = []
  closed = false
  snapshots = 0
  snapshotBytes = Buffer.from('\u001bcfixture')
  onSnapshot: ((count: number) => void) | null = null
  pauses = 0
  resumes = 0
  snapshotBegins = 0
  snapshotEnds = 0
  snapshotOptions: Array<{ tuiOwnsScrollback?: boolean } | undefined> = []
  onEndSnapshot: (() => void) | null = null

  beginSnapshot() { this.snapshotBegins++ }
  async snapshot(options?: { tuiOwnsScrollback?: boolean }): Promise<{ state: 'succeeded'; value: { bytes: Uint8Array; cols: number; rows: number } }> {
    this.snapshots++
    this.snapshotOptions.push(options)
    this.onSnapshot?.(this.snapshots)
    return { state: 'succeeded', value: { bytes: this.snapshotBytes, cols: 120, rows: 40 } }
  }
  endSnapshot() { this.snapshotEnds++; this.onEndSnapshot?.() }
  /** When set, every writeRaw parks on it instead of answering at once — a tmux that is slow to `%end`. */
  pendingWrites: Array<(result: TerminalActionResult) => void> = []
  holdWrites = false
  /** Every write and paste, in the order they reached the pane. */
  order: string[] = []
  async writeRaw(bytes: Uint8Array): Promise<TerminalActionResult> {
    this.writes.push(bytes)
    this.order.push(`raw:${Buffer.from(bytes).toString()}`)
    if (!this.holdWrites) return TERMINAL_ACTION_SUCCEEDED
    return new Promise((resolve) => { this.pendingWrites.push(resolve) })
  }
  /** When set, a paste waits on it, with the check the manager asked to be made as it lands. */
  pasteLands: ((allowed: (() => boolean) | undefined) => Promise<TerminalActionResult>) | null = null
  async pasteRaw(text: string, allowed?: () => boolean) {
    this.pastes.push(text)
    this.order.push(`paste:${text}`)
    return this.pasteLands ? this.pasteLands(allowed) : TERMINAL_ACTION_SUCCEEDED
  }
  async resize(size: { cols: number; rows: number }) { this.sizes.push(size); return TERMINAL_ACTION_SUCCEEDED }
  async scroll(direction: 'up' | 'down', lines: number) { this.scrolls.push({ direction, lines }); return TERMINAL_ACTION_SUCCEEDED }
  async pauseOutput() { this.pauses++; return TERMINAL_ACTION_SUCCEEDED }
  async resumeOutput() { this.resumes++; return TERMINAL_ACTION_SUCCEEDED }
  async close(): Promise<void> { this.closed = true }
}

function session(engine: string = 'codex', agentId = 'agent-1'): RegisteredSession {
  return {
    agentId, sessionId: `session-${agentId}`, engine, active: true,
    registeredAt: Date.now(), touchedAt: Date.now(), runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux:default:%1',
  } as unknown as RegisteredSession
}

describe('TerminalStreamManager', () => {
  let sink: TerminalStreamSink | null
  let stream: FakeStream
  let sent: Array<{ connId: string; type: string; payload: Record<string, unknown> }>
  let binarySent: Array<{ connId: string; frame: TerminalBinaryClear }>
  let manager: TerminalStreamManager
  let agents: Map<string, RegisteredSession>
  let outputBeforeOpen: Uint8Array | null
  let terminals: TerminalBackendCoordinator
  let paste: PastePort

  const newManager = (extra: Partial<ConstructorParameters<typeof TerminalStreamManager>[0]> = {}): TerminalStreamManager =>
    new TerminalStreamManager({
      terminals,
      resolveAgent: (id) => agents.get(id),
      sendTarget: (connId, type, payload) => { sent.push({ connId, type, payload }); return true },
      sendBinaryTarget: (connId, frame) => { binarySent.push({ connId, frame }); return true },
      streamingAvailable: true,
      paste: () => paste,
      preparedPaste: (_generation, artifact) => ({ path: artifact.name, descriptor: 0, current: () => true, close: () => {} }),
      now: () => Date.now(),
      ...extra,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    sink = null
    stream = new FakeStream()
    sent = []
    binarySent = []
    outputBeforeOpen = null
    agents = new Map([['agent-1', session()]])
    terminals = {
      openStream: async (_session: RegisteredSession, _size: unknown, nextSink: TerminalStreamSink) => {
        sink = nextSink
        if (outputBeforeOpen) nextSink.onData(outputBeforeOpen)
        return { state: 'succeeded' as const, value: stream }
      },
    } as unknown as TerminalBackendCoordinator
    // A worker double for the stream caller tests; actual storage/admission is tested through createPasteFiles.
    const uploads = new Map<string, { request: PasteBegin; parts: Map<number, Uint8Array>; complete: boolean }>()
    const imageBodies = new Map<string, Uint8Array>()
    const clipboard = createPasteClipboard('/fixture', {
      reservation: { claim: async () => ({ release: async () => {} }), release: async () => {} },
      open: (_generation, artifact) => ({ path: artifact.name, descriptor: 0, current: () => true, close() {} }),
      start: (file) => {
        const ready = writeImageToOsClipboard(file.path, imageBodies.get(file.path)!)
        return { ready, settled: ready.then(() => {}), cancel() {} }
      },
    })
    paste = {
      clipboard: (request) => clipboard.prepare(request), releaseClipboard: (generation) => clipboard.release(generation),
      begin: async (request) => { uploads.set(request.generation, { request, parts: new Map(), complete: false }); return { accepted: true } },
      chunk: async (request, bytes) => {
        const upload = uploads.get(request.generation)
        if (!upload || upload.complete) return { ignored: true }
        if (!upload.parts.has(request.seq)) upload.parts.set(request.seq, bytes)
        const written = [...upload.parts.values()].reduce((sum, part) => sum + part.length, 0)
        const progress = { bytesWritten: written, totalBytes: upload.request.totalBytes }
        if (written < upload.request.totalBytes) return progress
        upload.complete = true
        try {
          const body = new Uint8Array(Buffer.concat([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)))
          const name = upload.request.kind === 'image' ? await writePasteImageFile(body) : await writePasteDropFile(upload.request.filename, body)
          if (upload.request.kind === 'image') imageBodies.set(name, body)
          return { ...progress, artifact: { name, version: 'fixture' } }
        } catch { return { error: 'PASTE_STORAGE_FAILED' } }
      },
      cancel: (generation) => { clipboard.cancel(generation); if (generation === null) uploads.clear(); else uploads.delete(generation) },
      stop: async () => { uploads.clear(); await clipboard.stop() },
    }
    manager = newManager()
    vi.mocked(writePasteImageFile).mockReset().mockResolvedValue('/fake/paste-images/fake.png')
    vi.mocked(writePasteDropFile).mockReset().mockImplementation(async (filename: string) => `/fake/paste-drops/id-${filename}`)
    vi.mocked(writeImageToOsClipboard).mockReset().mockResolvedValue({ state: 'written' })
  })

  afterEach(async () => {
    await manager.stop()
    await paste.stop()
    vi.useRealTimers()
  })

  describe('bounded admission through the shipping backend lane', () => {
    let backend: BackendSocket
    const connection = 'local:admission'
    let running: Promise<unknown>[]
    let releases: Array<() => void>
    let handles: Map<string, FakeStream>
    let moves: MoveGate
    const hold = () => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => { release = resolve })
      releases.push(release)
      return { promise, release }
    }
    const frame = (type: string, payload: Record<string, unknown>, conn = connection) => {
      // Registered local membership is checked again by dispatchDown; this public entry returns its completion.
      const work = Promise.resolve(backend.fromGateway.frame(conn, { type, payload }, 'relay', 'web'))
      running.push(work)
      return work
    }
    const binary = (streamId: string, seq: number, kind = TerminalBinaryKind.input, bytes = Uint8Array.of(13), conn = connection) => {
      const work = backend.handleLocalBinary(conn, { streamId, seq, kind, bytes, compressed: false })
      running.push(work)
      return work
    }
    const open = async (index = 1, watch = false) => {
      const agentId = `admission-${index}`, paneId = `%${index}`
      agents.set(agentId, { ...session('codex', agentId), runtimes: [{ backend: 'tmux', paneId }], primaryRuntimeKey: `tmux:default:${paneId}` } as RegisteredSession)
      const handle = new FakeStream(); handle.runtime.paneId = paneId; handles.set(agentId, handle)
      await frame('terminal_open', { agentId, requestId: agentId, protocolVersion: 3, cols: 100, rows: 30, watch })
      return { id: String(sent.findLast((item) => item.type === 'terminal_ready' && item.payload.agentId === agentId)!.payload.streamId), handle, agentId }
    }
    const beginFile = (id: string, totalBytes = 20 * 1024 * 1024) => frame('terminal_chunked_upload_begin', {
      streamId: id, uploadKind: 'file', filename: 'file.txt', totalBytes,
    })
    const beginAnswer = () => sent.findLast((item) => item.type === 'terminal_chunked_upload_begin_result')!.payload
    beforeEach(async () => {
      running = []; releases = []; handles = new Map(); moves = new MoveGate()
      await manager.stop()
      terminals.openStream = async (row) => ({ state: 'succeeded', value: handles.get(row.agentId)! })
      manager = newManager({ moveGate: moves })
      backend = new BackendSocket('admission-fixture')
      backend.setTerminalStreamManager(manager)
      backend.registerLocalClient(connection, { sendFrame: () => true, sendBinary: () => true })
    })
    afterEach(async () => {
      for (const release of releases) release()
      for (const handle of handles.values()) {
        handle.holdWrites = false
        for (const release of handle.pendingWrites.splice(0)) release(TERMINAL_ACTION_SUCCEEDED)
      }
      for (const agentId of moves.held()) await moves.release(agentId)
      await backend.stop()
      await Promise.allSettled(running)
    })

    it.each([{ kind: 'image', invalid: false }, { kind: 'file', invalid: false }, { kind: 'image', invalid: true }, { kind: 'file', invalid: true }] as const)('retains $kind descriptor cleanup uncertainty (invalid=$invalid) across Cancel and reconnect at the global admission bound', async ({ kind, invalid }) => {
      await manager.stop()
      const close = vi.fn(() => { throw new Error('fixture close failure') })
      manager = newManager({ preparedPaste: () => {
        if (invalid) throw new PasteArtifactCleanupUnconfirmed()
        return { path: '/fake/prepared-file', descriptor: 0, current: () => true, close }
      } })
      backend.setTerminalStreamManager(manager)
      const pasteKind = kind === 'image' ? TerminalBinaryKind.imagePaste : TerminalBinaryKind.pasteFile
      for (let index = 1; index <= 128; index++) {
        const a = await open(index)
        await frame('terminal_chunked_upload_begin', { streamId: a.id, uploadKind: kind, filename: 'file.txt', totalBytes: 1 })
        expect(beginAnswer().accepted).toBe(true)
        await binary(a.id, 0, pasteKind, Uint8Array.of(1))
        expect(sent.findLast(item => item.type === 'terminal_error')?.payload.message).toBe('PASTE_FILE_CLOSE_FAILED')
        await frame('terminal_chunked_upload_cancel', { streamId: a.id })
        await beginFile(a.id)
        expect(beginAnswer().accepted).toBe(false)
        await backend.unregisterLocalClient(connection)
        backend.registerLocalClient(connection, { sendFrame: () => true, sendBinary: () => true })
      }
      const next = await open(129)
      await beginFile(next.id)
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      expect(close).toHaveBeenCalledTimes(invalid ? 0 : 128)
      await binary(next.id, 0)
      expect(next.handle.writes).toHaveLength(1)
    })

    it('accepts four chunks, rejects the fifth before delegation, and retains charges through Cancel/new begin', async () => {
      const a = await open(), b = await open(2), entered = hold(), done = hold()
      paste.chunk = vi.fn(async () => { entered.release(); await done.promise; return { bytesWritten: 1, totalBytes: 20 * 1024 * 1024 } })
      await beginFile(a.id)
      const chunks = Array.from({ length: 4 }, (_, seq) => binary(a.id, seq, TerminalBinaryKind.pasteFile, new Uint8Array(UPLOAD_CHUNK_BYTES)))
      await entered.promise
      expect(paste.chunk).toHaveBeenCalledOnce()
      await binary(a.id, 4, TerminalBinaryKind.pasteFile, new Uint8Array(UPLOAD_CHUNK_BYTES))
      expect(sent.at(-1)?.payload).toMatchObject({ code: 'TERMINAL_PASTE_FILE_FAILED', message: 'PASTE_WINDOW_EXCEEDED' })
      await beginFile(a.id)
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      await binary(b.id, 0)
      expect(b.handle.writes).toHaveLength(1)
      done.release(); await Promise.all(chunks)
      await beginFile(a.id)
      expect(beginAnswer()).toMatchObject({ accepted: true })
      expect(paste.chunk).toHaveBeenCalledOnce()
    })

    it('never relabels a queued chunk or late progress under a successor generation', async () => {
      const a = await open(), entered = hold(), done = hold()
      const generations: string[] = []
      paste.chunk = vi.fn(async (request) => {
        generations.push(request.generation)
        if (generations.length === 1) { entered.release(); await done.promise; return { bytesWritten: 1, totalBytes: 20 * 1024 * 1024 } }
        return { bytesWritten: 2, totalBytes: 20 * 1024 * 1024 }
      })
      await beginFile(a.id)
      const first = binary(a.id, 0, TerminalBinaryKind.pasteFile)
      await entered.promise
      const oldQueued = binary(a.id, 1, TerminalBinaryKind.pasteFile)
      await frame('terminal_chunked_upload_cancel', { streamId: a.id })
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
      const current = binary(a.id, 0, TerminalBinaryKind.pasteFile)
      done.release(); await Promise.all([first, oldQueued, current])
      expect(generations).toHaveLength(2)
      expect(generations[0]).not.toBe(generations[1])
      expect(sent.filter((item) => item.type === 'terminal_chunked_upload_progress').map((item) => item.payload.bytesWritten)).toEqual([2])
    })

    it('charges pending begin calls across cancellation instead of growing connected RPCs', async () => {
      const a = await open(), done = hold()
      paste.begin = vi.fn(async () => { await done.promise; return { accepted: true as const } })
      const begins: Promise<unknown>[] = []
      for (let index = 0; index < 4; index++) {
        begins.push(beginFile(a.id))
        await frame('terminal_chunked_upload_cancel', { streamId: a.id })
      }
      await beginFile(a.id)
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      expect(paste.begin).toHaveBeenCalledTimes(4)
      done.release(); await Promise.all(begins)
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
    })

    it('bounds 32 full windows even after transport bytes have drained, including closed streams', async () => {
      const done = hold(), streams: string[] = [], chunks: Promise<void>[] = []
      paste.chunk = vi.fn(async () => { await done.promise; return { bytesWritten: 1, totalBytes: 20 * 1024 * 1024 } })
      for (let index = 0; index < 33; index++) {
        const a = await open(index + 1); streams.push(a.id)
        if (index < 32) await beginFile(a.id)
      }
      const view = new Uint8Array(UPLOAD_CHUNK_BYTES)
      for (const id of streams.slice(0, 32)) for (let seq = 0; seq < 4; seq++) chunks.push(binary(id, seq, TerminalBinaryKind.pasteFile, view))
      await beginFile(streams[32])
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      await backend.unregisterLocalClient(connection)
      backend.registerLocalClient(connection, { sendFrame: () => true, sendBinary: () => true })
      const reopened = await open(34)
      await beginFile(reopened.id)
      expect(beginAnswer().accepted).toBe(false)
      done.release(); await Promise.all(chunks)
      await beginFile(reopened.id)
      expect(beginAnswer().accepted).toBe(true)
      expect(vi.mocked(paste.chunk).mock.calls.every((call) => call[1] === view)).toBe(true)
    })

    it('retains pipelined raw-write charges until their acknowledgements settle and closes only an overflowing stream', async () => {
      const a = await open(), b = await open(2)
      a.handle.holdWrites = true
      for (let seq = 0; seq < 64; seq++) await binary(a.id, seq)
      expect(a.handle.writes).toHaveLength(64)
      await binary(a.id, 64)
      expect(sent.some((item) => item.payload.code === 'TERMINAL_INPUT_OVERFLOW' && item.payload.streamId === a.id)).toBe(true)
      await binary(b.id, 0)
      expect(b.handle.writes).toHaveLength(1)
      for (const release of a.handle.pendingWrites.splice(0)) release(TERMINAL_ACTION_SUCCEEDED)
    })

    it('rejects an over-byte plain paste before it reaches the terminal and releases the original on settlement', async () => {
      const a = await open(), entered = hold(), done = hold()
      a.handle.pasteLands = async () => { entered.release(); await done.promise; return TERMINAL_ACTION_SUCCEEDED }
      const first = binary(a.id, 0, TerminalBinaryKind.paste, new Uint8Array(6 * 1024 * 1024).fill(120))
      await entered.promise
      await binary(a.id, 0, TerminalBinaryKind.paste, new Uint8Array(3 * 1024 * 1024).fill(120))
      expect(sent.some((item) => item.payload.code === 'TERMINAL_INPUT_OVERFLOW')).toBe(true)
      expect(a.handle.pastes).toHaveLength(1)
      done.release(); await first
    })

    it('bounds total unsettled input frames across lanes and recovers after their acknowledgements', async () => {
      const opened = []
      const settlements: Promise<unknown>[] = []
      const receive = manager.handleBinary.bind(manager)
      vi.spyOn(manager, 'handleBinary').mockImplementation((conn, value, admission) => receive(conn, value,
        (run, refused) => admission!((retain) => run((settled) => {
          retain(settled); settlements.push(settled)
        }), refused)))
      for (let index = 0; index < 9; index++) opened.push(await open(index + 1))
      for (const a of opened.slice(0, 8)) {
        a.handle.holdWrites = true
        for (let seq = 0; seq < 64; seq++) await binary(a.id, seq)
      }
      await beginFile(opened[8].id)
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      for (const a of opened.slice(0, 8)) for (const release of a.handle.pendingWrites.splice(0)) release(TERMINAL_ACTION_SUCCEEDED)
      // The public admission contract owns reporting too, not just the backend's native acknowledgement.
      await Promise.all(settlements)
      await beginFile(opened[8].id)
      expect(beginAnswer().accepted).toBe(true)
    })

    it('bounds total queued bytes across lanes without disturbing their already-admitted plain pastes', async () => {
      const done = hold(), opened: Array<Awaited<ReturnType<typeof open>>> = [], queued: Promise<void>[] = []
      for (let index = 0; index < 9; index++) opened.push(await open(index + 1))
      const first = new Uint8Array(6 * 1024 * 1024).fill(120), second = first.subarray(0, 2 * 1024 * 1024)
      for (const a of opened.slice(0, 8)) {
        a.handle.pasteLands = async () => { await done.promise; return TERMINAL_ACTION_SUCCEEDED }
        queued.push(binary(a.id, 0, TerminalBinaryKind.paste, first), binary(a.id, 0, TerminalBinaryKind.paste, second))
      }
      await binary(opened[8].id, 0)
      expect(sent.some((item) => item.payload.code === 'TERMINAL_INPUT_OVERFLOW' && item.payload.streamId === opened[8].id)).toBe(true)
      done.release(); await Promise.all(queued)
      expect(opened.slice(0, 8).every((a) => a.handle.pastes.length === 2)).toBe(true)
    })

    it('does not spend capacity for unknown, wrong-connection or watching streams', async () => {
      const a = await open(), watcher = await open(2, true)
      for (let index = 0; index < 200; index++) {
        await binary('00000000-0000-0000-0000-000000000001', index)
        await binary(a.id, index, TerminalBinaryKind.input, Uint8Array.of(13), 'local:unknown')
        await binary(watcher.id, index)
      }
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
      expect(watcher.handle.writes).toEqual([])
    })

    it('does not reserve input for a read-only manager before a writable manager takes over the same backend', async () => {
      await manager.stop()
      manager = newManager({ readOnly: true }); backend.setTerminalStreamManager(manager)
      const watched = await open()
      for (let seq = 0; seq < 600; seq++) await binary(watched.id, seq)
      expect(watched.handle.writes).toEqual([])
      await manager.stop()
      manager = newManager(); backend.setTerminalStreamManager(manager)
      const a = await open(2)
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
    })

    it('settles all held raw and text-paste charges when move ownership is refused', async () => {
      const refused = new Set<string>()
      moves = new MoveGate(id => refused.has(id), id => { refused.add(id) })
      await manager.stop(); manager = newManager({ moveGate: moves }); backend.setTerminalStreamManager(manager)
      const a = await open(), b = await open(2)
      moves.hold(a.agentId)
      for (let seq = 0; seq < 32; seq++) {
        await binary(a.id, seq, TerminalBinaryKind.input, Buffer.from('K'))
        await binary(a.id, 0, TerminalBinaryKind.paste, Buffer.from('P'))
      }
      await moves.refuse(a.agentId)
      await binary(a.id, 32, TerminalBinaryKind.input, Buffer.from('late'))
      await binary(b.id, 0, TerminalBinaryKind.input, Buffer.from('unrelated'))
      expect(a.handle.order).toEqual([])
      expect(b.handle.order).toEqual(['raw:unrelated'])
      const errors = sent.filter(item => item.type === 'terminal_error' && item.payload.streamId === a.id)
      expect(errors).toHaveLength(65)
      expect(errors.every(item => item.payload.message === 'This harness is held until the daemon restarts.')).toBe(true)
      expect(errors.some(item => item.payload.code === 'TERMINAL_INPUT_OVERFLOW')).toBe(false)
    })

    it.each(['file', 'image'] as const)('settles refused held %s charges and the current generation without reviving cancelled uploads', async (kind) => {
      const refused = new Set<string>()
      moves = new MoveGate(id => refused.has(id), id => { refused.add(id) })
      await manager.stop(); manager = newManager({ moveGate: moves }); backend.setTerminalStreamManager(manager)
      const a = await open(), b = await open(2)
      moves.hold(a.agentId)
      for (let index = 0; index < 4; index++) {
        await frame('terminal_chunked_upload_begin', { streamId: a.id, uploadKind: kind, filename: 'file.txt', totalBytes: 1 })
        expect(beginAnswer().accepted).toBe(true)
        await binary(a.id, 0, kind === 'file' ? TerminalBinaryKind.pasteFile : TerminalBinaryKind.imagePaste, Uint8Array.of(1))
        if (index < 3) await frame('terminal_chunked_upload_cancel', { streamId: a.id })
      }
      await moves.refuse(a.agentId)
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
      await binary(b.id, 0, TerminalBinaryKind.input, Buffer.from('unrelated'))
      expect(a.handle.order).toEqual([])
      expect(b.handle.order).toEqual(['raw:unrelated'])
      expect(writeImageToOsClipboard).not.toHaveBeenCalled()
      const errors = sent.filter(item => item.type === 'terminal_error' && item.payload.streamId === a.id)
      expect(errors).toHaveLength(1)
      expect(errors[0].payload).toMatchObject({ code: 'TERMINAL_PASTE_FAILED', message: 'This harness is held until the daemon restarts.' })
    })

    it('keeps MoveGate admission until callbacks finish while allowing later held keys into the same gate', async () => {
      const a = await open()
      moves.hold(a.agentId)
      for (let index = 0; index < 4; index++) {
        await frame('terminal_chunked_upload_begin', { streamId: a.id, uploadKind: 'image', totalBytes: 1 })
        await binary(a.id, 0, TerminalBinaryKind.imagePaste, Uint8Array.of(1))
        await frame('terminal_chunked_upload_cancel', { streamId: a.id })
      }
      await beginFile(a.id)
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_WINDOW_EXCEEDED' })
      await binary(a.id, 0, TerminalBinaryKind.paste, Buffer.from('P'))
      await binary(a.id, 0, TerminalBinaryKind.input, Buffer.from('K'))
      expect(a.handle.order).toEqual([])
      await moves.release(a.agentId)
      expect(a.handle.order).toEqual(['paste:P', 'raw:K'])
      expect(writeImageToOsClipboard).not.toHaveBeenCalled()
      await beginFile(a.id)
      expect(beginAnswer().accepted).toBe(true)
    })

    it('releases a reordered input reservation on drop and on eventual write, without breaking write pipelining', async () => {
      const a = await open()
      await binary(a.id, 1, TerminalBinaryKind.input, Buffer.from('B'))
      await binary(a.id, 0, TerminalBinaryKind.input, Buffer.from('A'))
      expect(a.handle.order).toEqual(['raw:A', 'raw:B'])
      await binary(a.id, 3)
      await backend.unregisterLocalClient(connection)
      backend.registerLocalClient(connection, { sendFrame: () => true, sendBinary: () => true })
      const b = await open(2)
      await binary(b.id, 0)
      expect(b.handle.writes).toHaveLength(1)
    })

    it('reports worker image capacity refusal and permits a new begin after cancellation', async () => {
      const opened = []
      for (let index = 0; index < 5; index++) opened.push(await open(index + 1))
      for (const a of opened.slice(0, 4)) await frame('terminal_chunked_upload_begin', {
        streamId: a.id, uploadKind: 'image', totalBytes: TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES,
      })
      vi.spyOn(paste, 'begin').mockResolvedValueOnce({ error: 'PASTE_CAPACITY' })
      await frame('terminal_chunked_upload_begin', {
        streamId: opened[4].id, uploadKind: 'image', totalBytes: TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES,
      })
      expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_CAPACITY' })
      await frame('terminal_chunked_upload_cancel', { streamId: opened[0].id })
      await frame('terminal_chunked_upload_begin', {
        streamId: opened[4].id, uploadKind: 'image', totalBytes: TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES,
      })
      expect(beginAnswer().accepted).toBe(true)
    })

    it('keeps no-service failure visible and releases begin admission for later independent input', async () => {
      await manager.stop()
      manager = newManager({ paste: undefined })
      backend.setTerminalStreamManager(manager)
      const a = await open()
      for (let index = 0; index < 8; index++) {
        await beginFile(a.id)
        expect(beginAnswer()).toMatchObject({ accepted: false, reason: 'PASTE_UNAVAILABLE' })
      }
      await binary(a.id, 0)
      expect(a.handle.writes).toHaveLength(1)
    })
  })

  it('publishes the complete engine catalog without a client whitelist', async () => {
    await manager.handleFrame('web-1', 'terminal_capabilities', { requestId: 'r1' })
    const result = sent.at(-1)!
    expect(result.type).toBe('terminal_capabilities_result')
    expect((result.payload.engines as Array<{ id: string }>).map((row) => row.id)).toEqual([...ENGINES])
  })

  // An app sent agent_instructions_read and agent_instructions_write, sealed, only to a daemon that said it knew them. They
  // went with the Swarm (2026-11-14), so this daemon no longer says so, and an older app sends neither.
  it('no longer says it knows the instructions requests', async () => {
    await manager.handleFrame('web-1', 'terminal_capabilities', { requestId: 'r1' })
    expect(sent.at(-1)?.payload.features).not.toHaveProperty('agentInstructions')
  })

  it('asks no window for the tab its input came from, and still writes input from an older one that names it', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'scoped', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const ready = sent.findLast(f => f.type === 'terminal_ready')!.payload
    expect(ready).not.toHaveProperty('swarmInput')
    const frame = { kind: TerminalBinaryKind.input, streamId: String(ready.streamId), seq: 0,
      bytes: Buffer.from('hello\r'), compressed: false, tabId: 'swarm-a' }
    await manager.handleBinary('web-1', frame)
    expect(stream.writes).toEqual([frame.bytes])
  })

  it('streams an agent on the PTY host as one on tmux', async () => {
    agents.set('agent-pty', {
      ...session('codex', 'agent-pty'),
      runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }],
      primaryRuntimeKey: 'ptyhost:p1:%3',
    } as unknown as RegisteredSession)
    agents.set('agent-none', { ...session('codex', 'agent-none'), runtimes: [], primaryRuntimeKey: '' } as unknown as RegisteredSession)
    await manager.handleFrame('web-1', 'terminal_open', { requestId: 'pty', protocolVersion: 3, agentId: 'agent-pty', cols: 100, rows: 30 })
    expect(sent.findLast(f => f.payload.requestId === 'pty')?.type).toBe('terminal_ready')
    await manager.handleFrame('web-1', 'terminal_open', { requestId: 'none', protocolVersion: 3, agentId: 'agent-none', cols: 100, rows: 30 })
    expect(sent.findLast(f => f.payload.requestId === 'none')).toMatchObject({ type: 'terminal_error', payload: { code: 'TERMINAL_RUNTIME_UNAVAILABLE' } })
  })

  it('uses the same generic path for every current engine', async () => {
    for (const [index, engine] of ENGINES.entries()) {
      const agentId = `agent-generic-${index}`
      agents.set(agentId, session(engine, agentId))
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: `open-${index}`, protocolVersion: 3, agentId, cols: 100, rows: 30,
      })
      const ready = sent.findLast((frame) => frame.type === 'terminal_ready')
      expect(ready?.payload.agentId).toBe(agentId)
      expect(ready?.payload.engineId).toBe(engine)
    }
  })

  it('automatically publishes a future engine once the source catalog contains it', () => {
    const futureCatalog = [...ENGINES, 'future-engine-added-later']
    expect(terminalEngineCapabilities(true, futureCatalog).map((row) => row.id)).toEqual(futureCatalog)
  })

  it('fails closed for an engine that is not in the current source catalog', async () => {
    const unsafe = session('claude') as unknown as { engine: string }
    unsafe.engine = 'hostile-unregistered-engine'
    agents.set('agent-1', unsafe as unknown as RegisteredSession)
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'unsupported', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_ENGINE_UNSUPPORTED')
  })

  it('rejects an unknown agent without opening a stream', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'missing', protocolVersion: 3, agentId: 'does-not-exist', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_AGENT_NOT_FOUND')
  })

  // Codex prints its transcript again after a resize, its clear first; at work it began after the keyframe had been
  // taken, and a phone drew the cleared screen (2026-10-13). Its clear never goes out as output.
  it('stands a keyframe in for an engine\'s print that begins as live output after a resize', async () => {
    const repaint = { clears: '\u001b[3J', ends: '\u001b[?2026l', withinMs: 250 }
    const output = () => binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.output)
      .map(({ frame }) => Buffer.from(frame.bytes).toString('latin1')).join('')
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 0, cols: 120, rows: 30 })
    const taken = stream.snapshots

    // Begun in one chunk and ended in another: the keyframe waits for the end.
    sink!.onData(Buffer.from('\u001b[?2026l\u001b[H\u001b[2J\u001b[3J\u001b[H\u001b[?2026h'))
    await vi.advanceTimersByTimeAsync(8)
    expect(stream.snapshots).toBe(taken + 1)
    expect(stream.snapshotOptions.at(-1)).toEqual({ conversationHistory: true, repaint: { ...repaint, cleared: true } })
    expect(output()).not.toContain('\u001b[3J')

    // Begun and ended in one chunk: the keyframe is taken at once.
    await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 1, cols: 120, rows: 40 })
    sink!.onData(Buffer.from('\u001b[2J\u001b[3J\u001b[?2026htranscript\u001b[?2026l'))
    await vi.advanceTimersByTimeAsync(8)
    expect(stream.snapshotOptions.at(-1)).toEqual({ conversationHistory: true })
    expect(output()).not.toContain('\u001b[3J')

    // Long after a resize a clear is the engine's own business, and goes out like any output.
    await vi.advanceTimersByTimeAsync(2_000)
    const before = stream.snapshots
    sink!.onData(Buffer.from('\u001b[3J'))
    await vi.advanceTimersByTimeAsync(8)
    expect(stream.snapshots).toBe(before)
    expect(output()).toContain('\u001b[3J')
  })

  // The keyframe after a resize was taken before Codex's print began, and the clear came in the output held behind it.
  // Released while the keyframe was still marked as being taken, it went to the viewer unread (review of #1310).
  it('reads the output a keyframe held back for an engine\'s print, as it reads live output', async () => {
    const repaint = { clears: '\u001b[3J', ends: '\u001b[?2026l', withinMs: 250 }
    const output = () => binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.output)
      .map(({ frame }) => Buffer.from(frame.bytes).toString('latin1')).join('')
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string
    stream.onEndSnapshot = () => {
      stream.onEndSnapshot = null
      sink!.onData(Buffer.from('\u001b[?2026hworking\u001b[?2026l'))
      sink!.onData(Buffer.from('\u001b[H\u001b[2J\u001b[3J\u001b[H\u001b[?2026h'))
    }
    const taken = stream.snapshots
    await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 0, cols: 120, rows: 30 })
    await vi.advanceTimersByTimeAsync(8)

    // The resize's keyframe, then the print's, which waits for its end.
    expect(stream.snapshots).toBe(taken + 2)
    expect(stream.snapshotOptions.at(-1)).toEqual({ conversationHistory: true, repaint: { ...repaint, cleared: true } })
    expect(stream.snapshotBegins).toBe(stream.snapshotEnds)
    expect(output()).not.toContain('\u001b[3J')
    expect(binarySent.at(-1)!.frame.kind).toBe(TerminalBinaryKind.keyframe)
  })

  it('tells a Grok snapshot not to seed tmux history, an engine kept in the scrollback to seed all of it, and leaves other engines alone', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-codex', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    // Codex prints its transcript again on a resize, which a keyframe after one waits for.
    expect(stream.snapshotOptions.at(-1)).toEqual({
      conversationHistory: true, repaint: { clears: '\u001b[3J', ends: '\u001b[?2026l', withinMs: 250 },
    })

    agents.set('claude-1', session('claude', 'claude-1'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-claude', protocolVersion: 3, agentId: 'claude-1', cols: 120, rows: 40,
    })
    // Claude Code runs as the person set it up: its history is sent as any pane's.
    expect(stream.snapshotOptions.at(-1)).toBeUndefined()

    agents.set('opencode-1', session('opencode', 'opencode-1'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-opencode', protocolVersion: 3, agentId: 'opencode-1', cols: 120, rows: 40,
    })
    expect(stream.snapshotOptions.at(-1)).toBeUndefined()

    agents.set('grok-1', session('grok', 'grok-1'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-grok', protocolVersion: 3, agentId: 'grok-1', cols: 120, rows: 40,
    })
    expect(stream.snapshotOptions.at(-1)).toEqual({ tuiOwnsScrollback: true })
  })

  it('tells the daemon an agent took input from its controller — never from a watcher, never for input it refused', async () => {
    // The keystroke prewarm (grid-reads-without-waking issue 03) hangs off this: typing into a pane whose
    // agent runs on a sleeping grid starts that grid. A read-only watcher's input reaches no pty, so it
    // must start nothing either.
    const typed: string[] = []
    const person: boolean[] = []
    const from: Array<{ connId: string, kind: string | null }> = []
    await manager.stop()
    manager = newManager({ onInput: (agentId, byPerson, source) => { typed.push(agentId); person.push(byPerson); from.push(source) } })
    await manager.handleFrame('web-1', 'terminal_open', { requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40 })
    const controller = sent.find((frame) => frame.type === 'terminal_ready' && frame.connId === 'web-1')!.payload.streamId as string
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, takeover: false,
    })
    const watcher = sent.find((frame) => frame.type === 'terminal_ready' && frame.connId === 'web-2')!
    expect(watcher.payload.readOnly).toBe(true)

    await manager.handleBinary('web-2', {
      kind: TerminalBinaryKind.input, streamId: watcher.payload.streamId as string, seq: 0, compressed: false, bytes: Buffer.from('x'),
    })
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId: controller, seq: 5, compressed: false, bytes: Buffer.from('out of order'),
    })
    expect(typed).toEqual([])

    await manager.handleBinary('web-1', { kind: TerminalBinaryKind.input, streamId: controller, seq: 0, compressed: false, bytes: Buffer.from('x') })
    await manager.handleBinary('web-1', { kind: TerminalBinaryKind.paste, streamId: controller, seq: 0, compressed: false, bytes: Buffer.from('hello') })
    // What the window's terminal answers by itself (focus, its attributes) is input too, but not the person's: every
    // harness another agent starts opens as a pane beside its starter, and its reports made each one the person's.
    await manager.handleBinary('web-1', { kind: TerminalBinaryKind.input, streamId: controller, seq: 1, compressed: false, bytes: Buffer.from('\x1b[I\x1b[?1;2c') })
    expect(typed).toEqual(['agent-1', 'agent-1', 'agent-1'])
    expect(person).toEqual([true, true, false])
    // Who typed: the controller's connection (gateway/browser.ts sends a page to the phone typing).
    expect(from[0]?.connId).toBe('web-1')
  })

  it('observes the first accepted person input of each controlling stream without per-keystroke source traffic', async () => {
    const onInputSource = vi.fn()
    await manager.stop()
    manager = newManager({ onInputSource })
    const open = async (connection: string, takeover = true): Promise<string> => {
      await manager.handleFrame(connection, 'terminal_open', {
        requestId: connection, protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, takeover,
      })
      return sent.filter(frame => frame.type === 'terminal_ready' && frame.connId === connection).at(-1)!.payload.streamId as string
    }
    const input = (connection: string, streamId: string, seq: number, value: string) => manager.handleBinary(connection, {
      kind: TerminalBinaryKind.input, streamId, seq, compressed: false, bytes: Buffer.from(value),
    })
    const first = await open('phone')
    const watcher = await open('watcher', false)
    await input('watcher', watcher, 0, 'refused watcher')
    await input('phone', first, 3, 'held out of order')
    await input('phone', first, 0, '\x1b[I\x1b[?1;2c')
    expect(onInputSource).not.toHaveBeenCalled()
    await input('phone', first, 1, 'x')
    await input('phone', first, 2, 'y')
    expect(onInputSource).toHaveBeenCalledExactlyOnceWith('agent-1', { connId: 'phone', kind: null })

    const second = await open('desktop')
    await input('phone', first, 4, 'old controller')
    expect(onInputSource).toHaveBeenCalledTimes(1)
    await input('desktop', second, 0, 'new controller')
    expect(onInputSource).toHaveBeenLastCalledWith('agent-1', { connId: 'desktop', kind: null })
    const reopened = await open('phone')
    await manager.handleBinary('phone', { kind: TerminalBinaryKind.paste, streamId: reopened, seq: 0,
      compressed: false, bytes: Buffer.from('pasted after takeover') })
    expect(onInputSource).toHaveBeenCalledTimes(3)
    expect(onInputSource).toHaveBeenLastCalledWith('agent-1', { connId: 'phone', kind: null })
  })

  it('keeps input flowing after a source observer throws and retries its first-person notification', async () => {
    const onInputSource = vi.fn().mockImplementationOnce(() => { throw new Error('observer failed') })
    const diagnostic = vi.fn()
    await manager.stop()
    manager = newManager({ onInputSource, diagnostic })
    await manager.handleFrame('phone', 'terminal_open', {
      requestId: 'open', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent.find(frame => frame.type === 'terminal_ready')!.payload.streamId as string
    for (let seq = 0; seq < 3; seq++) await manager.handleBinary('phone', {
      kind: TerminalBinaryKind.input, streamId, seq, compressed: false, bytes: Buffer.from('x'),
    })
    expect(stream.writes).toHaveLength(3)
    expect(onInputSource).toHaveBeenCalledTimes(2)
    expect(diagnostic).toHaveBeenCalledWith('input_source_listener_failed', expect.any(Object))
  })

  it('opens with a keyframe, streams coalesced output, and writes ordered raw input', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, compression: ['zlib'],
    })
    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    const streamId = sent[0].payload.streamId as string

    sink!.onData(Buffer.from('hello'))
    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.output)
    expect(binarySent.at(-1)?.frame.seq).toBe(1)

    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('abc'),
    })
    expect(Buffer.from(stream.writes[0]).toString()).toBe('abc')
    // Ahead of seq 1, which may still be on its way over the slower wire: it waits for it, and nothing is said.
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 2, compressed: false, bytes: Buffer.from('out-of-order'),
    })
    expect(stream.writes).toHaveLength(1)
    expect(sent.map((frame) => frame.payload.code)).not.toContain('TERMINAL_INPUT_INVALID')

    // An oversized frame is refused at once, with the counter untouched: the next accepted seq is still 1. The client
    // numbers its next keys from there, so the one waiting under its old numbering goes: released after them, it
    // would land after keys typed later than it.
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: Buffer.alloc(64 * 1024 + 1, 0x61),
    })
    expect(stream.writes).toHaveLength(1)
    expect(sent.at(-1)?.payload).toMatchObject({ code: 'TERMINAL_INPUT_INVALID', reason: 'size', expectedSeq: 1 })

    // The realigned keys: seq 1, then 2, each written in turn.
    const mouse = Buffer.from('\u001b[<0;12;8M')
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: mouse,
    })
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 2, compressed: false, bytes: Buffer.from('typed after'),
    })
    expect(stream.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(['abc', mouse.toString(), 'typed after'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent.filter((frame) => frame.payload.code === 'TERMINAL_INPUT_INVALID')).toHaveLength(1)

    await manager.handleFrame('web-1', 'terminal_resize', {
      streamId, resizeSeq: 0, cols: 140, rows: 50,
    })
    expect(stream.sizes.at(-1)).toEqual({ cols: 140, rows: 50 })
  })

  // The native-turn record that read it went with #3901: an input context a Desktop still sends is taken and goes nowhere,
  // and grants a watcher no control.
  it('opens a stream that names an input context as any other, and passes the context on to nothing', async () => {
    const onInput = vi.fn(), inputContext = 'fixture-native-input-context'
    manager = newManager({ onInput })
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'context', protocolVersion: 3, agentId: 'agent-1', cols: 80, rows: 24, inputContext,
    })
    const streamId = sent.find(frame => frame.type === 'terminal_ready' && frame.connId === 'web-1')!.payload.streamId as string
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'watch-context', protocolVersion: 3, agentId: 'agent-1', cols: 80, rows: 24, watch: true, inputContext,
    })
    const watchId = sent.find(frame => frame.type === 'terminal_ready' && frame.connId === 'web-2')!.payload.streamId as string
    await manager.handleBinary('web-2', { kind: TerminalBinaryKind.input, streamId: watchId, seq: 0, compressed: false, bytes: Buffer.from('\r') })
    expect(onInput).not.toHaveBeenCalled()
    await manager.handleBinary('web-1', { kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('hello') })
    expect(onInput).toHaveBeenLastCalledWith('agent-1', true, { connId: 'web-1', kind: null })
    await manager.handleBinary('web-1', { kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: Buffer.from('\r') })
    expect(onInput).toHaveBeenLastCalledWith('agent-1', true, { connId: 'web-1', kind: null })
  })

  it.each([[1, 1], [30, 30], [80, 8], [300, 120]])(
    'opens and resizes a terminal at its actual %i×%i pane size', async (cols, rows) => {
      const open = vi.spyOn(terminals, 'openStream')
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: 'small', protocolVersion: 3, agentId: 'agent-1', cols, rows,
      })
      expect(sent[0].type).toBe('terminal_ready')
      expect(open.mock.calls[0][1]).toEqual({ cols, rows })
      const streamId = sent[0].payload.streamId
      await manager.handleFrame('web-1', 'terminal_resize', {
        streamId, resizeSeq: 0, cols: 120, rows: 40,
      })
      await manager.handleFrame('web-1', 'terminal_resize', {
        streamId, resizeSeq: 1, cols, rows,
      })
      expect(stream.sizes).toEqual([{ cols: 120, rows: 40 }, { cols, rows }])
    },
  )

  it.each([[0, 20], [80, 0], [-1, 20], [80, -1], [1.5, 20], [80, 1.5], [301, 20], [80, 121]])(
    'rejects invalid %i×%i dimensions on open and resize', async (cols, rows) => {
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: 'invalid', protocolVersion: 3, agentId: 'agent-1', cols, rows,
      })
      expect(sent.at(-1)?.payload.code).toBe('TERMINAL_OPEN_INVALID')
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: 'valid', protocolVersion: 3, agentId: 'agent-1', cols: 80, rows: 24,
      })
      const streamId = sent.at(-1)!.payload.streamId
      await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 0, cols, rows })
      expect(stream.sizes).toEqual([])
      // A bad size must not consume the sequence number or prevent a later valid resize.
      await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 0, cols: 80, rows: 24 })
      expect(stream.sizes).toEqual([{ cols: 80, rows: 24 }])
    },
  )

  it('routes terminal_scroll to the stream handle, and rejects a malformed one', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-scroll', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'up', lines: 3 })
    expect(stream.scrolls.at(-1)).toEqual({ direction: 'up', lines: 3 })

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'sideways', lines: 3 })
    expect(stream.scrolls).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_SCROLL_INVALID')

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'down', lines: 0 })
    expect(stream.scrolls).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_SCROLL_INVALID')
  })

  it('pipelines keystrokes to tmux instead of waiting for each %end, and still reports a late failure', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-pipeline', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string
    stream.holdWrites = true

    const input = (seq: number, text: string): TerminalBinaryClear => ({
      kind: TerminalBinaryKind.input, streamId, seq, compressed: false, bytes: Buffer.from(text),
    })
    // Neither handleBinary resolves against tmux's reply: the second keystroke reaches the control
    // client while the first is still unanswered. Before, the local socket's dispatch chain sat on
    // that reply for every character typed.
    await manager.handleBinary('web-1', input(0, 'a'))
    await manager.handleBinary('web-1', input(1, 'b'))
    expect(stream.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(['a', 'b'])
    expect(stream.pendingWrites).toHaveLength(2)
    expect(sent.filter((frame) => frame.type === 'terminal_error')).toHaveLength(0)

    // A reply that arrives after the fact still carries its consequence: an uncertain write gets a
    // keyframe so the client can see what tmux actually did.
    const keyframesBefore = binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe).length
    stream.pendingWrites[0](TERMINAL_ACTION_SUCCEEDED)
    stream.pendingWrites[1](terminalActionPossiblyExecuted('tmux raw input stopped after a partial write'))
    await vi.advanceTimersByTimeAsync(50)
    const errors = sent.filter((frame) => frame.type === 'terminal_error')
    expect(errors).toHaveLength(1)
    expect(errors[0].payload).toMatchObject({ code: 'TERMINAL_INPUT_FAILED', streamId })
    expect(binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toHaveLength(keyframesBefore + 1)
  })

  it('never compresses output for a loopback client, whatever it asked for', async () => {
    const big = Buffer.alloc(8 * 1024, 0x61)   // well over the 1 KiB floor, and trivially compressible

    await manager.stop()
    manager = newManager({ isLoopback: (connId) => connId.startsWith('local:') })
    await manager.handleFrame('local:desktop', 'terminal_open', {
      requestId: 'open-local', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, compression: ['zlib', 'none'],
    })
    sink!.onData(big)
    await vi.advanceTimersByTimeAsync(8)
    const local = binarySent.at(-1)!.frame
    expect(local.kind).toBe(TerminalBinaryKind.output)
    expect(local.compressed).toBe(false)
    expect(local.bytes).toHaveLength(big.length)

    // The same request from anything that is NOT loopback keeps zlib: those frames cross the
    // internet through the relay, where it still pays.
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-web', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, compression: ['zlib', 'none'],
    })
    sink!.onData(big)
    await vi.advanceTimersByTimeAsync(8)
    const remote = binarySent.at(-1)!.frame
    expect(remote.kind).toBe(TerminalBinaryKind.output)
    expect(remote.compressed).toBe(true)
    expect(remote.bytes.length).toBeLessThan(big.length)
  })

  describe('keystrokes that come ahead of a missing one', () => {
    // A client moving a stream from the relay onto its P2P channel sends key N over the relay and N+1 over the
    // faster channel: N+1 came first, was refused, and the client's realignment lost two keys (2026-10-15).
    const open = async () => {
      await manager.handleFrame('web-1', 'terminal_open', { requestId: 'open-order', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40 })
      const streamId = sent[0].payload.streamId as string
      const key = (seq: number, text: string | Buffer = `k${seq}`) => manager.handleBinary('web-1', {
        kind: TerminalBinaryKind.input, streamId, seq, compressed: false, bytes: typeof text === 'string' ? Buffer.from(text) : text,
      })
      const written = () => stream.writes.map((bytes) => Buffer.from(bytes).toString())
      const refusals = () => sent.filter((frame) => frame.payload.code === 'TERMINAL_INPUT_INVALID').map((frame) => frame.payload)
      return { streamId, key, written, refusals }
    }

    it('are written, in their order, as soon as the missing one arrives', async () => {
      const { key, written, refusals } = await open()
      await key(1)
      await key(2)
      expect(written()).toEqual([])
      await key(0)
      expect(written()).toEqual(['k0', 'k1', 'k2'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(refusals()).toEqual([])
    })

    it('go when the missing one does not come in time, and the client is told once what is expected', async () => {
      const { streamId, key, written, refusals } = await open()
      await key(0)
      await key(2)
      await key(3)
      await vi.advanceTimersByTimeAsync(399)
      expect(refusals()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(written()).toEqual(['k0'])
      expect(refusals()).toEqual([expect.objectContaining({ streamId, reason: 'seq', expectedSeq: 1 })])
    })

    it('are refused at once after a wait was given up, until the expected one arrives', async () => {
      // The client realigns on the refusal and numbers its next keys from there: a frame it numbered under the
      // old count must not wait to land among them.
      const { key, written, refusals } = await open()
      await key(0)
      await key(2)
      await vi.advanceTimersByTimeAsync(400)
      await key(5)
      expect(refusals()).toHaveLength(2)
      expect(refusals()[1]).toMatchObject({ expectedSeq: 1 })
      await key(1, 'realigned')
      await key(3)
      expect(refusals()).toHaveLength(2)
      await key(2, 'next')
      expect(written()).toEqual(['k0', 'realigned', 'next', 'k3'])
    })

    it('give each gap a full wait of its own', async () => {
      const { key, written, refusals } = await open()
      await key(0)
      await key(2)
      await key(4)
      await vi.advanceTimersByTimeAsync(300)
      await key(1)
      expect(written()).toEqual(['k0', 'k1', 'k2'])
      await vi.advanceTimersByTimeAsync(399)
      expect(refusals()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(refusals()).toEqual([expect.objectContaining({ expectedSeq: 3 })])
      expect(written()).toEqual(['k0', 'k1', 'k2'])
    })

    it('are given up at once when more bytes wait than may be held', async () => {
      const { key, written, refusals } = await open()
      for (let seq = 1; seq <= 4; seq++) await key(seq, Buffer.alloc(64 * 1024, 0x61))
      expect(refusals()).toEqual([])
      await key(5, Buffer.alloc(1, 0x61))
      expect(refusals()).toEqual([expect.objectContaining({ expectedSeq: 0 })])
      await key(0)
      expect(written()).toEqual(['k0'])
    })

    it('are given up at once when more frames wait than may be held', async () => {
      const { key, written, refusals } = await open()
      for (let seq = 1; seq <= 64; seq++) await key(seq)
      expect(refusals()).toEqual([])
      await key(65)
      expect(refusals()).toEqual([expect.objectContaining({ expectedSeq: 0 })])
      await key(0)
      expect(written()).toEqual(['k0'])
    })

    it('go with any refusal, since the client numbers its next keys from what it is told', async () => {
      // A number already written comes while one waits: the refusal realigns the client, and the key held under
      // its old numbering would land among the new ones.
      const { key, written, refusals } = await open()
      await key(0)
      await key(2)
      await key(0, 'again')
      expect(refusals()).toEqual([expect.objectContaining({ expectedSeq: 1 })])
      await key(1, 'realigned')
      await key(2, 'next')
      expect(written()).toEqual(['k0', 'realigned', 'next'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(refusals()).toHaveLength(1)
    })

    it('keep the first of two frames under one number', async () => {
      const { key, written, refusals } = await open()
      await key(1, 'first')
      await key(1, 'second')
      await key(0)
      expect(written()).toEqual(['k0', 'first'])
      expect(refusals()).toEqual([])
    })

    it('are never written into a pane whose stream closed while they waited', async () => {
      const { streamId, key, written, refusals } = await open()
      await key(1)
      await manager.handleFrame('web-1', 'terminal_close', { streamId })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual([])
      expect(refusals()).toEqual([])
    })

    it('are traced, while tracing is on, by number and time and never by what was typed', async () => {
      const lines: string[] = []
      await manager.stop()
      manager = newManager({ typingTrace: (line) => lines.push(line) })
      const { streamId, key } = await open()
      const short = streamId.slice(0, 8)
      await key(1, 'secret-1')
      await vi.advanceTimersByTimeAsync(30)
      await key(0, 'secret-0')
      sink!.onData(Buffer.from('echo'))
      expect(lines).toEqual([
        `stream=${short} seq=1 held: 0 has not come (1 waiting)`,
        `stream=${short} seq=1..1 released after 30ms`,
        `stream=${short} seq=1 first output out +0ms after it was written`,
      ])
      // A keystroke whose next screen goes out as a keyframe is said so.
      await key(2, 'secret-2')
      await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 0, cols: 100, rows: 30 })
      expect(lines.at(-1)).toBe(`stream=${short} seq=2 keyframe (resize) out +0ms after it was written`)
      expect(lines.join('\n')).not.toContain('secret')
    })

    it('are given up before a paste, which never goes ahead of keys typed before it', async () => {
      const { streamId, key, written, refusals } = await open()
      await key(1)
      await manager.handleBinary('web-1', { kind: TerminalBinaryKind.paste, streamId, seq: 0, compressed: false, bytes: Buffer.from('pasted') })
      expect(refusals()).toEqual([expect.objectContaining({ expectedSeq: 0 })])
      expect(stream.pastes).toEqual(['pasted'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual([])
    })
  })

  it('keeps a paste out of a pane whose stream closed while the paste was on its way, and says nothing', async () => {
    // A stream's close no longer waits in line behind its paste (backendSocket.ts `enqueueTerminalBinary`):
    // the paste must ask again as it lands, or it lands in a pane its client has let go.
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-paste-close', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string
    let land!: () => void
    let askedAsItLanded: boolean | undefined
    stream.pasteLands = (allowed) => new Promise((resolve) => {
      land = () => {
        askedAsItLanded = allowed?.()
        resolve(askedAsItLanded ? TERMINAL_ACTION_SUCCEEDED : { state: 'failed', dispatch: 'not_started', reason: 'tmux paste-buffer could not be sent' })
      }
    })
    const pasting = manager.handleBinary('web-1', { kind: TerminalBinaryKind.paste, streamId, seq: 0, compressed: false, bytes: new TextEncoder().encode('rm -rf build') })
    await vi.waitFor(() => expect(stream.pastes).toEqual(['rm -rf build']))
    await manager.handleFrame('web-1', 'terminal_close', { streamId })
    const before = sent.length
    land()
    await pasting
    expect(askedAsItLanded).toBe(false)
    expect(sent.slice(before).map((frame) => frame.payload.code)).not.toContain('TERMINAL_PASTE_FAILED')
  })

  it('routes a binary paste kind to pasteRaw as one unit, never through writeRaw', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-paste', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string
    const paste = (text: string): TerminalBinaryClear => ({
      kind: TerminalBinaryKind.paste, streamId, seq: 0, compressed: false,
      bytes: new TextEncoder().encode(text),
    })

    // JSON is refused outright — a paste must ride the binary/AEAD channel, same reason terminal_input
    // does — so a stray legacy JSON paste never silently goes nowhere.
    await manager.handleFrame('web-1', 'terminal_paste', { streamId })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_BINARY_REQUIRED')
    expect(stream.pastes).toHaveLength(0)

    const longPaste = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    await manager.handleBinary('web-1', paste(longPaste))
    expect(stream.pastes).toEqual([longPaste])
    expect(stream.writes).toHaveLength(0)

    // Forwarded verbatim, same as input() — no filtering of its own.
    await manager.handleBinary('web-1', paste('a\x03b'))
    expect(stream.pastes.at(-1)).toBe('a\x03b')

    await manager.handleBinary('web-1', paste(''))
    expect(stream.pastes).toHaveLength(2)

    // A real paste of ordinary code (tens/hundreds of KB) must not bounce off a limit sized for one
    // keystroke chunk — this is the exact regression that froze a real terminal over a normal paste.
    const ordinaryLargePaste = 'x'.repeat(200 * 1024)
    await manager.handleBinary('web-1', paste(ordinaryLargePaste))
    expect(stream.pastes.at(-1)).toBe(ordinaryLargePaste)
    expect(stream.pastes).toHaveLength(3)
  })

  describe('chunked image/file upload', () => {
    const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    const fileContent = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34)

    async function openStream(requestId = 'open'): Promise<string> {
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId, protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
      })
      return sent.findLast((f) => f.type === 'terminal_ready')!.payload.streamId as string
    }

    function begin(streamId: string, fields: Record<string, unknown>): Promise<boolean> {
      return manager.handleFrame('web-1', 'terminal_chunked_upload_begin', { streamId, ...fields })
    }

    function chunk(streamId: string, kind: TerminalBinaryKind.imagePaste | TerminalBinaryKind.pasteFile, seq: number, bytes: Uint8Array): Promise<void> {
      return manager.handleBinary('web-1', { kind, streamId, seq, compressed: false, bytes })
    }

    function lastResult(): { connId: string; type: string; payload: Record<string, unknown> } {
      return sent.at(-1)!
    }

    it('advertises imagePaste and pasteFile in terminal_capabilities', async () => {
      await manager.handleFrame('web-1', 'terminal_capabilities', { requestId: 'r1' })
      const features = sent.at(-1)?.payload.features as Record<string, unknown>
      expect(features.imagePaste).toBe(true)
      expect(features.pasteFile).toBe(true)
      expect(features.mediaPreview).toBe(true)
    })

    it('rejects legacy JSON terminal_paste_image/terminal_paste_file the same way as terminal_paste', async () => {
      const streamId = await openStream()
      await manager.handleFrame('web-1', 'terminal_paste_image', { streamId })
      expect(lastResult().payload.code).toBe('TERMINAL_BINARY_REQUIRED')
      await manager.handleFrame('web-1', 'terminal_paste_file', { streamId })
      expect(lastResult().payload.code).toBe('TERMINAL_BINARY_REQUIRED')
    })

    describe('image worker completion boundary', () => {
      it('reports unknown clipboard input once without replaying it, then releases its reservation', async () => {
        const raw = vi.spyOn(stream, 'writeRaw').mockResolvedValue(terminalActionPossiblyExecuted('fixture input is uncertain'))
        const released = vi.spyOn(paste, 'releaseClipboard')
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(raw).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledOnce()
        expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload)
          .toMatchObject({ code: 'TERMINAL_PASTE_IMAGE_FAILED', message: 'fixture input is uncertain' })
        expect(sent.some((frame) => frame.type === 'terminal_paste_image_result')).toBe(false)
      })

      it.each(['before', 'after'] as const)('refuses image input when artifact authority changes %s clipboard preparation', async (when) => {
        let current = when !== 'before'
        const close = vi.fn()
        manager = newManager({ preparedPaste: (_generation, artifact) => ({ path: artifact.name, descriptor: 0, current: () => current, close }) })
        const clipboard = vi.spyOn(paste, 'clipboard').mockImplementation(async () => { current = false; return { state: 'written' } })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(clipboard).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
        expect(stream.writes).toEqual([]); expect(stream.pastes).toEqual([]); expect(close).toHaveBeenCalledOnce()
        expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload)
          .toMatchObject({ code: 'TERMINAL_PASTE_IMAGE_FAILED', message: 'PASTE_INVALID_ARTIFACT' })
      })

      it('closes final artifact evidence even if the clipboard release port fails', async () => {
        const close = vi.fn()
        manager = newManager({ preparedPaste: (_generation, artifact) => ({ path: artifact.name, descriptor: 0, current: () => true, close }) })
        vi.spyOn(paste, 'clipboard').mockResolvedValue({ state: 'written' })
        vi.spyOn(paste, 'releaseClipboard').mockImplementation(() => { throw new Error('release unavailable') })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(close).toHaveBeenCalledOnce(); expect(stream.writes).toEqual([Uint8Array.of(0x16)])
      })

      it('reports descriptor close failure without a successful image result', async () => {
        manager = newManager({ preparedPaste: (_generation, artifact) => ({ path: artifact.name, descriptor: 0, current: () => true,
          close: () => { throw new Error('close failed') } }) })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload)
          .toMatchObject({ code: 'TERMINAL_PASTE_IMAGE_FAILED', message: 'PASTE_FILE_CLOSE_FAILED' })
        expect(sent.some((frame) => frame.type === 'terminal_paste_image_result')).toBe(false)
      })

      it('refuses image begin visibly when the paste worker is unavailable', async () => {
        manager = newManager({ paste: () => null })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        expect(lastResult()).toMatchObject({ type: 'terminal_chunked_upload_begin_result',
          payload: { streamId, accepted: false, reason: 'PASTE_UNAVAILABLE' } })
        expect(writePasteImageFile).not.toHaveBeenCalled()
        expect(writeImageToOsClipboard).not.toHaveBeenCalled()
      })

      it('hands the original image chunk view to the existing paste worker', async () => {
        const received = vi.spyOn(paste, 'chunk').mockResolvedValue({ error: 'PASTE_UNAVAILABLE' })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(received).toHaveBeenCalledOnce()
        expect(received.mock.calls[0][1]).toBe(pngBytes)
        expect(stream.writes).toEqual([])
        expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload)
          .toMatchObject({ streamId, code: 'TERMINAL_PASTE_IMAGE_FAILED', message: 'PASTE_UNAVAILABLE' })
      })

      it('keeps B from replacing A clipboard while A terminal dispatch is unsettled', async () => {
        const handles = new Map<string, FakeStream>()
        const clipboardWrites: string[] = []
        let imageOrdinal = 0
        vi.mocked(writePasteImageFile).mockImplementation(async () => `image-${++imageOrdinal}.png`)
        vi.mocked(writeImageToOsClipboard).mockImplementation(async (path) => {
          clipboardWrites.push(path)
          return { state: 'written' }
        })
        terminals.openStream = async (row) => {
          const handle = new FakeStream()
          Object.assign(handle, { runtime: row.runtimes![0] })
          handles.set(row.agentId, handle)
          return { state: 'succeeded', value: handle }
        }
        const streams: string[] = []
        for (let index = 0; index < 2; index++) {
          const agentId = `image-agent-${index}`, connection = `image-client-${index}`
          agents.set(agentId, { ...session('codex', agentId), runtimes: [{ backend: 'tmux', paneId: `%${index + 20}` }],
            primaryRuntimeKey: `tmux:default:%${index + 20}` } as unknown as RegisteredSession)
          await manager.handleFrame(connection, 'terminal_open', {
            requestId: agentId, protocolVersion: 3, agentId, cols: 120, rows: 40,
          })
          const streamId = sent.findLast((frame) => frame.connId === connection && frame.type === 'terminal_ready')!.payload.streamId as string
          streams.push(streamId)
          await manager.handleFrame(connection, 'terminal_chunked_upload_begin', {
            streamId, uploadKind: 'image', totalBytes: pngBytes.length,
          })
        }
        const firstHandle = handles.get('image-agent-0')!
        let started!: () => void
        const dispatched = new Promise<void>((resolve) => { started = resolve })
        firstHandle.holdWrites = true
        const raw = firstHandle.writeRaw.bind(firstHandle)
        firstHandle.writeRaw = (bytes) => { const result = raw(bytes); started(); return result }
        const upload = (index: number) => manager.handleBinary(`image-client-${index}`, {
          kind: TerminalBinaryKind.imagePaste, streamId: streams[index], seq: 0, bytes: pngBytes, compressed: false,
        })
        const running = [upload(0)]
        try {
          await dispatched
          let admitted!: () => void
          const admission = new Promise<void>((resolve) => { admitted = resolve })
          const prepare = paste.clipboard.bind(paste)
          vi.spyOn(paste, 'clipboard').mockImplementation((request) => { admitted(); return prepare(request) })
          running.push(upload(1))
          await admission
          expect(clipboardWrites).toEqual(['image-1.png'])
          expect(handles.get('image-agent-1')!.writes).toEqual([])
        } finally {
          firstHandle.pendingWrites.splice(0).forEach((resolve) => resolve(TERMINAL_ACTION_SUCCEEDED))
          await Promise.all(running)
        }
        expect(clipboardWrites).toEqual(['image-1.png', 'image-2.png'])
        expect(handles.get('image-agent-1')!.writes).toEqual([Uint8Array.of(0x16)])
      })
    })

    it('accepts a begin, reports progress per chunk, and finishes an image via the clipboard', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
      expect(lastResult()).toMatchObject({ type: 'terminal_chunked_upload_begin_result', payload: { streamId, accepted: true } })

      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)

      const progress = sent.filter((f) => f.type === 'terminal_chunked_upload_progress')
      expect(progress).toHaveLength(1)
      expect(progress[0].payload).toMatchObject({ streamId, bytesWritten: pngBytes.length, totalBytes: pngBytes.length })

      expect(vi.mocked(writeImageToOsClipboard)).toHaveBeenCalledWith('/fake/paste-images/fake.png', pngBytes)
      expect(stream.writes).toHaveLength(1)
      expect(Buffer.from(stream.writes[0])).toEqual(Buffer.from([0x16])) // literal Ctrl+V
      const result = sent.findLast((f) => f.type === 'terminal_paste_image_result')!
      expect(result.payload).toMatchObject({ streamId, outcome: 'clipboard' })
    })

    // Real chunk boundaries, not arbitrary test-only slicing: every chunk but the last is exactly
    // UPLOAD_CHUNK_BYTES, matching how a real client actually splits an upload — the daemon's own
    // per-chunk validation rejects a seq beyond `ceil(totalBytes / UPLOAD_CHUNK_BYTES)`.
    const CHUNK = UPLOAD_CHUNK_BYTES

    it('assembles multiple chunks in order across several progress events', async () => {
      const streamId = await openStream()
      const big = new Uint8Array(CHUNK * 2 + 100).fill(0xab)
      await begin(streamId, { uploadKind: 'image', totalBytes: big.length })

      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, big.subarray(0, CHUNK))
      await chunk(streamId, TerminalBinaryKind.imagePaste, 1, big.subarray(CHUNK, CHUNK * 2))
      await chunk(streamId, TerminalBinaryKind.imagePaste, 2, big.subarray(CHUNK * 2, big.length))

      const progress = sent.filter((f) => f.type === 'terminal_chunked_upload_progress')
      expect(progress.map((f) => f.payload.bytesWritten)).toEqual([CHUNK, CHUNK * 2, big.length])
      expect(vi.mocked(writeImageToOsClipboard)).toHaveBeenCalledWith('/fake/paste-images/fake.png', big)
    })

    it('tolerates chunks arriving out of order', async () => {
      const streamId = await openStream()
      const big = new Uint8Array(CHUNK * 2 + 50).fill(0xcd)
      await begin(streamId, { uploadKind: 'image', totalBytes: big.length })

      await chunk(streamId, TerminalBinaryKind.imagePaste, 1, big.subarray(CHUNK, CHUNK * 2))
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, big.subarray(0, CHUNK))
      await chunk(streamId, TerminalBinaryKind.imagePaste, 2, big.subarray(CHUNK * 2, big.length))

      expect(vi.mocked(writeImageToOsClipboard)).toHaveBeenCalledWith('/fake/paste-images/fake.png', big)
    })

    it('ignores a re-sent chunk (same seq) rather than double-counting its bytes', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length * 2 })
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes) // duplicate

      const progress = sent.filter((f) => f.type === 'terminal_chunked_upload_progress')
      expect(progress.every((f) => f.payload.bytesWritten === pngBytes.length)).toBe(true)
      expect(vi.mocked(writeImageToOsClipboard)).not.toHaveBeenCalled() // still short of totalBytes
    })

    it('finishes a file upload by writing it under its original name and pasting the path — never the clipboard', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length })
      await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)

      expect(vi.mocked(writePasteDropFile)).toHaveBeenCalledWith('report.pdf', fileContent)
      expect(vi.mocked(writeImageToOsClipboard)).not.toHaveBeenCalled()
      expect(stream.writes).toHaveLength(0) // no Ctrl+V replay for a file
      expect(stream.pastes).toEqual(['/fake/paste-drops/id-report.pdf'])
      const result = sent.findLast((f) => f.type === 'terminal_paste_file_result')!
      expect(result.payload).toMatchObject({ streamId, path: '/fake/paste-drops/id-report.pdf' })
    })

    it('rejects a begin with no filename for a file upload', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'file', totalBytes: fileContent.length })
      expect(lastResult().payload).toMatchObject({ streamId, accepted: false })
    })

    it('rejects a begin over the per-kind size ceiling before any chunk is sent', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES + 1 })
      expect(lastResult().payload).toMatchObject({ streamId, accepted: false })
      expect(sent.some((f) => f.type === 'terminal_chunked_upload_progress')).toBe(false)
    })

    // Regression: previously a `begin` naming a streamId this connection has no live ActiveStream for
    // (e.g. after a reconnect/resync raced the client) was silently dropped — no reply at all — which
    // left the client's begin-accepted promise hanging until its own client-side timeout, indistinguishable
    // from a genuine hang. It must always answer, echoing the streamId the client named.
    it('replies accepted:false, echoing the streamId, when no live stream matches the begin', async () => {
      await manager.handleFrame('web-1', 'terminal_chunked_upload_begin', {
        streamId: 'stream-does-not-exist', uploadKind: 'image', totalBytes: pngBytes.length,
      })
      expect(lastResult()).toMatchObject({
        type: 'terminal_chunked_upload_begin_result',
        payload: { streamId: 'stream-does-not-exist', accepted: false, code: 'TERMINAL_STREAM_NOT_FOUND' },
      })
    })

    // Filenames belong to the paste component; the core records only the declared upload kind and size.
    it('logs an upload begin with its kind and size, never the file name', async () => {
      const lines: { event: string; fields: Record<string, unknown> }[] = []
      manager = newManager({ diagnostic: (event, fields) => lines.push({ event, fields }) })
      const streamId = await openStream()
      // A name with no dot, and one whose "extension" is the whole marker, must not leak through ext.
      for (const filename of ['SECRET-NAME-MARKER.PDF', 'SECRET-NAME-MARKER', 'x.SECRET-NAME-MARKER']) {
        await begin(streamId, { uploadKind: 'file', filename, totalBytes: fileContent.length })
        await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
      }

      const begins = lines.filter((l) => l.event === 'chunked_upload_begin')
      expect(begins).toHaveLength(3)
      expect(begins[0].fields).toMatchObject({ uploadKind: 'file', totalBytes: fileContent.length })
      expect(JSON.stringify(lines)).not.toMatch(/SECRET-NAME-MARKER/i)
    })

    // Even a short extension can be personal content; it stays out of the core's diagnostic.
    it('keeps both long and short extensions out of diagnostics', async () => {
      const lines: { event: string; fields: Record<string, unknown> }[] = []
      manager = newManager({ diagnostic: (event, fields) => lines.push({ event, fields }) })
      const streamId = await openStream()
      for (const filename of ['a.diaryentry', 'x.docx', 'b.tar.gz']) {
        await begin(streamId, { uploadKind: 'file', filename, totalBytes: fileContent.length })
        await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
      }

      const begins = lines.filter((l) => l.event === 'chunked_upload_begin')
      expect(begins).toHaveLength(3)
      for (const { fields } of begins) expect(fields).not.toHaveProperty('ext')
      expect(JSON.stringify(lines)).not.toMatch(/diaryentry/i)
    })

    it('rejects a second begin while one upload is already in progress on the same pane', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
      expect(lastResult().payload).toMatchObject({ streamId, accepted: false })
    })

    it('falls back to pasting the file path as text when no native clipboard is reachable', async () => {
      vi.mocked(writeImageToOsClipboard).mockResolvedValue(
        { state: 'unavailable', reason: 'no X11 or Wayland display on this machine' } satisfies OsClipboardImageResult,
      )
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)

      expect(stream.writes).toHaveLength(0) // no Ctrl+V — nothing was put on a clipboard
      expect(stream.pastes).toEqual(['/fake/paste-images/fake.png'])
      const result = sent.findLast((f) => f.type === 'terminal_paste_image_result')!
      expect(result.payload).toMatchObject({
        streamId, outcome: 'fallback_path', reason: 'no X11 or Wayland display on this machine',
      })
    })

    // A clipboard tool that's ON PATH but can't actually reach a display (a stale $DISPLAY with no
    // X server behind it — exactly what a headless Docker rig hits) lands in 'failed', not
    // 'unavailable', even though the outcome is identical: no OS clipboard to write to. This used to
    // freeze the whole session; it must degrade to the same file-path fallback 'unavailable' gets.
    it('falls back to pasting the file path when the clipboard tool is present but unreachable', async () => {
      vi.mocked(writeImageToOsClipboard).mockResolvedValue(
        { state: 'failed', reason: 'xclip exited with code 1' } satisfies OsClipboardImageResult,
      )
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)

      expect(stream.writes).toHaveLength(0) // no Ctrl+V — nothing was put on a clipboard
      expect(stream.pastes).toEqual(['/fake/paste-images/fake.png'])
      expect(sent.some((f) => f.type === 'terminal_error')).toBe(false)
      const result = sent.findLast((f) => f.type === 'terminal_paste_image_result')!
      expect(result.payload).toMatchObject({
        streamId, outcome: 'fallback_path', reason: 'xclip exited with code 1',
      })
    })

    it('reports a genuine file write failure as an error', async () => {
      vi.mocked(writePasteDropFile).mockRejectedValue(new Error('disk full'))
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length })
      await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)

      expect(stream.pastes).toHaveLength(0)
      expect(sent.findLast((f) => f.type === 'terminal_error')?.payload).toMatchObject({
        code: 'TERMINAL_PASTE_FILE_FAILED', streamId, message: 'PASTE_STORAGE_FAILED',
      })
    })

    it('ignores a chunk with no matching begin', async () => {
      const streamId = await openStream()
      await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
      expect(vi.mocked(writeImageToOsClipboard)).not.toHaveBeenCalled()
      expect(sent.some((f) => f.type === 'terminal_chunked_upload_progress')).toBe(false)
    })

    it('cancel discards the in-flight upload without writing or pasting anything', async () => {
      const streamId = await openStream()
      await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length * 2 })
      await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
      await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
      // A late-arriving second chunk after cancel must not resurrect the upload.
      await chunk(streamId, TerminalBinaryKind.pasteFile, 1, fileContent)

      expect(vi.mocked(writePasteDropFile)).not.toHaveBeenCalled()
      expect(stream.pastes).toHaveLength(0)

      // And a fresh begin afterwards works normally — cancel actually cleared the slot.
      await begin(streamId, { uploadKind: 'file', filename: 'retry.pdf', totalBytes: fileContent.length })
      expect(lastResult().payload).toMatchObject({ streamId, accepted: true })
    })

    describe('paste preparation boundary', () => {
      it('reports descriptor-close failure once, without first reporting a successful file paste', async () => {
        await manager.stop()
        manager = newManager({ preparedPaste: () => ({ path: '/fake/prepared-file', descriptor: 0, current: () => true,
          close: () => { throw new Error('fixture close failure') } }) })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'file', filename: 'file.txt', totalBytes: 1 })
        await chunk(streamId, TerminalBinaryKind.pasteFile, 0, Uint8Array.of(1))
        expect(sent.filter((item) => item.type === 'terminal_paste_file_result')).toEqual([])
        expect(sent.filter((item) => item.type === 'terminal_error')).toMatchObject([
          { payload: { code: 'TERMINAL_PASTE_FILE_FAILED', message: 'PASTE_FILE_CLOSE_FAILED' } },
        ])
      })

      function deferred<T>() {
        let resolve!: (value: T) => void
        const promise = new Promise<T>((done) => { resolve = done })
        return { promise, resolve }
      }

      it('keeps the existing busy refusal through final preparation and consumes duplicate completion once', async () => {
        const preparing = deferred<void>(), prepared = deferred<string>()
        writePasteDropFile.mockImplementationOnce(() => { preparing.resolve(); return prepared.promise })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length })
        const delivery = chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        await preparing.promise
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        expect(lastResult().payload).toMatchObject({ accepted: false, reason: 'an upload is already in progress on this pane' })
        await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        expect(writePasteDropFile).toHaveBeenCalledOnce()
        prepared.resolve('/fake/paste-drops/report.pdf')
        await delivery
        expect(stream.pastes).toEqual(['/fake/paste-drops/report.pdf'])
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        expect(lastResult().payload).toMatchObject({ accepted: true })
      })

      it('fences a cancelled file at the final input guard and preserves a new image generation', async () => {
        const reached = deferred<void>(), release = deferred<void>()
        const delivered: string[] = []
        stream.pasteLands = async (allowed) => {
          reached.resolve(); await release.promise
          if (!allowed?.()) return terminalActionNotStarted('cancelled')
          delivered.push('old file'); return TERMINAL_ACTION_SUCCEEDED
        }
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length })
        const old = chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        await reached.promise
        await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        release.resolve(); await old
        expect(delivered).toEqual([])
        await chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        expect(stream.writes).toEqual([Uint8Array.of(0x16)])
      })

      it('clears a failed preparation so either kind can begin again', async () => {
        const streamId = await openStream()
        writePasteDropFile.mockRejectedValueOnce(new Error('fixture failure'))
        await begin(streamId, { uploadKind: 'file', filename: 'report.pdf', totalBytes: fileContent.length })
        await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        expect(lastResult().payload).toMatchObject({ code: 'TERMINAL_PASTE_FILE_FAILED' })
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        expect(lastResult().payload).toMatchObject({ accepted: true })
      })

      it('does not deliver an old file preparation after Cancel and a new begin on the same stream', async () => {
        let finishPreparation!: (path: string) => void
        let preparationStarted!: () => void
        const started = new Promise<void>((resolve) => { preparationStarted = resolve })
        vi.mocked(writePasteDropFile).mockImplementationOnce(() => {
          preparationStarted()
          return new Promise<string>((resolve) => { finishPreparation = resolve })
        })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'file', filename: 'old.pdf', totalBytes: fileContent.length })
        const oldUpload = chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        await started
        await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
        await begin(streamId, { uploadKind: 'file', filename: 'new.pdf', totalBytes: fileContent.length })
        expect(lastResult().payload).toMatchObject({ streamId, accepted: true })

        const beforeOldResult = sent.length
        finishPreparation('/fake/paste-drops/old.pdf')
        await oldUpload
        expect(stream.pastes).toEqual([])
        expect(sent.slice(beforeOldResult).filter((frame) => frame.type === 'terminal_paste_file_result')).toEqual([])

        await chunk(streamId, TerminalBinaryKind.pasteFile, 0, fileContent)
        expect(stream.pastes).toEqual(['/fake/paste-drops/id-new.pdf'])
      })

      it('does not send Ctrl+V for a cancelled generation when its clipboard helper answers late', async () => {
        let finishClipboard!: (result: OsClipboardImageResult) => void
        let clipboardStarted!: () => void
        const started = new Promise<void>((resolve) => { clipboardStarted = resolve })
        vi.mocked(writeImageToOsClipboard).mockImplementationOnce(() => {
          clipboardStarted()
          return new Promise<OsClipboardImageResult>((resolve) => { finishClipboard = resolve })
        })
        const streamId = await openStream()
        await begin(streamId, { uploadKind: 'image', totalBytes: pngBytes.length })
        const oldUpload = chunk(streamId, TerminalBinaryKind.imagePaste, 0, pngBytes)
        await started
        await manager.handleFrame('web-1', 'terminal_chunked_upload_cancel', { streamId })
        await begin(streamId, { uploadKind: 'file', filename: 'new.pdf', totalBytes: fileContent.length })
        const beforeOldResult = sent.length
        finishClipboard({ state: 'written' })
        await oldUpload

        expect(stream.writes).toEqual([])
        expect(stream.pastes).toEqual([])
        expect(sent.slice(beforeOldResult).filter((frame) => frame.type === 'terminal_paste_image_result')).toEqual([])
      })

      it('accepts the four-chunk client window from ten simultaneous uploads', async () => {
        const uploads: Array<{ connection: string; streamId: string }> = []
        const handles: FakeStream[] = []
        terminals.openStream = async (row) => {
          const handle = new FakeStream()
          Object.assign(handle, { runtime: row.runtimes![0] })
          handles.push(handle)
          return { state: 'succeeded', value: handle }
        }
        for (let index = 0; index < 10; index++) {
          const agentId = `window-agent-${index}`
          const connection = `window-client-${index}`
          agents.set(agentId, { ...session('codex', agentId),
            runtimes: [{ backend: 'tmux', paneId: `%${index + 10}` }],
            primaryRuntimeKey: `tmux:default:%${index + 10}`,
          } as unknown as RegisteredSession)
          await manager.handleFrame(connection, 'terminal_open', {
            requestId: `window-${index}`, protocolVersion: 3, agentId, cols: 120, rows: 40,
          })
          const streamId = sent.findLast((frame) => frame.connId === connection && frame.type === 'terminal_ready')!.payload.streamId as string
          await manager.handleFrame(connection, 'terminal_chunked_upload_begin', {
            streamId, uploadKind: 'file', filename: 'window.bin', totalBytes: CHUNK * 5,
          })
          expect(lastResult().payload).toMatchObject({ streamId, accepted: true })
          uploads.push({ connection, streamId })
        }

        const body = new Uint8Array(CHUNK).fill(0xab)
        // The client sends all four before waiting for progress. Keep that behavior in this caller test.
        const window = uploads.flatMap(({ connection, streamId }) => Array.from({ length: 4 }, (_, seq) =>
          manager.handleBinary(connection, { kind: TerminalBinaryKind.pasteFile, streamId, seq, compressed: false, bytes: body })))
        await Promise.all(window)
        expect(sent.filter((frame) => frame.type === 'terminal_error')).toEqual([])
        for (const { streamId } of uploads) {
          const progress = sent.filter((frame) => frame.type === 'terminal_chunked_upload_progress' && frame.payload.streamId === streamId)
          expect(progress.map((frame) => frame.payload.bytesWritten)).toEqual([CHUNK, CHUNK * 2, CHUNK * 3, CHUNK * 4])
        }
        expect(writePasteDropFile).not.toHaveBeenCalled()
        expect(handles.flatMap((handle) => handle.pastes)).toEqual([])
      })
    })
  })

  it('does not replay pre-snapshot repaint bytes after the authoritative keyframe', async () => {
    outputBeforeOpen = Buffer.from('\u001b[2Jstale repaint')
    stream.snapshotBytes = Buffer.from('\u001bcnew prompt text')

    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-snapshot', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    expect(binarySent[0].frame.seq).toBe(0)
  })

  it('takes one ordered snapshot and releases its output gate after the keyframe', async () => {
    stream.snapshotBytes = Buffer.from('\u001bcnew prompt text')

    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-racing-snapshot', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(stream.snapshots).toBe(1)
    expect(stream.snapshotBegins).toBe(1)
    expect(stream.snapshotEnds).toBe(1)
    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    expect(binarySent[0].frame.seq).toBe(0)
  })

  it('takes over the first controller and expires the replacement lease after heartbeat timeout', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const firstStream = stream
    const firstStreamId = sent.findLast((frame) => frame.type === 'terminal_ready')?.payload.streamId as string
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(firstStream.closed).toBe(true)
    expect(sent.some((frame) => frame.connId === 'web-1'
      && frame.type === 'terminal_closed'
      && frame.payload.code === 'TERMINAL_TAKEN_OVER')).toBe(true)
    expect(sent.findLast((frame) => frame.type === 'terminal_ready')?.connId).toBe('web-2')
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input,
      streamId: firstStreamId,
      seq: 0,
      compressed: false,
      bytes: Buffer.from('stale input'),
    })
    expect(stream.writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(stream.closed).toBe(true)
    expect(sent.some((frame) => frame.connId === 'web-2'
      && frame.type === 'terminal_closed'
      && frame.payload.reason === 'heartbeat timeout')).toBe(true)
  })

  // A host that lost its backend link closes its remote streams without telling anyone; the client
  // only found out after 15 s of silence and three ignored resyncs, then gave up (2026-10-16). A
  // client that asks is now told at its next heartbeat.
  describe('a heartbeat or resync for a stream this connection does not hold', () => {
    const errors = () => sent.filter((frame) => frame.type === 'terminal_error')

    it('is answered with TERMINAL_STREAM_NOT_FOUND when the client asks', async () => {
      await manager.handleFrame('web-1', 'terminal_alive', { streamId: 'gone-1', reportMissing: true })
      await manager.handleFrame('web-1', 'terminal_resync', { streamId: 'gone-2', attempt: 1, reportMissing: true })
      expect(errors().map((frame) => [frame.connId, frame.payload.code, frame.payload.streamId])).toEqual([
        ['web-1', 'TERMINAL_STREAM_NOT_FOUND', 'gone-1'],
        ['web-1', 'TERMINAL_STREAM_NOT_FOUND', 'gone-2'],
      ])
    })

    it('stays silent for a client that does not ask, as every older client', async () => {
      await manager.handleFrame('web-1', 'terminal_alive', { streamId: 'gone-1' })
      await manager.handleFrame('web-1', 'terminal_resync', { streamId: 'gone-1', attempt: 1 })
      expect(errors()).toEqual([])
    })

    it('counts a stream held by another connection as missing for this one, and leaves it alone', async () => {
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      })
      const streamId = sent.findLast((frame) => frame.type === 'terminal_ready')?.payload.streamId as string
      await manager.handleFrame('web-2', 'terminal_alive', { streamId, reportMissing: true })
      expect(errors().at(-1)).toMatchObject({
        connId: 'web-2',
        payload: { code: 'TERMINAL_STREAM_NOT_FOUND', streamId },
      })
      expect(stream.closed).toBe(false)
    })
  })

  // Node's clock keeps running while a Mac sleeps, so a lid closed for forty minutes reached the next
  // sweep as forty minutes without `terminal_alive` and closed every stream at the wake — measured
  // 2026-09-28 as `[terminal-stream] closed` on every local terminal the moment the lid opened.
  it('carries a lease over the time the computer slept, and still expires it on awake silence', async () => {
    let asleepMs = 0
    await manager.stop()
    manager = newManager({ now: () => Date.now() + asleepMs })
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(20_000)
    asleepMs += 2_280_000 // the lid closes; no timer runs until it opens again
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stream.closed).toBe(false)
    expect(sent.some((frame) => frame.type === 'terminal_closed')).toBe(false)

    // Awake and still silent: the lease runs out on awake time, as before.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(stream.closed).toBe(true)
    expect(sent.some((frame) => frame.type === 'terminal_closed'
      && frame.payload.reason === 'heartbeat timeout')).toBe(true)
  })

  // A sweep read as a sleep carries each lease by `slept`, which `sleptFor` defines as the gap MINUS
  // one period — so every sweep still charges one EXPIRY_SWEEP_MS of silence however late it ran, and
  // a throttled machine cannot hold a dead client's lease open. Guards against "carry the whole gap",
  // which would never expire.
  it('still expires a lease when every sweep is late enough to read as a sleep', async () => {
    let asleepMs = 0
    await manager.stop()
    manager = newManager({ now: () => Date.now() + asleepMs })
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    // Twelve sweeps, each landing 15s late (gap 20s > 2 x 5s, so every one is read as a sleep) and no
    // `terminal_alive` in any of them. Six periods of charged silence is the 30s timeout.
    for (let i = 0; i < 12; i++) {
      asleepMs += 15_000
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(stream.closed).toBe(true)
    expect(sent.some((frame) => frame.type === 'terminal_closed'
      && frame.payload.reason === 'heartbeat timeout')).toBe(true)
  })

  // The incumbent's banner says WHO took over, so the close it gets carries what the winner
  // declared on open — verbatim through a relay, since the daemon never learns a peer's name.
  it('names the taker on the close when the winner introduced itself', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      client: { kind: 'desktop', name: '  Mac mini ', machineId: 'ab12ab12ab12ab12' },
    })
    const closed = sent.find((frame) => frame.connId === 'web-1' && frame.type === 'terminal_closed')
    expect(closed?.payload).toMatchObject({
      code: 'TERMINAL_TAKEN_OVER',
      takenBy: { kind: 'desktop', name: 'Mac mini', machineId: 'ab12ab12ab12ab12' },
    })
  })

  // The phone opens politely (`takeover: false`) and watches a terminal the desktop is driving. Its
  // banner says WHO has it — the desktop names a taker the same way — so the ready carries the
  // holder's own introduction, and nothing when the holder never gave one.
  it('names the holder on a watcher\'s ready', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      client: { kind: 'desktop', name: 'MacBookPro2021.local', machineId: 'ab12ab12ab12ab12' },
    })
    await manager.handleFrame('phone-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30, takeover: false,
      client: { kind: 'phone', name: 'iPhone' },
    })
    const ready = sent.find((frame) => frame.connId === 'phone-1' && frame.type === 'terminal_ready')
    expect(ready?.payload).toMatchObject({
      readOnly: true,
      heldBy: { kind: 'desktop', name: 'MacBookPro2021.local', machineId: 'ab12ab12ab12ab12' },
    })
    // The holder keeps the terminal, and a controller's own ready never names anybody.
    expect(sent.some((frame) => frame.connId === 'web-1' && frame.type === 'terminal_closed')).toBe(false)
    expect(sent.find((frame) => frame.connId === 'web-1' && frame.type === 'terminal_ready')?.payload)
      .not.toHaveProperty('heldBy')
  })

  it('says nothing about a holder that never introduced itself', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('phone-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30, takeover: false,
    })
    const ready = sent.find((frame) => frame.connId === 'phone-1' && frame.type === 'terminal_ready')
    expect(ready?.payload.readOnly).toBe(true)
    expect(ready?.payload).not.toHaveProperty('heldBy')
  })

  // A phone set a Harness OS computer up and opened its OpenCode, taking it at the phone's size; the
  // computer's screen watched. When the phone left, nothing told the screen, and OpenCode stayed
  // phone-sized in a corner of the screen until someone typed there (2026-10-18).
  it('tells the watchers when the controller leaves, not when it hands over', async () => {
    await manager.handleFrame('screen-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 211, rows: 57,
    })
    await manager.handleFrame('phone-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 45, rows: 30,
    })
    await manager.handleFrame('screen-1', 'terminal_open', {
      requestId: 'open-3', protocolVersion: 3, agentId: 'agent-1', cols: 211, rows: 57, takeover: false,
    })
    const ready = (connId: string) => sent.findLast((frame) => frame.connId === connId && frame.type === 'terminal_ready')
    const watching = ready('screen-1')?.payload.streamId
    expect(ready('screen-1')?.payload.readOnly).toBe(true)
    const free = () => sent.filter((frame) => frame.type === 'terminal_free')
    expect(free()).toHaveLength(0)

    await manager.handleFrame('phone-1', 'terminal_close', { streamId: ready('phone-1')?.payload.streamId })
    expect(free().map((frame) => [frame.connId, frame.payload.streamId])).toEqual([['screen-1', watching]])

    // Taken by another view instead: that one has it, and nobody is told it is free.
    sent.length = 0
    await manager.handleFrame('phone-1', 'terminal_open', {
      requestId: 'open-4', protocolVersion: 3, agentId: 'agent-1', cols: 45, rows: 30,
    })
    await manager.handleFrame('tablet-1', 'terminal_open', {
      requestId: 'open-5', protocolVersion: 3, agentId: 'agent-1', cols: 90, rows: 40,
    })
    expect(free()).toHaveLength(0)
  })

  // hn with no terminal (its server, kept for the sessions a closed window left) reads every pane of the desk. On
  // 2026-10-14 it reopened first after each daemon restart, took the terminals at its 80x24 layout and left the
  // window the person was using watching a shrunken agent until they typed. It opens with `watch: true` now.
  describe('a watch-only open', () => {
    let readOnlyOpens: boolean[]
    beforeEach(() => {
      readOnlyOpens = []
      terminals = {
        openStream: async (_session: RegisteredSession, _size: unknown, nextSink: TerminalStreamSink, readOnly?: boolean) => {
          sink = nextSink
          readOnlyOpens.push(readOnly === true)
          return { state: 'succeeded' as const, value: stream }
        },
      } as unknown as TerminalBackendCoordinator
      manager = newManager()
    })

    const ready = (connId: string) => sent.findLast((frame) => frame.connId === connId && frame.type === 'terminal_ready')!

    it('watches a terminal nobody holds: tmux attaches read-only, so the agent keeps its size, and nothing is typed', async () => {
      await manager.handleFrame('hn-headless', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 37, rows: 22, takeover: false, watch: true,
        client: { kind: 'tui', name: 'Mac Auto terminal' },
      })
      expect(ready('hn-headless').payload.readOnly).toBe(true)
      expect(ready('hn-headless').payload).not.toHaveProperty('heldBy')
      expect(readOnlyOpens).toEqual([true])
      const streamId = ready('hn-headless').payload.streamId as string
      await manager.handleFrame('hn-headless', 'terminal_resize', { streamId, resizeSeq: 1, cols: 30, rows: 10 })
      expect(sent.at(-1)?.payload.code).toBe('VIEW_ONLY')
      expect(stream.sizes).toEqual([])
    })

    it('is not anyone holding it: a window that reconnects politely beside it takes the terminal, and is told of no holder', async () => {
      // After a daemon restart, each in turn: hn with no terminal is back first, then a window with a person in it
      // (hn's, the desktop's, the phone's) reconnects the way it always does after its first open, without the key.
      for (const [connId, kind] of [['hn-window', 'tui'], ['desktop-1', 'desktop'], ['phone-1', 'phone']] as const) {
        await manager.closeConnection('hn-headless')
        await manager.handleFrame('hn-headless', 'terminal_open', {
          requestId: 'open-headless', protocolVersion: 3, agentId: 'agent-1', cols: 37, rows: 22, takeover: false, watch: true,
          client: { kind: 'tui', name: 'Mac Auto terminal' },
        })
        expect(ready('hn-headless').payload.readOnly).toBe(true)
        sent.length = 0
        readOnlyOpens.length = 0
        await manager.handleFrame(connId, 'terminal_open', {
          requestId: `open-${connId}`, protocolVersion: 3, agentId: 'agent-1', cols: 99, rows: 55, takeover: false,
          client: { kind, name: connId },
        })
        expect(ready(connId).payload.readOnly).toBe(false)
        expect(ready(connId).payload).not.toHaveProperty('heldBy')
        // tmux attaches it as the controller, at its own size.
        expect(readOnlyOpens).toEqual([false])
        // The watcher goes as any does when a terminal changes hands, and opens again on the new size.
        expect(sent.find((frame) => frame.connId === 'hn-headless' && frame.type === 'terminal_closed')?.payload)
          .toMatchObject({ code: 'TERMINAL_TAKEN_OVER', takenBy: { kind, name: connId } })
        await manager.closeConnection(connId)
      }
    })

    it('leaves the window beside it typing and resizing', async () => {
      await manager.handleFrame('hn-headless', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 37, rows: 22, takeover: false, watch: true,
      })
      await manager.handleFrame('desktop-1', 'terminal_open', {
        requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, takeover: false,
      })
      const streamId = ready('desktop-1').payload.streamId as string
      await manager.handleFrame('desktop-1', 'terminal_resize', { streamId, resizeSeq: 1, cols: 100, rows: 30 })
      expect(stream.sizes).toEqual([{ cols: 100, rows: 30 }])
      await manager.handleBinary('desktop-1', { kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('ok') })
      expect(Buffer.from(stream.writes[0]).toString()).toBe('ok')
    })

    it('leaves a client already driving the terminal alone, and a polite open beside both still watches that client', async () => {
      await manager.handleFrame('desktop-1', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
        client: { kind: 'desktop', name: 'MacBookPro2021.local' },
      })
      await manager.handleFrame('hn-headless', 'terminal_open', {
        requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 37, rows: 22, takeover: false, watch: true,
        client: { kind: 'tui', name: 'Mac Auto terminal' },
      })
      expect(sent.some((frame) => frame.connId === 'desktop-1' && frame.type === 'terminal_closed')).toBe(false)
      expect(ready('hn-headless').payload).toMatchObject({ readOnly: true, heldBy: { kind: 'desktop', name: 'MacBookPro2021.local' } })
      // The phone's pager guess, beside the desktop and the watch-only stream: the desktop's, named as it.
      await manager.handleFrame('phone-1', 'terminal_open', {
        requestId: 'open-3', protocolVersion: 3, agentId: 'agent-1', cols: 40, rows: 20, takeover: false,
        client: { kind: 'phone', name: 'iPhone 15' },
      })
      expect(ready('phone-1').payload).toMatchObject({ readOnly: true, heldBy: { kind: 'desktop', name: 'MacBookPro2021.local' } })
      expect(readOnlyOpens).toEqual([false, true, true])
    })

    it('is closed by a takeover like any watcher, so it opens again on the size the new holder gave the pane', async () => {
      await manager.handleFrame('hn-headless', 'terminal_open', {
        requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 37, rows: 22, takeover: false, watch: true,
      })
      await manager.handleFrame('phone-1', 'terminal_open', {
        requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 40, rows: 20,
        client: { kind: 'phone', name: 'iPhone 15' },
      })
      expect(sent.find((frame) => frame.connId === 'hn-headless' && frame.type === 'terminal_closed')?.payload)
        .toMatchObject({ code: 'TERMINAL_TAKEN_OVER', takenBy: { kind: 'phone', name: 'iPhone 15' } })
      expect(ready('phone-1').payload.readOnly).toBe(false)
    })

    it('is advertised, so a client can tell a daemon that would ignore the key', async () => {
      await manager.handleFrame('web-1', 'terminal_capabilities', { requestId: 'r1' })
      expect((sent.at(-1)?.payload.features as Record<string, unknown>).watchOnly).toBe(true)
    })
  })

  it('falls back to what the daemon can say about a silent winner, and says nothing over a bad claim', async () => {
    manager = newManager({
      describeClient: (connId) => connId === 'local-2' ? { kind: 'desktop', name: 'This Mac' } : null,
    })
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('local-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.find((frame) => frame.connId === 'web-1' && frame.type === 'terminal_closed')?.payload.takenBy)
      .toEqual({ kind: 'desktop', name: 'This Mac' })
    // A claim the daemon will not repeat: a kind with spaces, or a name that is not a name.
    await manager.handleFrame('web-3', 'terminal_open', {
      requestId: 'open-3', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      client: { kind: 'not a kind', name: 'x'.repeat(500) },
    })
    const closed = sent.find((frame) => frame.connId === 'local-2' && frame.type === 'terminal_closed')
    expect(closed?.payload.code).toBe('TERMINAL_TAKEN_OVER')
    expect(closed?.payload).not.toHaveProperty('takenBy')
    expect(sent.findLast((frame) => frame.type === 'terminal_ready')?.connId).toBe('web-3')
  })

  it('reads a client descriptor strictly', () => {
    expect(clientDescriptorFrom({ kind: 'phone', name: 'Hieu\u2019s iPhone' })).toEqual({ kind: 'phone', name: 'Hieu\u2019s iPhone' })
    expect(clientDescriptorFrom({ kind: 'desktop', name: 'a\u0000b', machineId: 'ab12ab12ab12ab12' }))
      .toEqual({ kind: 'desktop', name: 'a b', machineId: 'ab12ab12ab12ab12' })
    expect(clientDescriptorFrom({ kind: 'desktop', name: 'Mac', machineId: '../etc' })).toBeUndefined()
    expect(clientDescriptorFrom({ kind: 'Desktop', name: 'Mac' })).toBeUndefined()
    expect(clientDescriptorFrom({ kind: 'desktop', name: '   ' })).toBeUndefined()
    expect(clientDescriptorFrom('Mac')).toBeUndefined()
    expect(clientDescriptorFrom(undefined)).toBeUndefined()
  })

  it('takes over a second agent alias that resolves to the same tmux pane', async () => {
    agents.set('agent-alias', session('claude', 'agent-alias'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-alias', cols: 100, rows: 30,
    })
    expect(sent.some((frame) => frame.connId === 'web-1'
      && frame.type === 'terminal_closed'
      && frame.payload.code === 'TERMINAL_TAKEN_OVER')).toBe(true)
    expect(sent.findLast((frame) => frame.type === 'terminal_ready')?.connId).toBe('web-2')
  })

  it('keeps a client\'s other terminals alive when it opens another one', async () => {
    // The desktop app's pane grid: one connection, several agents, each its own tmux window.
    agents.set('agent-2', {
      ...session('claude', 'agent-2'),
      runtimes: [{ backend: 'tmux', paneId: '%2' }],
      primaryRuntimeKey: 'tmux:default:%2',
    } as unknown as RegisteredSession)

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const first = sent.find((frame) => frame.type === 'terminal_ready')?.payload.streamId as string

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-2', cols: 100, rows: 30,
    })

    expect(sent.some((frame) => frame.type === 'terminal_closed')).toBe(false)
    // The other pane still accepts operations on its original stream.
    const before = stream.sizes.length
    await manager.handleFrame('app-1', 'terminal_resize', {
      streamId: first, resizeSeq: 1, cols: 90, rows: 25,
    })
    expect(stream.sizes.length).toBe(before + 1)
  })

  it('notifies legacy views when a shared connection reopens the same terminal', async () => {
    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const first = sent.find((frame) => frame.type === 'terminal_ready')?.payload.streamId as string

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      client: { kind: 'desktop', name: 'Other window' },
    })

    expect(sent.filter((frame) => frame.type === 'terminal_closed')).toEqual([{
      connId: 'app-1',
      type: 'terminal_closed',
      payload: {
        protocolVersion: 3,
        streamId: first,
        reason: 'terminal reopened in another view',
        code: 'TERMINAL_TAKEN_OVER',
      },
    }])
    expect(sent.at(-1)).toMatchObject({ type: 'terminal_ready', payload: { requestId: 'open-2' } })
    const replacement = sent.at(-1)!.payload.streamId as string
    expect(replacement).not.toBe(first)
    await manager.handleBinary('app-1', {
      kind: TerminalBinaryKind.input, streamId: replacement, seq: 0, compressed: false, bytes: Buffer.from('new input'),
    })
    expect(Buffer.from(stream.writes.at(-1)!).toString()).toBe('new input')

    // Two tmux clients on one window is the thing this must never allow.
    const before = stream.sizes.length
    await manager.handleFrame('app-1', 'terminal_resize', {
      streamId: first, resizeSeq: 1, cols: 90, rows: 25,
    })
    expect(stream.sizes.length).toBe(before)
  })

  it.each(['agent-1', 'agent-alias'])('keeps relay views independent when watching and taking over %s', async (secondAgent) => {
    agents.set('agent-alias', session('codex', 'agent-alias'))
    const handles: FakeStream[] = []
    terminals.openStream = vi.fn(async () => {
      const handle = new FakeStream()
      handles.push(handle)
      return { state: 'succeeded' as const, value: handle }
    })
    const open = async (viewId: string, takeover: boolean, agentId = 'agent-1') => {
      await manager.handleFrame('shared-relay', 'terminal_open', {
        requestId: `${viewId}-${handles.length}`, protocolVersion: 3, agentId,
        cols: 100, rows: 30, viewId, takeover, client: { kind: 'desktop', name: viewId },
      })
      return sent.findLast((frame) => frame.type === 'terminal_ready')!.payload
    }
    const type = (streamId: unknown, text: string, seq = 0) => manager.handleBinary('shared-relay', {
      kind: TerminalBinaryKind.input, streamId: streamId as string, seq,
      compressed: false, bytes: Buffer.from(text),
    })

    const controller = await open('view-a', true)
    const watcher = await open('view-b', false, secondAgent)
    expect(watcher).toMatchObject({ readOnly: true, heldBy: { name: 'view-a' } })
    expect(handles[0].closed).toBe(false)
    expect(sent.filter((frame) => frame.type === 'terminal_closed')).toEqual([])
    await type(controller.streamId, 'still typing')
    await type(watcher.streamId, 'ignored')
    expect(Buffer.from(handles[0].writes[0]).toString()).toBe('still typing')
    expect(handles[1].writes).toEqual([])

    // Reopening the watcher only replaces that view's own stream.
    const watchingAgain = await open('view-b', false, secondAgent)
    expect(watchingAgain.readOnly).toBe(true)
    expect(handles[0].closed).toBe(false)
    expect(handles[1].closed).toBe(true)
    expect(sent.filter((frame) => frame.type === 'terminal_closed').map((frame) => frame.payload.streamId))
      .toEqual([watcher.streamId])

    const nextController = await open('view-b', true, secondAgent)
    expect(nextController.readOnly).toBe(false)
    expect(sent.find((frame) => frame.type === 'terminal_closed' && frame.payload.streamId === controller.streamId)?.payload)
      .toMatchObject({ code: 'TERMINAL_TAKEN_OVER', takenBy: { name: 'view-b' } })
    expect(handles[0].closed).toBe(true)

    // A displaced client (including the TUI's automatic watch) must never take control back.
    const displacedWatcher = await open('view-a', false)
    expect(displacedWatcher).toMatchObject({ readOnly: true, heldBy: { name: 'view-b' } })
    expect(handles[3].closed).toBe(false)
    await type(nextController.streamId, 'new owner')
    await type(displacedWatcher.streamId, 'ignored')
    expect(Buffer.from(handles[3].writes[0]).toString()).toBe('new owner')
    expect(handles[4].writes).toEqual([])
    await manager.handleFrame('shared-relay', 'terminal_close', { streamId: displacedWatcher.streamId })
    expect((await open('view-c', false)).heldBy).toEqual({ kind: 'desktop', name: 'view-b' })
    expect(handles[3].closed).toBe(false)
  })

  it('scopes identical view IDs to their authenticated connection', async () => {
    for (const connId of ['first', 'second']) {
      await manager.handleFrame(connId, 'terminal_open', {
        requestId: connId, protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
        viewId: 'same-view-id', takeover: false,
      })
    }
    expect(sent.filter((frame) => frame.type === 'terminal_ready').map((frame) => frame.payload.readOnly))
      .toEqual([false, true])
    expect(sent.filter((frame) => frame.type === 'terminal_closed')).toEqual([])
  })

  it('uses frequent ACKs rather than the five-second heartbeat for output backpressure', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 40; i++) {
      sink!.onData(Buffer.alloc(32 * 1024, i))
      const output = binarySent.at(-1)!.frame
      expect(output.kind).toBe(TerminalBinaryKind.output)
      await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: output.seq })
    }
    expect(binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toHaveLength(1)
    expect(stream.pauses).toBe(0)
  })

  it('emits an ordered sync frame every five seconds while idle', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-sync', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([
      TerminalBinaryKind.keyframe,
      TerminalBinaryKind.sync,
    ])
    expect(binarySent[1].frame.seq).toBe(1)
    expect(binarySent[1].frame.bytes).toHaveLength(0)
    expect(binarySent[1].frame.compressed).toBe(false)
  })

  it('fails closed when pending plus queued output exceeds two MiB', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-overflow', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    sink!.onData(Buffer.alloc(2 * 1024 * 1024))
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_OUTPUT_OVERFLOW')
    expect(stream.closed).toBe(true)
  })

  it('forwards only output released after the ordered snapshot cut', async () => {
    stream.onEndSnapshot = () => sink!.onData(Buffer.from('post-cut'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-cut', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([
      TerminalBinaryKind.keyframe,
      TerminalBinaryKind.output,
    ])
    expect(Buffer.from(binarySent[1].frame.bytes).toString()).toBe('post-cut')
  })

  it('pauses PTY output above the high watermark and resumes below the low watermark', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 13; i++) sink!.onData(Buffer.alloc(32 * 1024, i))
    await vi.advanceTimersByTimeAsync(1)
    expect(stream.pauses).toBe(1)
    expect(stream.resumes).toBe(0)
    sink!.onData(Buffer.from('buffered-while-renderer-paused'))
    const outputs = binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.output)
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: outputs[9].frame.seq })
    await vi.advanceTimersByTimeAsync(8)
    expect(stream.resumes).toBe(1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('buffered-while-renderer-paused')
    expect(binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toHaveLength(1)
  })

  it('closes a stream whose renderer stays stalled after tmux is paused', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-stall', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 13; i++) sink!.onData(Buffer.alloc(32 * 1024, i))
    expect(stream.pauses).toBe(1)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_RENDER_STALLED')
    expect(stream.closed).toBe(true)
  })

  it('fails closed instead of emitting an oversized binary keyframe', async () => {
    stream.snapshotBytes = Buffer.alloc(481 * 1024, 0x61)
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'oversized', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(stream.snapshots).toBe(1)
    expect(binarySent.some(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toBe(false)
    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_SNAPSHOT_TOO_LARGE')
    expect(stream.closed).toBe(true)
  })

  it('disconnect cleanup closes the stream and releases the controller', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.closeConnection('web-1')
    expect(stream.closed).toBe(true)
    const replacement = new FakeStream()
    stream = replacement
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.type).toBe('terminal_ready')
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.keyframe)
  })
  it('sends the first output after a quiet gap without waiting for the coalescing window', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-echo', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const before = binarySent.length

    // A keystroke echo: no timers advanced at all.
    sink!.onData(Buffer.from('a'))
    expect(binarySent.length).toBe(before + 1)
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.output)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('a')
  })

  it('still coalesces a burst onto the trailing window', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-burst', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    sink!.onData(Buffer.from('lead'))
    const afterLeadingEdge = binarySent.length

    // Everything arriving inside the window rides one frame, not one frame each.
    sink!.onData(Buffer.from('one'))
    sink!.onData(Buffer.from('two'))
    sink!.onData(Buffer.from('three'))
    expect(binarySent.length).toBe(afterLeadingEdge)

    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.length).toBe(afterLeadingEdge + 1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('onetwothree')
  })

  it('coalesces a loopback burst on a 2ms window while the relay keeps 8ms', async () => {
    await manager.stop()
    manager = newManager({ isLoopback: (connId) => connId.startsWith('local:') })

    const burst = async (connId: string, requestId: string): Promise<number> => {
      await manager.handleFrame(connId, 'terminal_open', {
        requestId, protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
      })
      await vi.advanceTimersByTimeAsync(20)   // a quiet gap, so 'lead' takes the leading edge
      sink!.onData(Buffer.from('lead'))
      const afterLeadingEdge = binarySent.length
      sink!.onData(Buffer.from('one'))
      sink!.onData(Buffer.from('two'))
      sink!.onData(Buffer.from('three'))
      expect(binarySent.length).toBe(afterLeadingEdge)
      return afterLeadingEdge
    }

    // The desktop on this computer: the burst goes out after 2ms, as one frame.
    let afterLeadingEdge = await burst('local:desktop', 'open-local-burst')
    await vi.advanceTimersByTimeAsync(2)
    expect(binarySent.length).toBe(afterLeadingEdge + 1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('onetwothree')

    // Anything else still waits the full 8ms window.
    afterLeadingEdge = await burst('web-1', 'open-web-burst')
    await vi.advanceTimersByTimeAsync(2)
    expect(binarySent.length).toBe(afterLeadingEdge)
    await vi.advanceTimersByTimeAsync(6)
    expect(binarySent.length).toBe(afterLeadingEdge + 1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('onetwothree')
  })

  it('gives the short window only to the terminal the loopback window has focused', async () => {
    await manager.stop()
    manager = newManager({ isLoopback: (connId) => connId.startsWith('local:') })

    // A burst after a quiet gap; returns how long its trailing frame took to go out.
    const trailingWindow = async (): Promise<number> => {
      await vi.advanceTimersByTimeAsync(20)
      sink!.onData(Buffer.from('lead'))
      const afterLeadingEdge = binarySent.length
      sink!.onData(Buffer.from('one'))
      sink!.onData(Buffer.from('two'))
      for (let ms = 1; ms <= 8; ms++) {
        await vi.advanceTimersByTimeAsync(1)
        if (binarySent.length > afterLeadingEdge) {
          expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('onetwo')
          return ms
        }
      }
      throw new Error('burst never flushed')
    }

    // Focus elsewhere before the open: this terminal is a background tile.
    manager.setFocusedAgent('local:desktop', 'agent-other')
    await manager.handleFrame('local:desktop', 'terminal_open', {
      requestId: 'open-focus', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(await trailingWindow()).toBe(8)

    // Focus moves onto it: the open stream follows, no reopen needed.
    manager.setFocusedAgent('local:desktop', 'agent-1')
    expect(await trailingWindow()).toBe(2)

    // No terminal focused at all.
    manager.setFocusedAgent('local:desktop', null)
    expect(await trailingWindow()).toBe(8)

    // Focus is a loopback matter: anything else keeps 8ms whatever it is told.
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-web-focus', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    manager.setFocusedAgent('web-1', 'agent-1')
    expect(await trailingWindow()).toBe(8)
  })

  it('forgets a loopback window\'s focus when it disconnects', async () => {
    await manager.stop()
    manager = newManager({ isLoopback: (connId) => connId.startsWith('local:') })
    manager.setFocusedAgent('local:desktop', 'agent-other')
    await manager.closeConnection('local:desktop')

    // Reconnected under the same id and silent about focus: back to the short window.
    await manager.handleFrame('local:desktop', 'terminal_open', {
      requestId: 'open-after-close', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(20)
    sink!.onData(Buffer.from('lead'))
    const afterLeadingEdge = binarySent.length
    sink!.onData(Buffer.from('tail'))
    await vi.advanceTimersByTimeAsync(2)
    expect(binarySent.length).toBe(afterLeadingEdge + 1)
  })

  describe('who is looking', () => {
    const open = (connId: string, extra: Record<string, unknown> = {}) =>
      manager.handleFrame(connId, 'terminal_open', {
        requestId: `open-${connId}`, protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30, ...extra,
      })
    beforeEach(async () => {
      await manager.stop()
      manager = newManager({ isLoopback: (connId) => connId.startsWith('local:') })
    })

    it('a loopback stream whose window lists other agents is not looked at', async () => {
      await open('local:desktop')
      manager.setVisibleAgents('local:desktop', ['agent-other'])
      expect(manager.isLookedAt('agent-1')).toBe(false)
      manager.setVisibleAgents('local:desktop', ['agent-1'])
      expect(manager.isLookedAt('agent-1')).toBe(true)
    })

    it('a loopback stream whose window never sent a list is looked at', async () => {
      await open('local:desktop')
      expect(manager.isLookedAt('agent-1')).toBe(true)
      manager.setVisibleAgents('local:desktop', null)
      expect(manager.isLookedAt('agent-1')).toBe(true)
    })

    it('a mobile or web stream is looked at, a takeover:false one included', async () => {
      await open('web-1')
      await open('web-2', { takeover: false })
      expect(manager.isLookedAt('agent-1')).toBe(true)
      await manager.closeConnection('web-1')
      expect(manager.isLookedAt('agent-1')).toBe(true)
      await manager.closeConnection('web-2')
      expect(manager.isLookedAt('agent-1')).toBe(false)
    })

    it('a watch:true stream is never looked at', async () => {
      await open('web-1', { watch: true })
      await open('local:desktop', { watch: true })
      expect(manager.isLookedAt('agent-1')).toBe(false)
    })

    it('a Share observer on a read-only manager counts even when it asks for watch:true', async () => {
      await manager.stop()
      manager = newManager({ readOnly: true })
      await open('observer:ken', { watch: true })
      expect(manager.isLookedAt('agent-1')).toBe(true)
    })

    it('a minimized window\'s empty list frees its agents', async () => {
      await open('local:desktop')
      manager.setVisibleAgents('local:desktop', [])
      expect(manager.isLookedAt('agent-1')).toBe(false)
    })

    it('closing the connection forgets its list', async () => {
      await open('local:desktop')
      manager.setVisibleAgents('local:desktop', [])
      await manager.closeConnection('local:desktop')
      await open('local:desktop')
      expect(manager.isLookedAt('agent-1')).toBe(true)
    })
  })

  describe('while an agent changes host', () => {
    const oldPane = { backend: 'ptyhost' as const, instance: 'p2', paneId: '%1' }
    const newPane = { backend: 'ptyhost' as const, instance: 'p2-0.5.0', paneId: '%7' }
    let gate: MoveGate
    let opens: Array<{ runtimes: unknown; size: unknown; readOnly: boolean; sink: TerminalStreamSink; stream: FakeStream }>
    let rawWrites: Array<{ runtime: unknown; bytes: string }>
    let duringOpen: (() => void) | null
    const paste = (connId: string, streamId: string, text: string) => manager.handleBinary(connId, {
      kind: TerminalBinaryKind.paste, streamId, seq: 0, bytes: Buffer.from(text), compressed: false,
    })
    /** What the mover does at the swap: the row names the new pane, and the agent's streams follow it. */
    const swap = async () => {
      agents.set('agent-1', row('agent-1', newPane))
      await manager.retarget('agent-1', newPane)
    }
    const row = (agentId: string, runtime: typeof oldPane) => ({
      ...session('codex', agentId), runtimes: [runtime], primaryRuntimeKey: `ptyhost:${runtime.instance}:${runtime.paneId}`,
    } as unknown as RegisteredSession)
    const openFrame = (connId: string, agentId = 'agent-1') => manager.handleFrame(connId, 'terminal_open', {
      requestId: `open-${connId}`, protocolVersion: 3, agentId, cols: 100, rows: 30,
    })
    const readyFor = (connId: string) => String(sent.findLast((f) => f.connId === connId && f.type === 'terminal_ready')!.payload.streamId)
    const input = (connId: string, streamId: string, seq: number, text: string) => manager.handleBinary(connId, {
      kind: TerminalBinaryKind.input, streamId, seq, bytes: Buffer.from(text), compressed: false,
    })

    beforeEach(async () => {
      await manager.stop()
      gate = new MoveGate()
      opens = []
      rawWrites = []
      agents = new Map([['agent-1', row('agent-1', oldPane)], ['agent-2', row('agent-2', { ...oldPane, paneId: '%2' })]])
      duringOpen = null
      terminals = {
        openStream: async (opened: RegisteredSession, size: unknown, nextSink: TerminalStreamSink, readOnly = false) => {
          const next = new FakeStream()
          opens.push({ runtimes: opened.runtimes, size, readOnly, sink: nextSink, stream: next })
          duringOpen?.()
          return { state: 'succeeded' as const, value: next }
        },
        backendFor: () => ({
          writeInput: async (runtime: unknown, bytes: Uint8Array) => {
            rawWrites.push({ runtime, bytes: Buffer.from(bytes).toString() })
            return TERMINAL_ACTION_SUCCEEDED
          },
          pasteInput: async (runtime: unknown, text: string) => {
            rawWrites.push({ runtime, bytes: `paste:${text}` })
            return TERMINAL_ACTION_SUCCEEDED
          },
        }),
      } as unknown as TerminalBackendCoordinator
      manager = newManager({ moveGate: gate, isLoopback: (connId) => connId.startsWith('local:') })
    })

    it('input during a hold is delivered once, in order, after release', async () => {
      const onInput = vi.fn()
      await manager.stop()
      manager = newManager({ moveGate: gate, onInput })
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await input('web-1', streamId, 0, 'a')
      await input('web-1', streamId, 1, 'b')
      await input('web-1', streamId, 2, 'c')
      // Taken as input at once (the prewarm, the quiet clock), but nothing reaches a pane yet.
      expect(onInput).toHaveBeenCalledTimes(3)
      expect(opens[0].stream.writes).toEqual([])
      await swap()
      expect(opens[1].stream.writes).toEqual([])
      await gate.release('agent-1')
      // Through the retargeted stream, onto the new pane; never the old one.
      expect(opens[1].stream.order).toEqual(['raw:a', 'raw:b', 'raw:c'])
      expect(opens[0].stream.writes).toEqual([])
      expect(rawWrites).toEqual([])
      expect(sent.filter((f) => f.type === 'terminal_error')).toEqual([])
    })

    it('refuses queued and direct terminal input after an uncertain move frees its transient queue', async () => {
      let refused = false
      await manager.stop()
      gate = new MoveGate(() => refused)
      manager = newManager({ moveGate: gate })
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await input('web-1', streamId, 0, 'queued')
      await paste('web-1', streamId, 'queued paste')
      refused = true
      await gate.release('agent-1')
      await input('web-1', streamId, 1, 'direct')
      await paste('web-1', streamId, 'direct paste')
      expect(opens[0].stream.order).toEqual([])
      expect(rawWrites).toEqual([])
      expect(sent.filter(frame => frame.type === 'terminal_error')).toHaveLength(4)
    })

    it('held input whose stream closed during the move still reaches the row\'s pane', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await input('web-1', streamId, 0, 'a')
      await paste('web-1', streamId, 'P')
      await manager.closeConnection('web-1')
      agents.set('agent-1', row('agent-1', newPane))
      await gate.release('agent-1')
      expect(rawWrites).toEqual([{ runtime: newPane, bytes: 'a' }, { runtime: newPane, bytes: 'paste:P' }])
      expect(opens[0].stream.writes).toEqual([])
    })

    it('a paste during a hold is delivered after release, in order with keystrokes', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await input('web-1', streamId, 0, 'a')
      await paste('web-1', streamId, 'P')
      await input('web-1', streamId, 1, 'b')
      expect(opens[0].stream.order).toEqual([])
      await swap()
      await gate.release('agent-1')
      expect(opens[1].stream.order).toEqual(['raw:a', 'paste:P', 'raw:b'])
      expect(opens[0].stream.order).toEqual([])
    })

    it('an image paste during a hold is delivered after release, in order with keystrokes', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
      await input('web-1', streamId, 0, 'a')
      await manager.handleFrame('web-1', 'terminal_chunked_upload_begin', { streamId, uploadKind: 'image', totalBytes: png.length })
      await manager.handleBinary('web-1', { kind: TerminalBinaryKind.imagePaste, streamId, seq: 0, compressed: false, bytes: png })
      await input('web-1', streamId, 1, 'b')
      expect(writeImageToOsClipboard).not.toHaveBeenCalled()
      expect(opens[0].stream.order).toEqual([])
      await swap()
      await gate.release('agent-1')
      expect(writeImageToOsClipboard).toHaveBeenCalledTimes(1)
      expect(opens[1].stream.order).toEqual(['raw:a', 'raw:\u0016', 'raw:b'])
      expect(sent.findLast((f) => f.type === 'terminal_paste_image_result')?.payload).toMatchObject({ streamId, outcome: 'clipboard' })
    })

    it('a prepared file held for a move reaches the new row after its stream closes', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await manager.handleFrame('web-1', 'terminal_chunked_upload_begin', { streamId, uploadKind: 'file', filename: 'move.txt', totalBytes: 2 })
      await manager.handleBinary('web-1', { kind: TerminalBinaryKind.pasteFile, streamId, seq: 0, compressed: false, bytes: Uint8Array.of(1, 2) })
      expect(opens[0].stream.pastes).toEqual([])
      await manager.closeConnection('web-1')
      agents.set('agent-1', row('agent-1', newPane))
      await gate.release('agent-1')
      expect(rawWrites).toEqual([{ runtime: newPane, bytes: 'paste:/fake/paste-drops/id-move.txt' }])
      expect(writeImageToOsClipboard).not.toHaveBeenCalled()
    })

    it('a held agent counts as looked at from the moment input or an open arrives, until it is let go', async () => {
      await openFrame('local:desktop')
      manager.setVisibleAgents('local:desktop', ['agent-other'])
      gate.hold('agent-1')
      expect(manager.isLookedAt('agent-1')).toBe(false)
      await input('local:desktop', readyFor('local:desktop'), 0, 'x')
      expect(manager.isLookedAt('agent-1')).toBe(true)
      await gate.release('agent-1')
      expect(manager.isLookedAt('agent-1')).toBe(false)
      // The next hold starts untouched.
      gate.hold('agent-1')
      expect(manager.isLookedAt('agent-1')).toBe(false)
      await gate.release('agent-1')

      manager.setVisibleAgents('local:other', ['agent-other'])
      gate.hold('agent-2')
      await openFrame('local:other', 'agent-2')
      expect(manager.isLookedAt('agent-2')).toBe(true)
      await gate.release('agent-2')
      expect(manager.isLookedAt('agent-2')).toBe(false)
    })

    it('an open during a hold returns at once on the current runtime, and is moved by the retarget at swap', async () => {
      gate.hold('agent-1')
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      expect(opens.map((o) => o.runtimes)).toEqual([[oldPane]])
      await swap()
      expect(opens.map((o) => o.runtimes)).toEqual([[oldPane], [newPane]])
      expect(opens[0].stream.closed).toBe(true)
      await gate.release('agent-1')
      expect(sent.filter((f) => f.type === 'terminal_closed' || f.type === 'terminal_error')).toEqual([])
      await input('web-1', streamId, 0, 'typed')
      expect(opens[1].stream.order).toEqual(['raw:typed'])
    })

    it('an open the swap overtook follows the row on its own', async () => {
      gate.hold('agent-1')
      // The mover switches the row and retargets while this open is still reaching the old pane: the
      // retarget finds no stream to move, so the open has to notice.
      duringOpen = () => {
        duringOpen = null
        agents.set('agent-1', row('agent-1', newPane))
        void manager.retarget('agent-1', newPane)
      }
      await openFrame('web-1')
      expect(opens.map((o) => o.runtimes)).toEqual([[oldPane], [newPane]])
      expect(opens[0].stream.closed).toBe(true)
      expect(sent.filter((f) => f.type === 'terminal_closed' || f.type === 'terminal_error')).toEqual([])
      await gate.release('agent-1')
    })

    it('a retarget opens the new pane at the size the client last asked for, even one the old pane refused', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      opens[0].stream.resize = async () => ({ state: 'failed', dispatch: 'rejected', reason: 'no' })
      await manager.handleFrame('web-1', 'terminal_resize', { streamId, resizeSeq: 1, cols: 90, rows: 20 })
      await swap()
      expect(opens[1].size).toEqual({ cols: 90, rows: 20 })
    })

    it('an open stream follows a retarget with no close, and gets the new pane\'s output', async () => {
      await openFrame('web-1')
      await openFrame('web-2')
      const watcherOpen = manager.handleFrame('web-3', 'terminal_open', {
        requestId: 'watch', protocolVersion: 3, agentId: 'agent-1', cols: 80, rows: 24, watch: true,
      })
      await watcherOpen
      const streamId = readyFor('web-2')
      await manager.handleFrame('web-2', 'terminal_resize', { streamId, resizeSeq: 1, cols: 120, rows: 40 })
      const [, before, watcher] = opens
      before.stream.snapshotBytes = Buffer.from('old pane')
      const framesBefore = binarySent.length
      sent = []

      await manager.retarget('agent-1', newPane)

      // Every open stream of the agent was re-subscribed on the new pane, at its own size and mode.
      expect(opens.slice(3).map((o) => [o.runtimes, o.size, o.readOnly])).toEqual([
        [[newPane], { cols: 120, rows: 40 }, false],
        [[newPane], { cols: 80, rows: 24 }, true],
      ])
      expect(before.stream.closed).toBe(true)
      expect(watcher.stream.closed).toBe(true)
      expect(sent.filter((f) => f.type === 'terminal_closed' || f.type === 'terminal_error')).toEqual([])
      const after = opens[3]
      // The client's screen is reset through the keyframe it already knows, on its own stream id.
      expect(after.stream.snapshots).toBe(1)
      const keyframe = binarySent.slice(framesBefore).find((f) => f.connId === 'web-2' && f.frame.kind === TerminalBinaryKind.keyframe)
      expect(keyframe?.frame.streamId).toBe(streamId)

      // The old pane's late output is dropped; the new pane's reaches the same stream.
      const sentNow = binarySent.length
      before.sink.onData(Buffer.from('late old output'))
      before.sink.onClose('old pane gone')
      after.sink.onData(Buffer.from('new pane output'))
      await vi.advanceTimersByTimeAsync(20)
      const outputs = binarySent.slice(sentNow).filter((f) => f.connId === 'web-2' && f.frame.kind === TerminalBinaryKind.output)
      expect(outputs.map((f) => [f.frame.streamId, Buffer.from(f.frame.bytes).toString()])).toEqual([[streamId, 'new pane output']])
      expect(sent.filter((f) => f.type === 'terminal_closed')).toEqual([])

      // Input on the same stream now goes to the new pane.
      await input('web-2', streamId, 0, 'typed')
      expect(after.stream.writes.map((b) => Buffer.from(b).toString())).toEqual(['typed'])
      expect(before.stream.writes).toEqual([])
    })

    it('a keyframe being taken of the old pane when the stream moves is taken again of the new one', async () => {
      await openFrame('web-1')
      const streamId = readyFor('web-1')
      const before = opens[0].stream
      let finishOld!: () => void
      before.snapshot = () => new Promise((resolve) => {
        finishOld = () => resolve({ state: 'succeeded', value: { bytes: Buffer.from('old pane'), cols: 100, rows: 30 } })
      })
      const resync = manager.handleFrame('web-1', 'terminal_resync', { streamId })
      await vi.advanceTimersByTimeAsync(0)
      const framesBefore = binarySent.length
      await manager.retarget('agent-1', newPane)
      const after = opens[1].stream
      after.snapshotBytes = Buffer.from('new pane')
      finishOld()
      await resync
      const keyframes = binarySent.slice(framesBefore).filter((f) => f.frame.kind === TerminalBinaryKind.keyframe)
      expect(keyframes.map((f) => [f.frame.streamId, Buffer.from(f.frame.bytes).toString()])).toEqual([[streamId, 'new pane']])
      expect(after.snapshotBegins).toBe(after.snapshotEnds)
      expect(sent.filter((f) => f.type === 'terminal_closed' || f.type === 'terminal_error')).toEqual([])
    })

    it('nothing is held for other agents', async () => {
      await openFrame('web-1', 'agent-2')
      const streamId = readyFor('web-1')
      gate.hold('agent-1')
      await input('web-1', streamId, 0, 'free')
      expect(opens[0].stream.writes.map((b) => Buffer.from(b).toString())).toEqual(['free'])
      await openFrame('web-2', 'agent-2')
      expect(opens).toHaveLength(2)
      expect(rawWrites).toEqual([])
    })
  })
})
