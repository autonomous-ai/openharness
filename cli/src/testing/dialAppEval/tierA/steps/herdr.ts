/**
 * Tier A's herdr (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decisions 6 and 7). One server a world at a made-up
 * path, the child of its first client, on no tty. Each herdr session has a pane, its shell the server's child on a tty
 * of its own, the agent under it; panes are `w1:p<n>` from `p1` in the order they open and never reused in a world, so a
 * pane a session had before herdr started again is no session's after. A client is a herdr process under the shell of a
 * tab that holds a herdr session, on that tab's tty. A pane takes herdr's focus as it opens, and as it is focused.
 *
 * The devices reach it as they reach the person's herdr. Its socket is a fake client (DevicesDeps.herdr), not a socket
 * server: real socket I/O would escape the driver's quiet check. It lists herdr's agents, tells their status to the
 * subscriptions naming their panes as their hooks run, and takes words as herdr's client does: a `typed` delivery to the
 * session whose agent is in the pane, only for an idle or done agent of the kind named, and none for a pane with no
 * agent, which herdr refuses. `herdr agent focus`, and the lsof and ps of the lookup of a pane's client
 * (cable/hosts/herdrOuter.ts), are answered from this model through the world's `run`. A server's socket appears as it
 * starts, and every watch on it is told.
 */
import { HERDR_KIND, HERDR_PANE, herdrClientDeps, type HerdrAnswer, type HerdrClient, type HerdrSubscriber }
  from '../../../../cable/hosts/herdrClient.js'
import { CONTROL, MAX_TEXT } from '../../../../cable/hosts/orca.js'
import { flagOf, programOf } from '../../argv.js'
import { tabLabel, type TabRef } from '../../itermRecords.js'
import { engineOf, type SessionDef, type SessionKey, type StepOf } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { labelOf, selectedTab, tabShell } from './iterm.js'
import { dropSession, nextTty, running, SHELLS, startProcess, startSession } from './sessions.js'

/** Where the eval's machine has herdr: the server and every client run it. */
export const HERDR = '/opt/eval/bin/herdr'
/** The socket herdr's clients connect to, as lsof names the server's end of each connection (herdrOuter.ts). */
const CLIENT_SOCKET = '/opt/eval/herdr/herdr-client.sock'
/** herdr's base 32 (herdrClient.ts HERDR_PANE_FORM): a workspace's nth pane is its nth digit. */
const DIGITS = '123456789ABCDEFGHJKMNPQRSTVWXYZ0'
const WORKSPACE = 'w1'

type Answer = { code: number; stdout?: string }
const FAILED: Answer = { code: 1 }
type HookEvent = StepOf<'hook'>['event']
type Status = 'idle' | 'working' | 'blocked' | 'done'
/** herdr's status of an agent after each of its hooks. */
const STATUSES: Readonly<Record<Exclude<HookEvent, 'end'>, Status>> = {
  start: 'idle', 'turn-start': 'working', 'needs-input': 'blocked', 'turn-stop': 'done',
}

/** status: herdr's of the agent in it; none once the agent left the pane. */
interface Pane { id: string; key: SessionKey; shell: number; tty: string; status?: Status }
interface Client { pid: number; tty: string }
/** The entry kinds and the panes whose status it names; a closed one is told nothing. */
interface Subscription { kinds: ReadonlySet<string>; panes: ReadonlySet<string>; to: HerdrSubscriber; open: boolean }
/** tab: its first client's, where it starts again. */
interface Server {
  pid: number; tab: TabRef; clients: Client[]; panes: Map<string, Pane>; focused?: string; subscriptions: Set<Subscription>
}
/** The server while one runs, and how many panes the world's servers have opened. */
interface Model { server?: Server; opened: number }
const models = new WeakMap<TierAWorld, Model>()

function modelOf(world: TierAWorld): Model {
  let model = models.get(world)
  if (!model) models.set(world, model = { opened: 0 })
  return model
}

const serverOf = (world: TierAWorld): Server | undefined => models.get(world)?.server

function needServer(world: TierAWorld): Server {
  const server = serverOf(world)
  if (!server) throw new Error(`scenario ${world.scenario.id}: no herdr runs`)
  return server
}

/** The session's newest pane on that server. */
function paneOf(world: TierAWorld, server: Server, key: SessionKey): Pane {
  const pane = [...server.panes.values()].filter((p) => p.key === key).at(-1)
  if (!pane) throw new Error(`scenario ${world.scenario.id}: ${key} runs in no herdr pane`)
  return pane
}

/** The clients still running: one whose tab closed under it (iterm.closeTab) is gone. */
function clientsOf(world: TierAWorld, server: Server): Client[] {
  return server.clients = server.clients.filter((client) => world.machine.processes.has(client.pid))
}

/** The person types in the client's terminal now: its access time moves. */
function use(world: TierAWorld, client: Client): void {
  world.machine.atimes.set(client.tty, Date.now())
}

/** A client started now in that tab, under its shell on its terminal, by the person typing `herdr` there. */
function attach(world: TierAWorld, tab: TabRef): Client {
  const shell = tabShell(world, tab)
  const client: Client = { pid: startProcess(world, shell.pid, HERDR, shell.tty), tty: shell.tty }
  use(world, client)
  return client
}

/** herdr started from that tab: the client, the server its child, and the server's socket, which each watch on it is
 *  told of: on the path the devices' client finds it at (herdrClientDeps). */
function startServer(world: TierAWorld, model: Model, tab: TabRef): Server {
  const client = attach(world, tab)
  const server: Server = { pid: startProcess(world, client.pid, HERDR), tab, clients: [client], panes: new Map(),
    subscriptions: new Set() }
  model.server = server
  queueMicrotask(() => { for (const watch of [...world.machine.socketWatches.get(herdrClientDeps().socketPath) ?? []]) watch() })
  return server
}

/** The server ends, its subscriptions with it, and every process it holds: its panes' and its clients'. */
function stopServer(world: TierAWorld, model: Model, server: Server): void {
  for (const sub of server.subscriptions) {
    queueMicrotask(() => {
      if (!sub.open) return
      sub.open = false
      sub.to.closed('ended')
    })
  }
  for (const pane of server.panes.values()) {
    for (const p of [...world.machine.processes.values()]) if (p.tty === pane.tty) world.machine.end(p.pid)
    world.panes.delete(pane.id)
  }
  for (const client of server.clients) world.machine.end(client.pid)
  world.machine.end(server.pid)
  model.server = undefined
}

/**
 * The session's herdr pane, made now: its shell on a terminal of its own, which the agent runs under. herdr starts from
 * the session's tab when none runs, and a tab with no client of it gets one.
 */
export function herdrPane(world: TierAWorld, s: SessionDef): { shell: number; tty: string; pane: string } {
  const model = modelOf(world)
  const tab = { window: s.window!, tab: s.tab! }
  let server = model.server
  if (!server) server = startServer(world, model, tab)
  const { tty: tabTty } = tabShell(world, tab)
  if (!clientsOf(world, server).some((client) => client.tty === tabTty)) server.clients.push(attach(world, tab))
  if (model.opened === DIGITS.length) throw new Error(`tier A opens at most ${DIGITS.length} herdr panes a world`)
  // macOS names every terminal it makes, and herdr runs in iTerm2 alone (iterm.ts).
  const tty = nextTty(world)!
  const pane: Pane = { id: `${WORKSPACE}:p${DIGITS[model.opened++]!}`, key: s.key,
    shell: startProcess(world, server.pid, SHELLS[world.platform], tty), tty }
  server.panes.set(pane.id, pane)
  server.focused = pane.id
  world.panes.set(pane.id, s.key)
  return { shell: pane.shell, tty, pane: pane.id }
}

/** The pane the session's hooks name in HERDR_PANE_ID. */
export const herdrPaneId = (world: TierAWorld, key: SessionKey): string => paneOf(world, needServer(world), key).id

/** Each open subscription [wants] hears it, as herdr writes on its own connection: on a turn of its own. */
function hear(server: Server, wants: (sub: Subscription) => boolean, name: string, data: Record<string, unknown>): void {
  for (const sub of server.subscriptions) {
    if (wants(sub)) queueMicrotask(() => { if (sub.open) sub.to.event(name, data) })
  }
}

/** herdr's word of an agent in a pane: told on every subscription to detections. */
function detected(world: TierAWorld, server: Server, pane: Pane, more: Record<string, unknown> = {}): void {
  hear(server, (sub) => sub.kinds.has('pane.agent_detected'), 'pane_agent_detected', { agent: engineOf(world.session(pane.key)),
    pane_id: pane.id, type: 'pane_agent_detected', workspace_id: WORKSPACE, ...more })
}

/**
 * A herdr session's hook, as herdr sees its agent: a start is a detection, an end the agent leaving its pane, and each
 * other a status told to the subscriptions naming its pane. A turn typed while iTerm2's selected tab holds a client of
 * herdr's was typed through that client: its terminal's access time moves first (Decision 6).
 */
export function herdrHeard(world: TierAWorld, key: SessionKey, event: HookEvent): void {
  const server = needServer(world)
  const pane = paneOf(world, server, key)
  const selected = selectedTab(world)
  if (event === 'turn-start' && selected) {
    for (const client of clientsOf(world, server)) {
      if (labelOf(world, `/dev/${client.tty}`) === tabLabel(selected)) use(world, client)
    }
  }
  if (event === 'end') {
    detected(world, server, pane, { final_status: pane.status, released: true })
    delete pane.status
    return
  }
  pane.status = STATUSES[event]
  if (event === 'start') return detected(world, server, pane)
  hear(server, (sub) => sub.panes.has(pane.id), 'pane.agent_status_changed',
    { agent: engineOf(world.session(key)), agent_status: pane.status, pane_id: pane.id, workspace_id: WORKSPACE })
}

/** herdr's AgentInfo of the agent in a pane: no name, and no session for a row herdr gives none (IH4). */
function agentInfo(world: TierAWorld, server: Server, pane: Pane): Record<string, unknown> {
  const s = world.session(pane.key)
  const kind = engineOf(s)
  return { pane_id: pane.id, agent: kind, agent_status: pane.status, focused: server.focused === pane.id, cwd: s.cwd,
    ...(s.herdrSession === false ? {} : { agent_session: { agent: kind, kind: 'id', value: s.id } }) }
}

/** herdr's socket as its client (herdrClient.ts) reaches it, while the server runs. */
export function herdrClient(world: TierAWorld): HerdrClient {
  return {
    request: async (method): Promise<HerdrAnswer> => {
      const server = serverOf(world)
      if (!server) return { ok: false, fault: 'no_socket' }
      if (method !== 'agent.list') {
        world.gap(`tier A does not model herdr's ${method}`)
        return { ok: false, fault: 'rejected', code: 'unknown_method' }
      }
      const agents = [...server.panes.values()]
        .flatMap((pane) => (pane.status === undefined ? [] : [agentInfo(world, server, pane)]))
      return { ok: true, result: { type: 'agent_list', agents } }
    },
    subscribe: (entries, to) => {
      const server = serverOf(world)
      const sub: Subscription = { kinds: new Set(entries.map((entry) => entry.type)), to, open: true,
        panes: new Set(entries.flatMap((entry) => ('pane_id' in entry ? [entry.pane_id] : []))) }
      if (server) server.subscriptions.add(sub)
      queueMicrotask(() => {
        if (!sub.open) return
        if (server) return to.started()
        sub.open = false
        to.closed('no_socket')
      })
      return { close: () => {
        sub.open = false
        server?.subscriptions.delete(sub)
      } }
    },
    // The real client's steps (herdrClient.ts prompt), so tier A types nothing the product would refuse: its form check,
    // herdr's agent.get of the pane, then herdr's agent.prompt of the text with its control characters as spaces.
    prompt: async (paneId, kind, text) => {
      const line = text.replace(CONTROL, ' ')
      if (!HERDR_PANE.test(paneId) || !HERDR_KIND.test(kind) || text.length > MAX_TEXT || line.trim() === '') {
        return { outcome: 'failed', fault: 'bad_request' }
      }
      const server = serverOf(world)
      if (!server) return { outcome: 'failed', fault: 'no_socket' }
      const pane = server.panes.get(paneId)
      // herdr answers agent_not_found for a pane with no agent (docs/specs/2026-11-16-device-herdr.md).
      if (pane?.status === undefined) return { outcome: 'failed', fault: 'rejected', code: 'agent_not_found' }
      if (engineOf(world.session(pane.key)) !== kind) return { outcome: 'failed', fault: 'not_that_agent' }
      if (pane.status !== 'idle' && pane.status !== 'done') return { outcome: 'busy' }
      world.deliver({ path: 'typed', target: pane.key, text: line })
      return { outcome: 'sent' }
    },
    // A server that starts again makes another socket: its stamp is the server's pid.
    socketStamp: () => {
      const server = serverOf(world)
      return server && String(server.pid)
    },
    // herdr is on the eval machine's PATH: no marker names one (Windows').
    binary: () => undefined,
  }
}

/** A listing's lines, each ended as the program ends it. */
const lines = (rows: string[]): string => rows.map((row) => `${row}\n`).join('')
/** The kernel address of the server's end of a client's connection, and of the client's own. */
const served = (client: Client): string => `0x${(client.pid * 2).toString(16)}`
const own = (client: Client): string => `0x${(client.pid * 2 + 1).toString(16)}`

/** `herdr agent focus <pane>`: herdr's focus moves to the pane, which it must have. */
function herdrCommand(world: TierAWorld, args: readonly string[]): Answer {
  if (args.length !== 3 || args[0] !== 'agent' || args[1] !== 'focus') {
    world.gap(`tier A does not model herdr ${args.slice(0, 2).join(' ')}`)
    return FAILED
  }
  const server = serverOf(world)
  if (!server?.panes.has(args[2]!)) return FAILED
  server.focused = args[2]
  return { code: 0 }
}

/** `lsof -a -U -p <pids> -F pdn`, as herdrOuter.ts lsofClients runs it: of the processes asked, the server's end of each
 *  client's connection to its client socket, and each client's own end with the server's as its peer. */
function lsof(world: TierAWorld, args: readonly string[]): Answer {
  const pids = flagOf(args, '-p')
  if (pids === undefined || args.join(' ') !== `-a -U -p ${pids} -F pdn`) {
    world.gap('tier A does not model this lsof')
    return FAILED
  }
  const asked = new Set(pids.split(',').map(Number))
  const server = serverOf(world)
  const clients = server ? clientsOf(world, server) : []
  const rows: string[] = []
  if (server && asked.has(server.pid)) {
    rows.push(`p${server.pid}`)
    for (const [i, client] of clients.entries()) rows.push(`f${10 + i}`, `d${served(client)}`, `n${CLIENT_SOCKET}`)
  }
  for (const client of clients) {
    if (asked.has(client.pid)) rows.push(`p${client.pid}`, 'f3', `d${own(client)}`, `n->${served(client)}`)
  }
  return { code: 0, stdout: lines(rows) }
}

/** `ps -o pid=,tty= -p <pids>`, as herdrOuter.ts reads its candidates' terminals: a row a process still running, `??` on
 *  none; it fails when one has gone, its rows intact. */
function ps(world: TierAWorld, args: readonly string[]): Answer {
  const pids = flagOf(args, '-p')
  if (pids === undefined || args.join(' ') !== `-o pid=,tty= -p ${pids}`) {
    world.gap('tier A does not model this ps')
    return FAILED
  }
  const asked = pids.split(',').map(Number)
  const rows = asked.flatMap((pid) => {
    const p = world.machine.processes.get(pid)
    return p ? [`${pid} ${p.tty ?? '??'}`] : []
  })
  return { code: rows.length === asked.length ? 0 : 1, stdout: lines(rows) }
}

/** The world answers herdr's command and the client lookup's lsof and ps from the model. */
export function answerHerdr(world: TierAWorld): void {
  world.answer((argv) => {
    switch (programOf(argv)) {
      case 'herdr': return herdrCommand(world, argv.slice(1))
      case 'lsof': return lsof(world, argv.slice(1))
      case 'ps': return ps(world, argv.slice(1))
      default: return undefined
    }
  })
}

export const herdrSteps: { [K in 'herdr.focus' | 'herdr.restart']: StepHandler<K> } = {
  // The person's own move: nothing of the devices' runs.
  'herdr.focus': async (world, { session }) => {
    const server = needServer(world)
    server.focused = paneOf(world, server, session).id
  },
  'herdr.restart': async (world) => {
    const model = modelOf(world)
    const server = needServer(world)
    // Its agents end with it, with no hook, then all else it holds.
    const keys = [...server.panes.values()]
      .flatMap((pane) => (pane.status !== undefined && running(world, pane.key) ? [pane.key] : []))
    for (const key of keys) await dropSession(world, key)
    stopServer(world, model, server)
    // herdr starts again from the same tab, and each agent that ran in it on a new pane.
    startServer(world, model, server.tab)
    for (const key of keys) await startSession(world, key)
  },
}
