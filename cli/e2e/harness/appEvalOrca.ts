/**
 * Tier B's Orca agents (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier B"; the plan's Decision 16): each one a
 * terminal-host stand-in of its own (orcaHost.ts) and its Node runner, the caller of every hook it runs, under Orca's
 * host's name, or another's for a held pane (HELD_MAKER); no engine process runs. Claude Code's hooks are InOrca's on that
 * terminal, Codex's CodexOutside's, and an agent ends when its stand-in does.
 *
 * Orca's steps (`orcaSteps`): the fake Orca (fakeOrca.ts) prints the layout the scenario's steps make (orcaListing.ts,
 * as tier A prints it) with the panes open now, and its focus; the plugin is its own loop on the throwaway home
 * (pluginLoop.ts), handed the worktree on screen at each orca.front and again as its panes open and close, as Orca's
 * `workspace.changed` hands it (relist). Words reach these agents by the Claude mod's inbox (appEvalClaude.ts holdMod),
 * by `orca terminal send` (the driver reads the fake's runs) and, should the devices take that path, by the Codex queue
 * (appEvalChatgpt.ts hear).
 *
 * Every session here runs inside the real Orca, so this worker's environment holds Orca's, tmux's and its terminal's
 * names, and the maker walk from this worker reaches the real Orca: nothing runs for an agent but on its stand-in, under
 * the daemon's environment, made from scratch (testing/daemonEnvironment.ts), and the session's own names (`orcaEngine`).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APP_BUNDLES } from '../../src/cable/hosts/hostDetect.js'
import { orcaLayout, orcaListing } from '../../src/testing/dialAppEval/orcaListing.js'
import { engineOf, HELD_MAKER, hookHandle, orcaPaneHandle, type SessionDef, type SessionKey, type StepOf }
  from '../../src/testing/dialAppEval/types.js'
import { hear } from './appEvalChatgpt.js'
import { holdMod } from './appEvalClaude.js'
import { guardEnv, orcaAccountHome, speak, type AppSteps, type TierBWorld } from './appEvalDriver.js'
import { CodexOutside } from './codexOutside.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { IN_ORCA, InOrca } from './inOrca.js'
import { orcaTerminal, type OrcaTerminal } from './orcaHost.js'
import { startPluginLoop, type PluginLoop } from './pluginLoop.js'

/** For the plugin's stream to open: its loop asks `harness device orca link` through the home's launcher, a CLI's start,
 *  then opens the stream. */
const STREAM_MS = 60_000
/** What the devices log as a `dial` stream opens (services/devicesListener.ts). */
export const STREAM_OPEN = '[devices] dial stream · open'
/** For tmux to kill a session, as isolatedTmux.ts waits for each of its commands: a server that hangs blocks no stop. */
const KILL_MS = 5_000
/** The person's prompt, as a turn's transcript opens with it; never shown. */
const PROMPT = 'Eval prompt.'

/** This worker's own names, as a run inside Orca, in a tmux pane of its terminal, has them: made up, and none may reach
 *  what tier B starts (the safety cases'). */
export const RUNNER: Readonly<Record<string, string>> = {
  ORCA_TERMINAL_HANDLE: 'term_00000000-0000-4000-8e00-0000000000e1', ORCA_AGENT_SESSION_ID: 'runner-orca-session',
  ORCA_PAIRING_CODE: 'runner-pairing', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'runner-spawn', ORCA_WORKTREE_ID: 'runner-repo::/work/runner',
  TMUX: '/tmp/runner-tmux/default,4141,0', TMUX_PANE: '%41', TERM_PROGRAM: 'runner-terminal', __CFBundleIdentifier: 'com.example.runner',
}
/** The names whose values say where a process runs: Orca's, tmux's and the terminal's. */
export const WHERE = /^(ORCA_|TMUX|TERM_PROGRAM|__CFBundleIdentifier$)/
/** [env]'s WHERE names alone. */
export const where = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([name]) => WHERE.test(name)))
/** An Orca session of the safety cases, made up as the catalog's are. */
export const madeUpSession = (key: string, more: Partial<SessionDef> = {}): SessionDef => ({
  key, app: 'orca', id: `00000000-0000-4000-8c00-${Buffer.from(key).toString('hex').padStart(12, '0')}`, title: `Eval ${key}`,
  cwd: '/work/eval-w1', ageMs: 0, worktree: 'w1', tab: 0, ...more,
})

/** Orca's names for the session's terminal, its made-up secrets beside them, with the session's own id (the plan's
 *  Decision 1), then its hints. */
const orcaNames = (s: Pick<SessionDef, 'key'>, hints: Record<string, string>): Record<string, string> =>
  ({ ...IN_ORCA, ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`, ...hints })

/**
 * The session's engine as its hooks run, on [terminal] when given: InOrca's (Claude Code) or CodexOutside's (Codex), in
 * the catalog's folder `/work/<name>` made under the daemon's projects. Its `env` is what every process run for the
 * agent gets: the daemon's (testing/daemonEnvironment.ts), Orca's names for the session and its hints (Decision 4), no
 * value of this worker's. A Codex runs in [codexHome] when given, else in the daemon's CODEX_HOME.
 */
export function orcaEngine(d: IsolatedDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>,
  { terminal, codexHome }: { terminal?: OrcaTerminal; codexHome?: string } = {}): InOrca | CodexOutside {
  const names = orcaNames(s, hints)
  const folder = s.cwd.slice('/work/'.length)
  if (engineOf(s) === 'codex') {
    return new CodexOutside(d, folder, children, names, { sessionId: s.id, ...(terminal ? { terminal } : {}), ...(codexHome === undefined ? {} : { home: codexHome }) })
  }
  return new InOrca(d, folder, children, names, { sessionId: s.id, ...(terminal ? { terminal: Promise.resolve(terminal) } : {}) })
}

/** Orca's plugin's loop on [d] (harness/pluginLoop.ts), under the daemon's network guard as every process tier B starts
 *  is, its environment otherwise its own. */
export function startOrcaPlugin(d: IsolatedDaemon, children: ChildProcess[]): PluginLoop {
  return startPluginLoop(d, children, guardEnv(d))
}

/** The environment [pid] was started with, as the OS keeps it (Linux's /proc, macOS's `ps -E`), each `name=value`: what
 *  a process was handed, not what it set itself since. */
export function startedWith(pid: number): string[] {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
  const line = execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  // ps prints them after the command's words, joined by spaces: a value's own spaces split it, so a caller matches the
  // names it knows, or the entries whose values it made.
  return line.trim().split(' ').filter((word) => word.includes('='))
}

/** The person's line that opens a turn and the agent's answer, as each engine's transcript holds them: the last answer is
 *  read from after the last prompt (cable/hosts/lastAnswer.ts), as tier A writes them (tierA/steps/sessions.ts). */
const LINES = {
  claude: {
    prompt: (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
    answer: (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  },
  codex: {
    prompt: (text: string) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } }),
    answer: (text: string) => ({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } }),
  },
}

export class OrcaAgent {
  private constructor(private readonly s: SessionDef, private readonly terminal: OrcaTerminal,
    private readonly engine: InOrca | CodexOutside, private readonly transcript: string) {}

  /** On a stand-in of its own, its hooks its engine's on that terminal (orcaEngine). */
  static async start(d: IsolatedDaemon, children: ChildProcess[], s: SessionDef, hints: Record<string, string>,
    codexHome?: string): Promise<OrcaAgent> {
    // Before its stand-in starts: a session tier B cannot run starts nothing.
    if (!s.cwd.startsWith('/work/')) throw new Error(`${s.key}: ${s.cwd} is not a catalog folder`)
    if (engineOf(s) === 'cursor') throw new Error(`${s.key}: tier B runs no Cursor agent in Orca`)
    const terminal = await orcaTerminal(d, children, s.held ? { name: HELD_MAKER } : {})
    const engine = orcaEngine(d, children, s, hints, { terminal, codexHome })
    if (engine instanceof CodexOutside) return new OrcaAgent(s, terminal, engine, engine.transcriptPath)
    // Where Claude Code keeps its conversation, in the daemon's projects folder, where the devices read a last answer.
    const transcript = join(d.env.CLAUDE_PROJECTS_DIR!, engine.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.id}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    // A relaunched session goes on in the transcript it had.
    appendFileSync(transcript, '')
    return new OrcaAgent(s, terminal, engine, transcript)
  }

  /** Its runner's: every hook's caller. */
  get pid(): number { return this.terminal.pid }

  /** Its hook for [event], as its engine runs it: a turn's prompt, and its [lastAnswer] when given, written in its
   *  transcript first. An end is its engine's leaving: Claude Code's SessionEnd hook, then its process; Codex runs no hook
   *  as it ends. */
  async hook(event: 'start' | 'turn-start' | 'needs-input' | 'turn-stop' | 'end', { lastAnswer }: { lastAnswer?: string } = {}): Promise<void> {
    const engine = this.engine
    const lines = LINES[engine instanceof CodexOutside ? 'codex' : 'claude']
    const said = (line: object): void => appendFileSync(this.transcript, `${JSON.stringify(line)}\n`)
    if (event === 'turn-start') said(lines.prompt(PROMPT))
    if (event === 'turn-stop' && lastAnswer !== undefined) said(lines.answer(lastAnswer))
    if (engine instanceof CodexOutside) {
      switch (event) {
        case 'start': return engine.hook('SessionStart', { source: 'startup' })
        case 'turn-start': return engine.hook('UserPromptSubmit')
        case 'turn-stop': return engine.hook('Stop')
        case 'end': return this.close()
        case 'needs-input': throw new Error(`${this.s.key}: tier B's Codex in Orca asks nothing`)
      }
    }
    // Claude Code names its transcript in every hook, and its session's title as it starts and at each prompt (hook/notify.mjs
    // observedBody).
    const transcript_path = this.transcript
    const titled = { transcript_path, session_title: this.s.title }
    switch (event) {
      case 'start': return engine.hook('SessionStart', { source: 'startup', ...titled })
      case 'turn-start': return engine.hook('UserPromptSubmit', titled)
      // As Claude Code tells its hooks of a permission it waits on (fakeEngine.mjs), the mod's PermissionRequest hook
      // among them, which says what the prompt is for (plugins/harness-device/hooks/asked): the dial asks from that.
      case 'needs-input': {
        await engine.hook('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt',
          transcript_path })
        const asked = await engine.asked('printf eval')
        if (asked.code !== 0) throw new Error(`${this.s.key}: the mod's PermissionRequest hook exited ${asked.code}`)
        return
      }
      case 'turn-stop': return engine.hook('Stop', { transcript_path })
      case 'end':
        await engine.hook('SessionEnd', { reason: 'prompt_input_exit', transcript_path })
        return this.close()
    }
  }

  /** A command on its terminal as its hooks run: its runner the caller, under its engine's environment, in its folder. */
  run(file: string, args: string[]): ReturnType<OrcaTerminal['run']> {
    return this.terminal.run(file, args, this.engine.env, '', this.engine.cwd)
  }

  /** Its stand-in ends: the agent goes with no hook. */
  close(): Promise<void> { return this.terminal.close() }
}

/** A running agent: its mod's poll, Claude Code's alone, and the person's tmux session it runs in, for one under tmux. */
interface Live { agent: OrcaAgent; mod?: AbortController; tmux?: string }
interface State {
  /** Each running agent, by session. */
  live: Map<SessionKey, Live>
  /** The latest layout step: what `terminal list` lays out from now on. */
  layout?: StepOf<'orca.layout'>
  /** The plugin's loop while it runs. */
  plugin?: PluginLoop
  /** The worktree the running loop was handed, and the terminals it was handed of it last. */
  front?: { worktree: string; told: string }
  /** What Orca's quit ended, for its relaunch: its agents, and whether the plugin ran. */
  quit?: { sessions: SessionKey[]; plugin: boolean }
  /** Orca's launch, 0 its first: its nth relaunch lays every pane out on its nth handle (orcaPaneHandle), the agents it
   *  ran at its quit and those started after alike. */
  launch: number
}
const states = new WeakMap<TierBWorld, State>()

/**
 * Orca, running: made at its first step, its own process with it, which, ended, quits Orca first, as the Claude app's
 * process ends its sessions: each agent ends, as Orca's quit ends them (Claude Code's SessionEnd, then its stand-in),
 * then its watches; the driver's end of its children waits for that. SIGKILL, the driver's last resort when that takes
 * too long, ends what is left at once, as a crash does: each mod's poll, tmux session and watch, its agents' stand-ins
 * with the driver's other children; an agent's end it cut short fails nothing.
 */
function orcaOf(world: TierBWorld): State {
  const known = states.get(world)
  if (known) return known
  const state: State = { live: new Map(), launch: 0 }
  states.set(world, state)
  // Only Orca's lifetime: what it does is in this file.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: world.d.root, env: world.d.env, stdio: ['pipe', 'ignore', 'ignore'] })
  world.children.push(child)
  const kill = child.kill.bind(child)
  let ending: Promise<void> | undefined
  let killed = false
  child.kill = (signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGKILL') {
      killed = true
      for (const live of state.live.values()) {
        live.mod?.abort()
        if (live.tmux) killTmux(world, live.tmux)
      }
      state.live.clear()
      world.orca.endWatch()
      return kill('SIGKILL')
    }
    // Its own end is that SIGKILL too, so its watches go whatever its agents' ends did.
    ending ??= endAll(world, state).catch((error: unknown) => { if (!killed) world.fail(error) })
      .finally(() => { child.kill('SIGKILL') })
    return true
  }
  return state
}

/** Each running agent ends at once, as Orca's quit ends them, then its watches: one that failed to end is thrown. */
async function endAll(world: TierBWorld, state: State): Promise<void> {
  const ended = await Promise.allSettled([...state.live.keys()].map((key) => endAgent(world, state, key, 'end')))
  for (const one of ended) if (one.status === 'rejected') throw one.reason
  world.orca.endWatch()
}

/** The handle of the session's pane while its agent runs, at Orca's launch. */
function handleOf(world: TierBWorld, state: State, key: SessionKey): string | undefined {
  return state.live.has(key) ? orcaPaneHandle(world.session(key), state.launch) : undefined
}

/** The handles of a worktree's open panes, in Orca's order. */
function terminalsOf(world: TierBWorld, state: State, worktree: string): string[] {
  const shown = orcaLayout(world.scenario, state.layout, (key) => handleOf(world, state, key)).find((w) => w.key === worktree)
  if (!shown) throw new Error(`scenario ${world.scenario.id}: orca.front names ${worktree}, which Orca has not laid out`)
  return shown.panes.map((pane) => pane.handle)
}

/** The plugin's loop is handed the worktree on Orca's screen: its open panes' handles. */
function handFront(state: State, plugin: PluginLoop, worktree: string, terminals: string[]): void {
  state.front = { worktree, told: JSON.stringify(terminals) }
  plugin.front(terminals)
}

/**
 * What `terminal list` prints from now on: the latest layout's worktrees, with the panes open now, in the daemon's
 * folders (orcaListing.ts, as tier A prints it). A pane opened, closed or renamed is Orca's `workspace.changed`, which
 * hands the loop the worktree on screen again (docs/plans/2026-11-18-dial-orca-tab-scope-design.md), as tier A's plugin
 * tells it (tierA/steps/orca.ts panesChanged): only terminals it was not handed last, as a rename's are.
 */
function relist(world: TierBWorld, state: State): void {
  const worktrees = orcaLayout(world.scenario, state.layout, (key) => handleOf(world, state, key), (path) => world.folder(path))
  world.orca.listing(orcaListing(worktrees, state.layout?.renamed ?? {}))
  const { plugin, front } = state
  if (!plugin || !front) return
  const terminals = terminalsOf(world, state, front.worktree)
  if (JSON.stringify(terminals) !== front.told) handFront(state, plugin, front.worktree, terminals)
}

/** A Codex home of the session's own, the Orca account's the daemon's Orca lists (appEvalDriver.ts orcaAccounts), in the
 *  root and not the daemon's CODEX_HOME, with Harness's hooks in it as the daemon installs them. */
function ownHome(world: TierBWorld, key: SessionKey): string {
  const home = orcaAccountHome(world.d.root, key)
  copyFileSync(join(world.d.env.CODEX_HOME!, 'hooks.json'), join(home, 'hooks.json'))
  return home
}

/**
 * A tmux session of the person's on the daemon's private server, as a person starts tmux in an Orca pane: its name, and
 * what tmux hands the programs it runs (the plan's Decision 4), so the hook asks that tmux of its pane and hears it is the
 * person's own.
 */
async function personsTmux(world: TierBWorld, s: SessionDef): Promise<{ name: string; hints: Record<string, string> }> {
  const { tmux } = world.d
  const name = `eval-${s.key}`
  const pane = await tmux.run('new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', '-c', world.folder(s.cwd), '/bin/sh')
  const [socket, pid, session] = (await tmux.run('display-message', '-p', '-t', pane, '#{socket_path},#{pid},#{session_id}')).split(',')
  return { name, hints: { TMUX: `${socket},${pid},${session!.replace(/^\$/, '')}`, TMUX_PANE: pane } }
}

/** At once, so Orca's last resort can end it as it is killed; one already gone fails nothing. */
function killTmux(world: TierBWorld, name: string): void {
  spawnSync('tmux', ['-S', world.d.tmux.socket, '-f', '/dev/null', 'kill-session', '-t', name], { env: world.d.tmux.env, timeout: KILL_MS })
}

/** The hints Orca hands the session's hooks at that launch (the plan's Decision 4): its pane's handle unless they name
 *  none (OH4's elimination), macOS's bundle id, and its tmux session's own. */
export function orcaHints(s: SessionDef, launch: number, platform: NodeJS.Platform, tmux: Record<string, string> = {}): Record<string, string> {
  const handle = hookHandle(s, launch)
  return {
    ...(handle === undefined ? {} : { ORCA_TERMINAL_HANDLE: handle }),
    ...(platform === 'darwin' ? { __CFBundleIdentifier: APP_BUNDLES.orca } : {}),
    ...tmux,
  }
}

/**
 * The session's agent starts in its pane: the pane opens on its handle at this launch (in Orca's list first, as Orca makes
 * the terminal its agent starts in), then its start hook, then for Claude Code the mod's poll, its hooks' hints Orca's
 * (orcaHints).
 */
async function startAgent(world: TierBWorld, state: State, key: SessionKey): Promise<void> {
  if (state.live.has(key)) throw new Error(`scenario ${world.scenario.id}: ${key} is running already`)
  const s = world.session(key)
  const { launch } = state
  const tmux = s.tmux ? await personsTmux(world, s) : undefined
  let agent: OrcaAgent
  try {
    const hints = orcaHints(s, launch, world.platform, tmux?.hints)
    const home = engineOf(s) === 'codex' && s.codexHome === 'own' ? ownHome(world, key) : undefined
    agent = await OrcaAgent.start(world.d, world.children, s, hints, home)
  } catch (error) {
    // Not yet live, so no end kills it: left, a reused daemon's next start of it would fail on its duplicate name.
    if (tmux) killTmux(world, tmux.name)
    throw error
  }
  const live: Live = { agent, ...(tmux ? { tmux: tmux.name } : {}) }
  state.live.set(key, live)
  // A held pane is a terminal another program was started in, and a tmux one's runs tmux's client: what is typed there
  // reaches no agent, as tier A has it (tierA/steps/sessions.ts keyOfOrcaHandle).
  if (!s.held && !s.tmux) world.orcaPane(key, orcaPaneHandle(s, launch))
  relist(world, state)
  await agent.hook('start')
  if (engineOf(s) === 'claude') {
    live.mod = new AbortController()
    void holdMod(world, key, s.id, live.mod.signal)
  }
}

/** The session's agent leaves its pane, which closes: as its engine leaves (`end`), or its pane closed under it with no
 *  hook (`close`). */
async function endAgent(world: TierBWorld, state: State, key: SessionKey, how: 'end' | 'close'): Promise<void> {
  const live = state.live.get(key)
  if (!live) throw new Error(`scenario ${world.scenario.id}: ${key}'s pane closes, but ${key} is not running`)
  state.live.delete(key)
  world.orcaPane(key, null)
  relist(world, state)
  try {
    if (how === 'end') await live.agent.hook('end')
    else await live.agent.close()
  } finally {
    live.mod?.abort()
    if (live.tmux) killTmux(world, live.tmux)
  }
}

/** The plugin's loop on the throwaway home, until the devices say its `dial` stream opened. */
async function startPlugin(world: TierBWorld, state: State): Promise<void> {
  if (state.plugin) throw new Error(`scenario ${world.scenario.id}: the plugin's loop runs already`)
  const from = world.d.log().length
  const plugin = state.plugin = startOrcaPlugin(world.d, world.children)
  await until(`${world.scenario.id}: the plugin's dial stream to open`, () => world.d.log().includes(STREAM_OPEN, from), STREAM_MS, 50)
    .catch((error: unknown) => {
      throw new Error(`${String(error instanceof Error ? error.message : error)}; its log: ${plugin.logs.slice(-5).join(' | ')}`)
    })
}

/** The plugin's loop ends, and its stream with it, as when Orca quits or the plugin is turned off. */
async function stopPlugin(world: TierBWorld, state: State): Promise<void> {
  const plugin = state.plugin
  if (!plugin) throw new Error(`scenario ${world.scenario.id}: the plugin's loop is not running`)
  state.plugin = undefined
  // Its next loop is handed no worktree until the next orca.front.
  state.front = undefined
  // It ends by itself once its stdin does, with code 0: any other end left a stream, send, watcher or timer behind.
  const code = await plugin.stop()
  if (code !== 0) world.fail(new Error(`the plugin's loop exited ${code}`))
}

function orcaNamed(world: TierBWorld, app: string): void {
  if (app !== 'orca') throw new Error(`scenario ${world.scenario.id}: Orca's steps quit and relaunch no ${app} app`)
}

export const orcaSteps: AppSteps = {
  hook: async (world, step) => {
    const state = orcaOf(world)
    if (step.event === 'start') return startAgent(world, state, step.session)
    if (step.event === 'end') return endAgent(world, state, step.session, 'end')
    const live = state.live.get(step.session)
    if (!live) throw new Error(`scenario ${world.scenario.id}: a hook for ${step.session}, which is not running`)
    await live.agent.hook(step.event, { lastAnswer: step.lastAnswer })
  },
  voice: async (world, step) => {
    hear(world)
    await speak(world, step)
  },
  /** Its agents end and their panes close, its watches end, and the plugin's loop stops; each is kept for its relaunch. */
  quit: async (world, step) => {
    orcaNamed(world, step.app)
    const state = orcaOf(world)
    const sessions = [...state.live.keys()]
    await endAll(world, state)
    const plugin = state.plugin !== undefined
    if (plugin) await stopPlugin(world, state)
    state.quit = { sessions, plugin }
  },
  /** Its agents come back with the same sessions on their next handles, in the order they had, then the plugin's loop
   *  where it ran. */
  relaunch: async (world, step) => {
    orcaNamed(world, step.app)
    const state = orcaOf(world)
    const quit = state.quit
    state.quit = undefined
    state.launch++
    for (const key of quit?.sessions ?? []) await startAgent(world, state, key)
    if (quit?.plugin) await startPlugin(world, state)
  },
  'orca.layout': async (world, step) => {
    const state = orcaOf(world)
    state.layout = step
    relist(world, state)
  },
  // A watch-focus line for the session's pane: the person focused it in Orca.
  'orca.focus': async (world, step) => {
    const handle = handleOf(world, orcaOf(world), step.session)
    if (handle === undefined) throw new Error(`scenario ${world.scenario.id}: orca.focus names ${step.session}, whose pane is not open`)
    world.orca.focus(handle)
  },
  // The plugin tells the worktree on Orca's screen.
  'orca.front': async (world, step) => {
    const state = orcaOf(world)
    if (!state.plugin) throw new Error(`scenario ${world.scenario.id}: orca.front with no plugin's loop running`)
    handFront(state, state.plugin, step.worktree, terminalsOf(world, state, step.worktree))
  },
  // With no plugin in Orca no loop of it ever runs, as with no extension in an editor.
  'orca.plugin': async (world, step) => {
    if (world.scenario.world?.orca?.plugin === false) return
    const state = orcaOf(world)
    if (step.open) await startPlugin(world, state)
    else await stopPlugin(world, state)
  },
  'orca.close': async (world, step) => endAgent(world, orcaOf(world), step.session, 'close'),
}
