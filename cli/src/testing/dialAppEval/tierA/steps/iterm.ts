/**
 * Tier A's iTerm2 (docs/plans/2026-11-22-dial-eval-iterm2-design.md, "Tier A"; the plan's Decisions 3, 4 and 9): iTerm2's
 * process and its server, under which each tab and split runs a login and a shell on a tty of its own. iTerm2 starts
 * with its first tab, its server as its child, which passes to launchd as iTerm2 relaunches keeping its sessions. No
 * process of either carries an app id: the devices' walk of a tab's parents is the real one (dialAppEval.spec.ts
 * learnApps), so iTerm2's server rule is what is graded. The world keeps a tty bare (`ttys004`), as `ps` prints it; the
 * devices, the watch and Harness Device name a tab by `/dev/ttys004`.
 *
 * The watch opens the devices' own `tabs` stream handler, as the listener hands it, with a stream of this file's, and
 * reports the tab the person selected on their `tab` handler. Calling the handlers directly skips the listener's own
 * limits, which have their own specs. Each select and tab report is recorded in the world's streams under TABS_STREAM
 * with its tab named by label (itermRecords.ts), so no tty reaches a result.
 */
import { APP_BUNDLES } from '../../../../cable/hosts/hostDetect.js'
import { tabOf } from '../../../../cable/hosts/tabs.js'
import { REFUSED, type ListenerStream, type ListenerStreamHandler } from '../../../../services/devicesListener.js'
import { selectRecord, TABS_STREAM, tabLabel, type TabRef } from '../../itermRecords.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { dropSession, keyOfShell, nextTty, startProcess } from './sessions.js'
import { handlerOf, tell } from './window.js'

const BUNDLE = '/Applications/iTerm.app'
const PROGRAM = `${BUNDLE}/Contents/MacOS/iTerm2`
/** Where iTerm2 3.6.6 copies its server in the home (scannedApp.ts isItermServer). */
const SERVER = 'Library/Application Support/iTerm2/iTermServer-3.6.6'
const LOGIN = '/usr/bin/login'
const SHELL = '/bin/zsh'

/** A tab or split: where it is, its login and shell, and the tty they run on, bare. */
interface Tab { ref: TabRef; login: number; shell: number; tty: string }
interface Model {
  /** iTerm2's process: gone once it relaunched. */
  app: number
  server: number
  /** The open tabs and splits, by label. */
  tabs: Map<string, Tab>
  /** The tab the last iterm.select reported. */
  selected?: TabRef
}
const models = new WeakMap<TierAWorld, Model>()

/** iTerm2, started with its server the first time a step needs it, on an iTerm2 scenario's macOS machine alone. */
function modelOf(world: TierAWorld): Model {
  let model = models.get(world)
  if (model) return model
  const home = world.machine.itermHome
  if (world.platform !== 'darwin' || home === undefined) {
    throw new Error(`scenario ${world.scenario.id}: iTerm2 runs on an iTerm2 scenario's macOS machine alone`)
  }
  world.machine.bundleIds.set(BUNDLE, APP_BUNDLES.iterm)
  const app = startProcess(world, 1, PROGRAM)
  models.set(world, model = { app, server: startProcess(world, app, `${home}/${SERVER}`), tabs: new Map() })
  return model
}

/** A tab's or split's shell, opened (its login, its shell, its tty) when none is: the empty shell a session starts in. */
export function tabShell(world: TierAWorld, ref: TabRef): { pid: number; tty: string } {
  const { server, tabs } = modelOf(world)
  const label = tabLabel(ref)
  let tab = tabs.get(label)
  if (!tab) {
    // macOS names every terminal it makes (modelOf).
    const tty = nextTty(world)!
    const login = startProcess(world, server, LOGIN, tty)
    tab = { ref, login, shell: startProcess(world, login, SHELL, tty), tty }
    tabs.set(label, tab)
  }
  return { pid: tab.shell, tty: tab.tty }
}

/** The label of the open tab or split on that tty, as the devices name it (`/dev/ttys004`). */
export function labelOf(world: TierAWorld, tty: string): string | undefined {
  for (const [label, tab] of models.get(world)?.tabs ?? []) if (`/dev/${tab.tty}` === tty) return label
  return undefined
}

/** The tab the last iterm.select reported. */
export function selectedTab(world: TierAWorld): TabRef | undefined {
  return models.get(world)?.selected
}

/**
 * The watch's tabs stream, opened on the devices' own handler: each select they write is recorded by its tab's label. A
 * line that is no select (a typing's write or enter) is taken and not recorded: tier A has no terminal to type into.
 */
export function openTabs(world: TierAWorld): void {
  const opened = { type: 'tabs' }
  world.streams.push({ at: Date.now(), window: TABS_STREAM, line: opened })
  const stream: ListenerStream = {
    write: (line) => {
      if (tabOf(line) === null) return true
      const select = selectRecord(line as { app: string; tty: string; raise?: boolean }, (tty) => labelOf(world, tty))
      world.streams.push({ at: Date.now(), window: TABS_STREAM, line: select })
      return true
    },
    // Every line is taken as it is written: none waits to drain, so the devices need never be told they can write.
    onWritable: () => {},
    // The watch holds it open for the whole scenario.
    ended: new AbortController().signal,
  }
  if (handlerOf<ListenerStreamHandler>(world, 'tabs').open(opened, stream) === REFUSED) {
    throw new Error("the devices' listener refused the watch's tabs stream")
  }
}

export const itermSteps: { [K in 'iterm.tab' | 'iterm.split' | 'iterm.closeTab' | 'iterm.select' | 'iterm.relaunch']: StepHandler<K> } = {
  'iterm.tab': async (world, { window, tab }) => {
    tabShell(world, { window, tab })
  },
  'iterm.split': async (world, { window, tab, split }) => {
    tabShell(world, { window, tab, split })
  },
  'iterm.closeTab': async (world, { window, tab }) => {
    const { tabs } = modelOf(world)
    const closing = [...tabs].filter(([, open]) => open.ref.window === window && open.ref.tab === tab)
    if (!closing.length) throw new Error(`scenario ${world.scenario.id}: no tab ${window}.${tab} is open`)
    for (const [label, open] of closing) {
      // Its session ends with no hook, as a process killed with its terminal runs none.
      const key = keyOfShell(world, open.shell)
      if (key !== undefined) await dropSession(world, key)
      // Then all else on its tty: an empty tab's login and shell, an agent that ended its session but had not exited.
      for (const p of [...world.machine.processes.values()]) if (p.tty === open.tty) world.machine.end(p.pid)
      tabs.delete(label)
    }
  },
  'iterm.select': async (world, { window, tab, split }) => {
    const model = modelOf(world)
    const ref = { window, tab, split: split ?? 0 }
    const label = tabLabel(ref)
    const open = model.tabs.get(label)
    if (!open) throw new Error(`scenario ${world.scenario.id}: no tab ${label} is open`)
    world.streams.push({ at: Date.now(), window: TABS_STREAM, line: { type: 'tab', app: 'iterm', tab: label } })
    await tell(world, { type: 'tab', app: 'iterm', tty: `/dev/${open.tty}` })
    model.selected = ref
  },
  'iterm.relaunch': async (world) => {
    const model = modelOf(world)
    world.machine.end(model.app)
    // Its server outlives it, for the sessions it keeps, under launchd now.
    world.machine.start({ ...world.machine.processes.get(model.server)!, ppid: 1 })
  },
}
