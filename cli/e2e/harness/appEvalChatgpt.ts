/**
 * Tier B's steps on the ChatGPT app's threads (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"): its Codex home,
 * written in the daemon's throwaway home as the app writes it (src/testing/codexAppFixture.ts), and its threads' Codex
 * sessions, each told by its own hooks from a process of its own (harness/codexOutside.ts), so the app quitting ends
 * them as it does.
 *
 * Words reach a Codex thread only through `codex queue`, the app's own CLI's or the one on PATH, both fakes that note
 * each call under the root (harness/codexAppCli.ts, harness/fakeEngine.mjs). From a voice step to the scenario's stop,
 * each new call is a `codex` delivery to the session of its thread, or to none when no session of the scenario has it,
 * so a send to the wrong thread is seen. No ChatGPT scenario has a thread the app resumes from its link, so no fake of
 * the app watches the links run.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { onTestFinished } from 'vitest'
import { codexAppFixture } from '../../src/testing/codexAppFixture.js'
import { StepNotBuilt, type SessionDef, type SessionKey } from '../../src/testing/dialAppEval/types.js'
import { notBuilt, speak, type AppSteps, type TierBWorld } from './appEvalDriver.js'
import { CodexOutside } from './codexOutside.js'
import { writeSchemeApps } from './schemeApps.js'

/** The queue calls of the app's own CLI and of the `codex` on PATH, under the root (codexAppCli.ts, fakeEngine.mjs). */
const LEDGERS = ['codex-app-queue', 'codex-queue']
/** The recording open's line that refuses a ChatGPT link, after the line that notes it. */
const LINK_FAILS = 'case "$*" in *codex://*) exit 1 ;; esac\n'

interface State {
  /** Each running session. */
  live: Map<SessionKey, CodexOutside>
  /** The sessions the app's quit ended, for its relaunch. */
  quit: SessionKey[]
  /** The threads Codex has named: it names a thread once, so a later write of its row keeps its name. */
  named: Set<string>
  /** Whether the queue calls are read. */
  heard: boolean
}
const states = new WeakMap<TierBWorld, State>()

function stateOf(world: TierBWorld): State {
  let state = states.get(world)
  if (!state) states.set(world, state = { live: new Map(), quit: [], named: new Set(), heard: false })
  return state
}

/**
 * The hints its Codex's hooks send: on macOS the ChatGPT app's bundle id, which its children inherit; on Linux none, and
 * the devices learn the app from the session's process, named as the app's program is. A Codex CLI is in Ghostty.
 */
function hintsOf(s: SessionDef, platform: string): Record<string, string> {
  if (s.cli) return { TERM_PROGRAM: 'ghostty' }
  return platform === 'darwin' ? { __CFBundleIdentifier: 'com.openai.codex' } : {}
}

/** The session runs: its process, and its start hook from the scenario's folder. */
async function start(world: TierBWorld, key: SessionKey): Promise<void> {
  const state = stateOf(world)
  if (state.live.has(key)) return
  const s = world.session(key)
  const codex = new CodexOutside(world.d, `eval-${key}`, world.children, hintsOf(s, world.platform), {
    sessionId: s.id, own: world.platform === 'linux' && !s.cli ? { title: 'ChatGPT' } : {},
  })
  state.live.set(key, codex)
  await codex.hook('SessionStart', { source: 'startup', cwd: s.cwd })
}

async function end(world: TierBWorld, key: SessionKey): Promise<void> {
  const state = stateOf(world)
  await state.live.get(key)?.end()
  state.live.delete(key)
}

/** The answer as Codex's rollout holds it (cable/hosts/lastAnswer.ts reads it back). */
const answerLine = (text: string): string =>
  `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: text } })}\n`

/**
 * The open as the scenario's world has it: a ChatGPT link it says fails is refused, by the recording open on macOS and,
 * on Linux, with no app named for its scheme. Set at each scenario's first write, so the one before leaves none of it.
 */
function linksAsTheWorldSays(world: TierBWorld): void {
  const fails = world.scenario.world?.linkFails?.includes('chatgpt') === true
  if (world.platform === 'linux') {
    writeSchemeApps(world.d, fails ? { claude: 'com.anthropic.Claude.desktop' } : { claude: 'com.anthropic.Claude.desktop', codex: 'chatgpt.desktop' })
    return
  }
  const open = world.d.env.HARNESS_OPEN_BIN!
  const notes = readFileSync(open, 'utf8').replace(LINK_FAILS, '')
  writeFileSync(open, fails ? notes + LINK_FAILS : notes)
}

/** Each queue call from now to the scenario's stop, as a `codex` delivery: one reader of each ledger, a child ended at
 *  stop, from its next line on. */
function hear(world: TierBWorld): void {
  const state = stateOf(world)
  if (state.heard) return
  state.heard = true
  const ids = new Map(world.scenario.sessions.map((s) => [s.id, s.key]))
  for (const name of LEDGERS) {
    const ledger = join(world.d.root, name)
    const from = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length + 1 : 1
    appendFileSync(ledger, '')
    const tail = spawn('tail', ['-n', `+${from}`, '-F', ledger], { env: world.d.env, stdio: ['ignore', 'pipe', 'ignore'] })
    world.children.push(tail)
    createInterface({ input: tail.stdout! }).on('line', (line) => {
      const { args } = JSON.parse(line) as { args: string[] }
      const thread = args[args.indexOf('--thread') + 1] ?? ''
      const text = args.find((arg) => arg.startsWith('--message='))?.slice('--message='.length) ?? ''
      world.deliver({ path: 'codex', target: ids.get(thread) ?? null, text })
    })
  }
}

export const chatgptSteps: AppSteps = {
  'claude.write': notBuilt('claude.write'),
  /**
   * The rows of `sessions` and `archived` written as the app writes them, last active their age (or `ages`) ago; the
   * sidebar's projects in `projects` order with each session's project; Codex's name of each thread it has not named
   * yet, then `names`. The daemon's own watch on the home sees each file.
   */
  'codex.write': async (world, step) => {
    const state = stateOf(world)
    if (world.scenario.steps.find((s) => s.kind === 'codex.write') === step) linksAsTheWorldSays(world)
    const home = codexAppFixture(join(world.d.env.HOME!, '.codex'))
    const now = Date.now()
    const keys = [...new Set([...step.sessions, ...step.archived ?? []])]
    if (keys.length > 0) {
      const archived = new Set(step.archived)
      home.threads(keys.map((key) => {
        const s = world.session(key)
        return { id: s.id, cwd: s.cwd, source: s.cli ? 'cli' : 'vscode', archived: archived.has(key) ? 1 : 0,
          recencyAtMs: now - (step.ages?.[key] ?? s.ageMs) }
      }))
    }
    if (step.projects) {
      const assignments = Object.fromEntries(world.scenario.sessions.filter((s) => s.project !== undefined)
        .map((s) => [s.id, { projectKind: 'local', projectId: s.project }]))
      home.state({ projectOrder: step.projects, assignments })
    }
    const names: Array<[SessionKey, string]> = [
      ...step.sessions.filter((key) => !state.named.has(world.session(key).id)).map((key): [SessionKey, string] => [key, world.session(key).title]),
      ...Object.entries(step.names ?? {}),
    ]
    for (const [key, name] of names) {
      const { id } = world.session(key)
      home.name(id, name)
      state.named.add(id)
    }
    if (step.walBusy) {
      // The app's own writer, open with a write of its rows in the WAL, as while it runs: the reader reads past it. Closed
      // as the test that runs the scenario ends, after its stop: the next scenario's start empties the home.
      const writer = home.writer()
      onTestFinished(() => writer.close())
      writer.exec('UPDATE threads SET recency_at_ms = recency_at_ms')
    }
  },
  hook: async (world, step) => {
    if (step.event === 'start') return start(world, step.session)
    const s = world.session(step.session)
    const codex = stateOf(world).live.get(step.session)
    if (!codex) throw new Error(`scenario ${world.scenario.id}: a hook for ${step.session}, which has not started`)
    switch (step.event) {
      case 'turn-start':
        return codex.hook('UserPromptSubmit', { cwd: s.cwd })
      case 'turn-stop':
        if (step.lastAnswer !== undefined) appendFileSync(codex.transcriptPath, answerLine(step.lastAnswer))
        return codex.hook('Stop', { cwd: s.cwd })
      // Codex runs no hook as its session ends: its process ends.
      case 'end':
        return end(world, step.session)
      // No ChatGPT scenario asks: its PermissionRequest is not built.
      case 'needs-input':
        throw new StepNotBuilt('hook', 'b')
    }
  },
  attach: notBuilt('attach'),
  voice: async (world, step) => {
    hear(world)
    await speak(world, step)
  },
  quit: async (world, step) => {
    const state = stateOf(world)
    const ended = [...state.live.keys()].filter((key) => world.session(key).app === step.app && !world.session(key).cli)
    for (const key of ended) await end(world, key)
    state.quit = ended
  },
  relaunch: async (world) => {
    const state = stateOf(world)
    for (const key of state.quit.splice(0)) await start(world, key)
  },
}
