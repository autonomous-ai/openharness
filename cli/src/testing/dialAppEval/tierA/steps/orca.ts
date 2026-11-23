/**
 * Tier A's model of Orca (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier A"; the plan's Decisions 3, 6 and 7):
 * the world answers the devices' own reads and actions of Orca's CLI (cable/hosts/orca.ts) from the scenario's layout, so
 * the real parsing, ordering and switching are graded. `terminal list` prints the latest `orca.layout`'s worktrees with
 * the panes open now (sessions.ts orcaHandleOf), as both tiers print it (orcaListing.ts). A focus watch is a child that
 * prints the last focus line Orca told, then each one after it: an `orca.focus` step's, and the echo of each switch.
 *
 * The plugin (the plan's Decision 9) opens the devices' own `dial` stream handler, as the listener hands it, and tells
 * the worktree on screen on their `orcaFront` handler; calling the handlers directly skips the listener's own limits,
 * which have their own specs. It tells that worktree again each time one of its panes opens or closes, as Orca's
 * `workspace.changed` fires for them (panesChanged). Its stream takes every line and records none: the lines hold names.
 * Orca's quit ends each watch and the stream; its relaunch opens the stream again where it was open.
 */
import type { OrcaChild } from '../../../../cable/hosts/orca.js'
import type { OrcaHomes } from '../../../../devices/orcaHomes.js'
import { REFUSED, type ListenerStream, type ListenerStreamHandler, type StreamEnd } from '../../../../services/devicesListener.js'
import { flagOf, ORCA_PROGRAMS, programOf } from '../../argv.js'
import { orcaLayout, orcaListing } from '../../orcaListing.js'
import { engineOf, ORCA_ECHO_MS, type StepOf } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { codexHomeOf, dropSession, orcaHandleOf } from './sessions.js'
import { handlerOf, tell } from './window.js'

/** `orca terminal --help`'s Commands list, the part the devices read (cable/hosts/orca.ts listsWatchFocus). */
const help = (watches: boolean): string => ['Commands:', '  list', '  switch', '  send', ...(watches ? ['  watch-focus'] : []), ''].join('\n')

/** Orca's accounts' homes (devices/orcaHomes.ts): the one each Codex agent in its panes runs in, an account's own. No
 *  Claude Code agent runs in one. */
export function orcaAccountHomes(world: TierAWorld): OrcaHomes {
  const own = world.scenario.sessions.filter((s) => s.app === 'orca' && engineOf(s) === 'codex' && s.codexHome === 'own')
  return { claude: [], codex: own.map((s) => codexHomeOf(world, s.key)) }
}

/** What `account list --json` prints for those homes, in Orca 1.4.256's shape: an account for each, with a made-up id. */
function accountList(world: TierAWorld): object {
  const engine = (homes: string[], name: string) => {
    const accounts = homes.map((home, i) => ({ id: `eval-${name}-${i + 1}`, home }))
    return { activeAccountId: accounts[0]?.id ?? null, accounts }
  }
  const { claude, codex } = orcaAccountHomes(world)
  return { id: 'eval', ok: true, result: { claude: engine(claude, 'claude'), codex: engine(codex, 'codex') } }
}

interface Watch { print(line: string): void; end(): void }
interface Model {
  /** The latest layout step: what `terminal list` lays out from now on. */
  layout?: StepOf<'orca.layout'>
  watches: Set<Watch>
  /** The last focus line Orca told, with a watch running or not: a new watch prints it first. */
  last?: string
  /** The plugin's open stream's end, while it is open. */
  plugin?: AbortController
  /** The worktree the plugin told on its open stream, and the terminals it told of it last. */
  front?: { worktree: string; told: string }
  /** Whether the plugin's stream was open as Orca quit, for its relaunch. */
  reopen?: boolean
  /** The echoes of switches still to be told: Orca's quit drops them with their panes. */
  echoes: Set<ReturnType<typeof setTimeout>>
}
const models = new WeakMap<TierAWorld, Model>()

function modelOf(world: TierAWorld): Model {
  let model = models.get(world)
  if (!model) models.set(world, model = { watches: new Set(), echoes: new Set() })
  return model
}

/** Orca tells the pane in focus: on every running watch, and kept for the next. */
function tellFocus(world: TierAWorld, handle: string): void {
  const model = modelOf(world)
  const line = `${JSON.stringify({ handle })}\n`
  model.last = line
  for (const watch of model.watches) watch.print(line)
}

/** The world's rules for Orca's commands: each is answered as Orca 1.4.256 does, from the scenario's model of it. A
 *  switch Orca made is echoed on each running watch ORCA_ECHO_MS later, as Orca tells the focus it moved. */
export function answerOrca(world: TierAWorld): void {
  world.answer((argv) => {
    if (!ORCA_PROGRAMS.includes(programOf(argv))) return undefined
    const watches = world.scenario.world?.orca?.watchFocus !== false
    switch (`${argv[1]} ${argv[2]}`) {
      case 'terminal --help': return { code: 0, stdout: help(watches) }
      // An Orca with no watch-focus exits 1 on it, as on any command it does not know.
      case 'terminal watch-focus': return { code: watches ? 0 : 1 }
      case 'terminal list': {
        const { layout } = modelOf(world)
        const worktrees = orcaLayout(world.scenario, layout, (key) => orcaHandleOf(world, key))
        return { code: 0, stdout: JSON.stringify(orcaListing(worktrees, layout?.renamed ?? {})) }
      }
      case 'terminal switch': {
        const handle = flagOf(argv, '--terminal')
        if (handle !== undefined) {
          const { echoes } = modelOf(world)
          const echo = setTimeout(() => {
            echoes.delete(echo)
            tellFocus(world, handle)
          }, ORCA_ECHO_MS)
          echoes.add(echo)
        }
        return { code: 0 }
      }
      case 'worktree activate':
      case 'terminal send':
        return { code: 0 }
      case 'account list': return { code: 0, stdout: JSON.stringify(accountList(world)) }
      default: return undefined
    }
  })
}

/**
 * `orca terminal watch-focus --json`, the one child the devices start of Orca's CLI (cable/hosts/orca.ts watchOrcaFocus):
 * it prints the last focus line Orca told, then each one after, until it is killed. Its stdout comes on a later turn, as
 * a real child's does.
 */
export function watchChild(world: TierAWorld): OrcaChild {
  const model = modelOf(world)
  const listeners: Array<(chunk: Buffer) => void> = []
  let exit!: () => void
  const exited = new Promise<void>((resolve) => { exit = resolve })
  const watch: Watch = {
    print: (line) => queueMicrotask(() => {
      if (!model.watches.has(watch)) return
      for (const listener of listeners) listener(Buffer.from(line))
    }),
    end: () => {
      if (!model.watches.delete(watch)) return
      exit()
    },
  }
  model.watches.add(watch)
  if (model.last !== undefined) watch.print(model.last)
  return { onData: (listener) => { listeners.push(listener) }, exited, kill: watch.end }
}

/** The plugin opens its stream as it does on Orca's start: a standby one, which never takes the stream from another
 *  Orca. The listener tells a stream it can take a line once it has opened. */
function openPlugin(world: TierAWorld): void {
  const model = modelOf(world)
  if (model.plugin) throw new Error(`scenario ${world.scenario.id}: the plugin's stream is already open`)
  const ended = new AbortController()
  let writable: (() => void) | undefined
  const stream: ListenerStream = { write: () => !ended.signal.aborted, onWritable: (run) => { writable = run }, ended: ended.signal }
  if (handlerOf<ListenerStreamHandler>(world, 'dial').open({ type: 'dial', standby: true }, stream) === REFUSED) {
    throw new Error("the devices' listener refused the plugin's dial stream")
  }
  model.plugin = ended
  writable?.()
}

/** The plugin's stream ends `gone`: its client went. */
function endPlugin(world: TierAWorld): void {
  const model = modelOf(world)
  if (!model.plugin) throw new Error(`scenario ${world.scenario.id}: the plugin's stream is not open`)
  const reason: StreamEnd = 'gone'
  model.plugin.abort(reason)
  model.plugin = undefined
  // The devices drop the worktree with the stream, and the plugin's next one knows none until Orca tells it again.
  model.front = undefined
}

/** The handles of a worktree's open panes, in Orca's order; none when Orca does not lay it out. */
function terminalsOf(world: TierAWorld, worktree: string): string[] | undefined {
  const shown = orcaLayout(world.scenario, modelOf(world).layout, (key) => orcaHandleOf(world, key)).find((w) => w.key === worktree)
  return shown?.panes.map((pane) => pane.handle)
}

/** The plugin tells the devices the worktree on Orca's screen: its open panes' handles. */
async function tellFront(world: TierAWorld, worktree: string, terminals: string[]): Promise<void> {
  await tell(world, { type: 'orcaFront', terminals })
  modelOf(world).front = { worktree, told: JSON.stringify(terminals) }
}

/**
 * A pane of Orca's opened, closed or was renamed: Orca's `workspace.changed`, on which the plugin tells the worktree on
 * screen again (docs/plans/2026-11-18-dial-orca-tab-scope-design.md), so a front told before its agents started lists
 * them once they do. Terminals it told already it does not send again (plugins/harness-device-orca/src/dial.ts push), as
 * after a rename. Nothing while its stream is closed or no worktree was told on it. A layout without that worktree took
 * its panes with it: the plugin sends what Orca gives it, no terminals.
 */
export async function panesChanged(world: TierAWorld): Promise<void> {
  const front = models.get(world)?.front
  if (!front) return
  const terminals = terminalsOf(world, front.worktree) ?? []
  if (JSON.stringify(terminals) !== front.told) await tellFront(world, front.worktree, terminals)
}

/** Orca quit: each watch ends with it, and so does the plugin's stream, kept for its relaunch. The pane in focus went
 *  with it, and those of the echoes still to come: a watch after the relaunch prints nothing until Orca tells a focus
 *  again. */
export function closeOrca(world: TierAWorld): void {
  const model = modelOf(world)
  for (const watch of [...model.watches]) watch.end()
  for (const echo of model.echoes) clearTimeout(echo)
  model.echoes.clear()
  model.last = undefined
  model.reopen = model.plugin !== undefined
  if (model.reopen) endPlugin(world)
}

/** Orca relaunched: the plugin opens its stream again where it was open. */
export function reopenOrca(world: TierAWorld): void {
  const model = modelOf(world)
  if (model.reopen) openPlugin(world)
  model.reopen = false
}

export const orcaModelSteps: { [K in 'orca.layout' | 'orca.focus' | 'orca.front' | 'orca.plugin' | 'orca.close']: StepHandler<K> } = {
  'orca.layout': async (world, step) => {
    modelOf(world).layout = step
    await panesChanged(world)
  },
  // A watch-focus line for the session's pane: the person focused it in Orca.
  'orca.focus': async (world, step) => {
    const handle = orcaHandleOf(world, step.session)
    if (handle === undefined) throw new Error(`scenario ${world.scenario.id}: orca.focus names ${step.session}, whose pane is not open`)
    tellFocus(world, handle)
  },
  // The plugin tells the worktree on Orca's screen, which must be one Orca lays out.
  'orca.front': async (world, step) => {
    const terminals = terminalsOf(world, step.worktree)
    if (!terminals) throw new Error(`scenario ${world.scenario.id}: orca.front names ${step.worktree}, which Orca has not laid out`)
    await tellFront(world, step.worktree, terminals)
  },
  // With no plugin in Orca no stream ever opens, as with no extension in an editor.
  'orca.plugin': async (world, step) => {
    if (world.scenario.world?.orca?.plugin === false) return
    if (step.open) openPlugin(world)
    else endPlugin(world)
  },
  'orca.close': async (world, step) => dropSession(world, step.session),
}
