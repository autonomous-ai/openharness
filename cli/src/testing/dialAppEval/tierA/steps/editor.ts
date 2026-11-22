/**
 * Tier A's fake extension (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "The fake extension"): each editor
 * window opens the devices' own `vscode` stream handler, as the listener hands it, with a stream of this file's, and
 * reports its shells on `vscode-state` as the extension's loop does (plugins/harness-device-vscode/src/loop.ts). Calling
 * the handlers directly skips the listener's own limits, which have their own specs.
 *
 * Every line both ways is recorded in the world's streams with each shell named by its session's key, so no pid of the
 * machine reaches a result (docs/plans/2026-11-22-dial-eval-vscode-cursor-plan.md, Decision 1). A line the devices write
 * that holds words is typed into the shell it names: a delivery the gate sees.
 *
 * A window that reloads, closes or goes with its editor's quit ends its stream `gone`, as the listener ends one whose
 * client went; a reload and a relaunch open the window again on a new id (the spec's V10 and V14).
 */
import { REFUSED, type ListenerHandler, type ListenerStream, type ListenerStreamHandler, type StreamEnd }
  from '../../../../services/devicesListener.js'
import type { Editor, SessionKey } from '../../types.js'
import type { StepHandler, TierAWorld } from '../world.js'
import { agentPid, keyOfShell, sessionsSteps, shellOf } from './sessions.js'

/** The fields of a line the devices write that name a shell by its pid (cable/hosts/vscodeTerminals.ts): an Enter line
 *  `{"enter":<shell>}` names its shell alone. */
const SHELL_FIELDS: readonly string[] = ['show', 'pid', 'enter']

/** Every string in a value, at any depth: words in a list or a nested object are typed as much as a field's. */
const stringsIn = (value: unknown): string[] => (typeof value === 'string' ? [value]
  : typeof value === 'object' && value !== null ? Object.values(value).flatMap(stringsIn) : [])

/** A window's open stream and what its last state said; `key` is the scenario's name for the window in its editor. */
interface OpenWindow {
  app: Editor; key: string; id: string; ended: AbortController; terminals: SessionKey[]; active: SessionKey | null; focused: boolean
}
interface Windows {
  /** How many streams each window name has opened in the world, in either editor, so no two streams share an id: a
   *  window's nth is `eval-<window>-<n>`. */
  opens: Map<string, number>
  /** Each editor's open windows, by slotOf, in the order of their last states: of two windows that list one shell, the
   *  later holds it, as the devices take it (vscodeTerminals.ts). */
  open: Map<string, OpenWindow>
  /** The windows each editor's quit closed, as they were, for its relaunch. */
  quit: Map<Editor, OpenWindow[]>
}
const windowsOf = new WeakMap<TierAWorld, Windows>()

function windows(world: TierAWorld): Windows {
  let state = windowsOf.get(world)
  if (!state) windowsOf.set(world, state = { opens: new Map(), open: new Map(), quit: new Map() })
  return state
}

/** A window is its editor's: VS Code's w1 is not Cursor's. */
const slotOf = (app: Editor, key: string): string => `${app} ${key}`

/** The editor of the window a step names: its sessions' (the plan's Decision 5), else the scenario's app. */
const editorOf = (world: TierAWorld, key: string): Editor =>
  (world.scenario.sessions.find((s) => s.window === key)?.app ?? world.scenario.app) as Editor

function handlerOf<T extends ListenerHandler | ListenerStreamHandler>(world: TierAWorld, type: string): T {
  const handler = world.listener[type]
  if (!handler) throw new Error(`the devices opened no listener for ${type}`)
  return handler as T
}

/** What a window's stream hears from the devices: each line recorded and taken at once, words typed where it names. */
function stream(world: TierAWorld, window: string, ended: AbortSignal): ListenerStream {
  return {
    write: (written) => {
      const line = { ...(written as Record<string, unknown>) }
      const words = Object.entries(line).flatMap(([field, value]) => (SHELL_FIELDS.includes(field) ? [] : stringsIn(value)))
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
    ended,
  }
}

/** The shell of a session the step names, which must run in a terminal. */
function shellNamed(world: TierAWorld, window: string, key: SessionKey): number {
  const shell = shellOf(world, key)
  if (shell === undefined) throw new Error(`scenario ${world.scenario.id}: window ${window} names ${key}, which runs in no terminal`)
  return shell
}

/** The window's state as its extension sends it: its window now the last to have sent one. */
async function report(world: TierAWorld, window: OpenWindow): Promise<void> {
  const { key, id, terminals, active, focused } = window
  const shells = terminals.map((session) => shellNamed(world, key, session))
  const { open } = windows(world)
  const slot = slotOf(window.app, key)
  open.delete(slot)
  open.set(slot, window)
  world.streams.push({ at: Date.now(), window: id, line: { type: 'vscode-state', terminals, active, focused } })
  const answer: unknown = await handlerOf<ListenerHandler>(world, 'vscode-state').handle(
    // The extension's loop says its window types (plugins/harness-device-vscode/src/loop.ts); the recorded line above
    // leaves it out, as tier B's does, so the two tiers' records stay alike.
    { type: 'vscode-state', window: id, terminals: shells, active: active === null ? null : shellNamed(world, key, active), focused,
      types: true },
    new AbortController().signal)
  if (answer !== undefined) throw new Error(`the devices' listener refused ${id}'s state: ${String(answer)}`)
}

/**
 * The window opens a new stream, `eval-<window>-<n>`, and reports its state on it. One already open is the scenario's
 * mistake: its stream would be dropped from the record while the devices still held it, with nothing left to end it.
 */
async function openWindow(world: TierAWorld, state: Omit<OpenWindow, 'id' | 'ended'>): Promise<void> {
  const { opens, open } = windows(world)
  const { key } = state
  if (open.has(slotOf(state.app, key))) throw new Error(`scenario ${world.scenario.id}: window ${key} is already open`)
  const n = (opens.get(key) ?? 0) + 1
  opens.set(key, n)
  const window: OpenWindow = { ...state, id: `eval-${key}-${n}`, ended: new AbortController() }
  const opened = { type: 'vscode', window: window.id }
  world.streams.push({ at: Date.now(), window: window.id, line: opened })
  if (handlerOf<ListenerStreamHandler>(world, 'vscode').open(opened, stream(world, window.id, window.ended.signal)) === REFUSED) {
    throw new Error(`the devices' listener refused ${window.id}'s stream`)
  }
  await report(world, window)
}

/** The window's stream ends: its extension's client went. */
function endWindow(world: TierAWorld, window: OpenWindow): void {
  windows(world).open.delete(slotOf(window.app, window.key))
  const reason: StreamEnd = 'gone'
  world.streams.push({ at: Date.now(), window: window.id, line: { ended: reason } })
  window.ended.abort(reason)
}

/** The open window the step names, in its editor: one the scenario never opened is its mistake. */
function openNamed(world: TierAWorld, key: string): OpenWindow {
  const window = windows(world).open.get(slotOf(editorOf(world, key), key))
  if (!window) throw new Error(`scenario ${world.scenario.id}: no window ${key} is open`)
  return window
}

/** The window that holds the session's shell: of the open ones that list it, the one whose state came last. */
function holding(world: TierAWorld, session: SessionKey): OpenWindow | undefined {
  return [...windows(world).open.values()].reverse().find((window) => window.terminals.includes(session))
}

/** The editor quit: each of its windows' streams ends, and is kept for its relaunch. */
export function closeWindows(world: TierAWorld, app: Editor): void {
  const closed = [...windows(world).open.values()].filter((window) => window.app === app)
  for (const window of closed) endWindow(world, window)
  windows(world).quit.set(app, closed)
}

/** The editor relaunched: each window its quit closed opens a new stream, reporting its sessions' new shells. */
export async function reopenWindows(world: TierAWorld, app: Editor): Promise<void> {
  const { quit } = windows(world)
  const closed = quit.get(app) ?? []
  quit.delete(app)
  for (const { key, terminals, active, focused } of closed) {
    const live = terminals.filter((session) => shellOf(world, session) !== undefined)
    await openWindow(world, { app, key, terminals: live, active: active !== null && live.includes(active) ? active : null, focused })
  }
}

export const editorSteps: { [K in 'editor.window' | 'editor.focus' | 'editor.closeTerminal' | 'editor.reload' | 'editor.close']: StepHandler<K> } = {
  'editor.window': async (world, step) => {
    if (world.scenario.world?.extension === false) return
    const inWindow = world.scenario.sessions.filter((s) => s.window === step.window)
    // Its terminals are the live ones the scenario puts in it, in the scenario's order, unless the step names them.
    const terminals = step.terminals ?? inWindow.filter((s) => shellOf(world, s.key) !== undefined).map((s) => s.key)
    await openWindow(world, { app: editorOf(world, step.window), key: step.window, terminals, active: step.active, focused: step.focused })
  },
  'editor.focus': async (world, step) => {
    if (world.scenario.world?.extension === false) return
    const held = holding(world, step.session)
    if (!held) throw new Error(`scenario ${world.scenario.id}: no open window holds ${step.session}'s terminal`)
    // One window has the focus: the one that had it says it lost it first, as the editor tells its extension and tier B's
    // windows say (appEvalEditor.ts). Two windows focused at once would leave the devices following the wrong one (VH3).
    for (const other of [...windows(world).open.values()]) {
      if (other !== held && other.focused) await report(world, { ...other, focused: false })
    }
    await report(world, { ...held, active: step.session, focused: true })
  },
  'editor.closeTerminal': async (world, step) => {
    const agent = agentPid(world, step.session)
    const shell = shellOf(world, step.session)
    if (agent === undefined || shell === undefined) throw new Error(`scenario ${world.scenario.id}: ${step.session} runs in no terminal`)
    const held = holding(world, step.session)
    // Which terminal VS Code makes active next is its own: the closed one is no longer, and none is said to be.
    if (held) {
      await report(world, { ...held, terminals: held.terminals.filter((session) => session !== step.session),
        active: held.active === step.session ? null : held.active })
    }
    await sessionsSteps.hook(world, { kind: 'hook', session: step.session, event: 'end' })
    world.machine.end(agent)
    world.machine.end(shell)
  },
  'editor.reload': async (world, step) => {
    if (world.scenario.world?.extension === false) return
    const window = openNamed(world, step.window)
    endWindow(world, window)
    const { app, key, terminals, active, focused } = window
    await openWindow(world, { app, key, terminals, active, focused })
  },
  'editor.close': async (world, step) => {
    if (world.scenario.world?.extension === false) return
    endWindow(world, openNamed(world, step.window))
  },
}
