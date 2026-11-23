/**
 * Tier A's steps on live sessions: their hooks, and the app quitting and coming back. A hook enters as the core passes it,
 * through `ports.devices.observed`, with the hints the session's app gives its agent (hook/notify.mjs hostHints). The
 * session's process is in the machine model: a base app's alone, an editor's agent under its terminal's shell, or for
 * the panel and Cursor's own agent under the editor, the editor under Terminal when it was started from there. Its
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
import { engineOf, placeOf, type App, type Editor, type Engine, type Platform, type SessionDef, type SessionKey } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'

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

interface Live {
  pid: number
  /** An editor terminal's shell, the agent's parent. */
  shell?: number
  transcriptPath: string
  /** The Claude mod's loop: the poll it holds open, until the session ends. */
  mod?: { pollId?: string; ended: boolean }
}
interface State {
  live: Map<SessionKey, Live>
  /** The sessions each app's quit ended, for its relaunch. */
  quit: Map<App, SessionKey[]>
  /** Each editor's process while it runs: one per launch. */
  editors: Map<App, number>
  /** Terminal.app's process, once an editor started from it runs. */
  terminalApp?: number
  /** Poll ids are never reused in a world: the inbox keeps a gone id that came before its poll. */
  polls: number
  /** The processes started in this world. */
  started: number
}
const states = new WeakMap<TierAWorld, State>()

function stateOf(world: TierAWorld): State {
  let state = states.get(world)
  if (!state) states.set(world, state = { live: new Map(), quit: new Map(), editors: new Map(), polls: 0, started: 0 })
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
 */
function hintsOf(world: TierAWorld, s: SessionDef): Record<string, string> {
  const { platform } = world
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
 *  reaches its editor (machine.ts appOf). */
function walkedApp(s: SessionDef, platform: Platform): string | undefined {
  if (platform === 'win32' || s.cli) return undefined
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

/** Codex's rollout of the session in a Codex home's sessions folder, as Codex names it. */
const rollout = (sessions: string, id: string): string => join(sessions, '2026', '11', '21', `rollout-2026-11-21T09-00-00-${id}.jsonl`)

/** Where the engine writes the session's transcript: Harness's own homes, which the devices read answers in, a Codex
 *  home of its own, or Cursor's home (engines/cursor/contract.ts CURSOR_TRANSCRIPT, in a folder named by the cwd). */
function transcriptOf(world: TierAWorld, s: SessionDef): string {
  const slug = s.cwd.replace(/[^A-Za-z0-9]/g, '-')
  switch (engineOf(s)) {
    case 'claude': return join(world.folders.claudeProjects, slug, `${s.id}.jsonl`)
    case 'codex': return rollout(s.codexHome === 'own' ? join(world.folders.codexHomes, s.key, 'sessions') : world.folders.codexSessions, s.id)
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

/** A live editor terminal session's shell. */
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
  // placeOf names a place for an editor's session alone.
  const editor = place === undefined ? 1 : editorProcess(world, s.app as Editor)
  const shell = place === 'terminal' ? nextPid(world) : undefined
  if (shell !== undefined) world.machine.start({ pid: shell, ppid: editor, executable: SHELLS[world.platform] })
  const pid = nextPid(world)
  const app = place === undefined ? walkedApp(s, world.platform) : undefined
  world.machine.start({ pid, ppid: shell ?? editor, executable: AGENTS[engine], ...(app === undefined ? {} : { app }) })
  world.machine.owners.set(s.id, { engine, pid, cwd: s.cwd, transcriptPath })
  const live: Live = { pid, ...(shell === undefined ? {} : { shell }), transcriptPath,
    ...(engine === 'claude' ? { mod: { ended: false } } : {}) }
  state.live.set(key, live)
  tell(world, key, live, 'session-start')
  if (live.mod) holdMod(world, key, s.id, live.mod)
}

/** Its end hook, and the mod's poll closed as its client goes; the process runs on until it is ended. */
function endSession(world: TierAWorld, key: SessionKey, live: Live): void {
  tell(world, key, live, 'session-end')
  world.machine.owners.delete(world.session(key).id)
  stateOf(world).live.delete(key)
  if (!live.mod) return
  live.mod.ended = true
  if (live.mod.pollId !== undefined) devices(world).inboxGone(live.mod.pollId)
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
        endSession(world, step.session, live)
        break
    }
  },
  // The app's sessions end with their processes, and an editor's terminals and own process with it.
  quit: async (world, step) => {
    const state = stateOf(world)
    const ended = [...state.live].filter(([key]) => world.session(key).app === step.app)
    for (const [key, live] of ended) {
      endSession(world, key, live)
      world.machine.end(live.pid)
      if (live.shell !== undefined) world.machine.end(live.shell)
    }
    const editor = state.editors.get(step.app)
    if (editor !== undefined) world.machine.end(editor)
    state.editors.delete(step.app)
    state.quit.set(step.app, ended.map(([key]) => key))
  },
  relaunch: async (world, step) => {
    const state = stateOf(world)
    const ended = state.quit.get(step.app) ?? []
    state.quit.delete(step.app)
    for (const key of ended) await startSession(world, key)
  },
}
