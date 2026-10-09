/** Codex's shared app-server owns work independently of its terminal client.
 * Never kill that server: unload only the confirmed conversation, leaving its
 * history available and all other clients running. New Harness launches opt out
 * of sharing, but sessions opened before an upgrade still need this path.
 * Moved from lib/codexSessionLifecycle.ts and lib/runtimeActivity.ts into the Codex worker. Core establishes
 * from its own evidence and the launch contract that a conversation is on the server (core/engines/
 * nativeControls.ts); this speaks the server's protocol for it (engines/facets/nativeControl.ts). */
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { realpath } from 'node:fs/promises'
import WebSocket from 'ws'
import { engineBin } from '../../lib/engineBin.js'
import type { EngineNativeControl, NativeConversation } from '../facets/nativeControl.js'

export interface CodexControl {
  request(method: string, params: Record<string, unknown>): Promise<any>
  close(): void
}

/** The CLI resolves its own socket location. It does not start a server. `proxy`
 * carries raw WebSocket bytes (not JSONL), as documented by Codex app-server. */
export async function connectCodexControl(home: string): Promise<CodexControl> {
  const child = spawn(engineBin('codex'), ['app-server', 'proxy'], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
  })
  const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin })
  const ws = new WebSocket('ws://localhost/', { createConnection: () => pipe as any,
    handshakeTimeout: 3_000, maxPayload: 2 << 20, perMessageDeflate: false })
  let nextId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const fail = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
  }
  const close = () => { fail(new Error('Codex control connection closed')); ws.terminate(); pipe.destroy(); child.kill() }
  child.on('error', error => { fail(error); ws.terminate() })
  child.on('exit', () => { fail(new Error('Codex control proxy exited')); ws.terminate() })
  pipe.on('error', error => { fail(error); ws.terminate() })
  ws.on('error', fail)
  ws.on('close', () => { fail(new Error('Codex control connection closed')); pipe.destroy(); child.kill() })
  ws.on('message', bytes => {
    try {
      const frame = JSON.parse(String(bytes))
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id); clearTimeout(entry.timer)
      if (frame.error) entry.reject(new Error(`Codex could not ${String(frame.error.message ?? 'complete the request').slice(0, 300)}`))
      else entry.resolve(frame.result)
    } catch { fail(new Error('Invalid Codex control response')); ws.terminate() }
  })
  const request: CodexControl['request'] = (method, params) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error('Codex control is unavailable')); return }
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex control request timed out')) }, 5_000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }), error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject)
      ws.once('close', () => reject(new Error('Codex control connection closed')))
    })
    const initialized = await request('initialize', { clientInfo: { name: 'harness', version: '1' }, capabilities: { experimentalApi: true } })
    if (typeof initialized?.codexHome !== 'string' || await realpath(initialized.codexHome) !== await realpath(home)) {
      throw new Error('Codex returned a different session store')
    }
    ws.send(JSON.stringify({ method: 'initialized' }))
    return { request, close }
  } catch (error) { close(); throw error }
}

export interface CodexNativeDeps {
  connect(home: string): Promise<CodexControl>
  now(): number
}

export function createNativeControl(deps: CodexNativeDeps = { connect: connectCodexControl, now: () => performance.now() }): EngineNativeControl {
  // Read-only activity connections, shared by profile. Never launch/resume a thread or
  // start an app-server to inspect it. An unrelated server's notLoaded is unknown.
  const controls = new Map<string, Promise<CodexControl>>()
  const retryAt = new Map<string, number>()
  return {
    async activity({ home, sessionId }: NativeConversation) {
      if ((retryAt.get(home) ?? 0) > deps.now()) return 'unknown'
      let connection = controls.get(home)
      if (!connection) { connection = deps.connect(home); controls.set(home, connection) }
      try {
        const control = await connection
        const read = await control.request('thread/read', { threadId: sessionId })
        if (read?.thread?.id !== sessionId) return 'unknown'
        if (read.thread.status?.type === 'active') return 'working'
        if (read.thread.status?.type === 'idle') return 'idle'
        return 'unknown'
      } catch {
        // An old/process-owned engine may share its profile with another server.
        // Do not keep spawning a failed proxy for every session every five seconds.
        if (controls.get(home) === connection) controls.delete(home)
        void connection.then(control => control.close()).catch(() => {})
        retryAt.set(home, deps.now() + 60_000)
        return 'unknown'
      }
    },

    /** Called AFTER a checkpoint and BEFORE signalling the terminal, for a conversation core established is on
     * a running server. There is no polling, model call, archive deletion or machine-wide daemon shutdown here. */
    async stop({ home, sessionId }, host) {
      const cancelled = () => new Error('The close request was cancelled or the session changed')
      const guard = async () => { if (!await host.current()) throw cancelled() }
      const control = await deps.connect(home)
      try {
        await guard()
        const read = await control.request('thread/read', { threadId: sessionId })
        if (read?.thread?.id !== sessionId) throw new Error('Codex returned a different conversation')
        if (read.thread.status?.type === 'notLoaded') return
        // A process-owned session can share its profile with an unrelated daemon;
        // thread/read reports notLoaded there and none of the calls below occur.
        const goal = await control.request('thread/goal/get', { threadId: sessionId })
        await guard()
        if (goal?.goal?.status === 'active') {
          await control.request('thread/goal/set', { threadId: sessionId, status: 'paused' })
        }
        await guard()
        const turns = await control.request('thread/turns/list', { threadId: sessionId, limit: 1, itemsView: 'summary' })
        await guard()
        const active = turns?.data?.find((turn: any) => turn.status === 'inProgress')
        if (active) await control.request('turn/interrupt', { threadId: sessionId, turnId: active.id })
        // Core notes the archive before it is sent: cut off before its unarchive, this worker gone, core asks
        // the next one to return the history (recover, below). It is the guard here, too.
        if (!await host.pending()) throw cancelled()
        // Archive is the public operation that unloads a thread. Unarchive moves
        // only its saved history back; it does not restart the thread. Always undo
        // the archive even if the user reopens while its response is in flight.
        let archiveError: unknown
        try { await control.request('thread/archive', { threadId: sessionId }) }
        catch (error) { archiveError = error }
        // A timed-out reply does not prove the archive failed to happen. Always
        // attempt to return the history to sessions before reporting the error.
        try { await control.request('thread/unarchive', { threadId: sessionId }) }
        catch (error) { throw archiveError ?? error }
        await host.settled()
        if (archiveError) throw archiveError
        await guard()
        const after = await control.request('thread/read', { threadId: sessionId })
        if (after?.thread?.id !== sessionId || after.thread.status?.type !== 'notLoaded') {
          throw new Error('Could not confirm the Codex conversation stopped; its pane remains open')
        }
      } finally { control.close() }
    },

    /** The history of a thread a lost worker archived and never unarchived, returned once. */
    async recover({ home, sessionId }) {
      const control = await deps.connect(home)
      try { await control.request('thread/unarchive', { threadId: sessionId }) }
      finally { control.close() }
    },

    close() {
      for (const control of controls.values()) void control.then(value => value.close()).catch(() => {})
      controls.clear()
    },
  }
}

export const nativeControl = createNativeControl()
