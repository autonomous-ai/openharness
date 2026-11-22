/**
 * One tier A scenario's world: the real devices (services/devices.ts) started in this process for one platform, with
 * the Claude app's store and the ChatGPT app's Codex home as fixtures in a fresh temp folder, the loopback dial on the
 * real cable, and every command, raise and send the devices make recorded with its virtual time and answered as the
 * scenario says, beside each line they log and each they write to an editor window. Nothing it hands the devices starts
 * a process or reads this machine: the readers of the machine are the spec's mocks (dialAppEval.spec.ts), answering from
 * the model (machine.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, win32 } from 'node:path'
import { vi } from 'vitest'
import { chatGptPlaces, claudeStoreRoots } from '../../../cable/hosts/appPlaces.js'
import { ClaudeAppStore } from '../../../cable/hosts/claudeAppStore.js'
import { CodexAppThreads } from '../../../cable/hosts/codexAppThreads.js'
import { windowClasses } from '../../../cable/hosts/frontApp.js'
import type { HcClient } from '../../../cable/hosts/hcClient.js'
import type { HerdrClient } from '../../../cable/hosts/herdrClient.js'
import { createLinuxRaise, type LinuxRaise } from '../../../cable/hosts/linuxRaise.js'
import type { OpencodeClient } from '../../../cable/hosts/opencodeClient.js'
import type { OrcaChild, OrcaReadDeps } from '../../../cable/hosts/orca.js'
import { env } from '../../../config/env.js'
import { emptyPorts, type CoreApi, type CorePorts } from '../../../core/api.js'
import { createOrcaHomesCache, readOrcaHomes } from '../../../devices/orcaHomes.js'
import { VSCODE_EXTENSION_ID, type VscodeEditor, type VscodeExtensionDeps } from '../../../devices/vscodeExtension.js'
import type { DevicesDeps, startDevices } from '../../../services/devices.js'
import type { ListenerHandler, ListenerStreamHandler } from '../../../services/devicesListener.js'
import { claudeAppFixture } from '../../claudeAppFixture.js'
import { codexAppFixture } from '../../codexAppFixture.js'
import { fakeCore } from '../../fakeCore.js'
import { RECORDED_LINUX_APPS } from '../../recordedLinuxApps.js'
import { ORCA_PROGRAMS, programOf } from '../argv.js'
import { agentIdOf, type App, type Delivery, type LinkedApp, type Platform, type Scenario, type Seen, type SessionDef, type SessionKey,
  type StepKind, type StepOf } from '../types.js'
import { quiet } from './clock.js'
import { LoopbackDial } from './loopbackDial.js'
import { machine, type MachineModel } from './machine.js'
import { answerOrca, orcaAccountHomes, watchChild } from './steps/orca.js'
import { recordTyping } from './steps/voice.js'
import { createStoreWatch, onHost } from './storeWatch.js'

export interface TierAWorld {
  readonly scenario: Scenario; readonly platform: Platform; readonly machine: MachineModel
  readonly ports: CorePorts; readonly core: CoreApi; readonly dial: LoopbackDial
  /** What `deps.listen` was handed: the devices' own listener's handlers. */
  readonly listener: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>
  readonly claudeStore: ReturnType<typeof claudeAppFixture>; readonly codexHome: ReturnType<typeof codexAppFixture>
  /**
   * Where the engines' transcripts go: Harness's own Claude Code and Codex homes and the suite's Cursor home (env
   * CURSOR_HOME), emptied for each scenario, and the folder of the world's own that holds each Codex with a home of its own.
   */
  readonly folders: { claudeProjects: string; codexSessions: string; cursorProjects: string; codexHomes: string }
  /** Each line on an editor window's stream, both ways (steps/editor.ts). */
  readonly streams: NonNullable<Seen['streams']>
  /** Every line the devices log, at its virtual time. */
  readonly logs: NonNullable<Seen['logs']>
  /** What the devices' transcriber answers. */
  speech: string | null
  /** The app in front, as the last front step told the watch. */
  front: App | 'other'
  /** A fixture file written: the store's watch hears of it now. */
  storeChanged(path: string): void
  agentId(key: SessionKey): string
  session(key: SessionKey): SessionDef
  deliver(d: Omit<Delivery, 'at'>): void
  /** How a command the devices run is answered: the first rule that answers decides, and one none answers exits 0. */
  answer(rule: (argv: readonly string[]) => { code: number; stdout?: string } | undefined): void
  /** This scenario on this platform cannot be graded: why. */
  gap(reason: string): void
  /** What a step holds open for the scenario (the app's WAL writer), closed as the world closes, before its folder goes. */
  onClose(close: () => void): void
  quiet(): Promise<void>
}

export type StepHandler<K extends StepKind> = (world: TierAWorld, step: StepOf<K>) => Promise<void>

type Answer = { code: number; stdout?: string }

/** Each app's macOS bundle id, the scheme of its links, and its Linux desktop file: Orca's rows open by no link. */
const APPS: Readonly<Record<LinkedApp, { bundle: string; scheme: string; desktopFile: string }>> = {
  claude: { bundle: 'com.anthropic.claudefordesktop', scheme: 'claude', desktopFile: 'com.anthropic.Claude.desktop' },
  chatgpt: { bundle: 'com.openai.codex', scheme: 'codex', desktopFile: 'chatgpt.desktop' },
  vscode: { bundle: 'com.microsoft.VSCode', scheme: 'vscode', desktopFile: RECORDED_LINUX_APPS.vscode.schemeDesktopFile },
  cursor: { bundle: 'com.todesktop.230313mzl4w4u92', scheme: 'cursor', desktopFile: RECORDED_LINUX_APPS.cursor.schemeDesktopFile },
}
/**
 * The commands found on each platform's PATH here, made up, recorded and never run: Linux's two a link needs, and Orca's
 * CLI where its .deb puts it on PATH (devices/orcaHomes.ts orcaBinary; the plan's Decision 6). On macOS Orca's is the
 * app's own (orcaAppBin), and on Windows the per-user install's (ORCA_EXE), whose folder Orca's installer does not put
 * on PATH. Nothing else of any platform's is installed.
 */
const ON_PATH: Readonly<Record<Platform, Readonly<Record<string, string>>>> = {
  darwin: {},
  linux: { 'xdg-mime': '/usr/bin/xdg-mime', 'xdg-open': '/usr/bin/xdg-open', 'orca-ide': '/opt/eval/orca/resources/bin/orca-ide' },
  win32: {},
}
/**
 * The Orca app's CLI, which HARNESS_ORCA_APP_BIN names: a made-up path in the spec's temp folder that nothing makes, so
 * never this machine's Orca. Every world of a run names the same one: the devices read Orca's homes as they start, in
 * any scenario, and a scenario run twice runs the same commands.
 */
const orcaAppBin = (): string => join(tmpdir(), 'dial-eval-orca', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca')
/** Windows' per-user programs' folder in the world's own, which LOCALAPPDATA names there: where the profile has it, so
 *  the Claude app's store is where it is with none set. */
const LOCAL_APP_DATA = join('AppData', 'Local')
/** Orca's CLI in its per-user install on Windows, under LOCALAPPDATA. */
const ORCA_EXE = (localAppData: string): string => win32.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
/** A child of Orca's CLI whose command failed: gone before it printed anything. */
const EXITED: OrcaChild = { onData: () => {}, exited: Promise.resolve(), kill: () => {} }
/** Every file of Orca's has its release's time: its `terminal --help` is read once, as in a real run. */
const ORCA_MTIME_MS = 1_763_337_600_000
/** Made-up places, recorded and never run. */
const CODEX_BIN = '/opt/eval/bin/codex'
const APP_CODEX_BIN = '/opt/eval/ChatGPT.app/codex'
const CURSOR_BIN = '/opt/eval/bin/cursor'
/** The programs whose commands the world answers as the scenario says, by name: macOS's and Linux's openers, the scheme
 *  lookup, the Windows helper, the Linux raise and Orca's CLI (steps/orca.ts). Cursor's CLI is answered only as Linux's
 *  folder row runs it, on one folder (cable/hosts/cursorFolder.ts). A command of any other is one tier A does not model. */
const ANSWERED: ReadonlySet<string> = new Set(['open', 'xdg-open', 'xdg-mime', 'harness-pty', 'raise', ...ORCA_PROGRAMS])

/** Harness's own engine homes are the suite's throwaway ones (vitest.setup.ts): never a folder outside this run's. */
function emptied(folder: string): string {
  const inside = relative(tmpdir(), folder)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error('tier A empties only folders of its own run')
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  return folder
}

/** Whether the world answers a command (ANSWERED). */
const answered = (argv: readonly string[]): boolean => ANSWERED.has(programOf(argv))
  || (argv.length === 2 && argv[0] === CURSOR_BIN && isAbsolute(argv[1]!))

/** Codex's queue's send (cable/hosts/codexQueue.ts): the thread and the words, the thread none unless it reads both. */
function queued(args: readonly string[]): { thread: string | undefined; text: string } {
  const at = args.indexOf('--thread')
  const message = args.find((arg) => arg.startsWith('--message='))
  return { thread: at < 0 || message === undefined ? undefined : args[at + 1], text: message?.slice('--message='.length) ?? '' }
}

/** An editor that is not installed: nothing of it is found or run. */
const noEditor = (editor: VscodeEditor, platform: Platform, root: string): VscodeExtensionDeps => ({
  editor, real: (path) => path, platform, home: root, pathVar: '', exists: () => false,
  executable: () => false, read: () => null, run: async () => ({ code: null, timedOut: false }), files: () => null,
  tempDir: () => join(root, 'vsix'), write: () => {}, remove: () => {},
})
/** The extension as this made-up build carries it, and the same version on in Cursor's record. */
const EXTENSION_VERSION = '0.0.0-eval'
/**
 * Cursor installed, its CLI at a made-up path (`bin`, as HARNESS_CURSOR_BIN names one), with this build's extension on:
 * the folder row's tap finds the CLI on Linux, and the extension's setup finds nothing to do. A run of the CLI is the
 * setup's alone, never modelled: a gap.
 */
const cursorInstalled = (platform: Platform, root: string, gap: (reason: string) => void): VscodeExtensionDeps => {
  const record = (platform === 'win32' ? win32.join : join)(root, '.cursor', 'extensions', 'extensions.json')
  return {
    ...noEditor('cursor', platform, root), bin: CURSOR_BIN, executable: (path) => path === CURSOR_BIN,
    files: () => ({ manifest: JSON.stringify({ version: EXTENSION_VERSION }), main: '' }),
    read: (path) => (path === record ? JSON.stringify([{ identifier: { id: VSCODE_EXTENSION_ID }, version: EXTENSION_VERSION }]) : null),
    run: async () => {
      gap("the editor extension's setup ran")
      return { code: null, timedOut: false }
    },
  }
}
/**
 * herdr, Herdr Core and opencode with nobody listening, as their clients say when there is no socket or service. Tier A
 * models no pane of theirs: words one is asked to put in a pane are `typed` into no session, which the gate counts.
 */
const noHerdr = (typed: (text: string) => void): HerdrClient => ({
  request: async () => ({ ok: false, fault: 'no_socket' }),
  subscribe: (_entries, to) => { queueMicrotask(() => to.closed('no_socket')); return { close: () => {} } },
  prompt: async (_pane, _kind, text) => { typed(text); return { outcome: 'failed', fault: 'no_socket' } },
  socketStamp: () => undefined,
  binary: () => undefined,
})
const noHc = (typed: (text: string) => void): HcClient => ({
  request: async () => ({ ok: false, fault: 'no_socket' }),
  subscribe: (to) => { queueMicrotask(() => to.closed('no_socket')); return { close: () => {} } },
  prompt: async (_address, _kind, text) => { typed(text); return { outcome: 'failed', fault: 'no_socket' } },
  keys: async () => false,
  socketStamp: () => undefined,
})
const noOpencode = (typed: (text: string) => void): OpencodeClient => ({
  registration: () => ({ fault: 'no_service' }),
  find: async () => ({ fault: 'no_service' }),
  request: async () => ({ ok: false, fault: 'no_service' }),
  events: (_onEvent, onClose) => { queueMicrotask(() => onClose('no_service')); return { close: () => {} } },
  prompt: async (_session, text) => { typed(text); return 'failed' },
})

export class World implements TierAWorld {
  readonly machine = machine
  readonly ports: CorePorts = emptyPorts()
  readonly core: CoreApi
  readonly dial: LoopbackDial
  listener: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>> = {}
  readonly claudeStore: ReturnType<typeof claudeAppFixture>
  readonly codexHome: ReturnType<typeof codexAppFixture>
  readonly folders: TierAWorld['folders']
  speech: string | null = null
  /** None until the driver's first front step, before the dial is plugged in. */
  front: App | 'other' = 'other'
  readonly commands: Seen['commands'] = []
  readonly deliveries: Seen['deliveries'] = []
  readonly streams: NonNullable<Seen['streams']> = []
  readonly logs: NonNullable<Seen['logs']> = []
  readonly gaps: string[] = []
  /** The virtual epoch ms of time 0: the driver sets it once the dial is welcomed and its page picked. */
  origin = Date.now()
  private readonly root: string
  private readonly rules: Array<(argv: readonly string[]) => Answer | undefined> = []
  private readonly watch = createStoreWatch()
  /** The store reads in flight: the clock moves on only once there are none. */
  private reads = 0
  private readonly closing: Array<() => void> = []

  constructor(readonly scenario: Scenario, readonly platform: Platform, start: typeof startDevices) {
    const root = this.root = mkdtempSync(join(tmpdir(), 'dial-eval-'))
    const installed = scenario.world?.chatgptInstalled !== false
    // The homes the devices find the apps' stores from, all in the temp folder: homedir() follows HOME (USERPROFILE on
    // Windows), and an empty folder variable counts as unset (cable/hosts/appPlaces.ts). The end-to-end tests' `open` is
    // not this world's.
    for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, root)
    for (const name of ['APPDATA', 'XDG_CONFIG_HOME', 'HARNESS_APPLICATIONS_DIR', 'HARNESS_OPEN_BIN']) vi.stubEnv(name, '')
    // Windows' LOCALAPPDATA is the world's, where Orca installs for one account; no other platform has one.
    vi.stubEnv('LOCALAPPDATA', platform === 'win32' ? join(root, LOCAL_APP_DATA) : '')
    // The welcome's voice language follows LANG (cableHost.ts voiceLang): the same on every host.
    vi.stubEnv('LANG', 'en_US.UTF-8')
    // The Orca app the devices find on macOS is the eval's made-up one, whatever this machine has.
    vi.stubEnv('HARNESS_ORCA_APP_BIN', orcaAppBin())
    // The fixture is at the platform's own first root, as this host names it (a Windows one's folders are this host's of
    // the same names): the readers read it there, and the store's watch on that root hears its writes as the app's.
    this.claudeStore = claudeAppFixture(onHost(claudeStoreRoots(platform, process.env, root)[0]!.root))
    // A signed-in Claude app has its account's folder.
    this.claudeStore.org()
    const codexHome = join(root, '.codex')
    this.codexHome = codexAppFixture(codexHome)
    if (installed) this.install(root, codexHome)
    // The sessions' folders are there, the only ones: what Cursor's folder row opens.
    for (const s of scenario.sessions) for (const folder of [s.cwd, ...s.folders ?? []]) machine.folders.add(folder)
    this.folders = { claudeProjects: emptied(env.CLAUDE_PROJECTS_DIR), codexSessions: emptied(join(env.CODEX_HOME, 'sessions')),
      cursorProjects: emptied(join(env.CURSOR_HOME, 'projects')), codexHomes: join(root, 'codex-homes') }
    // Orca's accounts' homes are there before any of their agents runs, as an account's is: the devices' read of them
    // keeps only folders there (devices/orcaHomes.ts).
    for (const home of orcaAccountHomes(this).codex) mkdirSync(home, { recursive: true })
    this.dial = new LoopbackDial(() => Date.now())
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    this.core = fakeCore({
      dataDir,
      // Signed out, so the devices open no lane to the backend for the owner's other machines: the dial serves this
      // computer, over its cable.
      account: { signedIn: () => false },
      // No Harness window: the person works in the apps.
      clients: { hasWindow: () => false },
      // Tier A has no Harness agent, so the real core would refuse a send or an answer to any: each is to no session.
      turns: { send: (_agentId, text) => this.nowhere(text), deliver: (_agentId, text) => this.nowhere(text) },
      questions: {
        answer: (_agentId, _requestId, answers) => this.nowhere(Object.values(answers).join('\n')),
        answerReviewed: async ({ answers }) => {
          this.nowhere(Object.values(answers).join('\n'))
          return false
        },
      },
    })
    start(this.core, this.ports, this.deps(root, installed))
  }

  storeChanged(path: string): void {
    this.watch.changed(path)
  }

  agentId(key: SessionKey): string {
    return agentIdOf(this.session(key))
  }

  session(key: SessionKey): SessionDef {
    const found = this.scenario.sessions.find((s) => s.key === key)
    if (!found) throw new Error(`scenario ${this.scenario.id} names no session ${key}`)
    return found
  }

  deliver(d: Omit<Delivery, 'at'>): void {
    this.deliveries.push({ at: Date.now(), ...d })
  }

  answer(rule: (argv: readonly string[]) => Answer | undefined): void {
    this.rules.push(rule)
  }

  gap(reason: string): void {
    if (!this.gaps.includes(reason)) this.gaps.push(reason)
  }

  onClose(close: () => void): void {
    this.closing.push(close)
  }

  quiet(): Promise<void> {
    return quiet(this.inFlight)
  }

  /** The clock's `inFlight`. */
  readonly inFlight = (): number => this.reads

  /** What the scenario saw, `at` from time 0, given the steps the driver ran. */
  seen(steps: Seen['steps']): Seen {
    const from0 = <T extends { at: number }>(rows: readonly T[]): T[] => rows.map((row) => ({ ...row, at: row.at - this.origin }))
    return { frames: from0(this.dial.frames), faces: from0(this.dial.faces), commands: from0(this.commands),
      deliveries: from0(this.deliveries), steps: from0(steps), streams: from0(this.streams), logs: from0(this.logs) }
  }

  /** The devices stopped, on virtual time still, and whatever they were reading landed. */
  async close(): Promise<void> {
    try {
      await this.ports.devices?.stop()
      await this.quiet()
    } finally {
      for (const close of this.closing.splice(0)) close()
    }
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true })
  }

  /** The ChatGPT app installed where this platform's devices look for it (services/devices.ts chatGptInstalled), with
   *  its Codex home. */
  private install(root: string, codexHome: string): void {
    mkdirSync(codexHome, { recursive: true })
    if (this.platform === 'darwin') {
      for (const app of chatGptPlaces('darwin', undefined, root)) machine.bundleIds.set(app, APPS.chatgpt.bundle)
    } else if (this.platform === 'linux') {
      const apps = join(root, 'apps')
      vi.stubEnv('HARNESS_APPLICATIONS_DIR', apps)
      mkdirSync(join(apps, 'chatgpt'), { recursive: true })
      writeFileSync(join(apps, 'chatgpt', 'ChatGPT'), '')
    } else {
      mkdirSync(join(root, 'OpenAI.Codex'))
    }
  }

  /** A send through the core, which reaches no session in tier A. */
  private nowhere(text: string): void {
    this.deliver({ path: 'turns', target: null, text })
  }

  /**
   * A command the devices ran: answered by the world's rules, and recorded at its virtual time with whether it ran to a
   * good end. One of a program the world does not answer (`modelled`) is a gap: its answer would be made up.
   */
  private ran(argv: string[], modelled = answered(argv)): Required<Answer> {
    if (!modelled) this.gap(`a command tier A does not answer: ${programOf(argv)}`)
    let answer: Answer = { code: 0 }
    for (const rule of this.rules) {
      const said = rule(argv)
      if (said) {
        answer = said
        break
      }
    }
    this.commands.push({ at: Date.now(), argv, ok: answer.code === 0 })
    return { stdout: '', ...answer }
  }

  /** Each of the store's calls that returns a promise, counted while it is in flight. */
  private counted<T extends object>(reader: T): T {
    return new Proxy(reader, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key, target)
        if (typeof member !== 'function') return member
        return (...args: unknown[]): unknown => {
          const result: unknown = member.apply(target, args)
          if (result instanceof Promise) {
            this.reads++
            const landed = (): void => { this.reads-- }
            result.then(landed, landed)
          }
          return result
        }
      },
    })
  }

  /**
   * Linux's raise: the real one (linuxRaise.ts), its ready and its walk of the session's parents, on a desktop that takes
   * a window by its process (X11, as sway, Hyprland and KDE do); GNOME's raise by the app's class alone is not graded.
   * Its backend's command is `raise [--app <app id>] [--pid <pid>]… [--class <class>]…`: the app the devices asked it to
   * raise, each raise its own however many run at once, then the pids nearest first and the classes as frontApp.ts
   * windowClasses spells them, what the real raise hands every desktop's backend.
   */
  private linuxRaise(): LinuxRaise {
    const asked = new AsyncLocalStorage<string | undefined>()
    const real = createLinuxRaise({
      find: async () => ({ kind: 'x11', display: ':0' }),
      backend: () => ({
        raise: async ({ pids, classes }) => {
          const app = asked.getStore()
          return this.ran(['raise', ...(app === undefined ? [] : ['--app', app]), ...pids.flatMap((pid) => ['--pid', String(pid)]),
            ...classes.flatMap((name) => ['--class', name])]).code === 0
        },
      }),
      processes: async () => [...machine.processes.values()].map(({ pid, ppid }) => ({ pid, ppid })),
      classes: windowClasses,
      log: () => {},
    })
    return { ready: (window) => real.ready(window), raise: (window) => asked.run(window.app, () => real.raise(window)) }
  }

  private deps(root: string, installed: boolean): DevicesDeps {
    const { platform, scenario } = this
    const typed = (text: string): void => this.deliver({ path: 'typed', target: null, text })
    const failing = new Set(scenario.world?.linkFails ?? [])
    const apps = Object.entries(APPS) as Array<[LinkedApp, (typeof APPS)[LinkedApp]]>
    // A link of an app the scenario says fails them is refused.
    this.answer((argv) => (apps.some(([app, { scheme }]) => failing.has(app) && argv.some((arg) => arg.startsWith(`${scheme}://`)))
      ? { code: 1 } : undefined))
    // On Linux each installed app's desktop file takes its scheme's links (cable/hosts/appLink.ts readApp): only the
    // ChatGPT app is ever missing (world.chatgptInstalled).
    this.answer((argv) => {
      if (!argv[0]?.endsWith('xdg-mime') || argv[1] !== 'query' || argv[2] !== 'default') return undefined
      const found = apps.find(([app, { scheme }]) => argv[3] === `x-scheme-handler/${scheme}` && (app !== 'chatgpt' || installed))
      return { code: 0, stdout: found ? `${found[1].desktopFile}\n` : '' }
    })
    // Words typed into a terminal are seen, and Orca's CLI is answered from the model, from before the devices start: they
    // read Orca's homes at once. Typing is seen first, as Orca's rule answers its sends.
    recordTyping(this)
    answerOrca(this)
    // Orca's CLI is found from the model too (the plan's Decision 6), and the devices build their own reads of it on
    // these. A lookup's accept is never asked: it reads the real disk. Of Orca's files only its CLI is there, where the
    // platform's installer puts it.
    const orcaInstall = { darwin: orcaAppBin(), linux: ON_PATH.linux['orca-ide']!, win32: ORCA_EXE(join(root, LOCAL_APP_DATA)) }[platform]
    const orca: OrcaReadDeps = {
      run: async (file, args) => this.ran([file, ...args]),
      onPath: (name) => (Object.hasOwn(ON_PATH[platform], name) ? ON_PATH[platform][name]! : null),
      exists: (path) => path === orcaInstall,
      platform,
      // Its focus watch, whose start is a command Orca ran: one that failed has already exited.
      spawn: (file, args) => (this.ran([file, ...args]).code === 0 ? watchChild(this) : EXITED),
      mtime: (path) => ({ realPath: path, mtimeMs: ORCA_MTIME_MS }),
    }
    const log = (line: string): void => { this.logs.push({ at: Date.now(), line }) }
    // Orca's accounts' homes, read as the devices read them on this computer (services/devices.ts orcaHomesCache): with
    // `account list` on these deps and LOCALAPPDATA, which orcaHomesDeps carries and the Orca deps do not.
    const localAppData = process.env.LOCALAPPDATA
    const orcaHomes = createOrcaHomesCache({
      read: () => readOrcaHomes({ ...orca, localAppData, uid: process.getuid?.() ?? -1,
        run: async (file, args) => ({ ...this.ran([file, ...args]), timedOut: false }) }),
      now: () => performance.now(),
      log,
    })
    return {
      logsDir: join(root, 'logs'),
      petsDir: join(root, 'pets'),
      cable: this.dial.cable,
      orca,
      codex: {
        run: async (file, args) => {
          const queue = args[0] === 'queue'
          const { code } = this.ran([file, ...args], queue)
          // A run that failed queued nothing. One that ran is a send, to no session when it names none of the scenario's.
          if (queue && code === 0) {
            const { thread, text } = queued(args)
            this.deliver({ path: 'codex', target: scenario.sessions.find((s) => s.id === thread)?.key ?? null, text })
          }
          return code
        },
        binary: () => CODEX_BIN,
        appBinary: () => (installed ? APP_CODEX_BIN : null),
        parentEnv: () => ({ PATH: '/usr/bin' }),
        readLoginShell: () => {},
        platform,
      },
      herdr: noHerdr(typed),
      hc: noHc(typed),
      cmux: { binary: () => null, sessions: async () => ({ ok: false, fault: 'no-binary' }), mode: async () => undefined,
        inputState: async () => undefined, paste: async (_workspace, _surface, text) => { typed(text); return false } },
      opencode: noOpencode(typed),
      claudeAppStore: this.counted(new ClaudeAppStore([this.claudeStore.root])),
      codexAppThreads: this.counted(new CodexAppThreads(this.codexHome.home)),
      watchStore: this.watch.watch,
      transcribe: async () => this.speech ?? '',
      bundleId: async (app) => machine.bundleIds.get(app),
      storePackageFolder: async () => (installed && platform === 'win32' ? join(root, 'OpenAI.Codex') : null),
      log,
      onExit: () => {},
      listen: async (handlers) => {
        this.listener = handlers
        return { close: async () => {} }
      },
      tty: async (pid) => machine.processes.get(pid)?.tty,
      claude: async () => null,
      orcaHomes,
      vscodeExtension: noEditor('vscode', platform, root),
      cursorExtension: cursorInstalled(platform, root, (reason) => this.gap(reason)),
      orcaPlugin: { orca: () => null, run: async () => ({ code: null, stdout: '', timedOut: false }), files: () => null, folder: join(root, 'orca-plugin') },
      processParents: async () => [...machine.processes.values()].map(({ pid, ppid }) => ({ pid, ppid })),
      claudeFullscreen: async () => false,
      // Each terminal agent leads its own job, which its shell's terminal has in front, as the machine this models starts
      // them (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md, Eval).
      processGroups: async (agent, shell) => (machine.processes.has(agent) && machine.processes.has(shell)
        ? { pgid: agent, tpgid: agent } : undefined),
      // Linux's and Windows' ways to bring a window forward, as the commands the checks read (checks.ts fronts).
      raise: platform === 'linux' ? this.linuxRaise() : undefined,
      windowsRaise: platform === 'win32' ? {
        app: async (bundle) => this.ran(['harness-pty', 'raise', bundle]).code === 0,
        link: async (url, bundle) => this.ran(['harness-pty', 'open-link', url, ...(bundle ? [bundle] : [])]).code === 0,
        cursorFolder: async (folder) => this.ran(['harness-pty', 'cursor-folder', folder]).code === 0,
        desktop: async () => this.ran(['harness-pty', 'desktop']).code === 0,
      } : undefined,
    }
  }
}
