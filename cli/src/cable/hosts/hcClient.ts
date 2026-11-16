/**
 * Herdr Core's socket (hc, docs/plans/2026-11-16-herdr-app-design.md): the terminals Herdr's window shows, their status,
 * and the dial's words, for the hc source and the Herdr adapter. hc is the core the Herdr app runs its terminals in, a
 * program of its own with its own API: not herdr 0.8.0, the older multiplexer herdrClient.ts speaks to. JSON-RPC 2.0,
 * one message a line. A request is one connection; a subscription is a connection of its own that writes `hello` and
 * `events.subscribe` together, then only reads.
 *
 * Everything is checked here. The socket is another program's: it must be this user's before anything connects, a line
 * has a bound, an answer counts only under its own id, and an error only by its kind, never by its message. The address
 * came from a hook or from hc and the text from the dial, so each is held to its form before it goes out.
 *
 * A prompt reads the terminal first. Only a fresh read says which program it runs now, and hc's `if` can refuse one that
 * is no longer idle but has no word for done. A send that timed out is never sent again: hc's manual says it may still
 * arrive, and a second one would be typed twice.
 *
 * Nothing here logs: hc's answers name people's folders and agents, and the source says what happened in its own fixed
 * words.
 */
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { HERDR_KIND } from './herdrClient.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS } from './orca.js'
import { connectLines, socketStampOf } from './unixSocket.js'

/** hc's address of a terminal of this machine, `t7`, `t1b`: never another machine's `vps/t7`. */
export const HC_TERMINAL = /^t[0-9][0-9a-z]{0,15}$/
/** hc's heartbeat comes every 15 s: three missed is a core that stopped talking. */
export const HC_SILENCE_MS = 45_000
/** hc holds a send up to 60 s behind a person's unfinished draft, then waits for about 3 s of quiet (5.2 s in all on an
 *  idle agent in the recording): a margin over both. */
export const HC_SEND_MS = 75_000
/** The most terminals a subscription keeps. */
export const HC_MAX_TERMINALS = 1024
/** A line's bound on every connection to hc. Its snapshot is one line with every terminal of the core (hidden workers,
 *  other machines' terminals, each command line twice), several times herdr's 1 MiB on a busy core; a `doc` line holds
 *  no document (F5). */
const HC_LINE_BYTES = 8 * 1024 * 1024
/** The key a hooked copy and a listed copy of one agent share (registry.ts). */
export const hcPaneKey = (address: string): string => `herdr-app:${address}`

/** A session's name as one folder's name: another (`..`, `a/b`) would make a path out of hc's folder. */
const HC_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** hc's error kinds, `not_found`: any other text is no kind of hc's, and is not passed on. */
const HC_ERROR_KIND = /^[a-z_]{1,64}$/
/** hc's `app` words that name an engine by another word. `codex` and `pi` are their engines' own. */
const KINDS: Record<string, string> = { 'claude-code': 'claude' }

export interface HcClientDeps { socketPath: string; home: string; uid: number; platform: NodeJS.Platform }

/** Where hc listens, as hc 0.1.21 works it out from the same environment (Task 1, F1). A relative or empty folder counts
 *  as unset: it would be the daemon's folder, not hc's. */
export function hcSocketPath(vars: NodeJS.ProcessEnv, home: string): string {
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : undefined)
  const socket = absolute(vars.HC_SOCKET)
  if (socket) return socket
  const session = vars.HC_SESSION && HC_SESSION.test(vars.HC_SESSION) ? vars.HC_SESSION : 'default'
  const runtime = absolute(vars.XDG_RUNTIME_DIR)
  if (runtime) return join(runtime, 'herdr-core', `${session}.sock`)
  return join(absolute(vars.XDG_STATE_HOME) ?? join(home, '.local', 'state'), 'herdr-core', session, `${session}.sock`)
}

export function hcClientDeps(): HcClientDeps {
  const home = homedir()
  return { socketPath: hcSocketPath(process.env, home), home, uid: process.getuid?.() ?? -1, platform: process.platform }
}

/** hc's `app` word as an engine's kind: the table, else its own word when it fits HERDR_KIND. */
export function hcKind(app: unknown): string | undefined {
  if (typeof app !== 'string') return undefined
  if (Object.hasOwn(KINDS, app)) return KINDS[app]
  return HERDR_KIND.test(app) ? app : undefined
}

export type HcStatus = 'idle' | 'working' | 'done' | 'blocked' | 'error'
const STATUSES: ReadonlySet<unknown> = new Set<HcStatus>(['idle', 'working', 'done', 'blocked', 'error'])

/** Why a connection gave no answer, or a subscription ended: the word its log line says. `rejected` is hc's own refusal. */
export type HcFault = 'no_socket' | 'refused' | 'timeout' | 'ended' | 'oversize' | 'bad_json' | 'bad_answer' | 'rejected'
/** Why a request has no result: the client's own word, or hc's refusal with hc's kind beside it. Kept apart, no kind of
 *  hc's reads as one of the client's words: a core that answers `no_socket` has a socket. */
export type HcFailure = { fault: Exclude<HcFault, 'rejected'> } | { fault: 'rejected'; kind: string }
export type HcAnswer = { ok: true; result: Record<string, unknown> } | ({ ok: false } & HcFailure)
/** A prompt not sent says why: as a request does, or that the client would not send it (`bad_request`), or that the
 *  terminal runs no agent of that kind now (`not_that_agent`). */
export type HcPrompt = { outcome: 'sent' | 'busy' }
  | ({ outcome: 'failed' } & (HcFailure | { fault: 'bad_request' | 'not_that_agent' }))

/** A terminal of this machine as hc tells it, each field checked. */
export interface HcTerminal {
  address: string
  live: boolean
  /** Its labels hold `herdr.space`: Herdr's window shows it. */
  space: boolean
  status?: HcStatus
  kind?: string
  name?: string
  cwd?: string
}

export interface HcSubscriber {
  /** hc's snapshot, at the start and after `missed`: every terminal of this machine in it. It replaces what was told. */
  snapshot(terminals: readonly HcTerminal[]): void
  /** One terminal as it is after a change; `live: false` once it finished or was removed. */
  changed(terminal: HcTerminal): void
  closed(reason: HcFault): void
}

export interface HcClient {
  request(method: string, params: Record<string, unknown>, deadlineMs?: number): Promise<HcAnswer>
  subscribe(to: HcSubscriber): { close(): void }
  prompt(address: string, kind: string, text: string): Promise<HcPrompt>
  /** The socket's inode and change time while it is a socket of this user's; else none. */
  socketStamp(): string | undefined
}

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A line's object, or none for a line that is no JSON object. */
const parse = (text: string): Fields | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** hc's terminal, read: none for another machine's, or one with no address in its form. Its folder is its foreground's
 *  when hc knows one: a person may `cd` before they start an agent. */
export function hcTerminal(value: unknown): HcTerminal | undefined {
  if (!isObject(value) || typeof value.address !== 'string' || !HC_TERMINAL.test(value.address)) return undefined
  const labels = isObject(value.labels) ? value.labels : {}
  const space = Object.hasOwn(labels, 'herdr.space') ? labels['herdr.space'] : undefined
  const status = isObject(value.status) ? value.status : {}
  const kind = hcKind(status.app)
  const foreground = isObject(value.foreground) ? value.foreground : {}
  const cwd = typeof foreground.cwd === 'string' ? foreground.cwd : value.cwd
  return {
    address: value.address,
    live: value.state === 'live',
    space: typeof space === 'string' && space !== '',
    ...(STATUSES.has(status.state) ? { status: status.state as HcStatus } : {}),
    ...(kind ? { kind } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  }
}

/** What a subscription keeps of a terminal, for up to HC_MAX_TERMINALS of them: the fields hcTerminal reads, an
 *  object's own narrowed to the keys it reads. A terminal's command line (in it and in its foreground), its title and a
 *  status's records are left in the line they came in. */
const READ: Record<string, readonly string[] | undefined> = {
  address: undefined, state: undefined, name: undefined, cwd: undefined,
  labels: ['herdr.space'], status: ['app', 'state'], foreground: ['cwd'],
}
const only = (value: unknown, keys: readonly string[]): unknown => isObject(value)
  ? Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
  : value
const factsOf = (value: Fields): Fields => Object.fromEntries(Object.entries(READ)
  .filter(([key]) => Object.hasOwn(value, key))
  .map(([key, keys]) => [key, keys ? only(value[key], keys) : value[key]]))

/** How each kind of event changes its terminal's fields, as Task 1 recorded them (F5); what is kept of them is
 *  `factsOf`'s. `removed` is the subscription's own. Every other kind (`turn`, `title`, `keep`, `doc`, `size`, one hc
 *  adds later) changes nothing. */
const whole = (facts: Fields, data: Fields): Fields => ({ ...facts, ...data })
const TAKES: Record<string, (facts: Fields, data: Fields) => Fields> = {
  created: whole,
  // Not recorded (F8): read as the terminal's own fields they name, as `created`'s are.
  lost: whole,
  restarted: whole,
  status: (facts, data) => ({ ...facts, status: data.status }),
  labels: (facts, data) => ({ ...facts, labels: data.labels }),
  foreground: (facts, data) => ({ ...facts, foreground: data }),
  // Its line names no state: the exit's code, signal and reason.
  finished: (facts) => ({ ...facts, state: 'finished' }),
}

const same = (a: HcTerminal, b: HcTerminal) => a.live === b.live && a.space === b.space && a.status === b.status
  && a.kind === b.kind && a.name === b.name && a.cwd === b.cwd

const lineOf = (id: string, method: string, params: Record<string, unknown>) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`

const answerOf = (body: Fields, id: string): HcAnswer => {
  if (body.id !== id) return { ok: false, fault: 'bad_answer' }
  if (isObject(body.result)) return { ok: true, result: body.result }
  const kind = isObject(body.error) && isObject(body.error.data) ? body.error.data.kind : undefined
  return typeof kind === 'string' && HC_ERROR_KIND.test(kind)
    ? { ok: false, fault: 'rejected', kind }
    : { ok: false, fault: 'bad_answer' }
}

/** A request's failure, as the prompt's. */
const failed = (answer: HcFailure): HcPrompt => answer.fault === 'rejected'
  ? { outcome: 'failed', fault: 'rejected', kind: answer.kind }
  : { outcome: 'failed', fault: answer.fault }

export function createHcClient(deps: HcClientDeps): HcClient {
  // Herdr's window, and hc's socket as this client speaks it, are tried on macOS only.
  const socketStamp = (): string | undefined =>
    deps.platform === 'darwin' ? socketStampOf(deps.socketPath, deps.uid) : undefined

  const request = (method: string, params: Record<string, unknown>, deadlineMs = RUN_TIMEOUT_MS) =>
    new Promise<HcAnswer>((resolve) => {
      if (!socketStamp()) return resolve({ ok: false, fault: 'no_socket' })
      const id = randomUUID()
      let done = false
      const finish = (answer: HcAnswer) => {
        if (done) return
        done = true
        clearTimeout(deadline)
        socket.destroy()
        resolve(answer)
      }
      const deadline = setTimeout(() => finish({ ok: false, fault: 'timeout' }), deadlineMs)
      deadline.unref()
      const socket = connectLines(deps.socketPath, lineOf(id, method, params), HC_LINE_BYTES, (text) => {
        const body = parse(text)
        finish(body ? answerOf(body, id) : { ok: false, fault: 'bad_json' })
      }, (fault) => finish({ ok: false, fault }))
    })

  const subscribe = (to: HcSubscriber): { close(): void } => {
    let over = false
    let socket: Socket | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    // `closed` is told once, and the caller's own close tells nothing.
    const end = (reason?: HcFault) => {
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
    const hello = randomUUID()
    const subscription = randomUUID()
    let step: 'hello' | 'subscribe' | 'live' = 'hello'
    // Each terminal's facts and what was told of it, so an event that names one fact tells the whole terminal.
    let kept = new Map<string, { facts: Fields; told: HcTerminal }>()
    // The last snapshot's seq: an event at or below it is already in it.
    let since = 0

    const snapshot = (seq: unknown, terminals: unknown): boolean => {
      if (typeof seq !== 'number' || !Array.isArray(terminals)) return false
      since = seq
      kept = new Map()
      for (const terminal of terminals) {
        if (kept.size >= HC_MAX_TERMINALS) break
        const told = hcTerminal(terminal)
        if (told) kept.set(told.address, { facts: factsOf(terminal as Fields), told })
      }
      to.snapshot([...kept.values()].map(({ told }) => told))
      return true
    }

    const event = (params: Fields) => {
      const { seq, terminal: address, type } = params
      if (typeof seq !== 'number' || seq <= since || typeof address !== 'string' || typeof type !== 'string') return
      const was = kept.get(address)
      if (type === 'removed') {
        if (!was) return
        kept.delete(address)
        return to.changed({ ...was.told, live: false })
      }
      if (!Object.hasOwn(TAKES, type)) return
      // Only `created` brings a terminal not kept: the rest name facts of one this client never read whole.
      if (!was && (type !== 'created' || kept.size >= HC_MAX_TERMINALS)) return
      const facts = factsOf({ ...TAKES[type](was?.facts ?? {}, isObject(params.data) ? params.data : {}), address })
      const told = hcTerminal(facts)
      if (!told) return
      kept.set(address, { facts, told })
      // hc writes a status line for each report, its last word again too, and a foreground line for each program a
      // shell runs (F5): only a change of what is told is told.
      if (!was || !same(was.told, told)) to.changed(told)
    }

    const line = (text: string) => {
      if (step === 'live') deadline?.refresh()
      const body = parse(text)
      if (!body) return end('bad_json')
      if (step === 'live') {
        const params = isObject(body.params) ? body.params : {}
        if (body.method === 'missed') {
          if (!snapshot(params.seq, params.terminals)) end('bad_answer')
        } else if (body.method === 'event') event(params)
        // A heartbeat, and a notification of a kind hc adds later, tell nothing.
        return
      }
      // hc answers a connection's requests in order (F4): `hello`'s first, then `events.subscribe`'s.
      if (step === 'hello') {
        const answer = answerOf(body, hello)
        // A core of another generation speaks another API: neither its refusal nor its answer is one this client reads.
        if (!answer.ok) return end(answer.fault === 'rejected' && answer.kind === 'unsupported_generation' ? 'bad_answer' : answer.fault)
        if (answer.result.generation !== 1) return end('bad_answer')
        step = 'subscribe'
        return
      }
      const answer = answerOf(body, subscription)
      if (!answer.ok) return end(answer.fault)
      step = 'live'
      // A live subscription hears hc's heartbeat at least, so silence is a core that stopped.
      clearTimeout(deadline)
      deadline = setTimeout(() => end('timeout'), HC_SILENCE_MS)
      deadline.unref()
      if (!snapshot(answer.result.seq, answer.result.terminals)) end('bad_answer')
    }

    deadline = setTimeout(() => end('timeout'), RUN_TIMEOUT_MS)
    deadline.unref()
    const out = `${lineOf(hello, 'hello', { generation: 1 })}${lineOf(subscription, 'events.subscribe', {})}`
    socket = connectLines(deps.socketPath, out, HC_LINE_BYTES, line, (fault) => end(fault))
    return handle
  }

  const prompt = async (address: string, kind: string, text: string): Promise<HcPrompt> => {
    // A newline would submit part of the text and an escape would steer the agent's screen: hc types the text as it is.
    const line = text.replace(CONTROL, ' ')
    // A text that is blank once its control characters are spaces (a transcript of newlines) has nothing to type.
    if (!HC_TERMINAL.test(address) || !HERDR_KIND.test(kind) || text.length > MAX_TEXT || line.trim() === '') {
      return { outcome: 'failed', fault: 'bad_request' }
    }
    const read = await request('terminal.get', { terminal: address })
    if (!read.ok) return failed(read)
    const terminal = hcTerminal(read.result)
    if (terminal?.address !== address) return { outcome: 'failed', fault: 'bad_answer' }
    if (!terminal.live || terminal.kind !== kind) return { outcome: 'failed', fault: 'not_that_agent' }
    if (terminal.status !== 'idle' && terminal.status !== 'done') return { outcome: 'busy' }
    // `if: "idle"` has hc refuse a terminal that went working since the read. Never `force`: it would type into a
    // program waiting on its own dialog.
    const sent = await request('terminal.send', {
      terminal: address, text: line, ...(terminal.status === 'idle' ? { if: 'idle' } : {}),
    }, HC_SEND_MS)
    if (sent.ok) return { outcome: 'sent' }
    return sent.fault === 'rejected' && sent.kind === 'status_mismatch' ? { outcome: 'busy' } : failed(sent)
  }

  return { request, subscribe, prompt, socketStamp }
}
