/** Codex's shared app-server owns work independently of its terminal client.
 * Never kill that server: unload only the confirmed conversation, leaving its
 * history available and all other clients running. New Harness launches opt out
 * of sharing, but sessions opened before an upgrade still need this path. */
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import WebSocket from 'ws'
import { sessionCodexHome } from './engineHomes.js'
import { engineBin } from './engineBin.js'
import { argvTokens, processRows, type ProcessRow } from './tmux.js'
import type { RegisteredSession } from './registry.js'

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

async function daemonIdentity(home: string): Promise<{ pid: number; processStartTime: string } | null> {
  try {
    const value = JSON.parse(await readFile(join(home, 'app-server-daemon', 'daemon.pid'), 'utf8'))
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStartTime !== 'string') throw new Error('Invalid Codex server identity')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export interface CodexStopDeps {
  daemonIdentity(home: string): Promise<{ pid: number; processStartTime: string } | null>
  rows(): Promise<ProcessRow[] | null>
  connect(home: string): Promise<CodexControl>
}

/** Called AFTER a checkpoint and BEFORE signalling the terminal. There is no
 * polling, model call, archive deletion or machine-wide daemon shutdown here. */
export async function stopSharedCodexSession(session: RegisteredSession, current: () => boolean,
  deps: CodexStopDeps = { daemonIdentity, rows: processRows, connect: connectCodexControl },
  confirmUnusedConversation?: (session: RegisteredSession) => Promise<boolean>): Promise<void> {
  if (session.engine !== 'codex') return
  const home = sessionCodexHome(session)
  const rows = await deps.rows()
  if (!rows) throw new Error('Could not verify the Codex server before stopping')
  const guard = () => { if (!current()) throw new Error('The close request was cancelled or the session changed') }
  // Close can beat discovery's exit reconciliation: the client has already
  // returned to its shell, with no conversation ever bound. Its checkpoint is
  // saved, and an unrelated shared server is not a reason to keep that pane.
  // Missing/recycled process identity and previously bound conversations still
  // need the normal verification below.
  if (session.processIdentity && !rows.some(row => row.pid === session.processIdentity!.pid)
    && !session.sessionId && !session.transcriptPath && session.boundAt == null && !session.resumeOnly) {
    guard()
    return
  }
  const owner = rows.find(row => row.pid === session.processIdentity?.pid && row.startMarker === session.processIdentity?.startMarker && row.executable === session.processIdentity?.executable)
  if (owner) {
    const args = argvTokens(owner.args)
    // Harness inserts this as the FIRST option, before resume/fork or prompt
    // text. A prompt merely mentioning --no-daemon is not proof of ownership.
    const option = /^node(?:\.exe)?$/.test(basename(args[0] ?? '')) && /(?:^|\/)codex(?:\.js)?$/.test(args[1] ?? '') ? 2 : 1
    // A remote app-server is not controlled by this machine's profile. Do not
    // report its work stopped merely because its local terminal was closed.
    if (args.slice(option).some(arg => arg === '--remote' || arg.startsWith('--remote='))) {
      throw new Error('Stop this conversation on its remote Codex server before closing its terminal')
    }
    if (args[option] === '--no-daemon') return
  }
  const daemon = await deps.daemonIdentity(home)
  if (!daemon) return // Older/process-owned Codex has no detached writer.
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ')
  if (!rows.some(row => row.pid === daemon.pid && normalize(row.startMarker) === normalize(daemon.processStartTime))) return
  if (!session.sessionId) {
    // An unused TUI has no conversation to unload. Close supplies fresh proof
    // of its empty composer after saving the screen; Pause and uncertain
    // discovery still require an exact conversation identity.
    if (owner && await confirmUnusedConversation?.(session)) {
      guard()
      return
    }
    throw new Error('Could not identify the conversation on the Codex server; the session is still open')
  }
  const control = await deps.connect(home)
  try {
    guard()
    const read = await control.request('thread/read', { threadId: session.sessionId })
    if (read?.thread?.id !== session.sessionId) throw new Error('Codex returned a different conversation')
    if (read.thread.status?.type === 'notLoaded') return
    // A process-owned session can share its profile with an unrelated daemon;
    // thread/read reports notLoaded there and none of the calls below occur.
    const goal = await control.request('thread/goal/get', { threadId: session.sessionId })
    guard()
    if (goal?.goal?.status === 'active') {
      await control.request('thread/goal/set', { threadId: session.sessionId, status: 'paused' })
    }
    guard()
    const turns = await control.request('thread/turns/list', { threadId: session.sessionId, limit: 1, itemsView: 'summary' })
    guard()
    const active = turns?.data?.find((turn: any) => turn.status === 'inProgress')
    if (active) await control.request('turn/interrupt', { threadId: session.sessionId, turnId: active.id })
    guard()
    // Archive is the public operation that unloads a thread. Unarchive moves
    // only its saved history back; it does not restart the thread. Always undo
    // the archive even if the user reopens while its response is in flight.
    let archiveError: unknown
    try { await control.request('thread/archive', { threadId: session.sessionId }) }
    catch (error) { archiveError = error }
    // A timed-out reply does not prove the archive failed to happen. Always
    // attempt to return the history to sessions before reporting the error.
    try { await control.request('thread/unarchive', { threadId: session.sessionId }) }
    catch (error) { throw archiveError ?? error }
    if (archiveError) throw archiveError
    guard()
    const after = await control.request('thread/read', { threadId: session.sessionId })
    if (after?.thread?.id !== session.sessionId || after.thread.status?.type !== 'notLoaded') {
      throw new Error('Could not confirm the Codex conversation stopped; its pane remains open')
    }
  } finally { control.close() }
}
