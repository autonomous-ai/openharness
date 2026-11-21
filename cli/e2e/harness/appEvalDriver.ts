/**
 * Tier B's driver of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B: scripted end to end, fake
 * apps"): each scenario on the real daemon and devices process, a fake dial on the desk (fakeDial.ts), the real
 * `harness hardware watch --json` for the app in front, and the fake backend for the dial's speech. A daemon serves the
 * first scenario and every one after it, reset, until a scenario asks for one of its own (`fresh`).
 *
 * Isolation: each daemon's open (HARNESS_OPEN_BIN, which only records), its home, its apps' folder and both apps'
 * stores are checked to be inside its root before it starts, and it is signed in to the fake backend alone. The network
 * guard (src/testing/dialAppEval/netGuard.ts) is in this process and preloaded into every process of the daemon and every
 * child started here: a start whose core or devices process did not load it fails.
 *
 * What it saw: the frames the dial received, at their arrival; the faces of the firmware's carousel model, fed those
 * frames and the person's own turns (a swipe moves the glass before the daemon hears of it); the commands of the
 * recording open; the deliveries the app's steps record; and, after `stop`, what the scenario cost (appEvalCost.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { chatGptPlaces, claudeStoreRoots } from '../../src/cable/hosts/appPlaces.js'
import { claudeAppFixture } from '../../src/testing/claudeAppFixture.js'
import { describeAttempt, guardThisProcess, netGuardEnv, readNetGuard, type NetAttempt } from '../../src/testing/dialAppEval/netGuard.js'
import { agentIdOf, type App, type Delivery, type EvalDriver, type Platform, type Scenario, type Seen,
  type SessionDef, type SessionKey, type Step, type StepKind, type StepOf } from '../../src/testing/dialAppEval/types.js'
import { CAROUSEL_REFRESH_MS, DialCarousel, type DialMessage } from '../../src/testing/dialCarousel.js'
import { beginCost, costEnv } from './appEvalCost.js'
import { writeAppCodex } from './codexAppCli.js'
import { CLI_ROOT, IsolatedDaemon, until } from './daemon.js'
import { Desk } from './desk.js'
import { FakeBackend, type FakeMachine } from './fakeBackend.js'
import type { FakeDial } from './fakeDial.js'
import { writeSchemeApps } from './schemeApps.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const SERIAL = 'EVAL-B'
const MAC = 'e2:e0:00:00:0e:b1'
/** The page of each app's ring: the ChatGPT app's threads are Codex's. */
const PAGE: Readonly<Record<App, string>> = { claude: 'claude', chatgpt: 'codex' }
/** The app in front as Harness Device names it: a bundle id on macOS, the window's process on Linux; `other` is an app
 *  the dial follows none of. */
const FRONT: Readonly<Record<'darwin' | 'linux', Record<App | 'other', string>>> = {
  darwin: { claude: 'com.anthropic.claudefordesktop', chatgpt: 'com.openai.codex', other: 'com.apple.Safari' },
  linux: { claude: 'claude-desktop', chatgpt: 'ChatGPT', other: 'firefox' },
}
/** The machine each daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'e7'.repeat(16), computerId: 'e2e-dial-eval-computer', name: 'Fixture', token: 'e2e-dial-eval-token' }
/** A fifth of a second of what the microphone heard: the fake backend answers its `speech` whatever the audio. */
const VOICE_PCM = Buffer.alloc(3_200, 1)
/** For the dial to be found, welcomed and shown its list: the fleet looks every 2 s, the dial greets every 2 s. */
const START_WITHIN_MS = 45_000
const CHILD_END_MS = 5_000
// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

export interface TierBWorld {
  readonly d: IsolatedDaemon; readonly desk: Desk; readonly dial: FakeDial
  readonly scenario: Scenario; readonly platform: Platform
  now(): number; agentId(key: SessionKey): string; session(key: SessionKey): SessionDef
  deliver(d: Omit<Delivery, 'at'>): void; gap(reason: string): void
  /** Ended at stop. */
  readonly children: ChildProcess[]
}
export type TierBHandler<K extends StepKind> = (world: TierBWorld, step: StepOf<K>) => Promise<void>

/** The steps this driver runs itself, on the dial and the watch. */
type GenericKind = 'front' | 'thread' | 'tap' | 'swipe' | 'unplug' | 'replug'
/** The steps on an app's sessions and stores, and its voice, whose words land on that app's paths: each app's file gives
 *  those its scenarios take (appEvalClaude.ts, appEvalChatgpt.ts). */
export type AppSteps = { [K in Exclude<StepKind, 'wait' | GenericKind>]?: TierBHandler<K> }
type Run = Exclude<Step, { kind: 'wait' }>

/** A daemon, its desk and its backend, kept across the scenarios that do not ask for a fresh one. */
interface Rig {
  d: IsolatedDaemon; desk: Desk; backend: FakeBackend
  /** The network guard's file, in the root: the processes it was loaded into and what it refused there. */
  guard: string
  /** How many of its attempts were handed on. */
  given: number
}

/** The ChatGPT app's bundle as the devices read it (`plutil`): its id and nothing else of the app. */
const CHATGPT_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.openai.codex</string>
</dict>
</plist>
`

const inside = (root: string, path: string | undefined): boolean => !!path && isAbsolute(path) && !relative(root, path).startsWith('..')
/** The files in [dir] and below gone, its folders kept: the daemon's watches on them stay. */
function emptied(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) rmSync(join(entry.parentPath, entry.name), { force: true })
  }
}
/** The rows of the last whole list the dial was sent, or undefined before one. */
function lastList(messages: readonly DialMessage[]): DialMessage[] | undefined {
  let last: DialMessage[] | undefined
  let rows: DialMessage[] | undefined
  for (const m of messages) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { last = rows; rows = undefined }
  }
  return last
}
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_END_MS)
  await exited
  clearTimeout(timer)
}

async function openRig(): Promise<Rig> {
  const backend = await FakeBackend.start()
  backend.addMachine(ME)
  let d: IsolatedDaemon | undefined
  try {
    d = await IsolatedDaemon.create({ env: {
      CABLE_DISABLE: 'false', BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    } })
    const guard = join(d.root, 'net-guard.jsonl')
    const cost = costEnv(d.root)
    // As enginehomes.e2e.ts preloads its fault: the master hands NODE_OPTIONS on to the core and every service.
    Object.assign(d.env, cost.env, netGuardEnv(guard, cost.nodeOptions))
    const home = d.env.HOME
    const claudeStore = claudeStoreRoots(process.platform, d.env, home ?? '')[0]?.root
    const places = { open: d.env.HARNESS_OPEN_BIN, home, applications: d.env.HARNESS_APPLICATIONS_DIR, 'Claude store': claudeStore,
      'Codex home': home && join(home, '.codex') }
    for (const [name, path] of Object.entries(places)) if (!inside(d.root, path)) throw new Error(`the daemon's ${name} is not inside its root`)
    // The store's folders, as the app leaves them, so the devices watch them from the start.
    claudeAppFixture(claudeStore!).org()
    mkdirSync(places['Codex home']!, { recursive: true })
    // Both apps' links have their app, as on a desktop with both installed.
    if (process.platform === 'linux') writeSchemeApps(d, { claude: 'com.anthropic.Claude.desktop', codex: 'chatgpt.desktop' })
    // The ChatGPT app installed before any dial comes, as the devices look for it at each attach: its bundle in the home's
    // Applications on macOS, its program in the root's stand-in for /usr/lib on Linux, and its own Codex CLI.
    const chatgpt = process.platform === 'linux'
      ? chatGptPlaces('linux', d.env.HARNESS_APPLICATIONS_DIR, home!)[0]!
      : join(home!, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist')
    if (!inside(d.root, chatgpt)) throw new Error("the daemon's ChatGPT app is not inside its root")
    mkdirSync(dirname(chatgpt), { recursive: true })
    writeFileSync(chatgpt, process.platform === 'linux' ? '' : CHATGPT_INFO_PLIST)
    writeAppCodex(d)
    const dials = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = dials
    writeFileSync(dials, '[]')
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.env.HARNESS_AUTH_DIR!, 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    await d.start()
    // An engine started by hand reads its hooks once, as it starts: they are in before any scenario starts one.
    await d.hooksInstalled(['claude', 'codex'])
    return { d, desk: new Desk(dials), backend, guard, given: 0 }
  } catch (error) {
    await d?.close().catch(() => {})
    await backend.close()
    throw error
  }
}

/** One scenario's world: what the dial received and showed, from its start to its stop. */
class World implements TierBWorld {
  readonly children: ChildProcess[] = []
  readonly steps: Seen['steps'] = []
  readonly gaps: string[] = []
  readonly carousel = new DialCarousel()
  cost: Seen['cost']
  /** Time 0, ms since the epoch: set as the scenario starts. */
  origin = Date.now()
  private readonly frames: Seen['frames'] = []
  private readonly faces: Seen['faces'] = []
  private readonly commands: Seen['commands'] = []
  private readonly deliveries: Delivery[] = []
  private plugged: FakeDial | undefined
  /** How many of the plugged dial's messages, and of the open's runs, were read. */
  private heard = 0
  private opened: number
  private page = ''
  private watch: ChildProcess | undefined
  private waiting: Array<() => void> = []
  private readonly refreshing: ReturnType<typeof setInterval>

  constructor(private readonly rig: Rig, readonly scenario: Scenario, readonly platform: Platform) {
    this.opened = rig.d.opens().length
    // The firmware's refresh task, which applies a list a moment after it ends: each turn also reads what came.
    this.refreshing = setInterval(() => this.read(), CAROUSEL_REFRESH_MS)
  }

  get d(): IsolatedDaemon { return this.rig.d }
  get desk(): Desk { return this.rig.desk }
  get backend(): FakeBackend { return this.rig.backend }
  get dial(): FakeDial {
    if (!this.plugged) throw new Error(`${this.scenario.id}: no dial is plugged in`)
    return this.plugged
  }

  now(): number { return Date.now() - this.origin }
  agentId(key: SessionKey): string { return agentIdOf(this.session(key)) }
  session(key: SessionKey): SessionDef {
    const found = this.scenario.sessions.find((s) => s.key === key)
    if (!found) throw new Error(`scenario ${this.scenario.id} names no session ${key}`)
    return found
  }
  deliver(d: Omit<Delivery, 'at'>): void { this.deliveries.push({ at: Date.now(), ...d }) }
  gap(reason: string): void { this.gaps.push(reason) }

  async plug(): Promise<void> {
    this.plugged = await this.desk.plug(SERIAL, MAC, FILTER)
    this.heard = 0
  }
  async unplug(): Promise<void> {
    this.read()
    this.plugged = undefined
    await this.desk.unplug(SERIAL)
  }

  /** A person's turn of the dial to the agent's tile: the face moves there at once, and the daemon is told. */
  swipe(agentId: string): void {
    this.carousel.heard({ t: 'focus', agentId })
    this.face(Date.now())
    this.dial.send({ t: 'focus', agentId })
  }
  pick(page: string): void {
    this.dial.pick(page)
    this.carousel.picked(page)
  }

  /** One line on the stdin of the watch Harness Device runs, started under the daemon's environment on its first line. */
  tell(line: { front: string } | { thread: string }): void {
    if (!this.watch) {
      this.watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
        cwd: CLI_ROOT, env: { ...this.d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
      })
      this.children.push(this.watch)
    }
    this.watch.stdin!.write(`${JSON.stringify(line)}\n`)
  }

  /** Resolves at the next read: what the dial received since is in `seen`. */
  nextRead(): Promise<void> {
    return new Promise((done) => this.waiting.push(done))
  }

  /** What came since the last read: the dial's frames at their arrival, then the refresh, then the open's runs. */
  read(): void {
    const dial = this.plugged
    if (dial) {
      for (; this.heard < dial.messages.length; this.heard++) {
        const message = dial.messages[this.heard]!
        const at = dial.arrivedAt[this.heard]!
        this.frames.push({ at, message })
        if (message.t === 'apps') this.page = typeof message.shown === 'string' ? message.shown : ''
        this.carousel.heard(message)
        this.face(at)
      }
    }
    this.carousel.refresh()
    this.face(Date.now())
    const opens = this.d.opens()
    for (; this.opened < opens.length; this.opened++) this.commands.push({ at: Date.now(), argv: opens[this.opened]! })
    for (const done of this.waiting.splice(0)) done()
  }

  seen(): Seen {
    const from0 = <T extends { at: number }>(rows: readonly T[]): T[] => rows.map((row) => ({ ...row, at: row.at - this.origin }))
    return { frames: from0(this.frames), faces: from0(this.faces), commands: from0(this.commands),
      deliveries: from0(this.deliveries), steps: from0(this.steps), ...(this.cost ? { cost: this.cost } : {}) }
  }

  /** The last read, and every child ended. */
  async close(): Promise<void> {
    clearInterval(this.refreshing)
    this.read()
    for (const child of this.children) await end(child)
  }

  /** The face, recorded when it changed. */
  private face(at: number): void {
    const { tiles, active } = this.carousel
    const shown = { page: this.page, tiles: [...tiles], active: tiles[active] ?? null }
    const last = this.faces.at(-1)
    if (last && last.page === shown.page && last.active === shown.active && last.tiles.join('\n') === shown.tiles.join('\n')) return
    this.faces.push({ at, ...shown })
  }
}

/**
 * The dial's words to the agent on its face, as the firmware speaks: the backend hears the step's words in any audio.
 * An app's `voice` step once its file records where words land (`world.deliver`): before, a voice check sees nothing.
 */
export const speak: TierBHandler<'voice'> = async (world, step) => {
  const w = world as World
  w.backend.speech = step.transcript
  const agentId = w.carousel.tiles[w.carousel.active]
  const uploadId = `eval-voice-${w.steps.length}`
  w.dial.send({ t: 'voice.begin', ...(agentId ? { agentId } : {}), uploadId, sr: 16_000, lang: 'en' })
  w.dial.audio(VOICE_PCM)
  w.dial.send({ t: 'voice.end', uploadId })
}

const GENERIC: { [K in GenericKind]: (world: World, step: StepOf<K>) => Promise<void> } = {
  front: async (world, step) => {
    world.tell({ front: FRONT[world.platform as 'darwin' | 'linux'][step.app] })
  },
  thread: async (world, step) => { world.tell({ thread: step.title }) },
  tap: async (world, step) => { world.dial.send({ t: 'agent.open', agentId: world.agentId(step.session) }) },
  // The rest that opens the session after a swipe is the cable's own timer: the step only turns the dial.
  swipe: async (world, step) => { world.swipe(world.agentId(step.session)) },
  unplug: (world) => world.unplug(),
  replug: (world) => world.plug(),
}

export class TierBDriver implements EvalDriver {
  readonly tier = 'b' as const
  private readonly guard = guardThisProcess()
  private rig: Rig | undefined
  private world: World | undefined
  /** The world started to its time 0: one that is not had its daemon left in no known state. */
  private ready = false
  /** Attempts read from a daemon's guard file, not yet handed on. */
  private readonly reached: NetAttempt[] = []
  /** The index in the scenario of the next step after the last one run. */
  private next = 0
  /** The running scenario's cost, ended at its stop after its children. */
  private costEnd: (() => Promise<NonNullable<Seen['cost']>>) | undefined

  /** Each scenario runs on its own app's steps. */
  constructor(private readonly appSteps: Partial<Record<App, AppSteps>>) {}

  async start(scenario: Scenario, platform: Platform): Promise<void> {
    if (platform !== process.platform) throw new Error(`tier B runs on its host's platform, not ${platform}`)
    this.ready = false
    this.next = 0
    if (this.rig && scenario.fresh) await this.closeRig()
    if (this.rig) await this.reset(this.rig)
    const rig = this.rig ??= await openRig()
    const world = this.world = new World(rig, scenario, platform)
    const front = scenario.world?.front ?? scenario.app
    await GENERIC.front(world, { kind: 'front', app: front })
    await world.plug()
    // The ring empty before the scenario goes on: nothing of the scenario before it is listed.
    await until(`${scenario.id}: the dial welcomed and shown an empty list`, () => {
      const { messages } = world.dial
      return messages.some((m) => m.t === 'welcome') && lastList(messages)?.length === 0
    }, START_WITHIN_MS, 50)
    // The person picks the app's page. While no session of it is listed the devices keep the ring they show, and the
    // app in front decides it once one is.
    world.pick(PAGE[front === 'other' ? scenario.app : front])
    const loaded = readNetGuard(rig.guard).loaded.map((p) => p.process)
    for (const name of ['core', 'devices']) if (!loaded.includes(name)) throw new Error(`the network guard is not in the ${name} process`)
    const cost = await beginCost(rig.d)
    world.origin = Date.now()
    this.costEnd = cost.end
    this.ready = true
  }

  async step(step: Run): Promise<void> {
    const world = this.need()
    const index = world.scenario.steps.indexOf(step, this.next)
    if (index < 0) throw new Error(`${world.scenario.id}: a ${step.kind} step that is not its next`)
    this.next = index + 1
    world.steps.push({ at: Date.now(), index, kind: step.kind, ...(step.label === undefined ? {} : { label: step.label }) })
    const { app } = world.scenario
    const handler = (Object.hasOwn(GENERIC, step.kind) ? GENERIC[step.kind as GenericKind] : this.appSteps[app]?.[step.kind as keyof AppSteps]) as
      ((world: World, step: Run) => Promise<void>) | undefined
    if (!handler) throw new Error(`${world.scenario.id}: tier B has no ${step.kind} step for the ${app} app`)
    await handler(world, step)
  }

  /** Without `until`, the scenario's own timing; with it, until it holds at a read of what the dial received, at most ms. */
  async settle(ms: number, until?: () => boolean): Promise<void> {
    const world = this.need()
    if (!until) {
      await new Promise((done) => setTimeout(done, ms))
      return
    }
    const deadline = Date.now() + ms
    while (!until() && Date.now() < deadline) await world.nextRead()
  }

  now(): number { return this.need().now() }
  seen(): Seen { return this.need().seen() }
  gaps(): string[] { return [...this.need().gaps] }

  async stop(): Promise<void> {
    const world = this.world
    const costEnd = this.costEnd
    this.costEnd = undefined
    try {
      await world?.close()
      if (world && costEnd) world.cost = await costEnd()
    } finally {
      if (this.rig) this.collect(this.rig)
      if (!this.ready && this.rig) await this.closeRig()
    }
  }

  /** The current daemon's guard file. */
  netGuardFile(): string {
    if (!this.rig) throw new Error('tier B: no daemon is running')
    return this.rig.guard
  }

  /** Each attempt off this machine since the last call, in this process or any daemon's, as `describeAttempt` says it. */
  networkReached(): string[] {
    if (this.rig) this.collect(this.rig)
    return [...this.guard.taken(), ...this.reached.splice(0)].map(describeAttempt)
  }

  /** One per e2e file, in its afterAll. */
  async close(): Promise<void> {
    try {
      if (this.rig) await this.closeRig()
    } finally {
      this.guard.uninstall()
    }
  }

  /** The last scenario's fixtures gone (its children ended at its stop), and its dial unplugged. */
  private async reset(rig: Rig): Promise<void> {
    const home = rig.d.env.HOME!
    emptied(claudeStoreRoots(process.platform, rig.d.env, home)[0]!.root)
    emptied(join(home, '.codex'))
    rig.backend.speech = null
    await rig.desk.unplug(SERIAL)
  }

  private collect(rig: Rig): void {
    const { attempts } = readNetGuard(rig.guard)
    this.reached.push(...attempts.slice(rig.given))
    rig.given = attempts.length
  }

  /** Read before it goes: the guard's file goes with the root. */
  private async closeRig(): Promise<void> {
    const rig = this.rig!
    this.rig = undefined
    this.collect(rig)
    try {
      await rig.desk.close()
      await rig.d.close()
    } finally {
      await rig.backend.close()
    }
  }

  private need(): World {
    if (!this.world) throw new Error('tier B: no scenario started')
    return this.world
  }
}
