/**
 * Tier A's fake extension (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "The fake extension"): each editor
 * window opens the devices' own `vscode` stream handler, as the listener hands it, with a stream of this file's, and
 * reports its shells on `vscode-state` as the extension's loop does (plugins/harness-device-vscode/src/loop.ts). Calling
 * the handlers directly skips the listener's own limits, which have their own specs.
 *
 * Every line both ways is recorded in the world's streams with each shell named by its session's key, so no pid of the
 * machine reaches a result (docs/plans/2026-11-22-dial-eval-vscode-cursor-plan.md, Decision 1). A line the devices write
 * that holds words is typed into the shell it names: a delivery the gate sees.
 */
import { REFUSED, type ListenerHandler, type ListenerStream, type ListenerStreamHandler } from '../../../../services/devicesListener.js'
import type { SessionKey, StepKind } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { keyOfShell, shellOf } from './sessions.js'

/** The fields of a line the devices write that name a shell by its pid (cable/hosts/vscodeTerminals.ts). */
const SHELL_FIELDS = ['show', 'pid'] as const

/** How many streams each window has opened in the world: a window's nth is `eval-<window>-<n>`. */
const opens = new WeakMap<TierAWorld, Map<string, number>>()

function handlerOf<T extends ListenerHandler | ListenerStreamHandler>(world: TierAWorld, type: string): T {
  const handler = world.listener[type]
  if (!handler) throw new Error(`the devices opened no listener for ${type}`)
  return handler as T
}

/** What a window's stream hears from the devices: each line recorded and taken at once, words typed where it names. */
function stream(world: TierAWorld, window: string): ListenerStream {
  return {
    write: (written) => {
      const line = { ...(written as Record<string, unknown>) }
      const words = Object.values(line).filter((value): value is string => typeof value === 'string')
      const shell = SHELL_FIELDS.map((field) => line[field]).find((value): value is number => typeof value === 'number')
      for (const field of SHELL_FIELDS) {
        const pid = line[field]
        if (typeof pid === 'number') line[field] = keyOfShell(world, pid) ?? 'other'
      }
      world.streams.push({ at: Date.now(), window, line })
      if (words.length > 0) {
        world.deliver({ path: 'typed', target: shell === undefined ? null : keyOfShell(world, shell) ?? null, text: words.join('\n') })
      }
      return true
    },
    // Every line is taken as it is written: none waits to drain, so the devices need never be told they can write.
    onWritable: () => {},
    // No step closes a window yet (the plan's Task 4), so no stream ends.
    ended: new AbortController().signal,
  }
}

/** The shell of a session the step names, which must run in a terminal. */
function shellNamed(world: TierAWorld, window: string, key: SessionKey): number {
  const shell = shellOf(world, key)
  if (shell === undefined) throw new Error(`scenario ${world.scenario.id}: window ${window} names ${key}, which runs in no terminal`)
  return shell
}

/** The editors' steps Task 4 of the plan builds: no scenario takes one before. */
const notBuilt = (kind: StepKind) => async (): Promise<void> => { throw new Error(`tier A: the ${kind} step is not built yet`) }

export const editorSteps: { [K in 'editor.window' | 'editor.focus' | 'editor.closeTerminal' | 'editor.reload' | 'editor.close']: StepHandler<K> } = {
  'editor.window': async (world, step) => {
    if (world.scenario.world?.extension === false) return
    // Its terminals are the live ones the scenario puts in it, in the scenario's order, unless the step names them.
    const terminals = step.terminals
      ?? world.scenario.sessions.filter((s) => s.window === step.window && shellOf(world, s.key) !== undefined).map((s) => s.key)
    const shells = terminals.map((key) => shellNamed(world, step.window, key))
    const active = step.active === null ? null : shellNamed(world, step.window, step.active)
    const counted = opens.get(world) ?? new Map<string, number>()
    opens.set(world, counted)
    const n = (counted.get(step.window) ?? 0) + 1
    counted.set(step.window, n)
    const id = `eval-${step.window}-${n}`
    const open = { type: 'vscode', window: id }
    world.streams.push({ at: Date.now(), window: id, line: open })
    if (handlerOf<ListenerStreamHandler>(world, 'vscode').open(open, stream(world, id)) === REFUSED) {
      throw new Error(`the devices' listener refused ${id}'s stream`)
    }
    world.streams.push({ at: Date.now(), window: id, line: { type: 'vscode-state', terminals, active: step.active, focused: step.focused } })
    const answer: unknown = await handlerOf<ListenerHandler>(world, 'vscode-state')
      .handle({ type: 'vscode-state', window: id, terminals: shells, active, focused: step.focused }, new AbortController().signal)
    if (answer !== undefined) throw new Error(`the devices' listener refused ${id}'s state: ${String(answer)}`)
  },
  'editor.focus': notBuilt('editor.focus'),
  'editor.closeTerminal': notBuilt('editor.closeTerminal'),
  'editor.reload': notBuilt('editor.reload'),
  'editor.close': notBuilt('editor.close'),
}
