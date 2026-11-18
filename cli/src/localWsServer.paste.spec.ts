/** Cancellation must cross the shipping socket/dispatch path while preparation is still held. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { BackendSocket, type Frame } from './backendSocket.js'
import { attachLocalWsServer } from './localWsServer.js'
import type { PastePort } from './core/api.js'
import { createPasteFiles } from './services/paste.js'
import { listenLocalSocket } from './lib/localSocket.js'
import { createPasteClipboard } from './services/pasteClipboard.js'
import { openPreparedPaste as provePreparedFile } from './lib/pasteArtifact.js'
import type { RegisteredSession } from './lib/registry.js'
import type { TerminalBackendCoordinator } from './lib/terminalBackendCoordinator.js'
import { encodeTerminalLocal, TerminalBinaryKind } from './lib/terminalBinary.js'
import { TerminalStreamManager } from './lib/terminalStreamManager.js'
import { TERMINAL_ACTION_SUCCEEDED, type TerminalStreamHandle } from './lib/terminalTypes.js'

type WireFrame = Frame & { payload?: Record<string, unknown> }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`wire fixture timed out: ${label}`)), 1_000)
    })])
  } finally { clearTimeout(timer) }
}

afterEach(() => vi.restoreAllMocks())

describe.skipIf(process.platform === 'win32')('paste cancellation over the private local WebSocket', () => {
  it.each([['file', true, false], ['image', true, false], ['file', false, false], ['image', false, false],
    ['file', true, true], ['file', false, true], ['image', true, true], ['image', false, true]] as const)(
    'keeps another pane responsive during %s preparation (cancel=%s, inline=%s), preserving final input order', async (kind, cancel, inline) => {
    const directory = mkdtempSync('/tmp/hpaste-wire-')
    const socketPath = join(directory, 'daemon.sock')
    const socket = await listenLocalSocket((_request, response) => { response.statusCode = 404; response.end() }, socketPath)
      .catch((error) => { rmSync(directory, { recursive: true, force: true }); throw error })
    const backend = new BackendSocket('paste-fixture')
    const preparing = deferred(), prepared = deferred(), input = deferred(), uploadInput = deferred(), completed = deferred()
    const writeClipboard = async () => { preparing.resolve(); await prepared.promise; completed.resolve(); return { state: 'written' as const } }
    const files = inline ? createPasteFiles(directory, { log: () => {}, clipboard: (root, deps) => createPasteClipboard(root, {
      ...deps, start: (file) => { file.close(); const ready = writeClipboard(); return { ready, settled: ready.then(() => {}), cancel() {} } },
    }) }) : undefined
    const writes: Array<{ agent: string; bytes: Uint8Array }> = []
    const pastes: string[] = []
    const order: string[] = []
    const handles = new Map<string, TerminalStreamHandle>()
    const sessions = new Map(['upload', 'other'].map((agentId, index) => [agentId, {
      agentId, sessionId: agentId, engine: 'codex', active: true,
      runtimes: [{ backend: 'tmux', paneId: `%${index + 1}` }], primaryRuntimeKey: `tmux:default:%${index + 1}`,
    } as unknown as RegisteredSession]))
    for (const agentId of sessions.keys()) handles.set(agentId, {
      runtime: { backend: 'tmux', paneId: agentId === 'upload' ? '%1' : '%2' }, beginSnapshot() {}, endSnapshot() {},
      snapshot: async () => ({ state: 'succeeded', value: { bytes: Buffer.from('fixture'), cols: 80, rows: 24 } }),
      writeRaw: async (bytes) => {
        writes.push({ agent: agentId, bytes })
        if (agentId === 'other') input.resolve()
        else { order.push(`key:${Buffer.from(bytes).toString('hex')}`); if (bytes[0] === 13) uploadInput.resolve() }
        return TERMINAL_ACTION_SUCCEEDED
      },
      pasteRaw: async (text) => { pastes.push(text); order.push('path'); return TERMINAL_ACTION_SUCCEEDED },
      resize: async () => TERMINAL_ACTION_SUCCEEDED, scroll: async () => TERMINAL_ACTION_SUCCEEDED,
      pauseOutput: async () => TERMINAL_ACTION_SUCCEEDED, resumeOutput: async () => TERMINAL_ACTION_SUCCEEDED,
      close: async () => {},
    } as TerminalStreamHandle)
    const paste: PastePort = {
      begin: async (request) => files ? files.begin(request) : { accepted: true as const },
      clipboard: async (request) => files ? files.clipboard(request) : writeClipboard(),
      releaseClipboard: (generation) => files?.releaseClipboard(generation),
      cancel: vi.fn((generation) => files?.cancel(generation)), stop: () => files?.stop(),
      chunk: async (request, bytes) => {
        if (kind === 'file') { preparing.resolve(); await prepared.promise }
        const result = files ? await files.chunk(request, bytes)
          : { bytesWritten: 2, totalBytes: 2, artifact: { name: 'prepared-file', version: 'fixture' } }
        if (kind === 'file') completed.resolve(); return result
      },
    }
    const manager = new TerminalStreamManager({
      terminals: { openStream: async (session: RegisteredSession) => ({ state: 'succeeded', value: handles.get(session.agentId)! }) } as unknown as TerminalBackendCoordinator,
      resolveAgent: (id) => sessions.get(id), streamingAvailable: true, paste: () => paste,
      preparedPaste: (generation, artifact) => files ? provePreparedFile(generation, artifact, directory)
        : { path: '/fixture/prepared-file', descriptor: 0, current: () => true, close() {} },
      sendTarget: (connection, type, payload) => backend.sendTerminalTo(connection, type, payload),
      sendBinaryTarget: (connection, frame) => backend.sendTerminalBinaryTo(connection, frame),
    })
    backend.setTerminalStreamManager(manager)
    const server = attachLocalWsServer(socket.server, { machineId: 'paste-fixture', backend })
    const client = new WebSocket(`ws+unix://${socketPath}:/api/local-ws`)
    const frames: WireFrame[] = []
    const waiters: Array<{ type: string; resolve: (frame: WireFrame) => void }> = []
    client.on('message', (raw, binary) => {
      if (binary) return
      const frame = JSON.parse(raw.toString()) as WireFrame
      const index = waiters.findIndex((waiter) => waiter.type === frame.type)
      if (index < 0) frames.push(frame)
      else waiters.splice(index, 1)[0].resolve(frame)
    })
    const next = (type: string) => bounded(new Promise<WireFrame>((resolve) => {
      const index = frames.findIndex((frame) => frame.type === type)
      if (index < 0) waiters.push({ type, resolve })
      else resolve(frames.splice(index, 1)[0])
    }), type)
    const send = (type: string, payload: Record<string, unknown>) => client.send(JSON.stringify({ type, payload }))
    try {
      await bounded(new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) }), 'open')
      send('machine_select', { machineId: 'paste-fixture', localProtocolVersion: 1 })
      await next('connected')
      const streamIds: string[] = []
      for (const agentId of sessions.keys()) {
        send('terminal_open', { agentId, requestId: agentId, protocolVersion: 3, cols: 80, rows: 24 })
        streamIds.push(String((await next('terminal_ready')).payload?.streamId))
      }
      send('terminal_chunked_upload_begin', { streamId: streamIds[0], uploadKind: kind, totalBytes: 2, filename: 'file.txt' })
      expect((await next('terminal_chunked_upload_begin_result')).payload?.accepted).toBe(true)
      client.send(encodeTerminalLocal({ kind: kind === 'file' ? TerminalBinaryKind.pasteFile : TerminalBinaryKind.imagePaste,
        streamId: streamIds[0], seq: 0, bytes: Uint8Array.of(1, 2), compressed: false })!)
      await bounded(preparing.promise, 'preparation entered')
      if (cancel) send('terminal_chunked_upload_cancel', { streamId: streamIds[0] })
      client.send(encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: streamIds[0], seq: 0,
        bytes: Uint8Array.of(13), compressed: false })!)
      client.send(encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: streamIds[1], seq: 0,
        bytes: Buffer.from('x'), compressed: false })!)
      // This must settle before preparation is released: neither socket serialization nor a helper can hide Cancel.
      await bounded(input.promise, 'unrelated input before preparation settles')
      if (cancel) expect(paste.cancel).toHaveBeenCalledOnce()
      if (!cancel) expect(order).toEqual([])
      prepared.resolve()
      await bounded(completed.promise, 'preparation settled')
      await bounded(uploadInput.promise, 'same-pane Enter after preparation')
      send('terminal_capabilities', { requestId: 'after-preparation' })
      await next('terminal_capabilities_result')
      expect(order).toEqual(cancel ? ['key:0d'] : [kind === 'file' ? 'path' : 'key:16', 'key:0d'])
      if (cancel) expect(pastes).toEqual([])
    } finally {
      prepared.resolve()
      client.terminate()
      await server.close()
      await backend.stop()
      await paste.stop()
      await socket.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
