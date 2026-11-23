/**
 * Tier A's steps on live sessions: their hooks, and the app quitting and coming back. A hook enters as the core passes it,
 * through `ports.devices.observed`, with the hints the session's app gives its agent (hook/notify.mjs hostHints). The
 * session's process is in the machine model: a base app's alone, an editor's agent under its terminal's shell, or for
 * the panel and Cursor's own agent under the editor, the editor under Terminal when it was started from there; an Orca
 * agent under its pane's shell, on that pane's terminal, which Orca's terminal host made (orcaPane); an iTerm2 agent
 * under its tab's shell, on that tab's terminal (iterm.ts tabShell). Its
 * transcript is in Harness's own engine homes, a Codex with a home of its own in that home, and Cursor's in Cursor's.
 * What each sends is chosen by the session's engine and place, never by its app. For a Claude Code session the mod is
 * this file: a loop holding `ports.devices.inboxPoll` open, so the devices' `modReady` holds as with the real plugin,
 * and each text a poll is answered with is a `mod` delivery to that session.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APP_BUNDLES } from '../../../../cable/hosts/hostDetect.js'
import { observedTitle } from '../../../../cable/hosts/observedTitle.js'
import type { DevicesPort } from '../../../../core/api.js'
import type { InboxAnswer } from '../../../../core/deviceHookCalls.js'
import { parseObservedHook, type ObservedEvent, type ObservedEventName } from '../../../../core/observedHook.js'
import { RECORDED_ORCA } from '../../../recordedOrca.js'
import { engineOf, HELD_MAKER, hookHandle, itermPlaceOf, orcaPaneHandle, placeOf, type App, type Editor, type Engine, type Platform,
  type SessionDef, type SessionKey } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { tabShell } from './iterm.js'
import { panesChanged } from './orca.js'

/** The first process's pid; each start takes the next, so a relaunched session's process is a new one. */
const FIRST_PID = 41_000
/** The mod waits a minute after a poll the devices could not hold (core/api.ts DEVICES_FALLBACKS). */
const MOD_RETRY_MS = 60_000

/** Each editor's bundle on macOS, and its program on each platform: on macOS the executable in that bundle. */
const EDITOR_PROGRAMS: Readonly<Record<Editor, { bundle: string; programs: Readonly<Record<Platform, string>> }>> = {
  vscode: { bundle: '/Applications/Visual Studio Code.app',
    programs: { darwin: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', linux: 'code', win32: 'Code.exe' } },
  cursor: { bundle: '/Applications/Cursor.app',
    programs: { darwin: '/Applications/Cursor.app/Contents/MacOS/Cursor', linux: 'cursor', win32: 'Cursor.exe' } },
}
/**
 * `code .` and `cursor .` run from Terminal.app, a macOS app: the scenarios that say so run on macOS alone. Their agents
 * hook with Terminal's bundle id, so the devices file the row under Terminal and never walk its parents. Tier B's real
 * daemon and `ps` chain do the same: V11 run on a daemon of its own (2026-11-22) holds no VS Code list either. The tier B
 * baseline's VS Code row for V11 is V10's last list, which the dial of the daemon they share still held from before V11
 * began (`list at -10391 on vscode: 2 rows a other`), as a has the same id in both.
 */
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app'
const SHELLS: Readonly<Record<Platform, string>> = { darwin: '/bin/zsh', linux: '/bin/bash', win32: 'pwsh.exe' }
const AGENTS: Readonly<Record<Engine, string>> = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent' }
/** The maker of Orca's panes' terminals as each platform names it (RECORDED_ORCA): its terminal host, the helper on macOS
 *  and the daemon on Linux; on Windows, where the devices read no maker, the app. */
const ORCA_HOSTS: Readonly<Record<Platform, string>> = {
  darwin: RECORDED_ORCA.macos.chain.at(-1)!.comm, linux: RECORDED_ORCA.linux.deb.makerComm, win32: 'Orca.exe',
}

interface Live {
  pid: number
  /** Its terminal's shell: an editor terminal's, the agent's parent, its Orca pane's or its iTerm2 tab's. */
  shell?: number
  /** The other processes of its Orca pane or iTerm2 tab, which end with it: a held one's maker, under tmux its client,
   *  its server and the shell the agent runs in, and an iTerm2 tab's login. */
  others: number[]
  transcriptPath: string
  /** The Claude mod's loop: the poll it holds open, until the session ends. */
  mod?: { pollId?: string; ended: boolean }
}
interface State {
  live: Map<SessionKey, Live>
  /** The sessions each app's quit ended, for its relaunch. */
  quit: Map<App, SessionKey[]>
  /** Orca's launch, 0 its first: its nth relaunch lays every pane out on its nth handle (orcaPaneHandle), the sessions
   *  it ran at its quit and those started after alike. */
  orcaLaunch: number
  /** Each editor's process while it runs: one per launch. */
  editors: Map<App, number>
  /** Terminal.app's process, once an editor started from it runs. */
  terminalApp?: number
  /** Orca's terminal host, once an Orca pane runs, until Orca quits: one per launch. */
  orcaHost?: number
  /** The terminals made in this world: an Orca pane's, an iTerm2 tab's or split's, or a tmux pane's in either. */
  ttys: number
  /** Poll ids are never reused in a world: the inbox keeps a gone id that came before its poll. */
  polls: number
  /** The processes started in this world. */
  started: number
}
const states = new WeakMap<TierAWorld, State>()

function stateOf(world: TierAWorld): State {
  let state = states.get(world)
  if (!state) states.set(world, state = { live: new Map(), quit: new Map(), orcaLaunch: 0, editors: new Map(), ttys: 0, polls: 0, started: 0 })
  return state
}

const nextPid = (world: TierAWorld): number => FIRST_PID + stateOf(world).started++

function devices(world: TierAWorld): DevicesPort {
  const port = world.ports.devices
  if (!port) throw new Error(`scenario ${world.scenario.id}: the devices are not started`)
  return port
}

const fromTerminal = (world: TierAWorld): boolean => world.scenario.world?.launchedFrom === 'terminal-app'

/**
 * The hints the hook sends from the session's app (hook/notify.mjs hostHints), as tier B's sessions send them
 * (e2e/harness/appEvalClaude.ts, appEvalChatgpt.ts) and dialCodexApp.e2e.ts's. The Claude app gives its Claude Code its
 * own session id and entrypoint everywhere, and macOS its bundle id; on Windows the hook names the app itself
 * (lookUpWindowsApp), the Claude app by that entrypoint and the ChatGPT app by its program in the hook's parents. The
 * ChatGPT app's Codex inherits the app's bundle id on macOS and names no app on Linux. A Codex CLI names its terminal,
 * Ghostty.
 *
 * An editor's agent: its terminal says TERM_PROGRAM=vscode, Cursor's as VS Code's. macOS gives the editor's bundle id,
 * or Terminal's to an editor started from there, and the hook finds the editor itself on Windows; Linux gives no bundle
 * id. The panel's Claude Code adds the extension's entrypoint.
 *
 * An Orca agent (the plan's Decision 4): Orca's agent session everywhere, and its pane's handle unless its hooks name
 * none; macOS adds Orca's bundle id. Under tmux the hook adds tmux's pane, as a tmux started in the pane hands its agents
 * Orca's variables; the hook keeps no TMUX. No TERM_PROGRAM, as Orca sets none.
 *
 * An iTerm2 tab's agent (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 8): iTerm2's TERM_PROGRAM and its
 * bundle id, as iTerm2 gives every shell it starts.
 */
function hintsOf(world: TierAWorld, s: SessionDef): Record<string, string> {
  const { platform } = world
  if (s.app === 'iterm') return { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: APP_BUNDLES.iterm }
  if (s.app === 'orca') {
    const handle = hookHandle(s, stateOf(world).orcaLaunch)
    return {
      ORCA_AGENT_SESSION_ID: `eval-orca-${s.key}`,
      ...(handle === undefined ? {} : { ORCA_TERMINAL_HANDLE: handle }),
      ...(platform === 'darwin' ? { __CFBundleIdentifier: APP_BUNDLES.orca } : {}),
      ...(s.tmux ? { TMUX_PANE: `%${world.scenario.sessions.indexOf(s)}` } : {}),
    }
  }
  const place = placeOf(s)
  if (place !== undefined) {
    const bundle = platform === 'linux' ? undefined : APP_BUNDLES[platform === 'darwin' && fromTerminal(world) ? 'terminal-app' : s.app]
    return {
      ...(place === 'terminal' ? { TERM_PROGRAM: 'vscode' } : {}),
      ...(bundle === undefined ? {} : { __CFBundleIdentifier: bundle }),
      ...(place === 'panel' ? { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } : {}),
    }
  }
  if (s.app === 'claude') {
    return {
      ...(platform === 'linux' ? {} : { __CFBundleIdentifier: APP_BUNDLES.claude }),
      CLAUDE_CODE_HOST_SESSION_ID: s.localId!, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    }
  }
  if (s.cli) return { TERM_PROGRAM: 'ghostty' }
  return platform === 'linux' ? {} : { __CFBundleIdentifier: APP_BUNDLES.codex }
}

/** The app a process table walk names for a base app's session (scannedApp.ts learnApps): macOS and Linux walk an app's
 *  sessions to it; Windows walks none, and a terminal is no listed app. An editor's agent has none of its own: the walk
 *  reaches its editor (machine.ts appOf). No process of Orca's has an app id (the plan's Decision 5): Orca's helper
 *  names no bundle id, and the walk knows none of Orca's Linux names. Nor has iTerm2's: its walk is the real one
 *  (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 4). */
function walkedApp(s: SessionDef, platform: Platform): string | undefined {
  if (platform === 'win32' || s.cli || s.app === 'orca' || s.app === 'iterm') return undefined
  return s.app === 'claude' ? 'claude' : 'codex'
}

/** An app process, with its bundle's id on macOS and its app id where a walk names one: Windows walks none. */
function startApp(world: TierAWorld, ppid: number, app: string, bundle: string, executable: string): number {
  const { platform } = world
  const pid = nextPid(world)
  if (platform === 'darwin') world.machine.bundleIds.set(bundle, APP_BUNDLES[app]!)
  world.machine.start({ pid, ppid, executable, ...(platform === 'win32' ? {} : { app }) })
  return pid
}

/** The editor's process: the running one, else one started now, under Terminal's when the editor was started from it. */
function editorProcess(world: TierAWorld, app: Editor): number {
  const state = stateOf(world)
  const running = state.editors.get(app)
  if (running !== undefined) return running
  const parent = fromTerminal(world)
    ? state.terminalApp ??= startApp(world, 1, 'terminal-app', TERMINAL_APP, `${TERMINAL_APP}/Contents/MacOS/Terminal`)
    : 1
  const { bundle, programs } = EDITOR_PROGRAMS[app]
  const pid = startApp(world, parent, app, bundle, programs[world.platform])
  state.editors.set(app, pid)
  return pid
}

/** A process started now, on that terminal: its pid, from the world's one count of them. */
export function startProcess(world: TierAWorld, ppid: number, executable: string, tty?: string): number {
  const pid = nextPid(world)
  world.machine.start({ pid, ppid, executable, ...(tty === undefined ? {} : { tty }) })
  return pid
}

/** A new terminal as the platform names it, `ttys0NN` and `pts/N`, from the world's one count of them; none on Windows,
 *  which has no `ps` to read one. */
export function nextTty(world: TierAWorld): string | undefined {
  const n = stateOf(world).ttys++
  if (world.platform === 'darwin') return `ttys0${String(n).padStart(2, '0')}`
  return world.platform === 'linux' ? `pts/${n}` : undefined
}

/**
 * The session's Orca pane (the plan's Decision 5): a shell on a terminal of its own, made by Orca's terminal host (on no
 * terminal, launchd's or init's child), or a held pane's by a maker of its own that is not Orca's. Under tmux the pane's
 * shell runs tmux's client, and tmux's server (on no terminal) runs the agent's shell on another terminal. The devices'
 * maker check reads each chain as the machine's `ps` would show it (scannedApp.ts ptyMaker). Gives the pane's shell, the
 * shell the agent runs under, and the pane's other processes, which end with it: Orca's host runs on for its other panes.
 */
function orcaPane(world: TierAWorld, s: SessionDef): { shell: number; parent: number; others: number[] } {
  const state = stateOf(world)
  const others: number[] = []
  const maker = s.held ? startProcess(world, 1, HELD_MAKER) : state.orcaHost ??= startProcess(world, 1, ORCA_HOSTS[world.platform])
  if (s.held) others.push(maker)
  const tty = nextTty(world)
  const shell = startProcess(world, maker, SHELLS[world.platform], tty)
  if (!s.tmux) return { shell, parent: shell, others }
  const client = startProcess(world, shell, 'tmux', tty)
  const server = startProcess(world, 1, 'tmux')
  const parent = startProcess(world, server, SHELLS[world.platform], nextTty(world))
  others.push(client, server, parent)
  return { shell, parent, others }
}

/** The session's iTerm2 tab or split (the plan's Decision 4): its shell, opened when none is, and the tab's login, which
 *  ends with it. A tmux or herdr session's pane is built by its own task (Tasks 5 and 6). */
function itermTab(world: TierAWorld, s: SessionDef): { shell: number; parent: number; others: number[] } {
  const place = itermPlaceOf(s)
  if (place !== 'tab') throw new Error(`tier A: an iTerm2 session in ${place} is not built yet`)
  const { pid: shell } = tabShell(world, { window: s.window!, tab: s.tab!, split: s.split })
  return { shell, parent: shell, others: [world.machine.processes.get(shell)!.ppid] }
}

/** Codex's rollout of the session in a Codex home's sessions folder, as Codex names it. */
const rollout = (sessions: string, id: string): string => join(sessions, '2026', '11', '21', `rollout-2026-11-21T09-00-00-${id}.jsonl`)

/** The Codex home of a session with one of its own, in the world's folder of them: an Orca agent's is its account's. */
export const codexHomeOf = (world: TierAWorld, key: SessionKey): string => join(world.folders.codexHomes, key)

/** Where the engine writes the session's transcript: Harness's own homes, which the devices read answers in, a Codex
 *  home of its own, or Cursor's home (engines/cursor/contract.ts CURSOR_TRANSCRIPT, in a folder named by the cwd). */
function transcriptOf(world: TierAWorld, s: SessionDef): string {
  const slug = s.cwd.replace(/[^A-Za-z0-9]/g, '-')
  switch (engineOf(s)) {
    case 'claude': return join(world.folders.claudeProjects, slug, `${s.id}.jsonl`)
    case 'codex': return rollout(s.codexHome === 'own' ? join(codexHomeOf(world, s.key), 'sessions') : world.folders.codexSessions, s.id)
    case 'cursor': return join(world.folders.cursorProjects, slug.replace(/^-+/, ''), 'agent-transcripts', s.id, `${s.id}.jsonl`)
  }
}

/** The answer as each engine's transcript holds it: cable/hosts/lastAnswer.ts reads Claude Code's and Codex's back,
 *  engines/cursor/normalizer.ts lastCursorTurnText Cursor's. */
const ANSWER_LINES: Readonly<Record<Engine, (text: string) => object>> = {
  claude: (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  codex: (text) => ({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } }),
  cursor: (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } }),
}
/** The person's line that opens a turn, as each engine's transcript holds it: the last answer is read from after the
 *  last one (engines/claude/normalize.ts lastTurnTextFromRawLines, engines/codex/normalizer.ts lastCodexTurnText,
 *  engines/cursor/normalizer.ts lastCursorTurnText). */
const PROMPT_LINES: Readonly<Record<Engine, (text: string) => object>> = {
  claude: (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }),
  codex: (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } }),
  cursor: (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } }),
}
const answerLine = (s: SessionDef, text: string): string => `${JSON.stringify(ANSWER_LINES[engineOf(s)](text))}\n`
const promptLine = (s: SessionDef): string => `${JSON.stringify(PROMPT_LINES[engineOf(s)]('Eval prompt.'))}\n`

/** The hook's body as the core takes it (core/observedHook.ts parseObservedHook): one it would refuse fails the step. */
function observe(world: TierAWorld, key: SessionKey, body: ObservedEvent): void {
  const event = parseObservedHook(body)
  if (!event) throw new Error(`scenario ${world.scenario.id}: the core refuses ${key}'s ${body.event} hook`)
  devices(world).observed(event)
}

function tell(world: TierAWorld, key: SessionKey, live: Live, event: ObservedEventName): void {
  const s = world.session(key)
  const engine = engineOf(s)
  // Claude Code alone says its session's name, on these two (hook/notify.mjs observedBody); Codex's and Cursor's hooks
  // carry none.
  const title = engine === 'claude' && (event === 'session-start' || event === 'turn-start') ? observedTitle(s.title) : undefined
  // Cursor's hook says its workspace's roots, and notify.mjs takes the first as the cwd.
  const cwd = engine === 'cursor' ? s.folders?.[0] ?? s.cwd : s.cwd
  observe(world, key, {
    engine, sessionId: s.id, event, cwd, callerPid: live.pid, transcriptPath: live.transcriptPath,
    hostHints: hintsOf(world, s), ...(title === undefined ? {} : { title }),
  })
}

/** The mod's loop: one poll held open at a time, the next asked as soon as one is answered. */
function holdMod(world: TierAWorld, key: SessionKey, sessionId: string, mod: NonNullable<Live['mod']>): void {
  const state = stateOf(world)
  void (async () => {
    while (!mod.ended) {
      const pollId = mod.pollId = `eval-poll-${++state.polls}`
      const answer = await devices(world).inboxPoll({ pollId, sessionId }).catch((): InboxAnswer => ({ off: true }))
      if (mod.ended) return
      if (typeof answer.text === 'string' && answer.text !== '') world.deliver({ path: 'mod', target: key, text: answer.text })
      // Unref'd: a wait still set when the scenario stops never holds the test run open.
      if (answer.off) await new Promise((resolve) => { setTimeout(resolve, MOD_RETRY_MS).unref() })
    }
  })()
}

/** Whether the session runs now: started, and not ended since. */
export function running(world: TierAWorld, key: SessionKey): boolean {
  return stateOf(world).live.has(key)
}

/** A live session's terminal's shell: an editor terminal's, its Orca pane's or its iTerm2 tab's. */
export function shellOf(world: TierAWorld, key: SessionKey): number | undefined {
  return stateOf(world).live.get(key)?.shell
}

/** A live session's agent process, its hooks' caller. */
export function agentPid(world: TierAWorld, key: SessionKey): number | undefined {
  return stateOf(world).live.get(key)?.pid
}

/** The live session whose terminal's shell this is. */
export function keyOfShell(world: TierAWorld, pid: number): SessionKey | undefined {
  for (const [key, live] of stateOf(world).live) if (live.shell === pid) return key
  return undefined
}

/** The handle of the session's Orca pane while it is open: from its start to its end, at Orca's launch. */
export function orcaHandleOf(world: TierAWorld, key: SessionKey): string | undefined {
  const s = world.session(key)
  return s.app === 'orca' && running(world, key) ? orcaPaneHandle(s, stateOf(world).orcaLaunch) : undefined
}

/** The live session whose open Orca pane has this handle and is its own terminal: a held one's is the terminal another
 *  program was started in, and a tmux one's runs tmux's client, so what either is sent reaches no agent. */
export function keyOfOrcaHandle(world: TierAWorld, handle: string): SessionKey | undefined {
  for (const key of stateOf(world).live.keys()) {
    const s = world.session(key)
    if (!s.held && !s.tmux && orcaHandleOf(world, key) === handle) return key
  }
  return undefined
}

/** The session runs: its processes and open session in the machine, its start hook, and for Claude Code the mod's poll. */
export async function startSession(world: TierAWorld, key: SessionKey): Promise<void> {
  const state = stateOf(world)
  if (state.live.has(key)) return
  const s = world.session(key)
  const engine = engineOf(s)
  const transcriptPath = transcriptOf(world, s)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  // A relaunched session goes on in the transcript it had.
  appendFileSync(transcriptPath, '')
  const place = placeOf(s)
  let shell: number | undefined
  let parent: number
  let others: number[] = []
  if (s.app === 'orca') ({ shell, parent, others } = orcaPane(world, s))
  else if (s.app === 'iterm') ({ shell, parent, others } = itermTab(world, s))
  else {
    // placeOf names a place for an editor's session alone.
    const editor = place === undefined ? 1 : editorProcess(world, s.app as Editor)
    shell = place === 'terminal' ? nextPid(world) : undefined
    if (shell !== undefined) world.machine.start({ pid: shell, ppid: editor, executable: SHELLS[world.platform] })
    parent = shell ?? editor
  }
  const pid = nextPid(world)
  const app = place === undefined ? walkedApp(s, world.platform) : undefined
  // On its shell's terminal, which only an Orca pane's and an iTerm2 tab's have.
  const tty = world.machine.processes.get(parent)?.tty
  world.machine.start({ pid, ppid: parent, executable: AGENTS[engine], ...(tty === undefined ? {} : { tty }),
    ...(app === undefined ? {} : { app }) })
  world.machine.owners.set(s.id, { engine, pid, cwd: s.cwd, transcriptPath })
  const live: Live = { pid, ...(shell === undefined ? {} : { shell }), others, transcriptPath,
    ...(engine === 'claude' ? { mod: { ended: false } } : {}) }
  state.live.set(key, live)
  // Orca made the pane's terminal before its agent started in it: the plugin hears of the pane first.
  if (s.app === 'orca') await panesChanged(world)
  tell(world, key, live, 'session-start')
  if (live.mod) holdMod(world, key, s.id, live.mod)
}

/** Its end hook, and the mod's poll closed as its client goes; the process runs on until it is ended. */
async function endSession(world: TierAWorld, key: SessionKey, live: Live): Promise<void> {
  tell(world, key, live, 'session-end')
  await closeSession(world, key, live)
}

/** The session is no longer open, and the mod's poll goes with its client; an Orca session's pane closes with it. */
async function closeSession(world: TierAWorld, key: SessionKey, live: Live): Promise<void> {
  world.machine.owners.delete(world.session(key).id)
  stateOf(world).live.delete(key)
  if (live.mod) {
    live.mod.ended = true
    if (live.mod.pollId !== undefined) devices(world).inboxGone(live.mod.pollId)
  }
  if (world.session(key).app === 'orca') await panesChanged(world)
}

/** Its pane or tab closed under it (orca.close, the plan's Decision 8; iterm.closeTab): the agent and its shell end with
 *  no hook, as a process killed with its terminal runs none. */
export async function dropSession(world: TierAWorld, key: SessionKey): Promise<void> {
  const live = stateOf(world).live.get(key)
  if (!live) throw new Error(`scenario ${world.scenario.id}: ${key}'s pane closes, but ${key} is not running`)
  endProcesses(world, live)
  await closeSession(world, key, live)
}

/** The agent's process, its terminal's shell and its pane's other processes end. */
function endProcesses(world: TierAWorld, live: Live): void {
  world.machine.end(live.pid)
  if (live.shell !== undefined) world.machine.end(live.shell)
  for (const pid of live.others) world.machine.end(pid)
}

function liveOf(world: TierAWorld, key: SessionKey): Live {
  const live = stateOf(world).live.get(key)
  if (!live) throw new Error(`scenario ${world.scenario.id}: a hook for ${key}, which has not started`)
  return live
}

export const sessionsSteps: { hook: StepHandler<'hook'>; quit: StepHandler<'quit'>; relaunch: StepHandler<'relaunch'> } = {
  hook: async (world, step) => {
    if (step.event === 'start') return startSession(world, step.session)
    const live = liveOf(world, step.session)
    const s = world.session(step.session)
    switch (step.event) {
      case 'turn-start':
        appendFileSync(live.transcriptPath, promptLine(s))
        tell(world, step.session, live, 'turn-start')
        break
      case 'needs-input':
        tell(world, step.session, live, 'needs-input')
        // Claude Code's PermissionRequest hook runs the plugin's client too (deviceClaude/asked.ts): what the prompt is for.
        if (engineOf(s) === 'claude' && step.asks === 'permission') {
          observe(world, step.session, { engine: 'claude', sessionId: s.id, event: 'asked', cwd: s.cwd, tool: 'Bash', summary: 'Eval check' })
        }
        break
      case 'turn-stop':
        if (step.lastAnswer !== undefined) appendFileSync(live.transcriptPath, answerLine(s, step.lastAnswer))
        tell(world, step.session, live, 'turn-stop')
        break
      case 'end':
        await endSession(world, step.session, live)
        break
    }
  },
  // The app's sessions end with their processes, an editor's terminals and own process with it, and Orca's terminal host
  // with Orca: its relaunch starts another.
  quit: async (world, step) => {
    const state = stateOf(world)
    const ended = [...state.live].filter(([key]) => world.session(key).app === step.app)
    for (const [key, live] of ended) {
      await endSession(world, key, live)
      endProcesses(world, live)
    }
    const editor = state.editors.get(step.app)
    if (editor !== undefined) world.machine.end(editor)
    state.editors.delete(step.app)
    if (step.app === 'orca' && state.orcaHost !== undefined) {
      world.machine.end(state.orcaHost)
      state.orcaHost = undefined
    }
    state.quit.set(step.app, ended.map(([key]) => key))
  },
  relaunch: async (world, step) => {
    const state = stateOf(world)
    const ended = state.quit.get(step.app) ?? []
    state.quit.delete(step.app)
    if (step.app === 'orca') state.orcaLaunch++
    for (const key of ended) await startSession(world, key)
  },
}
