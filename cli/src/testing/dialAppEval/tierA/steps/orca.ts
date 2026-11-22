/**
 * Tier A's model of Orca (docs/plans/2026-11-22-dial-eval-orca-design.md, "Tier A"; the plan's Decisions 3, 6 and 7):
 * the world answers the devices' own reads and actions of Orca's CLI (cable/hosts/orca.ts) from the scenario's layout, so
 * the real parsing, ordering and switching are graded. `terminal list` prints the latest `orca.layout`'s worktrees with
 * the panes open now (sessions.ts orcaHandleOf), as both tiers print it (orcaListing.ts). A focus watch is a child that
 * prints the last focus line Orca told, then each one after it: an `orca.focus` step's, and the echo of each switch.
 */
import type { OrcaChild } from '../../../../cable/hosts/orca.js'
import { orcaLayout, orcaListing } from '../../orcaListing.js'
import type { StepKind, StepOf } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { orcaHandleOf } from './sessions.js'

/** Orca's CLI by the name each platform's runs it as (devices/orcaHomes.ts orcaBinary): its launcher on macOS, the
 *  .deb's and the AppImage's `orca-ide` on Linux, `orca.exe` on Windows. */
export const ORCA_PROGRAMS: readonly string[] = ['orca', 'orca-ide', 'orca.exe']
/** How long Orca takes to tell the focus of a pane a switch showed (the plan's Decision 7). */
const ECHO_MS = 100
/** `orca terminal --help`'s Commands list, the part the devices read (cable/hosts/orca.ts listsWatchFocus). */
const help = (watches: boolean): string => ['Commands:', '  list', '  switch', '  send', ...(watches ? ['  watch-focus'] : []), ''].join('\n')
/** What `account list --json` prints with no account in Orca, in Orca 1.4.256's shape. */
const NO_ACCOUNTS = { id: 'eval', ok: true, result: { claude: { activeAccountId: null, accounts: [] }, codex: { activeAccountId: null, accounts: [] } } }

interface Watch { print(line: string): void }
interface Model {
  /** The latest layout step: what `terminal list` lays out from now on. */
  layout?: StepOf<'orca.layout'>
  watches: Set<Watch>
  /** The last focus line Orca told, with a watch running or not: a new watch prints it first. */
  last?: string
}
const models = new WeakMap<TierAWorld, Model>()

function modelOf(world: TierAWorld): Model {
  let model = models.get(world)
  if (!model) models.set(world, model = { watches: new Set() })
  return model
}

/** Orca tells the pane in focus: on every running watch, and kept for the next. */
function tell(world: TierAWorld, handle: string): void {
  const model = modelOf(world)
  const line = `${JSON.stringify({ handle })}\n`
  model.last = line
  for (const watch of model.watches) watch.print(line)
}

const programOf = (argv: readonly string[]): string => (argv[0] ?? '').split(/[\\/]/).at(-1)!
const after = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at < 0 ? undefined : argv[at + 1]
}

/** The world's rules for Orca's commands: each is answered as Orca 1.4.256 does, from the scenario's model of it. A
 *  switch Orca made is echoed on each running watch a moment later, as Orca tells the focus it moved. */
export function answerOrca(world: TierAWorld): void {
  world.answer((argv) => {
    if (!ORCA_PROGRAMS.includes(programOf(argv))) return undefined
    switch (`${argv[1]} ${argv[2]}`) {
      case 'terminal --help': return { code: 0, stdout: help(world.scenario.world?.orca?.watchFocus !== false) }
      case 'terminal list': {
        const { layout } = modelOf(world)
        const worktrees = orcaLayout(world.scenario, layout, (key) => orcaHandleOf(world, key))
        return { code: 0, stdout: JSON.stringify(orcaListing(worktrees, layout?.renamed ?? {})) }
      }
      case 'terminal switch': {
        const handle = after(argv, '--terminal')
        if (handle !== undefined) setTimeout(() => tell(world, handle), ECHO_MS)
        return { code: 0 }
      }
      case 'worktree activate':
      case 'terminal send':
        return { code: 0 }
      case 'account list': return { code: 0, stdout: JSON.stringify(NO_ACCOUNTS) }
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
  }
  model.watches.add(watch)
  if (model.last !== undefined) watch.print(model.last)
  return {
    onData: (listener) => { listeners.push(listener) },
    exited,
    kill: () => {
      if (!model.watches.delete(watch)) return
      exit()
    },
  }
}

/** A step kind of the contract whose handler has not landed: no scenario takes it yet, and one that did would fail. */
function notBuilt(kind: StepKind): () => Promise<never> {
  return async () => { throw new Error(`tier A: the ${kind} step is not built yet`) }
}

export const orcaModelSteps: { [K in 'orca.layout' | 'orca.focus' | 'orca.front' | 'orca.plugin' | 'orca.close']: StepHandler<K> } = {
  'orca.layout': async (world, step) => { modelOf(world).layout = step },
  // A watch-focus line for the session's pane: the person focused it in Orca.
  'orca.focus': async (world, step) => {
    const handle = orcaHandleOf(world, step.session)
    if (handle === undefined) throw new Error(`scenario ${world.scenario.id}: orca.focus names ${step.session}, whose pane is not open`)
    tell(world, handle)
  },
  'orca.front': notBuilt('orca.front'),
  'orca.plugin': notBuilt('orca.plugin'),
  'orca.close': notBuilt('orca.close'),
}
