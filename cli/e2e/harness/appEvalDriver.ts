/**
 * Tier B's driver of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B: scripted end to end, fake
 * apps"): each scenario on the real daemon and devices process, a fake dial on the desk (fakeDial.ts), the real
 * `harness hardware watch --json` for the app in front, and the fake backend for the dial's speech. A daemon serves the
 * first scenario and every one after it, reset, until a scenario asks for one of its own (`fresh`).
 *
 * Isolation: each daemon's open (HARNESS_OPEN_BIN, which only records: `writeRecordingOpen`), its home, its apps' folder,
 * both apps' stores, the editors' CLIs (HARNESS_VSCODE_BIN, HARNESS_CURSOR_BIN; on Linux Cursor's only records:
 * `writeRecordingCli`), Orca's CLI (the fake, as `orca` and `orca-ide`: `orcaCliInside`), its `tmux` (a recording wrapper
 * of its private server's), its `ps` (which hides every herdr outside this worker: `ownHerdrsOnly`) and, on Linux, the
 * raise's programs (`writeRaiseFakes`) are checked to be inside its root before it starts, and it is signed in to the fake
 * backend alone.
 * The network guard (src/testing/dialAppEval/netGuard.ts) is in this process and preloaded into every process of the
 * daemon and every child started here: a start whose running core or devices process did not load it fails, and the
 * driver's close fails on any attempt not yet handed on, those its last daemon made as it closed among them.
 *
 * What it saw: the frames the dial received, at their arrival; the faces of the firmware's carousel model, fed those
 * frames and the person's own turns (a swipe moves the glass before the daemon hears of it); the commands of the
 * recording open and of the recording Cursor CLI, with their exit, a folder in the daemon's projects written as the
 * catalog's `/work/` one, and the fake Orca's at their own times, each `terminal send` among them a `typed` delivery to
 * the session whose pane it named; in an iTerm2 scenario the devices' tmux and herdr runs at their own times, each pane
 * named by its session; the selects the watch printed, at their arrival, and the person's tab reports, each tab named by
 * its label; the deliveries and editor streams the app's steps record; the devices' log lines, at their read; and, after
 * `stop`, what the scenario cost (appEvalCost.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { chatGptPlaces, claudeStoreRoots } from '../../src/cable/hosts/appPlaces.js'
import { orcaBinary } from '../../src/devices/orcaHomes.js'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { claudeAppFixture } from '../../src/testing/claudeAppFixture.js'
import { flagOf } from '../../src/testing/dialAppEval/argv.js'
import { namedPanes, selectRecord, TABS_STREAM } from '../../src/testing/dialAppEval/itermRecords.js'
import { describeAttempt, guardThisProcess, NET_GUARD_FILE_ENV, netGuardEnv, readNetGuard, type NetAttempt } from '../../src/testing/dialAppEval/netGuard.js'
import { orcaListing } from '../../src/testing/dialAppEval/orcaListing.js'
import { agentIdOf, engineOf, frontName, PAGE, placeOf, type App, type Delivery, type EvalDriver, type LinkedApp, type Platform,
  type Scenario, type Seen, type SessionDef, type SessionKey, type Step, type StepKind, type StepOf } from '../../src/testing/dialAppEval/types.js'
import { CAROUSEL_REFRESH_MS, DialCarousel, type DialMessage } from '../../src/testing/dialCarousel.js'
import { writeExecutable } from '../../src/testing/executableFixture.js'
import { RECORDED_LINUX_APPS } from '../../src/testing/recordedLinuxApps.js'
import { beginCost, costEnv } from './appEvalCost.js'
import { writeAppCodex } from './codexAppCli.js'
import { IsolatedDaemon, SOURCES_CLI, until } from './daemon.js'
import { Desk, devicesPids } from './desk.js'
import { FakeBackend, type FakeMachine } from './fakeBackend.js'
import type { FakeDial } from './fakeDial.js'
import { FakeOrca } from './fakeOrca.js'
import { herdrRuns, ownHerdrsOnly } from './herdrServer.js'
import { recordingWrapper, runLog, type LoggedRun } from './runLog.js'
import { writeSchemeApps } from './schemeApps.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const SERIAL = 'EVAL-B'
const MAC = 'e2:e0:00:00:0e:b1'
/** The scheme of each app's links (cable/hosts/claudeApp.ts, codexApp.ts): the ChatGPT app's threads are Codex's. */
const SCHEME: Readonly<Record<LinkedApp, string>> = { claude: 'claude', chatgpt: 'codex', vscode: 'vscode', cursor: 'cursor' }
/** The machine each daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'e7'.repeat(16), computerId: 'e2e-dial-eval-computer', name: 'Fixture', token: 'e2e-dial-eval-token' }
/** A fifth of a second of what the microphone heard: the fake backend answers its `speech` whatever the audio. */
const VOICE_PCM = Buffer.alloc(3_200, 1)
/** For the dial to be found, welcomed and shown its list: the fleet looks every 2 s, the dial greets every 2 s; and for
 *  the devices to drop the last scenario's rows, at their 30 s look at the latest (deskEmpty). */
const START_WITHIN_MS = 45_000
const CHILD_END_MS = 5_000
/** The end of the watch's stderr a failure says. */
const STDERR_KEPT = 2_000
/** For the devices killed outright to be started again by the master, and to welcome the dial: a welcomed dial greets
 *  every 15 s (fakeDial.ts keepGreeting). */
const RESTART_WITHIN_MS = 45_000
/** The tmux commands the devices find and select a pane by (cable/hosts/tmux.ts), noted by the daemon's recording tmux. */
const TMUX_RECORDED = ['display-message', 'list-clients', 'list-panes', 'select-window', 'switch-client']
/** The devices take a Claude session whose mod poll closed this long ago for one whose next poll is coming
 *  (cable/hosts/inbox.ts READY_MS, 35 s), and a second more for the two clocks. */
const MOD_READY_MS = 36_000
/** What a scenario refused before its world began saw. */
const NOTHING_SEEN: Seen = { frames: [], faces: [], commands: [], deliveries: [], steps: [] }
// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs. Either runs from any
// folder, so each run here works in the daemon's root, where the cost counts what a scenario leaves running.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : SOURCES_CLI

/** One run of the recording open: the command it stands for, and whether it exited 0. */
export type OpenRun = Omit<Seen['commands'][number], 'at'>

export interface TierBWorld {
  readonly d: IsolatedDaemon; readonly desk: Desk; readonly dial: FakeDial
  readonly scenario: Scenario; readonly platform: Platform
  agentId(key: SessionKey): string; session(key: SessionKey): SessionDef
  /** [at]: when it reached its session, ms since the epoch; now when not given. */
  deliver(d: Omit<Delivery, 'at'>, at?: number): void; gap(reason: string): void
  /** Each run of the open from now on, as it is read: how a fake app sees the links the devices run. */
  onOpen(listener: (run: OpenRun) => void): void
  /** The app in front, as the watch was last told. */
  readonly front: App | 'other'
  /** A mod poll for the Claude session [sessionId] closed now. */
  modPolled(sessionId: string): void
  /** A fake app's own failure, outside any step: the scenario fails with it at its next step, wait or stop. */
  fail(error: unknown): void
  /** A title of the ChatGPT app's window, as Harness Device reads it: a line on the watch. */
  title(text: string): void
  /** A line on an editor window's stream, either way (Seen.streams); [at] as `deliver`'s. */
  stream(window: string, line: Record<string, unknown>, at?: number): void
  /** The catalog's folder `/work/<name>` on this daemon, made: `<projects>/<name>`, recorded back as `/work/<name>`. */
  folder(path: string): string
  /** Ended at stop. */
  readonly children: ChildProcess[]
  /** Orca's CLI, as `orca` and `orca-ide`: the fake. */
  readonly orca: FakeOrca
  /** The session's own Orca pane opened on [handle] now, or closed (null): what a `terminal send` types to a handle
   *  reaches the session whose own pane it was at the send. */
  orcaPane(key: SessionKey, handle: string | null): void
  /** Each iTerm2 tab's tty (`/dev/ttysNNN`) by its label (itermRecords.ts tabLabel), as the iTerm2 steps open them: a tab
   *  opened again under a label takes it over. A select of a tty no label holds is recorded as `other`. */
  readonly tabs: Map<string, string>
  /** Each tmux and herdr pane's session, by pane id: the devices' tmux and herdr runs name their panes by it. */
  readonly muxPanes: Map<string, SessionKey>
  /** The person's selected tab of iTerm2, by its label: told on the watch, and recorded on the tabs stream. */
  reportTab(label: string): void
  /** The herdrs the daemon's process table kept, this worker's, and dropped, all others (ownHerdrsOnly). */
  readonly herdrs: { kept(): number[]; dropped(): number[] }
}
export type TierBHandler<K extends StepKind> = (world: TierBWorld, step: StepOf<K>) => Promise<void>

/** The steps this driver runs itself, on the dial, the watch and the devices process. */
type GenericKind = 'front' | 'thread' | 'tap' | 'swipe' | 'stroke' | 'unplug' | 'replug' | 'devices.restart'
/** The steps on an app's sessions and stores, and its voice, whose words land on that app's paths: each app's file gives
 *  those its scenarios take (appEvalClaude.ts, appEvalChatgpt.ts). */
export type AppSteps = { [K in Exclude<StepKind, 'wait' | GenericKind>]?: TierBHandler<K> }
type Run = Exclude<Step, { kind: 'wait' }>

/** A daemon, its desk and its backend, kept across the scenarios that do not ask for a fresh one. */
interface Rig {
  d: IsolatedDaemon; desk: Desk; backend: FakeBackend
  /** Orca's CLI, as `orca` and `orca-ide`: the fake, and whether it has watch-focus now. */
  orca: FakeOrca
  watchFocus: boolean
  /** The sessions whose Orca account's home its Orca lists (orcaAccounts). */
  accounts: SessionKey[]
  /** Where its recording open notes its runs, and its recording Cursor CLI its own (Linux's alone: none on macOS). */
  runs: string
  cursorRuns: string
  /** Its projects folder, as given and as the system resolves it: a command naming either names the catalog's /work/. */
  projects: string[]
  /** The network guard's file: the processes it was loaded into and what it refused there. Outside the root, which goes
   *  with the daemon, so what its processes tried as they ended is read after. */
  guard: string
  /** How many of its attempts were handed on. */
  given: number
  /** When each Claude session's last mod poll closed, by its id: the devices still count it ready for a while. */
  polled: Map<string, number>
  /** Where its recording tmux and its herdr note the devices' runs (runLog.ts). */
  tmuxRuns: string
  herdrRuns: string
  herdrs: { kept(): number[]; dropped(): number[] }
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

export const inside = (root: string, path: string | undefined): boolean => !!path && isAbsolute(path) && !relative(root, path).startsWith('..')
/** The network guard's preload and file, from the daemon's environment: for a process started with one of its own. */
export function guardEnv(d: IsolatedDaemon): Record<string, string> {
  return { NODE_OPTIONS: d.env.NODE_OPTIONS!, [NET_GUARD_FILE_ENV]: d.env[NET_GUARD_FILE_ENV]! }
}
/**
 * Throws unless the network guard's [file] says it was loaded into each of [pids], [name]'s processes, each one Node
 * names [process] (netGuard.cjs processName). The pids are of processes running now: a line of a pid since reused proves
 * nothing of them.
 */
export function guardLoaded(file: string, name: string, pids: readonly number[], process = name): void {
  const { loaded } = readNetGuard(file)
  if (pids.length === 0 || !pids.every((pid) => loaded.some((l) => l.process === process && l.pid === pid))) {
    throw new Error(`the network guard is not in the ${name} process`)
  }
}
/** The file beside the recording open that has the links of an app fail while it is there. */
const failsFile = (open: string, app: LinkedApp): string => join(dirname(open), `${SCHEME[app]}.fails`)

/**
 * The open the devices run (HARNESS_OPEN_BIN), in place of the harness's own (harness/daemon.ts), which notes no exit: it
 * stands in for /usr/bin/open on macOS and for xdg-open on Linux (cable/hosts/appLink.ts), opens nothing, and notes each
 * run in [runs] as `<exit> <arguments>`. A link of an app `linksFail` names exits 1, on both: the open is how either
 * platform's link fails, while Linux's scheme still has its app (a scheme without one is kept by the devices for as
 * long as they run, so a later scenario on the same daemon would have no link at all).
 */
export function writeRecordingOpen(path: string, runs: string): void {
  if ([path, runs].some((p) => p.includes("'"))) throw new Error('the recording open\'s folder holds a quote')
  const fails = (Object.keys(SCHEME) as LinkedApp[]).map((app) =>
    `case "$*" in *${SCHEME[app]}://*) [ -e '${failsFile(path, app)}' ] && code=1 ;; esac\n`)
  writeExecutable(path, `#!/bin/sh\ncode=0\n${fails.join('')}printf '%s %s\\n' "$code" "$*" >> '${runs}'\nexit "$code"\n`)
}

/** The apps whose links the recording open at [path] fails from now on; every other app's links open. */
export function linksFail(path: string, apps: readonly App[]): void {
  for (const app of Object.keys(SCHEME) as LinkedApp[]) {
    if (apps.includes(app)) writeFileSync(failsFile(path, app), '')
    else rmSync(failsFile(path, app), { force: true })
  }
}

/**
 * Cursor's CLI as the devices run it on Linux to open a folder (HARNESS_CURSOR_BIN, devices/vscodeExtension.ts
 * cursorFolderCli), in place of the harness's missing one: it opens nothing, and notes each run in [runs] as the recording
 * open does, always with exit 0.
 */
export function writeRecordingCli(path: string, runs: string): void {
  if ([path, runs].some((p) => p.includes("'"))) throw new Error('the recording CLI\'s folder holds a quote')
  mkdirSync(dirname(path), { recursive: true })
  writeExecutable(path, `#!/bin/sh\nprintf '0 %s\\n' "$*" >> '${runs}'\nexit 0\n`)
}

/** What Linux's raise runs, each found on the PATH (cable/hosts/linuxDesktop.ts, linuxRaise.ts, linuxRaiseKwin.ts). */
export const RAISE_TOOLS = ['wmctrl', 'swaymsg', 'hyprctl', 'gdbus', 'dbus-send'] as const
/**
 * Each of them in [bin], refusing as the daemon's own wmctrl does (harness/daemon.ts): a daemon on a Linux desktop finds
 * this login's sockets in /tmp/.X11-unix and the runtime folder whatever its home, so a tap with the computer's own would
 * raise the developer's real editor.
 */
export function writeRaiseFakes(bin: string): void {
  for (const tool of RAISE_TOOLS) writeExecutable(join(bin, tool), '#!/bin/sh\nexit 1\n')
}
/** Those a daemon under [env] finds outside [root], or not at all. */
export function raiseToolsOutside(root: string, env: NodeJS.ProcessEnv): string[] {
  return RAISE_TOOLS.filter((tool) => !inside(root, resolveBinaryOnPath(tool, env) ?? undefined))
}

/** The names a daemon runs Orca's CLI by: Linux looks for `orca-ide` before `orca` (devices/orcaHomes.ts orcaBinary). */
const ORCA_NAMES = ['orca-ide', 'orca'] as const
/**
 * The Orca CLI a daemon under [env] would run, resolved as orcaBinary resolves it on [platform] over its PATH and
 * HARNESS_ORCA_APP_BIN, and each of `orca-ide` and `orca` its PATH gives first: it throws unless every one's real path is
 * inside [root]. Every session here runs inside the real Orca, whose `orca` is on the worker's PATH, and a daemon's PATH
 * ends in the computer's folders, where Orca's .deb puts an `orca-ide`; a link in the root runs the file it names.
 */
export function orcaCliInside(env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform): string {
  // orcaBinary reads the app's path from this process's environment, as the devices read theirs: the daemon's for the
  // call, this worker's again before anything else runs.
  const own = process.env.HARNESS_ORCA_APP_BIN
  const app = (path: string | undefined): void => {
    if (path === undefined) delete process.env.HARNESS_ORCA_APP_BIN
    else process.env.HARNESS_ORCA_APP_BIN = path
  }
  app(env.HARNESS_ORCA_APP_BIN)
  let cli: string | null
  try {
    cli = orcaBinary({ onPath: (name, accept) => resolveBinaryOnPath(name, env, accept), exists: existsSync, platform, localAppData: env.LOCALAPPDATA })
  } finally {
    app(own)
  }
  const real = realpathSync(root)
  const first = ORCA_NAMES.flatMap((name) => resolveBinaryOnPath(name, env) ?? [])
  if (cli === null || ![cli, ...first].every((path) => inside(real, realpathSync(path)))) {
    throw new Error("the daemon's Orca CLI is not inside its root")
  }
  return cli
}

/** The sessions whose Codex runs in a home of its own, an Orca account's: Orca lists that home (`orca account list`). */
export function orcaAccounts(scenario: Pick<Scenario, 'sessions'>): SessionKey[] {
  return scenario.sessions.filter((s) => s.app === 'orca' && engineOf(s) === 'codex' && s.codexHome === 'own').map((s) => s.key)
}
/** The Orca account's home a session's Codex runs in, in the daemon's root. */
export const orcaAccountHome = (root: string, key: SessionKey): string => join(root, 'orca-accounts', key)

/** The fake Orca's runs as commands, at their own times, each argument inside one of [projects] written as the catalog's
 *  `/work/` folder. */
export function orcaCommands(runs: readonly LoggedRun[], projects: readonly string[]): Seen['commands'] {
  return runs.map(({ argv, ok, at }) => ({ at, argv: workPaths(argv, projects), ok }))
}
/**
 * Each `terminal send` Orca took (cable/hosts/orca.ts) as a `typed` delivery at its time, to the session whose own pane
 * the handle it names was then ([ownerOf]); to none for any other handle, a closed, held or tmux pane's among them,
 * which the gate counts as a wrong send. One Orca refused typed nothing.
 */
export function orcaDeliveries(runs: readonly LoggedRun[], ownerOf: (handle: string, at: number) => SessionKey | undefined): Delivery[] {
  return runs.flatMap(({ argv, ok, at }): Delivery[] => {
    const text = argv.find((arg) => arg.startsWith('--text='))?.slice('--text='.length)
    if (!ok || argv[1] !== 'terminal' || argv[2] !== 'send' || text === undefined) return []
    const handle = flagOf(argv, '--terminal')
    return [{ at, path: 'typed', target: (handle === undefined ? undefined : ownerOf(handle, at)) ?? null, text }]
  })
}

/** The devices' tmux and herdr runs as commands, at their own times, each pane id written as the session [keyOf] says
 *  holds it (namedPanes), so no pane id reaches a result. */
export function muxCommands(runs: readonly LoggedRun[], keyOf: (pane: string) => SessionKey | undefined): Seen['commands'] {
  return runs.map(({ argv, ok, at }) => ({ at, argv: namedPanes(argv, keyOf), ok }))
}

/** A select the watch printed (devices/client.ts): `{"select":{"app","tty","raise"?}}`; undefined for any other line. */
export function selectOf(line: string): { app: string; tty: string; raise?: boolean } | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  const select = (value as { select?: unknown } | null)?.select
  if (typeof select !== 'object' || select === null) return undefined
  const { app, tty, raise } = select as Record<string, unknown>
  if (typeof app !== 'string' || typeof tty !== 'string' || (raise !== undefined && typeof raise !== 'boolean')) return undefined
  return raise === undefined ? { app, tty } : { app, tty, raise }
}

/** Each run noted in [runs] as `<exit> <arguments>`, in order, as the command [program] with them. */
function noted(runs: string, program: string): OpenRun[] {
  let text = ''
  try { text = readFileSync(runs, 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ')
    const args = line.slice(space + 1)
    return { argv: [program, ...(args ? args.split(' ') : [])], ok: line.slice(0, space) === '0' }
  })
}
/** Each run the recording open noted in [runs], in order, as the command it stood for on [platform]. */
export function openRuns(runs: string, platform: Platform): OpenRun[] {
  return noted(runs, platform === 'linux' ? 'xdg-open' : 'open')
}
/** The extension setup's runs of an editor's CLI (devices/vscodeExtension.ts): they open no folder. */
const EXTENSION_SETUP: ReadonlySet<string> = new Set(['--install-extension', '--uninstall-extension'])
/** Each run the recording Cursor CLI noted in [runs], in order, but the extension setup's. */
export function cliRuns(runs: string): OpenRun[] {
  return noted(runs, 'cursor').filter((run) => !EXTENSION_SETUP.has(run.argv[1] ?? ''))
}

/** [argv] with each argument inside one of [projects] written as the catalog's `/work/` folder (TierBWorld.folder), so
 *  one evaluator grades both tiers. */
export function workPaths(argv: readonly string[], projects: readonly string[]): string[] {
  return argv.map((arg) => {
    const dir = projects.find((p) => arg === p || arg.startsWith(`${p}/`))
    return dir === undefined ? arg : `/work${arg.slice(dir.length)}`
  })
}

/** The lines of [log] after offset [from] that hold the devices' `[device` tag, each from its tag on, and the offset after
 *  the last whole line: one still being written is read once it ends. */
export function deviceLines(log: string, from: number): { lines: string[]; next: number } {
  const end = log.lastIndexOf('\n') + 1
  if (end <= from) return { lines: [], next: from }
  const lines = log.slice(from, end - 1).split('\n').flatMap((line) => {
    const tag = line.indexOf('[device')
    return tag < 0 ? [] : [line.slice(tag)]
  })
  return { lines, next: end }
}
/** The files in [dir] and below gone, its folders kept: the daemon's watches on them stay. */
function emptied(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) rmSync(join(entry.parentPath, entry.name), { force: true })
  }
}
/** Whether the session's window was closed, and not opened again, before the step labeled [after] (the scenario's end
 *  without one). */
function windowClosed(scenario: Scenario, s: SessionDef, after: string | undefined): boolean {
  const end = after === undefined ? scenario.steps.length : scenario.steps.findIndex((step) => step.label === after)
  const last = scenario.steps.slice(0, end).findLast((step) =>
    (step.kind === 'editor.window' || step.kind === 'editor.reload' || step.kind === 'editor.close') && step.window === s.window)
  return last?.kind === 'editor.close'
}

/**
 * What tier B leaves out of [scenario] on [platform]; it throws for a world tier B does not build, so no scenario passes
 * or fails on one it only seems to run. On Linux a tap whose link failed brings its app by the raise (cable/hosts/open.ts,
 * linuxRaise.ts), which no fake records, so an open check of an app whose links fail is left out there: it would fail
 * on a raise that ran. So is one of an editor's terminal row there, whose tap brings its editor by the same raise, but
 * for a Cursor terminal row whose window closed before the tap: that tap opens its folder by Cursor's CLI, which the
 * recording one stands for (U12).
 */
export function tierBGaps(scenario: Scenario, platform: Platform): string[] {
  // Every daemon has the ChatGPT app installed before its first dial (openRig).
  if (scenario.world?.chatgptInstalled === false) throw new Error(`${scenario.id}: tier B builds no world with no ChatGPT app`)
  // The fake Claude Code asks only a permission (fakeEngine.mjs `<name>.permit`): AskUserQuestion's hooks are not built.
  if (scenario.steps.some((s) => s.kind === 'hook' && s.asks === 'question')) throw new Error(`${scenario.id}: tier B's Claude Code asks no question`)
  const failing = scenario.world?.linkFails ?? []
  const opened = platform === 'linux'
    ? scenario.checks.flatMap((c) => c.kind === 'open' ? [{ s: scenario.sessions.find((s) => s.key === c.session)!, after: c.after }] : [])
    : []
  const raised = ({ s, after }: (typeof opened)[number]): boolean =>
    placeOf(s) === 'terminal' && !(s.app === 'cursor' && windowClosed(scenario, s, after))
  return [
    ...opened.some(({ s }) => failing.some((app) => app === s.app)) ? ["a failed link's app comes by Linux's raise, which tier B does not record"] : [],
    ...opened.some(raised) ? ["an editor terminal's tap brings its editor by Linux's raise, which tier B does not record"] : [],
  ]
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
/**
 * Whether the dial was welcomed and holds nothing of an earlier scenario: the last list it was sent is empty, and the
 * last word of the apps names none with a row. The list is the shown page's alone, and the catalog's ids are shared: an
 * ended session's row stays on its page until the devices drop it (10 s after its end, or at their 30 s look for one
 * that said none), and the page picked next would show it.
 */
export function deskEmpty(messages: readonly DialMessage[]): boolean {
  const apps = messages.findLast((m) => m.t === 'apps')?.apps
  return messages.some((m) => m.t === 'welcome') && lastList(messages)?.length === 0
    && Array.isArray(apps) && !apps.some((a: { count?: unknown }) => typeof a.count === 'number' && a.count > 0)
}
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_END_MS)
  await exited
  clearTimeout(timer)
}

/** A daemon whose Orca lists the Orca accounts of [accounts]' sessions (orcaAccounts). */
async function openRig(guard: string, accounts: SessionKey[]): Promise<Rig> {
  const backend = await FakeBackend.start()
  backend.addMachine(ME)
  let d: IsolatedDaemon | undefined
  try {
    d = await IsolatedDaemon.create({ env: {
      CABLE_DISABLE: 'false', BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    } })
    const cost = costEnv(d.root)
    // As enginehomes.e2e.ts preloads its fault: the master hands NODE_OPTIONS on to the core and every service.
    Object.assign(d.env, cost.env, netGuardEnv(guard, cost.nodeOptions))
    // The devices' tmux runs noted by a wrapper first on the daemon's PATH, which runs the tmux the daemon found there,
    // its private server's; and its process table holds no herdr but this worker's.
    const tmux = resolveBinaryOnPath('tmux', d.env)
    if (!tmux) throw new Error('the daemon finds no tmux')
    const tmuxRuns = join(dirname(d.binDir), 'tmux-runs')
    writeExecutable(join(d.binDir, 'tmux'), recordingWrapper(tmux, tmuxRuns, TMUX_RECORDED))
    const herdrs = ownHerdrsOnly(d)
    const home = d.env.HOME
    const claudeStore = claudeStoreRoots(process.platform, d.env, home ?? '')[0]?.root
    const places = { open: d.env.HARNESS_OPEN_BIN, home, applications: d.env.HARNESS_APPLICATIONS_DIR, 'Claude store': claudeStore,
      'Codex home': home && join(home, '.codex'), 'VS Code CLI': d.env.HARNESS_VSCODE_BIN, 'Cursor CLI': d.env.HARNESS_CURSOR_BIN,
      tmux: resolveBinaryOnPath('tmux', d.env) ?? undefined, ps: resolveBinaryOnPath('ps', d.env) ?? undefined }
    for (const [name, path] of Object.entries(places)) if (!inside(d.root, path)) throw new Error(`the daemon's ${name} is not inside its root`)
    const runs = join(dirname(places.open!), 'runs.log')
    writeRecordingOpen(places.open!, runs)
    const cursorRuns = join(dirname(places['Cursor CLI']!), 'runs.log')
    mkdirSync(d.projectsDir, { recursive: true })
    const projects = [...new Set([d.projectsDir, realpathSync(d.projectsDir)])]
    // The store's folders, as the app leaves them, so the devices watch them from the start.
    claudeAppFixture(claudeStore!).org()
    mkdirSync(places['Codex home']!, { recursive: true })
    if (process.platform === 'linux') {
      // Every app's links have their app, as on a desktop with all four installed.
      writeSchemeApps(d, { claude: 'com.anthropic.Claude.desktop', codex: 'chatgpt.desktop',
        vscode: RECORDED_LINUX_APPS.vscode.schemeDesktopFile, cursor: RECORDED_LINUX_APPS.cursor.schemeDesktopFile })
      // A tap on a Cursor folder row runs Cursor's CLI there; macOS opens the folder by Cursor's bundle, through the open.
      writeRecordingCli(places['Cursor CLI']!, cursorRuns)
      writeRaiseFakes(d.binDir)
      const outside = raiseToolsOutside(d.root, d.env)
      if (outside.length > 0) throw new Error(`the daemon's ${outside.join(', ')} is not inside its root`)
    }
    // The ChatGPT app installed before any dial comes, as the devices look for it at each attach: its bundle in the home's
    // Applications on macOS, its program in the root's stand-in for /usr/lib on Linux, and its own Codex CLI.
    const chatgpt = process.platform === 'linux'
      ? chatGptPlaces('linux', d.env.HARNESS_APPLICATIONS_DIR, home!)[0]!
      : join(home!, 'Applications', 'ChatGPT.app', 'Contents', 'Info.plist')
    if (!inside(d.root, chatgpt)) throw new Error("the daemon's ChatGPT app is not inside its root")
    mkdirSync(dirname(chatgpt), { recursive: true })
    writeFileSync(chatgpt, process.platform === 'linux' ? '' : CHATGPT_INFO_PLIST)
    writeAppCodex(d)
    // Orca's CLI the fake under both its names, with watch-focus as a current Orca, and the one the daemon would run
    // inside its root: every session here runs inside the real Orca.
    const orca = FakeOrca.install(d, { watchFocus: true })
    orcaCliInside(d.env, d.root, process.platform)
    // Orca's accounts: the home each Codex agent of its runs in, there before the devices start, as they read Orca's list
    // as they start and not again for 5 minutes (devices/orcaHomes.ts ORCA_HOMES_REFRESH_MS). Tier A lists the same.
    const { root } = d
    const homes = accounts.map((key) => orcaAccountHome(root, key))
    for (const home of homes) mkdirSync(home, { recursive: true })
    orca.accounts({ codex: homes })
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
    return { d, desk: new Desk(dials), backend, orca, watchFocus: true, accounts, runs, cursorRuns, projects, guard, given: 0, polled: new Map(),
      tmuxRuns, herdrRuns: herdrRuns(d), herdrs }
  } catch (error) {
    await d?.close().catch(() => {})
    await backend.close()
    throw error
  }
}

/**
 * Where in [messages] the push that left the dial's last whole list starts: its `apps` frame, when one went just before
 * its `agents.begin`. Undefined before a whole list.
 */
function lastPush(messages: readonly DialMessage[]): number | undefined {
  const end = messages.findLastIndex((m) => m.t === 'agents.end')
  const begin = messages.findLastIndex((m, i) => i < end && m.t === 'agents.begin')
  if (begin < 0) return undefined
  return messages[begin - 1]?.t === 'apps' ? begin - 1 : begin
}

/** One scenario's world: what the dial received and showed, from the point its start found the desk empty to its stop. */
export class World implements TierBWorld {
  readonly children: ChildProcess[] = []
  readonly steps: Seen['steps'] = []
  readonly gaps: string[] = []
  readonly tabs = new Map<string, string>()
  readonly muxPanes = new Map<string, SessionKey>()
  /** The firmware's, from its last power on. */
  carousel = new DialCarousel()
  cost: Seen['cost']
  /** The scenario's cost, ended at its stop after its children: measured on the devices process running now. */
  costEnd: (() => Promise<NonNullable<Seen['cost']>>) | undefined
  /** Time 0, ms since the epoch: set as the scenario starts. */
  origin = Date.now()
  front: App | 'other' = 'other'
  private readonly frames: Seen['frames'] = []
  private readonly faces: Seen['faces'] = []
  private readonly commands: Seen['commands'] = []
  private readonly deliveries: Delivery[] = []
  private readonly streams: NonNullable<Seen['streams']> = []
  private readonly logs: NonNullable<Seen['logs']> = []
  /** Each Orca pane a session owned, by its handle, from its open to its close. */
  private readonly panes: Array<{ key: SessionKey; handle: string; from: number; to: number }> = []
  /** When it began, ms since the epoch: the fake Orca's runs since are its own. */
  private readonly began = Date.now()
  private plugged: FakeDial | undefined
  /** How many of the plugged dial's messages, of the open's runs and of the Cursor CLI's were read; where in the daemon's
   *  log the next read starts. */
  private heard = 0
  private opened: number
  private ranCli: number
  private logged: number
  private page = ''
  private watch: ChildProcess | undefined
  private waiting: Array<() => void> = []
  private readonly openers: Array<(run: OpenRun) => void> = []
  /** Stopped: what a fake app says after it reaches no watch. */
  private closed = false
  /** The first failure a fake app had, not yet thrown. */
  private failure: { error: unknown } | undefined
  private readonly refreshing: ReturnType<typeof setInterval>

  constructor(private readonly rig: Rig, readonly scenario: Scenario, readonly platform: Platform) {
    this.opened = openRuns(rig.runs, platform).length
    this.ranCli = cliRuns(rig.cursorRuns).length
    this.logged = rig.d.log().lastIndexOf('\n') + 1
    // The firmware's refresh task, which applies a list a moment after it ends: each turn also reads what came.
    this.refreshing = setInterval(() => this.read(), CAROUSEL_REFRESH_MS)
  }

  get d(): IsolatedDaemon { return this.rig.d }
  get desk(): Desk { return this.rig.desk }
  get orca(): FakeOrca { return this.rig.orca }
  get backend(): FakeBackend { return this.rig.backend }
  get herdrs(): { kept(): number[]; dropped(): number[] } { return this.rig.herdrs }
  get dial(): FakeDial {
    if (!this.plugged) throw new Error(`${this.scenario.id}: no dial is plugged in`)
    return this.plugged
  }

  agentId(key: SessionKey): string { return agentIdOf(this.session(key)) }
  session(key: SessionKey): SessionDef {
    const found = this.scenario.sessions.find((s) => s.key === key)
    if (!found) throw new Error(`scenario ${this.scenario.id} names no session ${key}`)
    return found
  }
  deliver(d: Omit<Delivery, 'at'>, at = Date.now()): void { this.deliveries.push({ at, ...d }) }
  gap(reason: string): void { this.gaps.push(reason) }
  onOpen(listener: (run: OpenRun) => void): void { this.openers.push(listener) }
  modPolled(sessionId: string): void { this.rig.polled.set(sessionId, Date.now()) }
  fail(error: unknown): void { this.failure ??= { error } }
  get failing(): boolean { return this.failure !== undefined }
  /** Throws a fake app's failure, once. */
  raise(): void {
    const failure = this.failure
    this.failure = undefined
    if (failure) throw failure.error
  }
  title(text: string): void { this.tell({ thread: text }) }
  reportTab(label: string): void {
    const tty = this.tabs.get(label)
    if (tty === undefined) throw new Error(`${this.scenario.id}: no iTerm2 tab ${label} is open`)
    this.stream(TABS_STREAM, { type: 'tab', app: PAGE.iterm, tab: label })
    this.tell({ tab: { app: PAGE.iterm, tty } })
  }
  stream(window: string, line: Record<string, unknown>, at = Date.now()): void { this.streams.push({ at, window, line }) }
  orcaPane(key: SessionKey, handle: string | null): void {
    const now = Date.now()
    const open = this.panes.find((p) => p.key === key && p.to === Infinity)
    if (open) open.to = now
    if (handle !== null) this.panes.push({ key, handle, from: now, to: Infinity })
  }
  folder(path: string): string {
    if (!path.startsWith('/work/')) throw new Error(`${this.scenario.id}: ${path} is not a catalog folder`)
    const made = join(this.d.projectsDir, path.slice('/work/'.length))
    if (!inside(this.d.projectsDir, made)) throw new Error(`${this.scenario.id}: ${path} is outside the daemon's projects`)
    mkdirSync(made, { recursive: true })
    return made
  }

  async plug(): Promise<void> {
    this.plugged = await this.desk.plug(SERIAL, MAC, FILTER)
    this.heard = 0
  }
  /** The glass goes dark, and the dial that comes back powers on with no tile: its firmware keeps nothing. */
  async unplug(): Promise<void> {
    this.read()
    this.plugged = undefined
    this.page = ''
    this.carousel = new DialCarousel()
    this.face(Date.now())
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

  /**
   * One line on the stdin of the watch Harness Device runs, started under the daemon's environment on its first line. A
   * watch that ends before the scenario fails it, with the end of what it said on its stderr. Each select it prints is
   * recorded on the tabs stream at its arrival, its tab named by its label.
   */
  tell(line: { front: string } | { thread: string } | { tab: { app: string; tty: string } }): void {
    if (this.closed) return
    if (!this.watch) {
      const watch = this.watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
        cwd: this.d.root, env: { ...this.d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.children.push(watch)
      const labelOf = (tty: string): string | undefined => [...this.tabs].find(([, open]) => open === tty)?.[0]
      createInterface({ input: watch.stdout! }).on('line', (printed) => {
        const select = selectOf(printed)
        if (select && !this.closed) this.stream(TABS_STREAM, selectRecord(select, labelOf))
      })
      let said = ''
      watch.stderr!.on('data', (chunk: Buffer) => { said = (said + chunk.toString('utf8')).slice(-STDERR_KEPT) })
      watch.once('exit', (code, signal) => {
        if (!this.closed) this.fail(new Error(`harness hardware watch ended before its scenario (${signal ?? code}): ${said.trim()}`))
      })
      // A line written as it ends fails with EPIPE: its end is the failure already.
      watch.stdin!.on('error', () => {})
    }
    if (this.watch.exitCode === null && this.watch.signalCode === null) this.watch.stdin!.write(`${JSON.stringify(line)}\n`)
  }

  /** Resolves at the next read: what the dial received since is in `seen`. */
  nextRead(): Promise<void> {
    return new Promise((done) => this.waiting.push(done))
  }

  /** What came since the last read: the dial's frames at their arrival, then the refresh, then the open's and the Cursor
   *  CLI's runs, then the devices' log lines. */
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
    const runs = openRuns(this.rig.runs, this.platform)
    for (; this.opened < runs.length; this.opened++) {
      const run = this.atWork(runs[this.opened]!)
      this.commands.push({ at: Date.now(), ...run })
      for (const listener of this.openers) listener(run)
    }
    const ran = cliRuns(this.rig.cursorRuns)
    for (; this.ranCli < ran.length; this.ranCli++) this.commands.push({ at: Date.now(), ...this.atWork(ran[this.ranCli]!) })
    const { lines, next } = deviceLines(this.d.log(), this.logged)
    this.logged = next
    const at = Date.now()
    for (const line of lines) this.logs.push({ at, line })
    for (const done of this.waiting.splice(0)) done()
  }

  /**
   * What the dial was sent before the first [cut] of its messages, where the start found the desk empty, forgotten but
   * the push that emptied its list, and every face but the one it shows now: the catalog's ids are shared, so an earlier
   * scenario's list on a dial that still held it would pass or fail this one's checks. The world's first dial, so its
   * frames are its messages, one for one.
   */
  forgetBefore(cut: number): void {
    this.read()
    this.frames.splice(0, lastPush(this.dial.messages.slice(0, cut)) ?? cut)
    this.faces.length = 0
    this.face(Date.now())
  }

  seen(): Seen {
    const from0 = <T extends { at: number }>(rows: readonly T[]): T[] => rows.map((row) => ({ ...row, at: row.at - this.origin }))
    return { frames: from0(this.frames), faces: from0(this.faces), commands: from0(this.commands),
      deliveries: from0(this.deliveries), steps: from0(this.steps), streams: from0(this.streams), logs: from0(this.logs),
      ...(this.cost ? { cost: this.cost } : {}) }
  }

  /** The last read, and every child ended: one that fails to end is thrown once the others are. */
  async close(): Promise<void> {
    clearInterval(this.refreshing)
    this.read()
    this.closed = true
    let failed: { error: unknown } | undefined
    for (const child of this.children) {
      try { await end(child) } catch (error) { failed ??= { error } }
    }
    if (failed) throw failed.error
  }

  /**
   * The fake Orca's runs since this world began, as commands in time order with the others, and its sends as deliveries.
   * Read once, as the world stops: each run carries its own time, and a read of a daemon's every run at each of the
   * world's reads would cost this worker a share of its CPU for nothing.
   */
  takeOrca(): void {
    const runs = this.rig.orca.log().filter((run) => run.at >= this.began)
    this.commands.push(...orcaCommands(runs, this.rig.projects))
    this.commands.sort((a, b) => a.at - b.at)
    this.deliveries.push(...orcaDeliveries(runs, (handle, at) =>
      this.panes.find((p) => p.handle === handle && p.from <= at && at < p.to)?.key))
  }

  /** An iTerm2 scenario's alone: the devices' tmux and herdr runs since this world began, read once as it stops, as the
   *  fake Orca's are: commands in time order with the others, each pane named by the session it holds. The core runs
   *  tmux too, and tier A answers the devices' tmux and herdr for iTerm2 alone: no other app's commands take them. */
  takeMux(): void {
    if (this.scenario.app !== 'iterm') return
    const runs = [...runLog(this.rig.tmuxRuns), ...runLog(this.rig.herdrRuns)].filter((run) => run.at >= this.began)
    this.commands.push(...muxCommands(runs, (pane) => this.muxPanes.get(pane)))
    this.commands.sort((a, b) => a.at - b.at)
  }

  /**
   * The devices process killed outright, as a crash, and started again by the master on the same root, sessions and dial:
   * done once the dial is welcomed again and the new process runs with the network guard in it. The scenario's cost is
   * measured from that start: the measure of the one killed went with it, and one that never came back has none.
   */
  async restartDevices(): Promise<void> {
    const before = devicesPids(this.d)
    const back = this.dial.messages.length
    this.costEnd = undefined
    for (const pid of before) process.kill(pid, 'SIGKILL')
    await this.dial.welcomeAfter(back, RESTART_WITHIN_MS)
    const started = await until('the devices started again', () => {
      const pids = devicesPids(this.d)
      return pids.length > 0 && !pids.some((pid) => before.includes(pid)) ? pids : null
    }, RESTART_WITHIN_MS, 100)
    guardLoaded(this.rig.guard, 'devices', started)
    this.costEnd = (await beginCost(this.d)).end
  }

  private atWork(run: OpenRun): OpenRun { return { ...run, argv: workPaths(run.argv, this.rig.projects) } }

  /** The face, recorded when it changed (faceChange). */
  private face(at: number): void {
    const { tiles, active, refused } = this.carousel
    const shown = { page: this.page, tiles: [...tiles], active: tiles[active] ?? null, refused }
    if (faceChange(this.faces.at(-1), shown)) this.faces.push({ at, ...shown })
  }
}

type Face = Seen['faces'][number]
/** Whether the face shown differs from the last one recorded: its page, tiles, the tile on it, or a refusal alone, so a
 *  face check sees each refusal. */
export function faceChange(last: Face | undefined, next: Omit<Face, 'at'>): boolean {
  return !last || last.page !== next.page || last.active !== next.active || last.refused !== next.refused
    || last.tiles.join('\n') !== next.tiles.join('\n')
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
    world.front = step.app
    world.tell({ front: frontName(world.platform, step.app) })
  },
  thread: async (world, step) => { world.title(step.title) },
  tap: async (world, step) => { world.dial.send({ t: 'agent.open', agentId: world.agentId(step.session) }) },
  // The rest that opens the session after a swipe is the cable's own timer: the step only turns the dial.
  swipe: async (world, step) => { world.swipe(world.agentId(step.session)) },
  // Three lines toward older ones, as dialVscode.e2e.ts strokes: each move's 8 is one line (scrollLines.ts).
  stroke: async (world) => {
    world.dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
    for (let move = 0; move < 3; move++) world.dial.send({ t: 'scroll', phase: 'move', dy: 8, v: 0 })
    world.dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
  },
  unplug: (world) => world.unplug(),
  replug: (world) => world.plug(),
  'devices.restart': (world) => world.restartDevices(),
}

export class TierBDriver implements EvalDriver {
  readonly tier = 'b' as const
  private readonly guard = guardThisProcess()
  /** This driver's own folder, outside every daemon's root: each daemon's guard file. */
  private readonly own = mkdtempSync(join(tmpdir(), 'dial-eval-b-'))
  private daemons = 0
  private rig: Rig | undefined
  private world: World | undefined
  /** The world started to its time 0: one that is not had its daemon left in no known state. */
  private ready = false
  /** Attempts read from a daemon's guard file, not yet handed on. */
  private readonly reached: NetAttempt[] = []
  /** The index in the scenario of the next step after the last one run. */
  private next = 0

  /** Each scenario runs on its own app's steps. */
  constructor(private readonly appSteps: Partial<Record<App, AppSteps>>) {}

  async start(scenario: Scenario, platform: Platform): Promise<void> {
    // Nothing of the last scenario is this one's, even when this one goes no further than its checks here, which leave the
    // daemon as the last stop left it.
    this.world = undefined
    if (platform !== process.platform) throw new Error(`tier B runs on its host's platform, not ${platform}`)
    const gaps = tierBGaps(scenario, platform)
    this.ready = false
    this.next = 0
    // The scenario's ids are the catalog's, shared with those before it: a voice to a session whose poll the devices still
    // count could reach it by an earlier scenario's poll, so such a scenario has a daemon of its own.
    const polled = this.rig?.polled
    const counted = polled !== undefined && scenario.steps.some((s) => s.kind === 'voice')
      && scenario.sessions.some((s) => Date.now() - (polled.get(s.id) ?? -Infinity) < MOD_READY_MS)
    // The devices read Orca's accounts once as they start: a Codex in an account the running Orca does not list has a
    // daemon of its own, whose Orca lists it.
    const accounts = orcaAccounts(scenario)
    const unlisted = this.rig !== undefined && accounts.some((key) => !this.rig!.accounts.includes(key))
    if (this.rig && (scenario.fresh || counted || unlisted)) await this.closeRig()
    if (this.rig) await this.reset(this.rig)
    const rig = this.rig ??= await openRig(join(this.own, `net-guard-${++this.daemons}.jsonl`), accounts)
    // Rewritten only when it changes: each rewrite moves the launcher's mtime, and the devices ask `terminal --help` again.
    const watchFocus = scenario.world?.orca?.watchFocus !== false
    if (rig.watchFocus !== watchFocus) {
      rig.orca.watchFocus(watchFocus)
      rig.watchFocus = watchFocus
    }
    const world = this.world = new World(rig, scenario, platform)
    for (const reason of gaps) world.gap(reason)
    linksFail(rig.d.env.HARNESS_OPEN_BIN!, scenario.world?.linkFails ?? [])
    const front = scenario.world?.front ?? scenario.app
    await GENERIC.front(world, { kind: 'front', app: front })
    await world.plug()
    // Every page empty before the scenario goes on: nothing of the scenarios before it is listed, nor seen.
    const cut = await until(`${scenario.id}: the dial welcomed, and no app's page with a row`,
      () => deskEmpty(world.dial.messages) && world.dial.messages.length, START_WITHIN_MS, 50)
    world.forgetBefore(cut)
    // The person picks the app's page. While no session of it is listed the devices keep the ring they show, and the
    // app in front decides it once one is.
    world.pick(PAGE[front === 'other' ? scenario.app : front])
    // The processes running now, by pid: a line of one the master has since started again proves nothing of this one.
    const core = rig.d.corePid()
    const running = { core: core === null ? [] : [core], devices: devicesPids(rig.d) }
    for (const [name, pids] of Object.entries(running)) guardLoaded(rig.guard, name, pids)
    const cost = await beginCost(rig.d)
    world.origin = Date.now()
    world.costEnd = cost.end
    this.ready = true
  }

  async step(step: Run): Promise<void> {
    const world = this.need()
    world.raise()
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
      world.raise()
      return
    }
    const deadline = Date.now() + ms
    while (!until() && Date.now() < deadline && !world.failing) await world.nextRead()
    world.raise()
  }

  /** What the scenario saw; nothing for one refused before its world began, which the runner still reads. */
  seen(): Seen { return this.world?.seen() ?? NOTHING_SEEN }
  /** The last scenario's world, kept after its stop: for a test that reads what its daemon did. */
  lastWorld(): TierBWorld { return this.need() }
  gaps(): string[] { return [...this.world?.gaps ?? []] }

  async stop(): Promise<void> {
    const world = this.world
    const costEnd = world?.costEnd
    if (world) world.costEnd = undefined
    try {
      try {
        await world?.close()
      } finally {
        // Ended whatever the close did: a measurement left running fails the next scenario's start.
        if (world && costEnd) world.cost = await costEnd()
      }
    } finally {
      // Whatever the close did: the gate sees each send.
      world?.takeOrca()
      world?.takeMux()
      if (this.rig) this.collect(this.rig)
      if (!this.ready && this.rig) await this.closeRig()
    }
    world?.raise()
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

  /** One per e2e file, in its afterAll: it throws naming each attempt off this machine not handed on before. */
  async close(): Promise<void> {
    let failed: unknown
    try {
      if (this.rig) await this.closeRig()
    } catch (error) {
      failed = error
    }
    this.guard.uninstall()
    const reached = this.networkReached()
    rmSync(this.own, { recursive: true, force: true })
    if (reached.length > 0) throw new Error(`tier B reached beyond this machine: ${reached.join('; ')}`)
    if (failed) throw failed
  }

  /** The last scenario's fixtures gone (its children ended at its stop), and its dial unplugged. */
  private async reset(rig: Rig): Promise<void> {
    const home = rig.d.env.HOME!
    emptied(claudeStoreRoots(process.platform, rig.d.env, home)[0]!.root)
    emptied(join(home, '.codex'))
    // Every session's transcript and rollout too: the ids are the catalog's, so a later scenario's session goes on in the
    // same file, and a recap could pass on an earlier scenario's answer.
    emptied(rig.d.env.CLAUDE_PROJECTS_DIR!)
    emptied(join(rig.d.env.CODEX_HOME!, 'sessions'))
    for (const key of rig.accounts) emptied(join(orcaAccountHome(rig.d.root, key), 'sessions'))
    emptied(join(home, '.cursor', 'projects'))
    // Orca lays nothing out until a scenario's layout, its watches end with the last scenario, and a new one tells no
    // focus of it: a watch prints the last line told first.
    rig.orca.listing(orcaListing([], {}))
    rig.orca.endWatch()
    rig.orca.focus(null)
    rig.backend.speech = null
    await rig.desk.unplug(SERIAL)
  }

  private collect(rig: Rig): void {
    const { attempts } = readNetGuard(rig.guard)
    this.reached.push(...attempts.slice(rig.given))
    rig.given = attempts.length
  }

  /** Its guard file read once the daemon is gone, so what it tried as it closed is handed on too. */
  private async closeRig(): Promise<void> {
    const rig = this.rig!
    this.rig = undefined
    try {
      await rig.desk.close()
      await rig.d.close()
    } finally {
      this.collect(rig)
      rmSync(rig.guard, { force: true })
      await rig.backend.close()
    }
  }

  private need(): World {
    if (!this.world) throw new Error('tier B: no scenario started')
    return this.world
  }
}
