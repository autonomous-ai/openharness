/**
 * One tier A scenario's world: the real devices (services/devices.ts) started in this process for one platform, with
 * the Claude app's store and the ChatGPT app's Codex home as fixtures in a fresh temp folder, the loopback dial on the
 * real cable, and every command, raise and send the devices make recorded with its virtual time and answered as the
 * scenario says. Nothing it hands the devices starts a process or reads this machine: the readers of the machine are
 * the spec's mocks (dialAppEval.spec.ts), answering from the model (machine.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { vi } from 'vitest'
import { chatGptPlaces, claudeStoreRoots } from '../../../cable/hosts/appPlaces.js'
import { ClaudeAppStore } from '../../../cable/hosts/claudeAppStore.js'
import { CodexAppThreads } from '../../../cable/hosts/codexAppThreads.js'
import { windowClasses } from '../../../cable/hosts/frontApp.js'
import type { HcClient } from '../../../cable/hosts/hcClient.js'
import type { HerdrClient } from '../../../cable/hosts/herdrClient.js'
import { createLinuxRaise } from '../../../cable/hosts/linuxRaise.js'
import type { OpencodeClient } from '../../../cable/hosts/opencodeClient.js'
import type { OrcaReadDeps, OrcaReads } from '../../../cable/hosts/orca.js'
import { env } from '../../../config/env.js'
import { emptyPorts, type CoreApi, type CorePorts } from '../../../core/api.js'
import type { VscodeEditor, VscodeExtensionDeps } from '../../../devices/vscodeExtension.js'
import type { DevicesDeps, startDevices } from '../../../services/devices.js'
import type { ListenerHandler, ListenerStreamHandler } from '../../../services/devicesListener.js'
import { claudeAppFixture } from '../../claudeAppFixture.js'
import { codexAppFixture } from '../../codexAppFixture.js'
import { fakeCore } from '../../fakeCore.js'
import { agentIdOf, type App, type Delivery, type Platform, type Scenario, type Seen, type SessionDef, type SessionKey,
  type StepKind, type StepOf } from '../types.js'
import { quiet } from './clock.js'
import { LoopbackDial } from './loopbackDial.js'
import { machine, type MachineModel } from './machine.js'
import { createStoreWatch, onHost } from './storeWatch.js'

export interface TierAWorld {
  readonly scenario: Scenario; readonly platform: Platform; readonly machine: MachineModel
  readonly ports: CorePorts; readonly core: CoreApi; readonly dial: LoopbackDial
  /** What `deps.listen` was handed: the devices' own listener's handlers. */
  readonly listener: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>
  readonly claudeStore: ReturnType<typeof claudeAppFixture>; readonly codexHome: ReturnType<typeof codexAppFixture>
  /** Where the engines' transcripts go, Harness's own Claude Code and Codex homes: emptied for each scenario. */
  readonly folders: { claudeProjects: string; codexSessions: string }
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

/** Each app's macOS bundle id, the scheme of its links, and its Linux desktop file. */
const APPS: Readonly<Record<App, { bundle: string; scheme: string; desktopFile: string }>> = {
  claude: { bundle: 'com.anthropic.claudefordesktop', scheme: 'claude', desktopFile: 'com.anthropic.Claude.desktop' },
  chatgpt: { bundle: 'com.openai.codex', scheme: 'codex', desktopFile: 'chatgpt.desktop' },
}
/** The commands found on a Linux PATH here: the two a link needs. Nothing else of any platform's is installed. */
const LINUX_TOOLS: ReadonlySet<string> = new Set(['xdg-mime', 'xdg-open'])
/** Made-up places, recorded and never run. */
const CODEX_BIN = '/opt/eval/bin/codex'
const APP_CODEX_BIN = '/opt/eval/ChatGPT.app/codex'
/** The programs whose commands the world answers as the scenario says, by name: macOS's and Linux's openers, the scheme
 *  lookup, the Windows helper and the Linux raise. A command of any other is one tier A does not model. */
const ANSWERED: ReadonlySet<string> = new Set(['open', 'xdg-open', 'xdg-mime', 'harness-pty', 'raise'])

/** Harness's own engine homes are the suite's throwaway ones (vitest.setup.ts): never a folder outside this run's. */
function emptied(folder: string): string {
  const inside = relative(tmpdir(), folder)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error('tier A empties only folders of its own run')
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  return folder
}

/** A command's program, as its path or name ends. */
const programOf = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).at(-1)!

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
/** Orca's reads, which never land: no Orca runs here. */
const noOrca: OrcaReads = {
  orcaWatchesFocus: () => new Promise(() => {}),
  orcaTabs: () => new Promise(() => {}),
  watchOrcaFocus: () => { throw new Error('no Orca in tier A') },
}

export class World implements TierAWorld {
  readonly machine = machine
  readonly ports: CorePorts = emptyPorts()
  readonly core: CoreApi
  readonly dial: LoopbackDial
  listener: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>> = {}
  readonly claudeStore: ReturnType<typeof claudeAppFixture>
  readonly codexHome: ReturnType<typeof codexAppFixture>
  readonly folders: { claudeProjects: string; codexSessions: string }
  speech: string | null = null
  /** None until the driver's first front step, before the dial is plugged in. */
  front: App | 'other' = 'other'
  readonly commands: Seen['commands'] = []
  readonly deliveries: Seen['deliveries'] = []
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
    for (const name of ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'HARNESS_APPLICATIONS_DIR', 'HARNESS_OPEN_BIN']) vi.stubEnv(name, '')
    // The welcome's voice language follows LANG (cableHost.ts voiceLang): the same on every host.
    vi.stubEnv('LANG', 'en_US.UTF-8')
    // The fixture is at the platform's own first root, as this host names it (a Windows one's folders are this host's of
    // the same names): the readers read it there, and the store's watch on that root hears its writes as the app's.
    this.claudeStore = claudeAppFixture(onHost(claudeStoreRoots(platform, process.env, root)[0]!.root))
    // A signed-in Claude app has its account's folder.
    this.claudeStore.org()
    const codexHome = join(root, '.codex')
    this.codexHome = codexAppFixture(codexHome)
    if (installed) this.install(root, codexHome)
    this.folders = { claudeProjects: emptied(env.CLAUDE_PROJECTS_DIR), codexSessions: emptied(join(env.CODEX_HOME, 'sessions')) }
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
      deliveries: from0(this.deliveries), steps: from0(steps) }
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
  private ran(argv: string[], modelled = ANSWERED.has(programOf(argv))): Required<Answer> {
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

  private deps(root: string, installed: boolean): DevicesDeps {
    const { platform, scenario } = this
    const typed = (text: string): void => this.deliver({ path: 'typed', target: null, text })
    const failing = new Set(scenario.world?.linkFails ?? [])
    const apps = Object.entries(APPS) as Array<[App, (typeof APPS)[App]]>
    // A link of an app the scenario says fails them is refused.
    this.answer((argv) => (apps.some(([app, { scheme }]) => failing.has(app) && argv.some((arg) => arg.startsWith(`${scheme}://`)))
      ? { code: 1 } : undefined))
    // On Linux each installed app's desktop file takes its scheme's links (cable/hosts/appLink.ts readApp).
    this.answer((argv) => {
      if (!argv[0]?.endsWith('xdg-mime') || argv[1] !== 'query' || argv[2] !== 'default') return undefined
      const found = apps.find(([app, { scheme }]) => argv[3] === `x-scheme-handler/${scheme}` && (app === 'claude' || installed))
      return { code: 0, stdout: found ? `${found[1].desktopFile}\n` : '' }
    })
    const orca: OrcaReadDeps = {
      run: async (file, args) => this.ran([file, ...args]),
      onPath: (name) => (platform === 'linux' && LINUX_TOOLS.has(name) ? `/usr/bin/${name}` : null),
      exists: () => false,
      platform,
      // Orca's focus watch: never started, as its reads are given.
      spawn: () => ({ onData: () => {}, exited: Promise.resolve(), kill: () => {} }),
      mtime: () => null,
    }
    return {
      logsDir: join(root, 'logs'),
      petsDir: join(root, 'pets'),
      cable: this.dial.cable,
      orca,
      orcaReads: noOrca,
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
      log: () => {},
      onExit: () => {},
      listen: async (handlers) => {
        this.listener = handlers
        return { close: async () => {} }
      },
      tty: async (pid) => machine.processes.get(pid)?.tty,
      claude: async () => null,
      orcaHomes: { get: () => ({ claude: [], codex: [] }), answered: () => true, refresh: async () => false },
      vscodeExtension: noEditor('vscode', platform, root),
      cursorExtension: noEditor('cursor', platform, root),
      orcaPlugin: { orca: () => null, run: async () => ({ code: null, stdout: '', timedOut: false }), files: () => null, folder: join(root, 'orca-plugin') },
      processParents: async () => [...machine.processes.values()].map(({ pid, ppid }) => ({ pid, ppid })),
      claudeFullscreen: async () => false,
      processGroups: async () => undefined,
      // Linux's and Windows' ways to bring a window forward, as the commands the checks read (checks.ts fronts). On Linux
      // the real raise (linuxRaise.ts), its ready and its walk of the session's parents, on a desktop that takes a window
      // by its process (X11, as sway, Hyprland and KDE do): GNOME's raise by the app's class alone is not graded. Its
      // backend's command is `raise [--pid <pid>]… [--class <class>]…`, the pids nearest first and the classes as
      // frontApp.ts windowClasses spells them: what the real raise hands every desktop's backend.
      raise: platform === 'linux' ? createLinuxRaise({
        find: async () => ({ kind: 'x11', display: ':0' }),
        backend: () => ({
          raise: async ({ pids, classes }) => this.ran(['raise', ...pids.flatMap((pid) => ['--pid', String(pid)]),
            ...classes.flatMap((name) => ['--class', name])]).code === 0,
        }),
        processes: async () => [...machine.processes.values()].map(({ pid, ppid }) => ({ pid, ppid })),
        classes: windowClasses,
        log: () => {},
      }) : undefined,
      windowsRaise: platform === 'win32' ? {
        app: async (bundle) => this.ran(['harness-pty', 'raise', bundle]).code === 0,
        link: async (url, bundle) => this.ran(['harness-pty', 'open-link', url, ...(bundle ? [bundle] : [])]).code === 0,
        cursorFolder: async (folder) => this.ran(['harness-pty', 'cursor-folder', folder]).code === 0,
        desktop: async () => this.ran(['harness-pty', 'desktop']).code === 0,
      } : undefined,
    }
  }
}
