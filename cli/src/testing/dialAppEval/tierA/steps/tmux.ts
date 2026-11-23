/**
 * Tier A's tmux (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decisions 5 and 6), the one model Orca's and iTerm2's
 * sessions run on. One server a world, launchd's child on no tty, at a made-up path. A tmux session a client tab
 * (`eval-<window>-<tab>`) or an Orca pane (`eval-<key>`), each one window with a pane a session in `split` order: the
 * pane's shell is the server's child on a tty of its own, the agent runs under it, and its id is the session's index in
 * the scenario (`%2`), the TMUX_PANE its hook sends. A client is a tmux process under its tab's (or Orca pane's) shell on
 * that tty, with the time it was used last. tmux ends a session with its last pane, its clients with it, and the server
 * with its last session.
 *
 * The world answers the devices' tmux runs (cable/hosts/tmux.ts) from this model, each `#{…}` of their formats filled
 * from it: a name it does not hold is a gap, as its answer would be made up.
 */
import { programOf } from '../../argv.js'
import { tabLabel } from '../../itermRecords.js'
import type { SessionDef, SessionKey } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { labelOf, selectedTab, tabShell } from './iterm.js'
import { nextTty, SHELLS, startProcess } from './sessions.js'

/** Where the eval's machine has tmux: the server and every client run it. */
export const TMUX = '/opt/eval/bin/tmux'

interface Pane { id: string; key: SessionKey; shell: number; tty?: string }
interface Session { name: string; panes: Pane[]; active: string }
/** used: when the person last typed in it, at virtual time. */
interface Client { pid: number; tty?: string; session: Session; used: number }
interface Model { server: number; sessions: Map<string, Session>; clients: Client[] }
const models = new WeakMap<TierAWorld, Model>()

type Answer = { code: number; stdout?: string }
const FAILED: Answer = { code: 1 }

/** The pane id of the session's tmux pane: its index in the scenario. */
export const tmuxPaneId = (world: TierAWorld, s: SessionDef): string => `%${world.scenario.sessions.indexOf(s)}`

function modelOf(world: TierAWorld): Model {
  let model = models.get(world)
  if (!model) models.set(world, model = { server: startProcess(world, 1, TMUX), sessions: new Map(), clients: [] })
  return model
}

/** The clients still running: one whose terminal closed under it (iterm.closeTab) is gone. */
function clientsOf(world: TierAWorld, model: Model): Client[] {
  return model.clients = model.clients.filter((client) => world.machine.processes.has(client.pid))
}

/** The person types in the client's terminal now. */
function use(world: TierAWorld, client: Client): void {
  client.used = Date.now()
  if (client.tty !== undefined) world.machine.atimes.set(client.tty, client.used)
}

/** A client of the session, started now under that shell on its terminal. */
function attach(world: TierAWorld, model: Model, session: Session, shell: number): void {
  const tty = world.machine.processes.get(shell)?.tty
  const client: Client = { pid: startProcess(world, shell, TMUX, tty), ...(tty === undefined ? {} : { tty }), session, used: 0 }
  use(world, client)
  model.clients.push(client)
}

/**
 * The session's tmux pane, made now: its shell on a terminal of its own, which the agent runs under. Its tmux session's
 * first pane starts that session with a client, under [client] when given (an Orca pane's shell), else under the
 * session's iTerm2 tab's.
 */
export function tmuxPane(world: TierAWorld, s: SessionDef, client?: number): { shell: number; tty: string | undefined; pane: string } {
  const model = modelOf(world)
  const name = s.app === 'iterm' ? `eval-${s.window!}-${s.tab!}` : `eval-${s.key}`
  const tty = nextTty(world)
  const pane: Pane = { id: tmuxPaneId(world, s), key: s.key, shell: startProcess(world, model.server, SHELLS[world.platform], tty),
    ...(tty === undefined ? {} : { tty }) }
  let session = model.sessions.get(name)
  if (!session) {
    model.sessions.set(name, session = { name, panes: [], active: pane.id })
    attach(world, model, session, client ?? tabShell(world, { window: s.window!, tab: s.tab! }).pid)
  }
  const split = (p: Pane): number => world.session(p.key).split ?? 0
  session.panes = [...session.panes, pane].sort((a, b) => split(a) - split(b))
  // A tmux run names the pane only where the devices found tmux: an iTerm2 scenario's machine (world.ts).
  if (world.machine.installed.has('tmux')) world.panes.set(pane.id, s.key)
  return { shell: pane.shell, tty, pane: pane.id }
}

/** The session's pane, when it runs in one, and its tmux session. */
function paneOf(world: TierAWorld, by: (pane: Pane) => boolean): { session: Session; pane: Pane } | undefined {
  for (const session of models.get(world)?.sessions.values() ?? []) {
    const pane = session.panes.find(by)
    if (pane) return { session, pane }
  }
  return undefined
}

function needPane(world: TierAWorld, key: SessionKey): { session: Session; pane: Pane } {
  const found = paneOf(world, (pane) => pane.key === key)
  if (!found) throw new Error(`scenario ${world.scenario.id}: ${key} runs in no tmux pane`)
  return found
}

/** The session's pane closes with its shell: its tmux session ends with its last pane, and the server with its last. */
export function closePane(world: TierAWorld, key: SessionKey): void {
  const model = models.get(world)
  const found = paneOf(world, (pane) => pane.key === key)
  if (!model || !found) return
  const { session, pane } = found
  world.machine.end(pane.shell)
  session.panes = session.panes.filter((p) => p !== pane)
  if (session.active === pane.id && session.panes.length) session.active = session.panes[0]!.id
  if (!session.panes.length) {
    for (const client of clientsOf(world, model)) if (client.session === session) world.machine.end(client.pid)
    model.sessions.delete(session.name)
  }
  if (model.sessions.size) return
  world.machine.end(model.server)
  models.delete(world)
}

/** Decision 6: a turn of the session typed while iTerm2's selected tab holds a client of its tmux session was typed
 *  through that client. */
export function typedThrough(world: TierAWorld, key: SessionKey): void {
  const model = models.get(world)
  const selected = selectedTab(world)
  const found = paneOf(world, (pane) => pane.key === key)
  if (!model || !selected || !found) return
  for (const client of clientsOf(world, model)) {
    if (client.session === found.session && client.tty !== undefined && labelOf(world, `/dev/${client.tty}`) === tabLabel(selected)) {
      use(world, client)
    }
  }
}

/** A pane's format names, as tmux fills them. No pane of the person's carries a daemon's tag or a start command. */
const paneNames = (session: Session, pane: Pane): Record<string, string> => ({
  pane_id: pane.id, pane_pid: String(pane.shell), pane_tty: pane.tty === undefined ? '' : `/dev/${pane.tty}`,
  pane_active: session.active === pane.id ? '1' : '0', pane_start_command: '', '@harness_daemon': '', session_name: session.name,
})
/** A client's, beside its session's active pane's. tmux names a client by its terminal, and gives its activity in seconds. */
const clientNames = (client: Client): Record<string, string> => {
  const tty = client.tty === undefined ? '' : `/dev/${client.tty}`
  const active = client.session.panes.find((pane) => pane.id === client.session.active)!
  return { ...paneNames(client.session, active), client_activity: String(Math.floor(client.used / 1000)), client_pid: String(client.pid),
    client_name: tty, client_tty: tty }
}

/** The index of the `}` closing the item whose body starts at [from]. */
function closing(format: string, from: number): number {
  let depth = 0
  for (let i = from; i < format.length; i++) {
    if (format.startsWith('#{', i)) {
      depth++
      i++
    } else if (format[i] === '}') {
      if (depth === 0) return i
      depth--
    }
  }
  throw new Error(`tier A: a tmux format with an unclosed item: ${format}`)
}

/** An item's body cut at its commas outside any `#{…}`. */
function parts(body: string): string[] {
  const cut: string[] = []
  let from = 0
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith('#{', i)) i = closing(body, i + 2)
    else if (body[i] === ',') {
      cut.push(body.slice(from, i))
      from = i + 1
    }
  }
  return [...cut, body.slice(from)]
}

/** fnmatch's `*` and `?`, as `#{m:…}` matches. */
const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's')

/** One `#{…}` item: a name, `?cond,yes,no`, `m:pattern,text` or `=width:…`, the forms tmux.ts sends. */
function item(world: TierAWorld, body: string, names: Record<string, string>): string {
  if (body.startsWith('?')) {
    const [cond = '', yes = '', no = ''] = parts(body.slice(1))
    // A bare name is looked up, as tmux does; anything else is a format.
    const value = cond.includes('#{') ? expand(world, cond, names) : item(world, cond, names)
    return expand(world, value !== '' && value !== '0' ? yes : no, names)
  }
  if (body.startsWith('m:')) {
    const [pattern = '', text = ''] = parts(body.slice(2))
    return glob(expand(world, pattern, names)).test(expand(world, text, names)) ? '1' : '0'
  }
  const width = /^=([0-9]+):(.*)$/s.exec(body)
  if (width) return item(world, width[2]!, names).slice(0, Number(width[1]))
  if (Object.hasOwn(names, body)) return names[body]!
  world.gap(`tier A does not model tmux format #{${body}}`)
  return ''
}

/** A format with each `#{…}` filled from [names]. */
function expand(world: TierAWorld, format: string, names: Record<string, string>): string {
  let out = ''
  for (let i = 0; i < format.length;) {
    if (format.startsWith('#{', i)) {
      const end = closing(format, i + 2)
      out += item(world, format.slice(i + 2, end), names)
      i = end + 1
    } else {
      out += format[i++]
    }
  }
  return out
}

/** The lines of a listing, each ended as tmux ends it. */
const lines = (rows: string[]): string => rows.map((row) => `${row}\n`).join('')

/** One tmux command: its flags, the value after each of -t, -F and -c, and the rest. */
function parse(args: readonly string[]): { name: string; flags: Set<string>; values: Map<string, string>; rest: string[] } {
  const [name = '', ...more] = args
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const rest: string[] = []
  for (let i = 0; i < more.length; i++) {
    const arg = more[i]!
    if (['-t', '-F', '-c'].includes(arg)) values.set(arg, more[++i] ?? '')
    else if (arg.startsWith('-')) flags.add(arg)
    else rest.push(arg)
  }
  return { name, flags, values, rest }
}

/** One tmux command, answered from the model. One the model does not hold is a gap. */
function command(world: TierAWorld, model: Model, args: readonly string[]): Answer {
  const { name, flags, values, rest } = parse(args)
  const target = values.get('-t')
  const found = target === undefined ? undefined : paneOf(world, (pane) => pane.id === target)
  if (target !== undefined && !found) return FAILED
  switch (name) {
    case 'display-message':
      if (!found || !flags.has('-p') || rest.length !== 1) break
      return { code: 0, stdout: lines([expand(world, rest[0]!, paneNames(found.session, found.pane))]) }
    case 'list-clients': {
      const format = values.get('-F')
      if (format === undefined) break
      const clients = clientsOf(world, model).filter((client) => !found || client.session === found.session)
      return { code: 0, stdout: lines(clients.map((client) => expand(world, format, clientNames(client)))) }
    }
    case 'list-panes': {
      const format = values.get('-F')
      if (format === undefined || !flags.has('-a')) break
      const panes = [...model.sessions.values()].flatMap((session) => session.panes.map((pane) => ({ session, pane })))
      return { code: 0, stdout: lines(panes.map(({ session, pane }) => expand(world, format, paneNames(session, pane)))) }
    }
    // Each session has one window: selecting it is selecting what it already shows.
    case 'select-window':
      if (!found) break
      return { code: 0 }
    case 'select-pane':
      if (!found) break
      found.session.active = found.pane.id
      return { code: 0 }
    // tmux makes the target pane active as it switches the client to its session.
    case 'switch-client': {
      if (!found) break
      const client = clientsOf(world, model).find((c) => c.tty !== undefined && `/dev/${c.tty}` === values.get('-c'))
      if (!client) return FAILED
      client.session = found.session
      found.session.active = found.pane.id
      return { code: 0 }
    }
  }
  world.gap(`tier A does not model tmux ${name}`)
  return FAILED
}

/** The world answers tmux's runs from the model: each command of a run in turn (`a ; b`), up to the first that fails.
 *  With no server running, tmux has nothing to answer. */
export function answerTmux(world: TierAWorld): void {
  world.answer((argv) => {
    if (programOf(argv) !== 'tmux') return undefined
    const model = models.get(world)
    if (!model) return FAILED
    const commands: string[][] = [[]]
    for (const arg of argv.slice(1)) {
      if (arg === ';') commands.push([])
      else commands.at(-1)!.push(arg)
    }
    let stdout = ''
    for (const args of commands) {
      const said = command(world, model, args)
      if (said.code !== 0) return said
      stdout += said.stdout ?? ''
    }
    return { code: 0, stdout }
  })
}

export const tmuxSteps: { [K in 'tmux.detach' | 'tmux.attach' | 'tmux.selectPane']: StepHandler<K> } = {
  'tmux.detach': async (world, { session }) => {
    const { session: detached } = needPane(world, session)
    for (const client of clientsOf(world, modelOf(world))) if (client.session === detached) world.machine.end(client.pid)
  },
  'tmux.attach': async (world, { session, window, tab }) => {
    attach(world, modelOf(world), needPane(world, session).session, tabShell(world, { window, tab }).pid)
  },
  // The person's own move: nothing of the devices' runs.
  'tmux.selectPane': async (world, { session }) => {
    const { session: moved, pane } = needPane(world, session)
    moved.active = pane.id
  },
}
