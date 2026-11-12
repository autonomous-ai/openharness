/**
 * The agent verbs' line to a daemon (docs/design/2026-10-11-agent-client.md): the local socket of the daemon
 * that owns the caller's pane, as `harness send` finds it, opened as a TOOL. A window's registration would turn
 * on the question watcher and count as a person looking (backendSocket.ts `registerLocalClient`), and an agent
 * polling every few seconds is not one. Another of the owner's machines is reached through the same socket over
 * the paired relay (`machine_select` naming it).
 */
import { randomUUID } from 'node:crypto'
import { LOCAL_JSON_MAX_BYTES, refusedLineText, tooLargeText } from '../lib/localJsonLimit.js'
import { WebSocket } from 'ws'
import { env } from '../config/env.js'
import { readAuthSession } from '../lib/authSession.js'
import { localWsTarget } from '../lib/localTransport.js'
import { daemonPipe, type LocalDaemonOptions } from '../lib/windows/daemonPipe.js'
import { pipeWebSocket } from '../lib/windows/pipeClient.js'
import { computerId, daemonUnreachableText } from '../lib/daemonState.js'
import { paneOwner, sendPane } from '../messages/command.js'

export class AgentClientError extends Error {
  /** [reason]: which limit or rule refused, for a refusal (`SPAWN_LIMIT`'s `OPEN_LIMIT`, `TURNED_OFF`'s `SWITCH_OFF`). */
  constructor(readonly code: string, message: string, readonly reason?: string) { super(message) }
}

/** Which daemon: its port and data folder, and this machine's id as the daemon knows it. */
export interface Where {
  port: number
  dataDir: string
  machineId: string
  /** The caller's pane is one a Harness daemon made (tmux owner tag or native host name). */
  harnessPane?: boolean
}

export interface Daemon {
  /** The machine this line reaches. */
  machineId: string
  request(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /**
   * Follows [agentIds] by what the daemon pushes (`agents_watch`, core/toolWatches.ts): [heard] is told the harness each
   * state event is about. False from a daemon too old to push to tools, or one that refused the watch; the caller then
   * looks for itself. A line a test makes may have none.
   */
  watch?(agentIds: string[], heard: (agentId: string, event: PushedEvent) => void): Promise<boolean>
  /**
   * Follows [agentIds] on the machine this line reaches by what it pushes (`harness_watch`, gateway/harnessWatch.ts):
   * names and states only, [heard] told each `harness_event`. The answer: the lease and what each is doing now, or the
   * refusal by name. A lease lasts five minutes; asking again renews it. A line a test makes may have none.
   */
  harnessWatch?(agentIds: string[], heard: (agentId: string, event: PushedEvent) => void): Promise<Record<string, unknown>>
  close(): void
}

/** What the daemon pushes a watch (core/toolWatches.ts), and another machine a harness watch (gateway/harnessWatch.ts). */
const PUSHED = new Set(['agent_activity', 'turn_ended', 'commander_question', 'commander_question_close', 'agent_deleted', 'harness_event'])

/** A pushed event as a listener hears it: its type and payload. */
export interface PushedEvent { type: string; payload: Record<string, unknown> }

/** The least of a WebSocket this needs, so a test can hand in a fake. */
export interface ClientSocket {
  send(data: string): void
  close(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: { toString(): string }, binary: boolean) => void): unknown
  on(event: 'close', listener: (code: number) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type Connect = (where: Where) => ClientSocket | Promise<ClientSocket>

/** The daemon that made [pane], else the one this CLI's settings name. */
export function whereFor(pane: string | undefined, owner: typeof paneOwner = paneOwner): Where {
  const found = pane ? owner(pane) : null
  // What the daemon runs as (`wantedDaemonIdentity` in cli.ts): signed out, this computer's id. Signed out, the app made
  // harnesses and `harness new` refused to.
  const machineId = readAuthSession()?.machineId || computerId()
  return { port: found?.port ?? env.PORT, dataDir: found?.dataDir ?? env.ADAPTER_DATA_DIR, machineId,
    harnessPane: !!found || (!!pane && pane.startsWith('p') && sendPane({ HARNESS_PANE: pane }) === pane) }
}

/** The Unix socket on macOS/Linux, or the authenticated daemon pipe on Windows. Neither falls back to the port:
 *  its listener may belong to another OS user or outlive a stale daemon record (lib/localTransport.ts). */
export async function connectSocket(where: Where, options: LocalDaemonOptions = {}): Promise<ClientSocket> {
  if ((options.platform ?? process.platform) === 'win32') {
    const target = await (options.pipe ?? daemonPipe)(where.dataDir, where.port)
    if (!target) throw new AgentClientError('DAEMON_UNREACHABLE', daemonUnreachableText(null, where.dataDir))
    return pipeWebSocket(target)
  }
  const target = localWsTarget(where.dataDir, where.port)
  return new WebSocket(target.url, { headers: target.headers })
}

export const DEFAULT_TIMEOUT_MS = 20_000

/** Opens a line to [machineId] (this machine when left out) through [where]'s daemon. */
export async function openDaemon(where: Where, machineId: string = where.machineId, connect: Connect = connectSocket): Promise<Daemon> {
  if (!where.machineId) throw new AgentClientError('NOT_SIGNED_IN', 'This computer has no Harness machine id yet. Run `harness login`.')
  const socket = await connect(where)
  return new Promise((resolveOpen, rejectOpen) => {
    const waiting = new Map<string, { done: (payload: Record<string, unknown>) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
    let ready = false, closed = false
    let heard: ((agentId: string, event: PushedEvent) => void) | null = null
    const failAll = (error: AgentClientError): void => {
      closed = true
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.fail(error) }
      waiting.clear()
      if (!ready) rejectOpen(error)
    }
    socket.on('error', (error) => failAll(new AgentClientError('DAEMON_UNREACHABLE', daemonUnreachableText(error, where.dataDir))))
    socket.on('close', (code) => failAll(code === 4404
      ? new AgentClientError('NO_PEER_LINK', 'That machine is not linked to this one. Run `harness link` first.')
      // Too big for the transport itself (past its ceiling the daemon never reads the frame to say so).
      : code === 1009 ? new AgentClientError('REQUEST_TOO_LARGE', refusedLineText(undefined))
        : new AgentClientError('DISCONNECTED', 'The connection to Harness closed.')))
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    socket.on('message', (raw, binary) => {
      if (binary) return
      let frame: { type?: string; agentId?: unknown; payload?: Record<string, unknown> }
      try { frame = JSON.parse(raw.toString()) } catch { return }
      // The daemon refused a frame too large for it, and closes the line: what waits on it hears why, with the daemon's own numbers.
      if (frame.type === 'frame_too_large') { failAll(new AgentClientError('REQUEST_TOO_LARGE', refusedLineText(frame.payload))); return }
      if (frame.type === 'machine_select_error') {
        failAll(new AgentClientError(String(frame.payload?.error ?? 'MACHINE_UNAVAILABLE'), 'That machine is not reachable now. `harness machines` lists which are online.'))
        socket.close()
        return
      }
      if (!ready && frame.type === 'connected') {
        ready = true
        const request: Daemon['request'] = (type, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((done, fail) => {
          if (closed) { fail(new AgentClientError('DISCONNECTED', 'The connection to Harness closed.')); return }
          const requestId = randomUUID()
          const text = JSON.stringify({ type, payload: { ...payload, requestId } })
          // Past what the daemon's socket takes, said here with its size: sent, the daemon would refuse it and close the line.
          const bytes = Buffer.byteLength(text)
          if (bytes > LOCAL_JSON_MAX_BYTES) { fail(new AgentClientError('REQUEST_TOO_LARGE', tooLargeText(bytes))); return }
          const timer = setTimeout(() => {
            waiting.delete(requestId)
            fail(new AgentClientError('TIMEOUT', `Harness did not answer ${type} in time. Try again.`))
          }, timeoutMs)
          waiting.set(requestId, { done, fail, timer })
          socket.send(text)
        })
        resolveOpen({
          machineId,
          close: () => { closed = true; socket.close() },
          request,
          watch: async (agentIds, listener) => {
            // Listening before the daemon answers: a change pushed between its answer and the caller's next look is kept.
            heard = listener
            const reply = await request('agents_watch', { agentIds })
            if (reply.ok === true) return true
            heard = null
            return false
          },
          harnessWatch: async (agentIds, listener) => {
            heard = listener
            return await request('harness_watch', { agentIds })
          },
        })
        return
      }
      const requestId = frame.payload?.requestId
      const entry = typeof requestId === 'string' ? waiting.get(requestId) : undefined
      if (!entry) {
        // A question's own requestId is the daemon's, never one of ours.
        const agentId = frame.agentId ?? frame.payload?.agentId
        if (heard && PUSHED.has(frame.type ?? '') && typeof agentId === 'string' && agentId) heard(agentId, { type: frame.type!, payload: frame.payload ?? {} })
        return
      }
      waiting.delete(requestId as string)
      clearTimeout(entry.timer)
      // A refusal is an answer: the caller reads `error` itself, as each request's codes mean different things.
      entry.done(frame.payload!)
    })
  })
}
