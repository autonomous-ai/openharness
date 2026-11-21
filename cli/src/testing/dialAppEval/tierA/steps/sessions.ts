/**
 * Tier A's steps on live sessions: their hooks, and the app quitting and coming back. A hook enters as the core passes it,
 * through `ports.devices.observed`, with the hints the session's app gives its Claude Code or Codex (hook/notify.mjs
 * hostHints); the session's process is in the machine model, its transcript in Harness's own engine homes. For a
 * Claude session the mod is this file: a loop holding `ports.devices.inboxPoll` open, so the devices' `modReady` holds
 * as with the real plugin, and each text a poll is answered with is a `mod` delivery to that session.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APP_BUNDLES } from '../../../../cable/hosts/hostDetect.js'
import { observedTitle } from '../../../../cable/hosts/observedTitle.js'
import type { DevicesPort } from '../../../../core/api.js'
import type { InboxAnswer } from '../../../../core/deviceHookCalls.js'
import { parseObservedHook, type ObservedEvent, type ObservedEventName } from '../../../../core/observedHook.js'
import type { App, Platform, SessionDef, SessionKey } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'

/** The first session's pid; each start takes the next, so a relaunched session's process is a new one. */
const FIRST_PID = 41_000
/** The mod waits a minute after a poll the devices could not hold (core/api.ts DEVICES_FALLBACKS). */
const MOD_RETRY_MS = 60_000

interface Live {
  pid: number
  transcriptPath: string
  /** The Claude mod's loop: the poll it holds open, until the session ends. */
  mod?: { pollId?: string; ended: boolean }
}
interface State {
  live: Map<SessionKey, Live>
  /** The sessions each app's quit ended, for its relaunch. */
  quit: Map<App, SessionKey[]>
  /** Poll ids are never reused in a world: the inbox keeps a gone id that came before its poll. */
  polls: number
  /** The processes started in this world. */
  started: number
}
const states = new WeakMap<TierAWorld, State>()

function stateOf(world: TierAWorld): State {
  let state = states.get(world)
  if (!state) states.set(world, state = { live: new Map(), quit: new Map(), polls: 0, started: 0 })
  return state
}

function devices(world: TierAWorld): DevicesPort {
  const port = world.ports.devices
  if (!port) throw new Error(`scenario ${world.scenario.id}: the devices are not started`)
  return port
}

/** The ChatGPT app's threads run on Codex. */
const engineOf = (s: SessionDef): 'claude' | 'codex' => (s.app === 'claude' ? 'claude' : 'codex')

/**
 * The hints the hook sends from the session's app (hook/notify.mjs hostHints), as tier B's sessions send them
 * (e2e/harness/appEvalClaude.ts, appEvalChatgpt.ts) and dialCodexApp.e2e.ts's. The Claude app gives its Claude Code its
 * own session id and entrypoint everywhere, and macOS its bundle id; on Windows the hook names the app itself
 * (lookUpWindowsApp), the Claude app by that entrypoint and the ChatGPT app by its program in the hook's parents. The
 * ChatGPT app's Codex inherits the app's bundle id on macOS and names no app on Linux. A Codex CLI names its terminal,
 * Ghostty.
 */
function hintsOf(s: SessionDef, platform: Platform): Record<string, string> {
  if (s.app === 'claude') {
    return {
      ...(platform === 'linux' ? {} : { __CFBundleIdentifier: APP_BUNDLES.claude }),
      CLAUDE_CODE_HOST_SESSION_ID: s.localId!, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    }
  }
  if (s.cli) return { TERM_PROGRAM: 'ghostty' }
  return platform === 'linux' ? {} : { __CFBundleIdentifier: APP_BUNDLES.codex }
}

/** The app a process table walk names for the session (scannedApp.ts learnApps): macOS and Linux walk an app's
 *  sessions to it; Windows walks none, and a terminal is no listed app. */
function walkedApp(s: SessionDef, platform: Platform): string | undefined {
  if (platform === 'win32' || s.cli) return undefined
  return s.app === 'claude' ? 'claude' : 'codex'
}

/** Where the engine writes the session's transcript, in Harness's own homes, which the devices read answers in. */
function transcriptOf(world: TierAWorld, s: SessionDef): string {
  return s.app === 'claude'
    ? join(world.folders.claudeProjects, s.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${s.id}.jsonl`)
    : join(world.folders.codexSessions, '2026', '11', '21', `rollout-2026-11-21T09-00-00-${s.id}.jsonl`)
}

/** The answer as each engine's transcript holds it (cable/hosts/lastAnswer.ts reads it back). */
function answerLine(s: SessionDef, text: string): string {
  const line = s.app === 'claude'
    ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    : { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } }
  return `${JSON.stringify(line)}\n`
}

/** The person's line that opens a turn, as each engine's transcript holds it: the last answer is read from after the
 *  last one (engines/claude/normalize.ts lastTurnTextFromRawLines, engines/codex/normalizer.ts lastCodexTurnText). */
function promptLine(s: SessionDef): string {
  const text = 'Eval prompt.'
  const line = s.app === 'claude'
    ? { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
    : { type: 'event_msg', payload: { type: 'user_message', message: text } }
  return `${JSON.stringify(line)}\n`
}

/** The hook's body as the core takes it (core/observedHook.ts parseObservedHook): one it would refuse fails the step. */
function observe(world: TierAWorld, key: SessionKey, body: ObservedEvent): void {
  const event = parseObservedHook(body)
  if (!event) throw new Error(`scenario ${world.scenario.id}: the core refuses ${key}'s ${body.event} hook`)
  devices(world).observed(event)
}

function tell(world: TierAWorld, key: SessionKey, live: Live, event: ObservedEventName): void {
  const s = world.session(key)
  // Claude Code says the name the app gave the session on these two (hook/notify.mjs observedBody).
  const title = s.app === 'claude' && (event === 'session-start' || event === 'turn-start') ? observedTitle(s.title) : undefined
  observe(world, key, {
    engine: engineOf(s), sessionId: s.id, event, cwd: s.cwd, callerPid: live.pid, transcriptPath: live.transcriptPath,
    hostHints: hintsOf(s, world.platform), ...(title === undefined ? {} : { title }),
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

/** The session runs: its process and open session in the machine, its start hook, and for Claude the mod's poll. */
export async function startSession(world: TierAWorld, key: SessionKey): Promise<void> {
  const state = stateOf(world)
  if (state.live.has(key)) return
  const s = world.session(key)
  const pid = FIRST_PID + state.started++
  const transcriptPath = transcriptOf(world, s)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  // A relaunched session goes on in the transcript it had.
  appendFileSync(transcriptPath, '')
  const app = walkedApp(s, world.platform)
  world.machine.start({ pid, ppid: 1, executable: engineOf(s), ...(app === undefined ? {} : { app }) })
  world.machine.owners.set(s.id, { engine: engineOf(s), pid, cwd: s.cwd, transcriptPath })
  const live: Live = { pid, transcriptPath, ...(s.app === 'claude' ? { mod: { ended: false } } : {}) }
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
        if (s.app === 'claude' && step.asks === 'permission') {
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
  quit: async (world, step) => {
    const state = stateOf(world)
    const ended = [...state.live].filter(([key]) => world.session(key).app === step.app)
    for (const [key, live] of ended) {
      endSession(world, key, live)
      world.machine.end(live.pid)
    }
    state.quit.set(step.app, ended.map(([key]) => key))
  },
  relaunch: async (world, step) => {
    const state = stateOf(world)
    const ended = state.quit.get(step.app) ?? []
    state.quit.delete(step.app)
    for (const key of ended) await startSession(world, key)
  },
}
