/**
 * `harness pair <verb>` and `harness pair mcp`: the control interface from a shell or an MCP client
 * (daemons/BRAIN.md, "Control interface"). Both speak the loopback `pair` request to this computer's
 * harnessd, introducing themselves as a TOOL (`machine_select { tool: true }`) so the daemon never mistakes
 * them for a person at a window: a tool is not presence, gets no daemon_* lines, and wakes no brain.
 *
 * Write verbs carry the pair harness's token (pair/token.ts) when this process has one; without it the
 * daemon refuses them (TOKEN_REQUIRED). The daemon decides everything; this file only asks.
 */
import { randomUUID } from 'node:crypto'
import { CONTROL_TOOLS } from './control.js'
import { harnessPaneEnv } from './learn/approval.js'
import { presentedToken } from './token.js'
import { HARNESS_SESSION_PREFIX } from '../lib/harnessSessionLabel.js'

export interface PairSocket {
  send(data: string): void
  close(): void
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown
  on(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface PairClientDeps {
  port: number
  /** This computer's machine id, as its daemon knows it; resolved from /api/status when absent. */
  machineId: () => Promise<string | null>
  connect: (url: string) => PairSocket
  env: NodeJS.ProcessEnv
  tokenFile?: string | null
  timeoutMs?: number
}

/** One `pair` request to this computer's daemon. Resolves its reply; rejects only when it cannot be asked. */
export async function pairRequest(deps: PairClientDeps, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const machineId = await deps.machineId()
  if (!machineId) throw new Error('Harness is not running on this computer. Start it with `harness start`.')
  const token = presentedToken(deps.env, deps.tokenFile)
  return new Promise((resolve, reject) => {
    const socket = deps.connect(`ws://127.0.0.1:${deps.port}/api/local-ws`)
    const requestId = randomUUID()
    let settled = false
    const finish = (error: Error | null, reply?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      if (error) reject(error); else resolve(reply!)
    }
    const timer = setTimeout(() => finish(new Error('Harness did not answer in time.')), deps.timeoutMs ?? 60_000)
    socket.on('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, tool: true } })))
    socket.on('error', (error) => finish(error))
    socket.on('close', (code, reason) => finish(new Error(`The connection to Harness closed (${code}${reason.toString() ? `: ${reason.toString()}` : ''}).`)))
    socket.on('message', (data) => {
      let frame: { type?: string; payload?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame.type === 'connected') {
        socket.send(JSON.stringify({ type: 'pair', payload: { ...payload, ...(token ? { token } : {}), requestId } }))
        return
      }
      if (frame.type === 'pair_result' && frame.payload?.requestId === requestId) {
        const { requestId: _id, ...reply } = frame.payload
        finish(null, reply)
      }
    })
  })
}

// ── `harness pair <verb>` ─────────────────────────────────────────────────────────────────────────────

/** `talk` is not one: the person talks to their daemon from a window (`daemon_talk`), never from a tool. */
export const PAIR_CLI_VERBS = new Set([...CONTROL_TOOLS.map((tool) => tool.name), 'status', 'journal', 'mcp', 'lessons'])
export const LESSON_ACTIONS = ['list', 'show', 'approve', 'skip', 'revert', 'restore', 'export'] as const
/** Lesson actions that need the person: a challenge, the daemon's one-time nonce, a yes at the terminal. */
const PERSON_LESSON_ACTIONS = new Set(['approve', 'restore', 'export'])

/** `list-harnesses` and `list_harnesses` are the same verb. */
export function pairVerb(word: string | undefined): string | null {
  const verb = (word ?? '').replace(/-/g, '_')
  return PAIR_CLI_VERBS.has(verb) ? verb : null
}

export const PAIR_USAGE = [
  'Usage: harness pair <verb> [arguments] [--json]',
  '',
  '  Reads (anyone on this computer):',
  '    status                                 is pairing on, and with which daemon',
  '    list_machines                          the machines the daemon can see',
  '    list_harnesses [--machine <id>]        every harness, its status and open question',
  '    read_harness <agentId> [--machine id]  one harness: question, options, recaps, asks',
  '    brief [--since <minutes>]              what happened since then, on every machine',
  '',
  '  Writes (the pair harness only: HARNESSD_PAIR_TOKEN; the autonomy dial decides the rest):',
  '    answer_question <agentId> <requestId> <choice> [--machine id]',
  '    send_prompt <agentId> <text…> [--machine id]',
  '    stop_turn <agentId> [--machine id]',
  '    start_harness <engine> <folder> [--name n] [--machine id] [-- first prompt…]',
  '    pause_harness <agentId> [--machine id]   stop its process, keep its conversation',
  '    resume_harness <agentId> [--machine id]',
  '    say <line…>                            one line in the status line (rate-limited)',
  '',
  '  (talk to your daemon from a window: a talk is a model turn, and only a window is you)',
  '',
  '  Lessons (daemons/LEARNING.md; the lessons folder, ~/.harness/lessons):',
  '    lessons [list]                         every lesson: pending, approved, reverted, skipped',
  '    lessons show <id>                      its SKILL.md or note, with where it came from',
  '    lessons approve <id> [--create]        teach it (asks you at a terminal outside Harness; --create writes a new',
  '                                           AGENTS.md for a note, in a project opted in with learn.agentsMd)',
  '    lessons skip <id>                      drop a pending lesson; it is never proposed again',
  '    lessons revert <id>                    git revert of its commit, and unpublished',
  '    lessons restore <id>                   bring back a skill the curator archived (asks you first)',
  '    lessons export [--dry-run]             write approved skills where pair.jsonc learn.export says (asks you first)',
  '  mcp [--token-file <path>]                a stdio MCP server named harnessd with the same tools',
  '',
  '  --json   one JSON line (the default prints it indented)',
].join('\n')

export class PairUsageError extends Error {}

/** The `pair` payload for a verb and its words. Throws PairUsageError on a missing argument. */
export function parsePairArgs(verb: string, argv: string[]): { payload: Record<string, unknown>; json: boolean } {
  const words: string[] = []
  const options: Record<string, string> = {}
  let json = false
  let tail: string[] | null = null
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--') { tail = argv.slice(i + 1); break }
    if (word === '--json') { json = true; continue }
    if (word === '--create' && verb === 'lessons') { options.create = 'true'; continue }
    if (word === '--dry-run' && verb === 'lessons') { options.dryRun = 'true'; continue }
    const flag = /^--(machine|since|name|prompt|token-file)(?:=(.*))?$/.exec(word)
    if (flag) {
      const value = flag[2] ?? argv[++i]
      if (value === undefined) throw new PairUsageError(`--${flag[1]} needs a value.`)
      options[flag[1]!] = value
      continue
    }
    words.push(word)
  }
  const need = (n: number, what: string): void => { if (words.length < n) throw new PairUsageError(`${verb} needs ${what}.`) }
  const machine = options.machine ? { machineId: options.machine } : {}
  const rest = (from: number): string => [...words.slice(from), ...(tail ?? [])].join(' ').trim()
  let payload: Record<string, unknown>
  switch (verb) {
    case 'status': case 'list_machines': case 'journal': payload = { verb }; break
    case 'list_harnesses': payload = { verb, ...machine }; break
    case 'read_harness': case 'stop_turn': case 'pause_harness': case 'resume_harness':
      need(1, 'an agent id'); payload = { verb, agentId: words[0], ...machine }; break
    case 'brief': {
      const since = options.since !== undefined ? Number(options.since) : undefined
      if (since !== undefined && !Number.isFinite(since)) throw new PairUsageError('--since takes minutes.')
      payload = { verb, ...(since !== undefined ? { sinceMinutes: since } : {}) }
      break
    }
    case 'answer_question':
      need(3, 'an agent id, the question\'s requestId and a choice')
      payload = { verb, agentId: words[0], requestId: words[1], choice: rest(2), ...machine }
      break
    case 'send_prompt':
      need(1, 'an agent id')
      payload = { verb, agentId: words[0], text: rest(1), ...machine }
      if (!payload.text) throw new PairUsageError('send_prompt needs the text to send.')
      break
    case 'start_harness':
      need(2, 'an engine and a folder')
      payload = { verb, engine: words[0], cwd: words[1], ...(options.name ? { name: options.name } : {}), ...machine }
      if (rest(2) || options.prompt) payload.prompt = options.prompt ?? rest(2)
      break
    case 'lessons': {
      const action = words[0] ?? 'list'
      if (!(LESSON_ACTIONS as readonly string[]).includes(action)) throw new PairUsageError(`lessons has no "${action}" (${LESSON_ACTIONS.join(', ')}).`)
      if (action !== 'list' && action !== 'export' && !words[1]) throw new PairUsageError(`lessons ${action} needs a lesson id (harness pair lessons list).`)
      payload = {
        verb, action, ...(words[1] && action !== 'export' ? { id: words[1] } : {}),
        ...(options.create && action === 'approve' ? { create: true } : {}),
        ...(options.dryRun && action === 'export' ? { dryRun: true } : {}),
      }
      break
    }
    case 'say': {
      const text = rest(0)
      if (!text) throw new PairUsageError(`${verb} needs words.`)
      payload = { verb, line: text }
      break
    }
    default: throw new PairUsageError(`pair has no verb "${verb}".`)
  }
  if (options['token-file']) payload.tokenFile = options['token-file']
  return { payload, json }
}

export interface PairCommandDeps extends PairClientDeps {
  output: (line: string) => void
  error: (line: string) => void
  /**
   * Ask the person at this terminal (y/N). Absent — no terminal, or an agent's shell tool — and
   * `lessons approve` refuses: nothing is taught without the person's yes.
   */
  confirm?: ((question: string) => Promise<boolean>) | null
  /** The tmux session this process runs in, when it runs in one (a harness pane is `harness-…`). */
  paneSession?: () => Promise<string | null>
}

/** Why this process is inside a harness, or null. The daemon checks again, and its answer is the one that counts. */
async function insideHarness(deps: PairCommandDeps): Promise<string | null> {
  const marker = harnessPaneEnv(deps.env)
  if (marker) return `${marker} is set: this shell runs inside a harness`
  const session = await deps.paneSession?.().catch(() => null)
  return session?.startsWith(HARNESS_SESSION_PREFIX) ? `this shell runs in the harness pane ${session}` : null
}

/**
 * `lessons approve <id>`, `restore <id>`, `export`: the person's alone (pair/learn/approval.ts). Refused inside
 * a harness; otherwise a challenge (the daemon verifies this process and hands it a one-time nonce with the
 * lesson, or the export plan), shown here, a yes at the terminal, and the action with that nonce.
 */
async function personLessonAction(deps: PairCommandDeps, payload: Record<string, unknown>, json: boolean): Promise<number> {
  const print = (reply: Record<string, unknown>): void => deps.output(json ? JSON.stringify(reply) : JSON.stringify(reply, null, 2))
  const action = String(payload.action)
  const inside = await insideHarness(deps)
  if (inside) {
    print({ ok: false, error: 'INSIDE_HARNESS', detail: `${inside}. ${action} is the person's: press [y] on the daemon's line, or run it in a terminal outside Harness` })
    return 1
  }
  if (!deps.confirm) {
    print({ ok: false, error: 'CONFIRM', detail: `${action} asks you at a terminal; run it in one, or press [y] on the daemon's line` })
    return 1
  }
  const challenge = await pairRequest(deps, { verb: 'lessons', action: 'challenge', for: action, ...(payload.id ? { id: payload.id } : {}) })
  if (typeof challenge.error === 'string' || typeof challenge.nonce !== 'string') { print(challenge); return 1 }
  const { nonce, expiresInMs: _expires, ...shown } = challenge
  deps.error(typeof shown.text === 'string' ? shown.text : JSON.stringify(shown, null, 2))
  const question = action === 'approve' ? `Teach lesson ${String(payload.id)} to your agents? [y/N] `
    : action === 'restore' ? `Restore lesson ${String(payload.id)}? [y/N] `
      : 'Export as shown? [y/N] '
  if (!(await deps.confirm(question))) {
    print({ ok: false, error: 'DECLINED' })
    return 1
  }
  const reply = await pairRequest(deps, { ...payload, nonce })
  print(reply)
  return typeof reply.error === 'string' ? 1 : 0
}

export async function pairCommand(argv: string[], deps: PairCommandDeps): Promise<number> {
  const verb = pairVerb(argv[0])
  if (!verb || argv.includes('--help') || argv.includes('-h')) {
    deps.output(PAIR_USAGE)
    return verb ? 0 : 2
  }
  let parsed: { payload: Record<string, unknown>; json: boolean }
  try { parsed = parsePairArgs(verb, argv.slice(1)) }
  catch (err) {
    if (!(err instanceof PairUsageError)) throw err
    deps.error(err.message)
    deps.error('')
    deps.error(PAIR_USAGE)
    return 2
  }
  const { tokenFile, ...payload } = parsed.payload
  try {
    if (verb === 'lessons' && PERSON_LESSON_ACTIONS.has(String(payload.action)) && payload.dryRun !== true) return await personLessonAction(deps, payload, parsed.json)
    const reply = await pairRequest({ ...deps, tokenFile: typeof tokenFile === 'string' ? tokenFile : deps.tokenFile }, payload)
    deps.output(parsed.json ? JSON.stringify(reply) : JSON.stringify(reply, null, 2))
    return typeof reply.error === 'string' ? 1 : 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.output(parsed.json ? JSON.stringify({ ok: false, error: 'UNREACHABLE', detail: message }) : message)
    return 1
  }
}
