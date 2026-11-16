/**
 * herdr's socket (docs/specs/2026-11-16-device-herdr.md): its agents, their status, and the dial's words, for the herdr
 * adapter and the herdr source. Newline-delimited JSON, one request a connection, and a subscription on a connection of
 * its own that is never written to again: herdr 0.8.0 ends a subscription sent a second request.
 *
 * Everything is checked here. The socket is another program's: it must be this user's before anything connects, a line
 * has a bound, and a request's answer counts only under its own id. The pane id came from a hook or from herdr and the text from
 * the dial, so each is held to its form before it goes out.
 *
 * A prompt reads the pane again first. herdr types into a working agent as readily as into an idle one: in the spike the
 * agent's Enter was lost and the text joined its next prompt. herdr has no prompt that waits for idle, so the read
 * narrows that to one round trip.
 *
 * Nothing here focuses a pane, which stays `herdr agent focus` (herdr.ts), or keeps state per pane. Nothing here logs:
 * herdr's answers name people's folders and agents, and the source says what happened in its own fixed words.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, watch, type FSWatcher } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS } from './orca.js'

/** herdr's pane id, `w1:p1` (its own guide). */
export const HERDR_PANE = /^w[0-9]{1,9}:p[0-9]{1,9}$/
/** An agent's kind as herdr names it: `claude`, `codex`, … */
export const HERDR_KIND = /^[a-z][a-z0-9_-]{0,31}$/
/** The longest line read from herdr. A list of 64 agents is a few dozen KiB; a line that keeps coming is not herdr. */
export const MAX_LINE_BYTES = 1024 * 1024
/** herdr's own error codes, `agent_not_found`: any other text is no code of herdr's, and is not passed on. */
const HERDR_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The key a hooked copy and a listed copy of one agent share (registry.ts). */
export const herdrPaneKey = (paneId: string): string => `herdr:${paneId}`

export interface HerdrClientDeps { socketPath: string; home: string; uid: number; platform: NodeJS.Platform }

/** Where herdr's server listens, as herdr works it out from the same environment. A relative XDG_CONFIG_HOME counts as
 *  unset, as the XDG rule says: it would be the daemon's folder, not herdr's. */
export function herdrSocketPath(vars: NodeJS.ProcessEnv, home: string): string {
  const config = vars.XDG_CONFIG_HOME && isAbsolute(vars.XDG_CONFIG_HOME) ? vars.XDG_CONFIG_HOME : join(home, '.config')
  return join(config, 'herdr', 'herdr.sock')
}

export function herdrClientDeps(): HerdrClientDeps {
  const home = homedir()
  return { socketPath: herdrSocketPath(process.env, home), home, uid: process.getuid?.() ?? -1, platform: process.platform }
}

/** Why a connection gave no answer, or a subscription ended: the word its log line says. `rejected` is herdr's own
 *  refusal. */
export type HerdrFault = 'no_socket' | 'refused' | 'timeout' | 'ended' | 'oversize' | 'bad_json' | 'bad_answer' | 'rejected'
/** Why a request has no result: the client's own word, or herdr's refusal with herdr's code beside it. Kept apart, no code
 *  of herdr's reads as one of the client's words: a herdr that answers `no_socket` has a socket. */
export type HerdrFailure = { fault: Exclude<HerdrFault, 'rejected'> } | { fault: 'rejected'; code: string }
export type HerdrAnswer = { ok: true; result: Record<string, unknown> } | ({ ok: false } & HerdrFailure)
/** A prompt not sent says why: as a request does, or that the client would not send it (`bad_request`), or that the pane
 *  holds another kind (`not_that_agent`). */
export type HerdrPrompt = { outcome: 'sent' | 'busy' }
  | ({ outcome: 'failed' } & (HerdrFailure | { fault: 'bad_request' | 'not_that_agent' }))
export type HerdrEntry = { type: 'pane.agent_detected' | 'pane.closed' | 'pane.exited' } | { type: 'pane.agent_status_changed'; pane_id: string }
export interface HerdrSubscriber {
  started(): void
  event(name: string, data: Record<string, unknown>): void
  closed(reason: HerdrFault): void
}
export interface HerdrClient {
  request(method: string, params: Record<string, unknown>): Promise<HerdrAnswer>
  subscribe(entries: readonly HerdrEntry[], to: HerdrSubscriber): { close(): void }
  prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
  /** The socket's inode and change time while it is a socket of this user's; else none. */
  socketStamp(): string | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A line's object, or none for a line that is no JSON object. */
const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const answerOf = (body: Record<string, unknown>, id: string): HerdrAnswer => {
  if (body.id === id && isObject(body.result)) return { ok: true, result: body.result }
  // herdr answers a request it could not read under "", as the spike saw.
  if ((body.id === id || body.id === '') && isObject(body.error)) {
    const code = body.error.code
    return typeof code === 'string' && HERDR_CODE.test(code)
      ? { ok: false, fault: 'rejected', code }
      : { ok: false, fault: 'bad_answer' }
  }
  return { ok: false, fault: 'bad_answer' }
}

/** A request's failure, as the prompt's. */
const failed = (answer: HerdrFailure): HerdrPrompt => answer.fault === 'rejected'
  ? { outcome: 'failed', fault: 'rejected', code: answer.code }
  : { outcome: 'failed', fault: answer.fault }

/**
 * One connection that writes `out` once connected, and tells each line that comes back, in order, until the socket is
 * destroyed. `end` is told why it ended: a line past MAX_LINE_BYTES as soon as it is past, before the rest is read; a
 * connection that never opened; one that closed. Unref'd, as each deadline is: a herdr connection never keeps the
 * devices process up.
 */
function connect(
  path: string, out: string, line: (text: string) => void, end: (fault: 'refused' | 'ended' | 'oversize') => void,
): Socket {
  let opened = false
  let held: Buffer[] = []
  let size = 0
  const socket = createConnection({ path })
  socket.unref()
  socket.on('connect', () => {
    opened = true
    socket.write(out)
  })
  // The close that follows says it.
  socket.on('error', () => {})
  socket.on('close', () => end(opened ? 'ended' : 'refused'))
  socket.on('data', (chunk: Buffer) => {
    let from = 0
    while (!socket.destroyed) {
      const newline = chunk.indexOf(0x0a, from)
      const piece = chunk.subarray(from, newline === -1 ? chunk.length : newline)
      size += piece.length
      if (size > MAX_LINE_BYTES) return end('oversize')
      held.push(piece)
      if (newline === -1) return
      const text = Buffer.concat(held).toString('utf8')
      held = []
      size = 0
      from = newline + 1
      line(text)
    }
  })
  return socket
}

export function createHerdrClient(deps: HerdrClientDeps): HerdrClient {
  const socketStamp = (): string | undefined => {
    // herdr's socket on Windows is a named pipe, which this client does not speak.
    if (deps.platform === 'win32') return undefined
    try {
      const file = lstatSync(deps.socketPath, { bigint: true })
      return file.isSocket() && file.uid === BigInt(deps.uid) ? `${file.ino}:${file.ctimeNs}` : undefined
    } catch {
      return undefined
    }
  }

  const request = (method: string, params: Record<string, unknown>) => new Promise<HerdrAnswer>((resolve) => {
    if (!socketStamp()) return resolve({ ok: false, fault: 'no_socket' })
    const id = randomUUID()
    let done = false
    const finish = (answer: HerdrAnswer) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(answer)
    }
    const deadline = setTimeout(() => finish({ ok: false, fault: 'timeout' }), RUN_TIMEOUT_MS)
    deadline.unref()
    const socket = connect(deps.socketPath, `${JSON.stringify({ id, method, params })}\n`, (text) => {
      const body = parse(text)
      finish(body ? answerOf(body, id) : { ok: false, fault: 'bad_json' })
    }, (fault) => finish({ ok: false, fault }))
  })

  const subscribe = (entries: readonly HerdrEntry[], to: HerdrSubscriber): { close(): void } => {
    let over = false
    let started = false
    let socket: Socket | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    // `closed` is told once, and the caller's own close tells nothing.
    const end = (reason?: HerdrFault) => {
      if (over) return
      over = true
      clearTimeout(deadline)
      socket?.destroy()
      if (reason) to.closed(reason)
    }
    const handle = { close: () => end() }
    if (!socketStamp()) {
      // Told once the caller holds its close, as every other end is.
      queueMicrotask(() => end('no_socket'))
      return handle
    }
    deadline = setTimeout(() => end('timeout'), RUN_TIMEOUT_MS)
    deadline.unref()
    const id = randomUUID()
    const out = `${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: entries } })}\n`
    socket = connect(deps.socketPath, out, (text) => {
      const body = parse(text)
      if (!body) return end('bad_json')
      if (started) {
        // A line of another shape is no event this client knows: herdr may add some.
        if (typeof body.event === 'string' && isObject(body.data)) to.event(body.event, body.data)
        return
      }
      // The connection carries this one request, so its first line is the answer to it. A live subscription has no
      // deadline: herdr says nothing while nothing changes.
      const answer = answerOf(body, id)
      if (!answer.ok) return end(answer.fault)
      if (answer.result.type !== 'subscription_started') return end('bad_answer')
      started = true
      clearTimeout(deadline)
      to.started()
    }, (fault) => end(fault))
    return handle
  }

  const prompt = async (paneId: string, kind: string, text: string): Promise<HerdrPrompt> => {
    // A newline would submit part of the text and an escape would steer the agent's screen: herdr types the text as it is.
    const line = text.replace(CONTROL, ' ')
    // A text that is blank once its control characters are spaces (a transcript of newlines) has nothing to type.
    if (!HERDR_PANE.test(paneId) || !HERDR_KIND.test(kind) || text.length > MAX_TEXT || line.trim() === '') {
      return { outcome: 'failed', fault: 'bad_request' }
    }
    const read = await request('agent.get', { target: paneId })
    if (!read.ok) return failed(read)
    const agent: Record<string, unknown> = isObject(read.result.agent) ? read.result.agent : {}
    // Only this pane's agent_info says what the pane holds now.
    if (read.result.type !== 'agent_info' || agent.pane_id !== paneId) return { outcome: 'failed', fault: 'bad_answer' }
    if (agent.agent !== kind) return { outcome: 'failed', fault: 'not_that_agent' }
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return { outcome: 'busy' }
    const sent = await request('agent.prompt', { target: paneId, text: line })
    return sent.ok ? { outcome: 'sent' } : failed(sent)
  }

  return { request, subscribe, prompt, socketStamp }
}

/** Calls `changed` on each change in the nearest existing folder of `<config>/herdr`, `<config>` and `home`, moving
 *  to a nearer one as it appears, and out of one that is removed. Returns its stop. Never throws: a watch that cannot be
 *  held tells nothing. */
export function watchHerdrSocket(deps: Pick<HerdrClientDeps, 'socketPath' | 'home'>, changed: () => void): () => void {
  const folders = [dirname(deps.socketPath), dirname(dirname(deps.socketPath)), deps.home]
  let held: { watcher: FSWatcher; at: number } | undefined
  const hold = () => {
    // inotify ends the watch of a folder that is removed, so a herdr that made it again would never be seen.
    if (held && !existsSync(folders[held.at])) {
      held.watcher.close()
      held = undefined
    }
    for (let at = 0; at < (held?.at ?? folders.length); at++) {
      let watcher: FSWatcher
      try {
        watcher = watch(folders[at], { persistent: false }, () => {
          hold()
          changed()
        })
      } catch {
        continue
      }
      // A watch that fails tells nothing more, and throws nothing into the devices process. Its folder gone, it moves out.
      watcher.on('error', () => {
        watcher.close()
        hold()
      })
      held?.watcher.close()
      held = { watcher, at }
      return
    }
  }
  hold()
  return () => {
    held?.watcher.close()
    held = undefined
  }
}
