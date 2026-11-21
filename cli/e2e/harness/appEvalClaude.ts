/**
 * Tier B's steps on the Claude app's sessions (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B"):
 * - its store, written in the daemon's throwaway home as the app writes it (src/testing/claudeAppFixture.ts);
 * - its live sessions, each the suite's fake Claude Code (outsideAgent.ts) going on in the session's own conversation
 *   (`--resume <id>`) with the hints the app gives its Claude Code, on Linux under a fake of the app. Its hooks are the
 *   ones it runs itself: a turn is `!until <name>`, its last answer the release file's text, a permission it asks for
 *   `<name>.permit` (fakeEngine.mjs). The harness-device mod's inbox poll is held for it (modInbox.ts), and each text a
 *   poll is answered is a `mod` delivery to that session; each prompt its terminal took that no step typed is a `typed`
 *   one. So words that reach any session by either path are seen with their target;
 * - the mod's attach, through the real `harness device claude link --json` and its post, as dialClaudeAppFollow.e2e.ts;
 * - the app itself: a process for as long as it runs, which quits with its sessions and relaunches them, and resumes a
 *   resumable session whose continue link opened, then shows it, its mod's attach naming it, as the real app does (the
 *   design's "The fake apps react to links").
 *
 * Every process these start runs under the daemon's environment, the network guard's preload in it (appEvalDriver.ts).
 * The app's process is in `world.children`: the driver ends it at stop, and its end first ends each of its sessions
 * (their SessionEnd hook, their poll, their process), so nothing of a scenario outlives it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { claudeStoreRoots } from '../../src/cable/hosts/appPlaces.js'
import { APP_BUNDLES } from '../../src/cable/hosts/hostDetect.js'
import { fetchOverSocket } from '../../src/lib/localTransport.js'
import { claudeAppFixture } from '../../src/testing/claudeAppFixture.js'
import type { SessionDef, SessionKey } from '../../src/testing/dialAppEval/types.js'
import { inside, speak, type AppSteps, type OpenRun, type TierBWorld } from './appEvalDriver.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './daemon.js'
import { inboxPoll } from './modInbox.js'
import { Outside } from './outsideAgent.js'

const LINUX = process.platform === 'linux'
// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
/** For a hook the fake ran to be in its log. */
const HOOK_MS = 30_000
/** For a session's SessionEnd hook as it leaves: past it, its process goes all the same. */
const END_MS = 10_000
/** The mod waits a minute after a poll the devices could not hold (503), and a second after one they did not hold. */
const OFF_RETRY_MS = 60_000
const HELD_MS = 1_000
/** For `harness device claude link --json`, which asks the daemon once: past it, it is ended and the attach fails. */
const LINK_MS = 30_000
/** The end of the link's stderr a failure says. */
const STDERR_KEPT = 2_000

interface Live {
  outside: Outside
  /** Ends the mod's poll. */
  mod: AbortController
  /** The prompts typed into it and the turns it answered; the open turn's name; a permission dialog waiting on the person. */
  turns: number
  stops: number
  open?: string
  asking?: true
  /** Its transcript, and its size as it started: the prompts after are what this run typed or was sent. */
  transcript: string
  from: number
}
interface FakeApp {
  process: ChildProcess
  live: Map<SessionKey, Live>
  /** Each start in flight, so a link and a step never start one session twice. */
  starting: Map<SessionKey, Promise<Live>>
  /** Ended: a link run after it reaches no app. */
  closed: boolean
}
interface State {
  app?: FakeApp
  /** The sessions the app's quit ended, for its relaunch. */
  quit: SessionKey[]
}
const states = new WeakMap<TierBWorld, State>()
/** The devices' socket each daemon's link named, asked once per daemon. */
const sockets = new WeakMap<IsolatedDaemon, Promise<string>>()
/** The daemons whose home has the mod. */
const modded = new WeakSet<IsolatedDaemon>()
/** Names of turns, unique for the run: a daemon's root holds the release files of every scenario it ran. */
let turnsTyped = 0

const stateOf = (world: TierBWorld): State => {
  let state = states.get(world)
  if (!state) states.set(world, state = { quit: [] })
  return state
}
/** The link the devices make for a Claude app session (cable/hosts/claudeApp.ts). */
const linkOf = (s: SessionDef): string => `claude://code/continue?session=${s.localId}`
const fileOf = (world: TierBWorld, name: string, kind: 'release' | 'permit'): string => join(world.d.engineConfig.root, `${name}.${kind}`)

/**
 * [text] in [file] whole: written beside it and renamed over it. The fake Claude Code reads a release or permit file the
 * moment it is there, and one caught between its creation and its write is empty: a turn that answers `answer N: …`.
 */
export function writeWhole(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

/** The app, running: started at the first step on it. */
function appOf(world: TierBWorld): FakeApp {
  const state = stateOf(world)
  if (state.app) return state.app
  // Only the app's lifetime: what it does is in this file.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { env: world.d.env, stdio: ['pipe', 'ignore', 'ignore'] })
  world.children.push(child)
  const app: FakeApp = { process: child, live: new Map(), starting: new Map(), closed: false }
  // Only the links run since it started reach it.
  world.onOpen((run) => follow(world, app, run))
  // Ended, it ends its sessions first, and only then goes: the driver's end of its children waits for that.
  const kill = child.kill.bind(child)
  let ending: Promise<void> | undefined
  child.kill = () => {
    ending ??= close(world, app).finally(() => { kill('SIGKILL') })
    return true
  }
  state.app = app
  return app
}

/** A link that opened, continuing a resumable session the app is not running: it resumes it and shows it, its mod's
 *  attach naming it. */
function follow(world: TierBWorld, app: FakeApp, run: OpenRun): void {
  if (app.closed || !run.ok) return
  const s = world.scenario.sessions.find((one) => one.app === 'claude' && one.resumable && !one.ghost && run.argv.includes(linkOf(one)))
  if (s) start(world, app, s.key).then(() => attach(world, s.key)).catch((error: unknown) => world.fail(error))
}

/** The session's Claude Code, its start hook run, and the mod's poll held. */
function start(world: TierBWorld, app: FakeApp, key: SessionKey): Promise<Live> {
  const running = app.live.get(key)
  if (running) return Promise.resolve(running)
  let starting = app.starting.get(key)
  if (!starting) {
    starting = (async () => {
      const s = world.session(key)
      if (!s.localId) throw new Error(`scenario ${world.scenario.id}: Claude session ${key} has no localId`)
      // The Claude app's hints (hook/notify.mjs hostHints): its session id and entrypoint everywhere, and macOS its
      // bundle id; Linux names the app by the process above the engine. Its hooks name the app's title (session_title).
      const hints: Record<string, string> = {
        CLAUDE_CODE_HOST_SESSION_ID: s.localId, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', FAKE_CLAUDE_SESSION_TITLE: s.title,
        ...(LINUX ? {} : { __CFBundleIdentifier: APP_BUNDLES.claude }),
      }
      const folder = basename(s.cwd)
      const transcript = join(world.d.env.CLAUDE_PROJECTS_DIR!, join(world.d.projectsDir, folder).replace(/[^a-zA-Z0-9]/g, '-'), `${s.id}.jsonl`)
      let from = 0
      try { from = statSync(transcript).size } catch { /* its first run */ }
      installMod(world.d)
      const outside = await Outside.start(world.d, folder, hints, LINUX ? 'claude-app' : undefined, { resume: s.id })
      const live: Live = { outside, mod: new AbortController(), turns: 0, stops: 0, transcript, from }
      app.live.set(key, live)
      void holdMod(world, key, s.id, live.mod.signal)
      return live
    })().finally(() => app.starting.delete(key))
    app.starting.set(key, starting)
  }
  return starting
}

/** The mod's loop: one poll held at a time, the next asked as soon as one is answered. */
async function holdMod(world: TierBWorld, key: SessionKey, sessionId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const asked = Date.now()
    let answer: Awaited<ReturnType<typeof inboxPoll>> | undefined
    try { answer = await inboxPoll(world.d, sessionId, signal) } catch { /* aborted, or the daemon is between answers */ }
    world.modPolled(sessionId)
    const text = (answer?.body as { text?: unknown } | null | undefined)?.text
    if (answer?.status === 200 && typeof text === 'string' && text !== '') world.deliver({ path: 'mod', target: key, text })
    const wait = answer?.status === 503 ? OFF_RETRY_MS : Date.now() - asked < HELD_MS ? HELD_MS : 0
    if (wait) await delay(wait, undefined, { signal }).catch(() => {})
  }
}

/**
 * Each prompt [transcript] took that no step typed (`!until <name>`), at the time its own row says (ms since the epoch,
 * none when the row names none): words some path typed into its session, when they reached it.
 */
export function typedPrompts(transcript: string): Array<{ at?: number; text: string }> {
  const typed: Array<{ at?: number; text: string }> = []
  for (const line of transcript.split('\n')) {
    let row: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    try { row = JSON.parse(line) as typeof row } catch { continue }
    const prompt = row.type === 'user' ? row.message?.content : undefined
    if (typeof prompt !== 'string' || /^!until eval-turn-\d+$/.test(prompt)) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    typed.push({ ...(Number.isNaN(at) ? {} : { at }), text: prompt })
  }
  return typed
}

/** The words typed into this session while it ran, read as it leaves. */
function typedInto(world: TierBWorld, key: SessionKey, live: Live): void {
  let text = ''
  // From its size in bytes as it started.
  try { text = readFileSync(live.transcript).subarray(live.from).toString('utf8') } catch { return }
  for (const { at, text: words } of typedPrompts(text)) world.deliver({ path: 'typed', target: key, text: words }, at)
}

/** It leaves as Claude Code does when the app ends it: its open turn over, its SessionEnd hook, then its process. */
async function end(world: TierBWorld, app: FakeApp, key: SessionKey, live: Live): Promise<void> {
  app.live.delete(key)
  const { outside } = live
  // A dialog waiting on the person is declined, as with Esc; an open turn answers as it would.
  if (live.asking) outside.type('\x1b')
  else if (live.open) writeWhole(fileOf(world, live.open, 'release'), '')
  outside.type('!exit')
  try {
    await until(`${key}'s SessionEnd hook`, () => outside.ran(world.d, 'SessionEnd'), END_MS, 50)
  } finally {
    live.mod.abort()
    typedInto(world, key, live)
    await outside.close()
  }
}

/** The app's end: no more links, and each of its sessions, those still starting too. */
async function close(world: TierBWorld, app: FakeApp): Promise<void> {
  app.closed = true
  const state = stateOf(world)
  if (state.app === app) state.app = undefined
  await Promise.allSettled([...app.starting.values()])
  // A session that did not say its end goes all the same: the next scenario's wait for an empty ring sees what is left.
  await Promise.allSettled([...app.live].map(([key, live]) => end(world, app, key, live)))
}

function liveOf(world: TierBWorld, key: SessionKey): Live {
  const live = stateOf(world).app?.live.get(key)
  if (!live) throw new Error(`scenario ${world.scenario.id}: a hook for ${key}, which is not running`)
  return live
}

/**
 * The harness-device mod in the home's Claude Code, before its first session starts (Claude Code reads its hooks as it
 * starts): its entry, as `claude plugin install` leaves it, and its PermissionRequest hook, the real `harness device
 * claude asked` (plugins/harness-device/hooks/asked), which tells the devices what the prompt asks. The fake Claude Code
 * runs the hooks of its settings only, so the mod's is there, beside the daemon's.
 */
function installMod(d: IsolatedDaemon): void {
  if (modded.has(d)) return
  modded.add(d)
  const settings = join(d.env.HOME!, '.claude', 'settings.json')
  const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean>; hooks?: Record<string, unknown[]> }
  const quoted = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`
  const asked = `cd ${quoted(CLI_ROOT)} && ${[process.execPath, ...CLI_ENTRY, 'device', 'claude', 'asked'].map(quoted).join(' ')} >/dev/null 2>&1`
  writeFileSync(settings, JSON.stringify({
    ...current,
    enabledPlugins: { ...current.enabledPlugins, 'harness-device@openharness': true },
    hooks: { ...current.hooks, PermissionRequest: [...(current.hooks?.PermissionRequest ?? []), { matcher: '*', hooks: [{ type: 'command', command: asked, timeout: 5 }] }] },
  }))
}

/** The mod's attach of the session the app shows, as the mod posts it to the devices. */
async function attach(world: TierBWorld, key: SessionKey): Promise<void> {
  const socket = await devicesSocket(world)
  const answer = await fetchOverSocket(socket)('http://localhost/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'attach', sessionId: world.session(key).id }),
  })
  if (answer.status !== 204) throw new Error(`the mod's attach was answered ${answer.status}`)
}

/**
 * The devices' socket a run of `harness device claude link --json` that ended with [code] named in [stdout], checked to
 * be inside the daemon's [root], so the attach reaches no other daemon's devices; a failure says the end of [stderr].
 */
export function linkedSocket(root: string, code: number | null, stdout: string, stderr: string): string {
  let path: unknown
  if (code === 0) try { path = (JSON.parse(stdout) as { devicesSocket?: unknown }).devicesSocket } catch { /* it named none */ }
  if (typeof path !== 'string' || path === '') {
    throw new Error(`harness device claude link --json named no devices' socket (exit ${code}): ${stderr.slice(-STDERR_KEPT).trim()}`)
  }
  if (!inside(root, path)) throw new Error("harness device claude link --json named a devices' socket outside the daemon's root")
  return path
}

/** The devices' socket, as the mod finds it: the real link, asked again after a look that failed. */
function devicesSocket(world: TierBWorld): Promise<string> {
  const { d } = world
  let socket = sockets.get(d)
  if (socket) return socket
  socket = (async () => {
    installMod(d)
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'claude', 'link', '--json'], { cwd: CLI_ROOT, env: d.env, stdio: ['ignore', 'pipe', 'pipe'] })
    world.children.push(child)
    let said = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT) })
    const timer = setTimeout(() => child.kill('SIGKILL'), LINK_MS)
    // Its output read to the end.
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    clearTimeout(timer)
    return linkedSocket(d.root, code, said, stderr)
  })()
  sockets.set(d, socket)
  socket.catch(() => { if (sockets.get(d) === socket) sockets.delete(d) })
  return socket
}

export const claudeSteps = {
  /** Each session's file written as the app writes it, last active `ageMs` ago and written now. */
  'claude.write': async (world, step) => {
    appOf(world)
    const now = Date.now()
    const store = claudeAppFixture(claudeStoreRoots(world.platform, world.d.env, world.d.env.HOME!)[0]!.root)
    for (const key of step.sessions) {
      const s = world.session(key)
      if (!s.localId) throw new Error(`scenario ${world.scenario.id}: Claude session ${key} has no localId`)
      store.write({ localId: s.localId, cliSessionId: s.id, cwd: s.cwd, title: s.title, lastActivityAt: now - s.ageMs,
        isArchived: step.archived === true }, { mtime: now })
    }
  },
  hook: async (world, step) => {
    const { d } = world
    if (step.event === 'start') {
      await start(world, appOf(world), step.session)
      return
    }
    const live = liveOf(world, step.session)
    const { outside } = live
    switch (step.event) {
      case 'turn-start': {
        if (live.open) throw new Error(`scenario ${world.scenario.id}: ${step.session}'s turn is open already`)
        live.open = `eval-turn-${++turnsTyped}`
        const turns = ++live.turns
        outside.type(`!until ${live.open}`)
        await until(`${step.session}'s UserPromptSubmit hook`, () => outside.ran(d, 'UserPromptSubmit', turns), HOOK_MS, 50)
        break
      }
      case 'needs-input':
        // Claude Code asks within the turn; a question is drawn as a permission is, so it says the same to its hooks.
        if (!live.open) throw new Error(`scenario ${world.scenario.id}: ${step.session} asks with no turn open`)
        writeWhole(fileOf(world, live.open, 'permit'), 'printf eval')
        live.asking = true
        break
      case 'turn-stop': {
        if (!live.open || live.asking) throw new Error(`scenario ${world.scenario.id}: ${step.session} has no turn to stop`)
        const stops = ++live.stops
        writeWhole(fileOf(world, live.open, 'release'), step.lastAnswer ?? '')
        live.open = undefined
        await until(`${step.session}'s Stop hook`, () => outside.ran(d, 'Stop', stops), HOOK_MS, 50)
        break
      }
      case 'end':
        await end(world, stateOf(world).app!, step.session, live)
        break
    }
  },
  attach: (world, step) => attach(world, step.session),
  voice: speak,
  quit: async (world, step) => {
    if (step.app !== 'claude') throw new Error(`scenario ${world.scenario.id}: the Claude app's steps quit no ${step.app} app`)
    const state = stateOf(world)
    const app = state.app
    if (!app) return
    state.quit = [...app.live.keys()]
    const exited = new Promise<void>((done) => app.process.once('exit', () => done()))
    app.process.kill()
    await exited
  },
  relaunch: async (world, step) => {
    if (step.app !== 'claude') throw new Error(`scenario ${world.scenario.id}: the Claude app's steps relaunch no ${step.app} app`)
    const state = stateOf(world)
    const app = appOf(world)
    for (const key of state.quit.splice(0)) await start(world, app, key)
  },
} satisfies AppSteps
