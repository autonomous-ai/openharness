/**
 * Tier B's steps on iTerm2 (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Tier B"; its plan's Decisions 8, 9 and 15).
 * Every tab and split is a tab of a fake iTerm2 (outsideAgent.ts), on a pty of its own under the fake iTerm2's server, in
 * the daemon's throwaway home:
 * - a tab's Claude Code is its shell's job there (Outside), with iTerm2's hints;
 * - a tmux one runs in a tmux session of the person's on the daemon's private server (ownTmux.ts), one session a tab its
 *   first client runs in (`eval-<window>-<tab>`, as tier A's), that client attached at the shell of a tab of the fake
 *   iTerm2 before any agent starts in it, so each one's start hook finds it there; each agent in a window of its own. A
 *   client detached leaves its tab open on that shell, as tier A's does: macOS gives a closed tab's tty to the next tab,
 *   and the tab a session's start looked up would read as the next one's (I13). A Claude Code's
 *   prompt is typed through a client of its session in the tab the person last selected, when one is there, so that
 *   client is the one used (the plan's Decision 6); else into its pane. A Codex is a process of its own in its pane
 *   (codexOutside.ts), told by its hooks, under the daemon's CODEX_HOME;
 * - a herdr one runs in a pane of the test's own herdr (herdrServer.ts), started by its first client in a tab of the fake
 *   iTerm2, so its panes keep iTerm2's hints and their parents reach the fake iTerm2 before this worker; herdr is told
 *   its session, herdr's own Claude Code report, unless the scenario says its row gives none;
 * - an empty tab or split the person opens runs a shell alone; a session or client that starts in it takes its place.
 * Each Claude Code goes on in its session's conversation under its title, on the Claude app's own session steps
 * (appEvalClaude.ts). Each tab's tty is in `world.tabs` by its label, so the watch's selects and the person's reports name
 * tabs by label, and each tmux and herdr pane is the world's by its session (`muxPane`), from before its start to its
 * close.
 *
 * At stop the Claude Code sessions end first, each in its terminal; then this file's own process ends the rest: the empty
 * tabs, the tmux sessions and their clients' tabs, herdr and its tab. Killed, it takes them with it at once.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { APP_BUNDLES } from '../../src/cable/hosts/hostDetect.js'
import { sessionTab, tabLabel, type TabRef } from '../../src/testing/dialAppEval/itermRecords.js'
import { NET_GUARD_FILE_ENV } from '../../src/testing/dialAppEval/netGuard.js'
import { engineOf, itermPlaceOf, type SessionDef, type SessionKey } from '../../src/testing/dialAppEval/types.js'
import { appOf, claudeSteps, drop, start as startClaude, type ClaudeHost, type ClaudeTerminal } from './appEvalClaude.js'
import { guardEnv, guardLoaded, speak, type AppSteps, type TierBWorld } from './appEvalDriver.js'
import { CodexOutside } from './codexOutside.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { PrivateHerdr, type HerdrTab } from './herdrServer.js'
import { closeTab, killTab, openTab, Outside, relaunchIterm, typeInto, type Tab } from './outsideAgent.js'
import { InOwnTmux } from './ownTmux.js'

const execFileAsync = promisify(execFile)
/** For tmux to answer, as isolatedTmux.ts waits for each of its commands: a server that hangs blocks no stop. */
const TMUX_MS = 5_000
/** The parents read at most from a tab's command up to its fake iTerm2: its shell, the tab's pty, iTerm2's server. */
const UP_TO_APP = 6
/** What a `harness` command finds its daemon by, which a tab's has from the daemon's environment and a tmux pane's from
 *  the server's does not: the mod's PermissionRequest hook (`harness device claude asked`) tells the daemon a prompt
 *  waits through it. */
const DAEMON_ENV = ['ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'PORT'] as const

/**
 * What a session's hooks send of iTerm2 (the plan's Decision 8), beside what its multiplexer sets: a tab's, iTerm2's
 * TERM_PROGRAM and bundle id, as iTerm2 gives every shell it starts; tmux's, the bundle id its server started with, as
 * tmux sets TERM_PROGRAM and TMUX_PANE itself; herdr's, what its server started with in an iTerm2 tab, as herdr sets
 * HERDR_PANE_ID and no TERM_PROGRAM.
 */
export function itermHints(s: SessionDef): Record<string, string> {
  return itermPlaceOf(s) === 'tmux'
    ? { __CFBundleIdentifier: APP_BUNDLES.iterm }
    : { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: APP_BUNDLES.iterm }
}

/** The tab at [label] opened on [tty]: it takes the label over, and a label an older tab had on that tty goes, as macOS
 *  gives a closed tab's tty to the next one. */
export function tabOpened(tabs: Map<string, string>, label: string, tty: string): void {
  for (const [other, held] of tabs) if (held === tty) tabs.delete(other)
  tabs.set(label, tty)
}

/** The tab at [label] on [tty] closed: its label goes, unless a newer tab took it over. */
export function tabClosed(tabs: Map<string, string>, label: string, tty: string): void {
  if (tabs.get(label) === tty) tabs.delete(label)
}

/** A tab of the fake iTerm2's: where it is, its tty, and its fake iTerm2's process, none once iTerm2 relaunched. */
interface Opened { window: string; tab: number; label: string; tty: string; app?: number }
/** A tmux client's tab: the client (pid) is its shell's job. */
interface Client extends Opened { pid: number; processes: Tab }
interface State {
  /** The empty tabs and splits the person opened, by label. */
  empty: Map<string, Opened & { processes: Tab }>
  /** Each tab session's tab, by session. */
  tabs: Map<SessionKey, Opened>
  /** Each tmux session's clients' tabs, by its name; each tmux session's Claude Code, by session: its tmux session and pane. */
  tmux: Map<string, Client[]>
  inTmux: Map<SessionKey, { name: string; pane: string }>
  /** herdr, from its first session's start: its server and its first client's tab; each herdr session's pane, by session,
   *  in the order they started. */
  herdr?: { server: PrivateHerdr & { tab: HerdrTab }; opened: Opened }
  inHerdr: Map<SessionKey, string>
  /** The tab the person last selected, by label. */
  selected?: string
  /** Each Codex, by session. */
  codex: Map<SessionKey, CodexOutside>
}
const states = new WeakMap<TierBWorld, State>()

/** iTerm2's Claude Code: in its place's terminal (opened). */
const ITERM_HOST: ClaudeHost = (world, s) => ({ hints: itermHints(s), terminal: () => opened(world, s) })

/** The world's iTerm2: its tabs and multiplexers, and the process that ends them at stop, after the Claude Code sessions
 *  in them, which end first. */
function itermOf(world: TierBWorld): State {
  const known = states.get(world)
  if (known) return known
  // The app that ends the Claude Code sessions at stop is a child before this one: each says its end in its terminal.
  appOf(world, ITERM_HOST)
  const state: State = { empty: new Map(), tabs: new Map(), tmux: new Map(), inTmux: new Map(), inHerdr: new Map(), codex: new Map() }
  states.set(world, state)
  // Only the terminals' lifetime: what they do is in this file.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: world.d.root, env: world.d.env, stdio: ['pipe', 'ignore', 'ignore'] })
  world.children.push(child)
  const kill = child.kill.bind(child)
  let ending: Promise<void> | undefined
  child.kill = (signal?: NodeJS.Signals | number) => {
    // The driver's last resort, when the end takes too long: all goes at once.
    if (signal === 'SIGKILL') {
      killAll(world, state)
      return kill('SIGKILL')
    }
    // One that could not end fails the scenario.
    ending ??= Promise.allSettled(closeAll(world, state)).then((ended) => {
      for (const one of ended) if (one.status === 'rejected') world.fail(one.reason)
      kill('SIGKILL')
    })
    return true
  }
  return state
}

const killNow = (pid: number): void => {
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

/** The empty tabs, the tmux sessions with their clients' tabs, and herdr with its tab: their Claude Code went first. */
function closeAll(world: TierBWorld, state: State): Array<Promise<void>> {
  return [
    ...[...state.empty.keys()].map((label) => closeEmpty(world, state, label)),
    ...[...state.tmux].map(async ([name, clients]) => {
      // It went with its last pane; one still there goes now, with its clients.
      await world.d.tmux.run('kill-session', '-t', `=${name}`).catch(() => {})
      await Promise.all(clients.map((client) => closeTab(client.processes, `the client tab ${client.label}`)))
    }),
    ...state.herdr ? [state.herdr.server.stop()] : [],
  ]
}

function killAll(world: TierBWorld, state: State): void {
  for (const { processes } of state.empty.values()) killTab(processes)
  for (const [name, clients] of state.tmux) {
    spawnSync('tmux', ['-S', world.d.tmux.socket, '-f', '/dev/null', 'kill-session', '-t', `=${name}`], { env: world.d.tmux.env, timeout: TMUX_MS })
    for (const client of clients) killTab(client.processes)
  }
  if (state.herdr) {
    // Its server leads a process group of its own, with what its panes run.
    killNow(-state.herdr.server.pid)
    killNow(state.herdr.server.tab.pid)
  }
}

/** [pid]'s tty, as macOS names a terminal (`/dev/ttys004`): one of this test's own processes. */
async function ttyOf(pid: number): Promise<string> {
  return `/dev/${(await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(pid)])).stdout.trim()}`
}

/** The fake iTerm2 a tab's command [pid] runs under: the first of its parents started from the fake iTerm2's bundle, each
 *  one of this test's own processes. */
async function appAbove(d: IsolatedDaemon, pid: number): Promise<number> {
  const app = join(d.env.HOME!, 'Applications', 'iTerm.app', 'Contents', 'MacOS', 'iTerm2')
  for (let at = pid, up = 0; at > 1 && up < UP_TO_APP; up++) {
    const row = /^(\d+)\s+(.*)$/.exec((await execFileAsync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(at)])).stdout.trim())
    if (!row) break
    if (row[2] === app) return at
    at = Number(row[1])
  }
  throw new Error(`no fake iTerm2 above process ${pid}`)
}

/** The tab at [at] opened on [tty], under the fake iTerm2 [app]: it takes its label over. */
function opening(world: TierBWorld, at: TabRef, tty: string, app: number | undefined): Opened {
  const label = tabLabel(at)
  tabOpened(world.tabs, label, tty)
  return { window: at.window, tab: at.tab, label, tty, app }
}

/** The empty tab at [label], if one is open there, closed: a session or client that starts there takes its place, as the
 *  person's starts in that tab's shell. */
async function closeEmpty(world: TierBWorld, state: State, label: string): Promise<void> {
  const empty = state.empty.get(label)
  if (!empty) return
  state.empty.delete(label)
  await closeTab(empty.processes, `the empty tab ${label}`)
  tabClosed(world.tabs, label, empty.tty)
}

/** An empty tab or split of the fake iTerm2 at [at], a shell alone, unless a tab is open there. */
async function emptyTab(world: TierBWorld, at: TabRef): Promise<void> {
  const state = itermOf(world)
  if (world.tabs.has(tabLabel(at))) return
  const tab = await openTab(world.d, world.d.env.HOME!, world.d.env, ['/bin/sh'], { app: 'iterm' })
  state.empty.set(tabLabel(at), { ...opening(world, at, await ttyOf(tab.pid), tab.appPid), processes: tab })
}

/** Whether Claude Code's process [pid] ran its [event] hook in [sessionId] [times] since the hook log was [from] long,
 *  as Outside.ran reads it. */
function ran(d: IsolatedDaemon, pid: number, sessionId: string, event: string, times = 1, from = 0): boolean {
  const line = new RegExp(`claude pid=${pid} ${event}\\S* session=${sessionId} ran`, 'g')
  return (d.hookLog().slice(from).match(line)?.length ?? 0) >= times
}

/** The session's Claude Code started in its place: its terminal. */
async function opened(world: TierBWorld, s: SessionDef): Promise<ClaudeTerminal> {
  const state = itermOf(world)
  const folder = basename(world.folder(s.cwd))
  switch (itermPlaceOf(s)) {
    case 'tmux': return inTmux(world, state, s, folder)
    case 'herdr': return inHerdr(world, state, s, folder)
    default: return inTab(world, state, s, folder)
  }
}

/** Its tab's or split's shell's job, in a tab of the fake iTerm2. */
async function inTab(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<ClaudeTerminal> {
  const at = { window: s.window!, tab: s.tab!, split: s.split }
  await closeEmpty(world, state, tabLabel(at))
  const outside = await Outside.start(world.d, folder, { ...itermHints(s), FAKE_CLAUDE_SESSION_TITLE: s.title }, 'iterm',
    { shell: true, resume: s.id })
  const tab = opening(world, at, await ttyOf(outside.pid), await appAbove(world.d, outside.pid))
  state.tabs.set(s.key, tab)
  const closed = (): void => {
    state.tabs.delete(s.key)
    tabClosed(world.tabs, tab.label, tab.tty)
  }
  return {
    shellPid: outside.shellPid,
    type: (text) => outside.type(text),
    ran: (d, event, times, from) => outside.ran(d, event, times, from),
    close: () => outside.close().finally(closed),
    killTab: () => {
      outside.killTab()
      closed()
    },
  }
}

/** A client of the tmux session [name], attached at the shell of a new tab of the fake iTerm2 at [at], as the person
 *  types `tmux attach` there: used now, once tmux lists it. */
async function attach(world: TierBWorld, state: State, name: string, at: TabRef): Promise<void> {
  const { d } = world
  await closeEmpty(world, state, tabLabel(at))
  const processes = await openTab(d, d.env.HOME!, { ...d.tmux.env, TERM: 'xterm-256color' },
    ['tmux', '-S', d.tmux.socket, '-f', '/dev/null', 'attach-session', '-t', name], { app: 'iterm', shell: true })
  const { pid } = processes
  try {
    await until(`a client on ${name} in an iTerm2 tab`,
      async () => (await d.tmux.run('list-clients', '-F', '#{client_pid}')).split('\n').includes(String(pid)), 30_000, 50)
  } catch (error) {
    await closeTab(processes, `the client tab of ${name}`)
    throw error
  }
  const tab = opening(world, at, await ttyOf(pid), await appAbove(d, pid))
  state.tmux.get(name)!.push({ ...tab, pid, processes })
}

/** The client gone from its session's clients. */
function leave(state: State, client: Client): void {
  for (const clients of state.tmux.values()) if (clients.includes(client)) clients.splice(clients.indexOf(client), 1)
}

/** A client's tab closed: tmux runs on without it. */
async function closeClient(world: TierBWorld, state: State, client: Client): Promise<void> {
  leave(state, client)
  await closeTab(client.processes, `the client tab ${client.label}`)
  tabClosed(world.tabs, client.label, client.tty)
}

/** The client detached, as `tmux detach` in its tab: it ends, and its tab stays open on its shell, an empty one that holds
 *  its tty, so no tab opened after takes it. */
async function detach(world: TierBWorld, state: State, client: Client): Promise<void> {
  leave(state, client)
  await world.d.tmux.run('detach-client', '-t', client.tty)
  await until(`the client in ${client.label} ended`, () => {
    try { process.kill(client.pid, 0) } catch { return true }
    return false
  }, 10_000, 50)
  const { window, tab, label, tty, app, processes } = client
  state.empty.set(label, { window, tab, label, tty, app, processes })
}

/** The person's tmux session in [s]'s tab, its first client attached there: its name, and the pane of the shell it opened
 *  with when it opened now, which goes once its first agent runs, so it holds its agents' windows alone. */
async function tmuxSession(world: TierBWorld, state: State, s: SessionDef): Promise<{ name: string; shell?: string }> {
  const name = `eval-${s.window}-${s.tab}`
  if (state.tmux.has(name)) return { name }
  const shell = await world.d.tmux.run('new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}')
  state.tmux.set(name, [])
  await attach(world, state, name, { window: s.window!, tab: s.tab! })
  return { name, shell }
}

/** The client of tmux session [name] in the tab the person last selected, if one is there; it must show [pane], where its
 *  keys go. */
async function selectedClient(world: TierBWorld, state: State, name: string, pane: string): Promise<Client | undefined> {
  const client = state.tmux.get(name)?.find((one) => one.label === state.selected)
  if (!client) return undefined
  const shown = (await world.d.tmux.run('list-clients', '-F', '#{client_pid} #{pane_id}')).split('\n')
  if (!shown.includes(`${client.pid} ${pane}`)) throw new Error(`scenario ${world.scenario.id}: the client in ${client.label} shows no pane of its session's agent`)
  return client
}

/** In a window of its own of the person's tmux session in its tab, on the daemon's private server. */
async function inTmux(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<ClaudeTerminal> {
  const { d } = world
  const { name, shell } = await tmuxSession(world, state, s)
  const daemon = Object.fromEntries(DAEMON_ENV.map((variable) => [variable, d.env[variable]!]))
  // Its pane is its own from before it is made: the devices ask tmux of it at its start hook.
  const opened = Date.now()
  const own = await InOwnTmux.startIn(d, name, folder,
    { resume: s.id, env: { ...guardEnv(d), ...daemon, ...itermHints(s), FAKE_CLAUDE_SESSION_TITLE: s.title } })
  if (shell !== undefined) await d.tmux.run('kill-pane', '-t', shell)
  // As in every process of the daemon: its hooks are its children.
  guardLoaded(d.env[NET_GUARD_FILE_ENV]!, `${name} pane's Claude Code`, [own.pid], 'node')
  world.muxPane(s.key, own.pane, opened)
  state.inTmux.set(s.key, { name, pane: own.pane })
  const gone = (): void => {
    state.inTmux.delete(s.key)
    world.muxPane(s.key, null)
  }
  return {
    type: async (text) => {
      // Through its tab's pseudo-terminal, as Outside types, so tmux reads it from that client's tty.
      const client = await selectedClient(world, state, name, own.pane)
      if (client) {
        typeInto(client.processes.process, `${text}\r`)
        return
      }
      // `send-keys -l` types no Enter alone.
      await (text === '' ? d.tmux.run('send-keys', '-t', own.pane, 'Enter') : own.type(text))
    },
    ran: (log, event, times, from) => ran(log, own.pid, own.sessionId, event, times, from),
    // Its pane goes, its Claude Code with it; one that ended went with it already.
    close: () => d.tmux.run('kill-pane', '-t', own.pane).then(gone, gone),
    killTab: () => {
      killNow(own.pid)
      gone()
    },
  }
}

/** In a pane of herdr, which its first session starts from its tab. */
async function inHerdr(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<ClaudeTerminal> {
  const { d } = world
  if (!state.herdr) {
    const at = { window: s.window!, tab: s.tab! }
    await closeEmpty(world, state, tabLabel(at))
    const server = await PrivateHerdr.startIn(d, 'iterm', { env: itermHints(s) })
    state.herdr = { server, opened: opening(world, at, server.tab.tty, server.tab.appPid) }
  }
  const { server } = state.herdr
  const opened = Date.now()
  const agent = await server.hooked(folder, { resume: s.id, env: { FAKE_CLAUDE_SESSION_TITLE: s.title } })
  guardLoaded(d.env[NET_GUARD_FILE_ENV]!, `herdr pane's Claude Code`, [agent.pid], 'node')
  // herdr's own Claude Code report, unless its row gives no session (IH4).
  if (s.herdrSession !== false) await server.reportSession(agent.pane, agent.sessionId)
  world.muxPane(s.key, agent.pane, opened)
  state.inHerdr.set(s.key, agent.pane)
  const gone = (): void => {
    state.inHerdr.delete(s.key)
    world.muxPane(s.key, null)
  }
  return {
    type: (text) => server.type(agent.pane, text),
    ran: (log, event, times, from) => ran(log, agent.pid, agent.sessionId, event, times, from),
    // Its pane goes, its Claude Code with it; one herdr took with it went already.
    close: () => server.rpc('pane.close', { pane_id: agent.pane }).then(gone, gone),
    killTab: () => {
      killNow(agent.pid)
      gone()
    },
  }
}

/** The answer as Codex's rollout holds it (cable/hosts/lastAnswer.ts reads it back). */
const answerLine = (text: string): string =>
  `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } })}\n`

/** The session's Codex, in a window of its own of the person's tmux session in its tab, under the daemon's CODEX_HOME. */
async function startCodex(world: TierBWorld, s: SessionDef): Promise<void> {
  const state = itermOf(world)
  if (itermPlaceOf(s) !== 'tmux') throw new Error(`scenario ${world.scenario.id}: tier B runs iTerm2's Codex in tmux alone`)
  const { name, shell } = await tmuxSession(world, state, s)
  const opened = Date.now()
  const codex = await CodexOutside.inTmux(world.d, name, basename(world.folder(s.cwd)), world.children, itermHints(s), { sessionId: s.id })
  if (shell !== undefined) await world.d.tmux.run('kill-pane', '-t', shell)
  state.codex.set(s.key, codex)
  world.muxPane(s.key, codex.pane!, opened)
  state.inTmux.set(s.key, { name, pane: codex.pane! })
  await codex.hook('SessionStart', { source: 'startup' })
}

/** A step on the session's Codex: its hooks, as Codex runs them; it runs none as it ends, its process goes. */
async function codexHook(world: TierBWorld, step: { session: SessionKey; event: string; lastAnswer?: string }): Promise<void> {
  const state = itermOf(world)
  const codex = state.codex.get(step.session)
  if (!codex) throw new Error(`scenario ${world.scenario.id}: a hook for ${step.session}, which has not started`)
  switch (step.event) {
    case 'turn-start': return codex.hook('UserPromptSubmit')
    case 'turn-stop':
      if (step.lastAnswer !== undefined) appendFileSync(codex.transcriptPath, answerLine(step.lastAnswer))
      return codex.hook('Stop')
    case 'end':
      state.codex.delete(step.session)
      state.inTmux.delete(step.session)
      await codex.end()
      return world.muxPane(step.session, null)
    default: throw new Error(`scenario ${world.scenario.id}: tier B's Codex in iTerm2 has no ${step.event} step`)
  }
}

function tmuxOf(world: TierBWorld, state: State, key: SessionKey): { name: string; pane: string } {
  const found = state.inTmux.get(key)
  if (!found) throw new Error(`scenario ${world.scenario.id}: ${key} runs in no tmux`)
  return found
}

export const itermSteps: AppSteps = {
  hook: async (world, step) => {
    if (engineOf(world.session(step.session)) === 'codex') {
      return step.event === 'start' ? startCodex(world, world.session(step.session)) : codexHook(world, step)
    }
    if (step.event !== 'start') return claudeSteps.hook(world, step)
    itermOf(world)
    await startClaude(world, appOf(world, ITERM_HOST), step.session)
  },
  voice: speak,
  'iterm.tab': (world, { window, tab }) => emptyTab(world, { window, tab }),
  'iterm.split': (world, { window, tab, split }) => emptyTab(world, { window, tab, split }),
  'iterm.closeTab': async (world, { window, tab }) => {
    const state = itermOf(world)
    const there = (open: Opened): boolean => open.window === window && open.tab === tab
    if (state.herdr && there(state.herdr.opened)) throw new Error(`scenario ${world.scenario.id}: tier B closes no herdr client's tab`)
    const sessions = [...state.tabs].filter(([, open]) => there(open)).map(([key]) => key)
    const empties = [...state.empty.values()].filter(there)
    const clients = [...state.tmux.values()].flatMap((list) => list.filter(there))
    if (sessions.length + empties.length + clients.length === 0) throw new Error(`scenario ${world.scenario.id}: no tab ${window}.${tab} is open`)
    // Its agents end with no hook, as a process killed with its terminal runs none; then all else in it, while an agent in
    // tmux runs on under its server.
    for (const key of sessions) await drop(world, key)
    for (const empty of empties) await closeEmpty(world, state, empty.label)
    for (const client of clients) await closeClient(world, state, client)
  },
  'iterm.select': async (world, { window, tab, split }) => {
    const label = tabLabel({ window, tab, split })
    itermOf(world).selected = label
    world.reportTab(label)
  },
  'iterm.relaunch': async (world) => {
    const state = itermOf(world)
    const tabs = [...state.empty.values(), ...state.tabs.values(), ...[...state.tmux.values()].flat(), ...state.herdr ? [state.herdr.opened] : []]
    // Each tab's own fake iTerm2 ends; its server, and what it runs, goes on under launchd.
    for (const tab of tabs) {
      if (tab.app === undefined) continue
      await relaunchIterm({ appPid: tab.app })
      tab.app = undefined
    }
  },
  'tmux.detach': async (world, { session }) => {
    const state = itermOf(world)
    for (const client of [...state.tmux.get(tmuxOf(world, state, session).name)!]) await detach(world, state, client)
  },
  'tmux.attach': async (world, { session, window, tab }) => {
    const state = itermOf(world)
    await attach(world, state, tmuxOf(world, state, session).name, { window, tab })
  },
  // The person's own move on tmux's server: its window, then its pane.
  'tmux.selectPane': async (world, { session }) => {
    const { pane } = tmuxOf(world, itermOf(world), session)
    await world.d.tmux.run('select-window', '-t', pane, ';', 'select-pane', '-t', pane)
  },
  // The person's own move in herdr.
  'herdr.focus': async (world, { session }) => {
    const state = itermOf(world)
    const pane = state.inHerdr.get(session)
    if (!state.herdr || pane === undefined) throw new Error(`scenario ${world.scenario.id}: ${session} runs in no herdr`)
    await state.herdr.server.rpc('pane.focus', { pane_id: pane })
  },
  'herdr.restart': async (world) => {
    const state = itermOf(world)
    const herdr = state.herdr
    if (!herdr) throw new Error(`scenario ${world.scenario.id}: no herdr runs`)
    const keys = [...state.inHerdr.keys()]
    // Its server ends with its client's tab and its agents, with no hook.
    state.herdr = undefined
    await herdr.server.stop()
    tabClosed(world.tabs, herdr.opened.label, herdr.opened.tty)
    for (const key of keys) await drop(world, key)
    // Started again from a new tab under the same label, and each agent going on in its conversation on a new pane, in the
    // order they had.
    const app = appOf(world, ITERM_HOST)
    for (const key of keys) await startClaude(world, app, key)
  },
}
