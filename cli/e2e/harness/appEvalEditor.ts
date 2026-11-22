/**
 * Tier B's steps on the editors' agents and windows (docs/plans/2026-11-22-dial-eval-vscode-cursor-design.md, "Tier B"):
 * - each terminal agent is the foreground job of a real shell in a tab of a fake of its editor (outsideAgent.ts openTab),
 *   so the parent chain `ps` reads is the machine's own, as in dialVscode.e2e.ts; in a world whose editor was started
 *   with `code .` from Terminal, the fake editor runs under a shell of a fake Terminal. Claude Code runs on the Claude
 *   app's own session code (appEvalClaude.ts) with the editor's hints, a panel session under the editor with the
 *   extension's entrypoint. A Codex is a process of its own in such a tab (codexOutside.ts inTab), one with a home of its
 *   own in a home in the root that is not the daemon's CODEX_HOME. V12's Claude Code runs in a tmux session of the
 *   person's on the daemon's private server, its client attached from a terminal of the editor (ownTmux.ts tabClient).
 *   cursor-agent is a shell's job in such a tab of a fake Cursor, and Cursor's own agent a process under the fake Cursor
 *   (cursorOutside.ts), each telling the devices by Cursor's own hooks;
 * - each window is Harness's extension's own loop over a fake window (editorWindow.ts), reporting its shells on the real
 *   devices' socket. What the loop printed is the window's stream in tier A's shapes (the plan's Decision 1): the stream
 *   `eval-<window>-<n>`, the window's nth in the scenario, its shells named by their sessions' keys, never by a pid;
 * - words reach these agents by the Claude mod's inbox and the prompts typed into a Claude Code (appEvalClaude.ts), and
 *   by the Codex queue (appEvalChatgpt.ts hear): the extension types none.
 *
 * Every process goes in `world.children`, or is the editor's: its own process, ended at stop, first ends the Codex, Cursor
 * and tmux sessions it runs (as the Claude app's ends its sessions, appEvalClaude.ts), so nothing of a scenario outlives it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { basename, join } from 'node:path'
import { APP_BUNDLES } from '../../src/cable/hosts/hostDetect.js'
import { NET_GUARD_FILE_ENV } from '../../src/testing/dialAppEval/netGuard.js'
import { EDITORS, engineOf, placeOf, type App, type Editor, type SessionDef, type SessionKey } from '../../src/testing/dialAppEval/types.js'
import type { WindowState } from '../../../plugins/harness-device-vscode/src/window.ts'
import { hear } from './appEvalChatgpt.js'
import { appOf, claudeSteps, start as startClaude, type ClaudeHost } from './appEvalClaude.js'
import { guardEnv, guardLoaded, speak, type AppSteps, type TierBWorld } from './appEvalDriver.js'
import { CodexOutside } from './codexOutside.js'
import { CursorOutside } from './cursorOutside.js'
import { until } from './daemon.js'
import { startEditorWindow, type EditorWindow, type Printed } from './editorWindow.js'
import { InOwnTmux, tabClient } from './ownTmux.js'

/** For a window's loop to connect: it first asks the CLI's `link` through the home's launcher (editorWindow.ts). */
const CONNECT_MS = 60_000
/** For a window to take a state it was told. */
const TOOK_MS = 10_000

/** A window as its extension tells it: its editor, its terminals by session, the active one, and whether it is focused. */
interface Look { app: Editor; terminals: SessionKey[]; active: SessionKey | null; focused: boolean }
/** An open window: its stream's id in the records, and its loop. */
interface Open extends Look { id: string; loop: EditorWindow }
interface State {
  /** Each running agent's shell, by session: the one its editor reports for its terminal. */
  shells: Map<SessionKey, number>
  /** Each running session, in the order it started. */
  running: SessionKey[]
  codex: Map<SessionKey, CodexOutside>
  cursor: Map<SessionKey, CursorOutside>
  /** How each tmux session ends, by its session, and how it goes at once. */
  tmux: Map<SessionKey, { end(): Promise<void>; kill(): void }>
  /** In the order of their last states: of two windows that list one shell, the later holds it, as the devices take it
   *  (vscodeTerminals.ts). */
  windows: Map<string, Open>
  /** How many streams each window opened in the scenario. */
  opens: Map<string, number>
  /** What each editor's quit ended, for its relaunch. */
  quit: Map<App, { sessions: SessionKey[]; windows: Array<[string, Look]> }>
}
const states = new WeakMap<TierBWorld, State>()

/**
 * The records of one stream of a window, from what its loop printed, in tier A's shapes (the plan's Decision 1): its open
 * once connected, each state the window took, each show with the raise printed right after it folded in, each line
 * scrolled, for the terminal active as it ran, the only one the loop scrolls, and each page key, which moves a fullscreen
 * Claude Code's view as a scroll, for the shell it was pressed in. Each shell is named by [keyOf], `other` for one no
 * session has.
 */
export function windowRecords(window: string, keyOf: (pid: number) => SessionKey | undefined,
  record: (line: Record<string, unknown>, at: number) => void): (printed: Printed, at: number) => void {
  const named = (pid: number | null): SessionKey | null => pid === null ? null : keyOf(pid) ?? 'other'
  let active: number | null = null
  let shown: Record<string, unknown> | undefined
  return (printed, at) => {
    const last = shown
    shown = undefined
    // Into the show's record itself, which is already made.
    if (printed.raise && last) last.raise = true
    else if (printed.state === 'connected') record({ type: 'vscode', window }, at)
    else if (printed.took) {
      active = printed.took.active
      record({ type: 'vscode-state', terminals: printed.took.terminals.map(named), active: named(active), focused: printed.took.focused }, at)
    } else if (printed.show !== undefined) record(shown = { show: named(printed.show) }, at)
    else if (printed.scroll !== undefined) record({ scroll: printed.scroll, pid: named(active) }, at)
    else if (printed.key !== undefined) record({ scroll: printed.key, pid: named(printed.pid ?? null) }, at)
  }
}

const fromTerminal = (world: Pick<TierBWorld, 'scenario'>): boolean => world.scenario.world?.launchedFrom === 'terminal-app'
const noExtension = (world: TierBWorld): boolean => world.scenario.world?.extension === false

/**
 * What the hook sends from an editor's agent (hook/notify.mjs hostHints), as tier A's sessions send it
 * (tierA/steps/sessions.ts): its terminal says TERM_PROGRAM=vscode, Cursor's as VS Code's; macOS gives the editor's bundle
 * id, or Terminal's to an editor started from there; Linux gives none. The panel's Claude Code adds the extension's
 * entrypoint. In tmux, tmux names the terminal program itself, and the bundle id is what its server inherited. Cursor's own
 * agent, in no terminal, gives the bundle id alone.
 */
export function editorHints(world: Pick<TierBWorld, 'platform' | 'scenario'>, s: SessionDef): Record<string, string> {
  const place = placeOf(s)
  const bundle = world.platform === 'darwin' ? APP_BUNDLES[fromTerminal(world) ? 'terminal-app' : s.app] : undefined
  return {
    ...(place === 'terminal' && !s.tmux ? { TERM_PROGRAM: 'vscode' } : {}),
    ...(bundle === undefined ? {} : { __CFBundleIdentifier: bundle }),
    ...(place === 'panel' ? { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } : {}),
  }
}

/** An editor's Claude Code: under a fake of its editor, a terminal's as its shell's job, the editor started from Terminal
 *  when the world says so. */
const EDITOR_HOST: ClaudeHost = (world, s) => ({
  hints: editorHints(world, s), app: s.app as Editor, shell: placeOf(s) === 'terminal', launchedFrom: world.scenario.world?.launchedFrom,
})

/** The editor, running: started at its first step, its own process with it, which, ended, ends what it runs first and only
 *  then goes; the driver's end of its children waits for that. */
function editorOf(world: TierBWorld): State {
  const known = states.get(world)
  if (known) return known
  const state: State = { shells: new Map(), running: [], codex: new Map(), cursor: new Map(), tmux: new Map(), windows: new Map(),
    opens: new Map(), quit: new Map() }
  states.set(world, state)
  // Only the editor's lifetime: what it does is in this file.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: world.d.root, env: world.d.env, stdio: ['pipe', 'ignore', 'ignore'] })
  world.children.push(child)
  const kill = child.kill.bind(child)
  let ending: Promise<void> | undefined
  child.kill = (signal?: NodeJS.Signals | number) => {
    // The driver's last resort, when the end takes too long: what it runs goes at once with it, with no hook.
    if (signal === 'SIGKILL') {
      for (const codex of state.codex.values()) codex.killTab()
      for (const cursor of state.cursor.values()) cursor.killTab()
      for (const tmux of state.tmux.values()) tmux.kill()
      return kill('SIGKILL')
    }
    // Its windows and its Claude Code are children of their own; its Codex, Cursor and tmux sessions it ends itself, and
    // one it could not end fails the scenario.
    ending ??= Promise.allSettled([...[...state.codex.values()].map((codex) => codex.end()), ...[...state.cursor.values()].map(endCursor),
      ...[...state.tmux.values()].map((tmux) => tmux.end())])
      .then((ended) => {
        for (const one of ended) if (one.status === 'rejected') world.fail(one.reason)
        kill('SIGKILL')
      })
    return true
  }
  return state
}

const keyOfShell = (state: State, pid: number): SessionKey | undefined => [...state.shells].find(([, shell]) => shell === pid)?.[0]

/**
 * A Codex home of the session's own, in the root and not the daemon's CODEX_HOME, with Harness's hooks in it as the daemon
 * installs them in a moved home it knows of: its hooks reach the devices as tier A's do. A new one each start, so no
 * rollout of an earlier scenario is in it.
 */
function ownHome(world: TierBWorld): string {
  const home = mkdtempSync(join(world.d.root, 'codex-home-'))
  copyFileSync(join(world.d.env.CODEX_HOME!, 'hooks.json'), join(home, 'hooks.json'))
  return home
}

/** The session's Codex in a tab of its editor, its start hook run: its shell. */
async function startCodex(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<number | undefined> {
  const codex = await CodexOutside.inTab(world.d, folder, world.children, editorHints(world, s),
    { app: s.app as Editor, launchedFrom: world.scenario.world?.launchedFrom },
    { sessionId: s.id, ...(s.codexHome === 'own' ? { home: ownHome(world) } : {}) })
  state.codex.set(s.key, codex)
  await codex.hook('SessionStart', { source: 'startup' })
  return codex.shellPid
}

/** The session's Cursor agent under its editor, cursor-agent in a terminal and Cursor's own in none, its start hook run:
 *  its shell, for a terminal. Its workspace is the session's folders, or its own folder alone. */
async function startCursor(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<number | undefined> {
  const roots = (s.folders ?? [s.cwd]).map((one) => world.folder(one))
  const cursor = await CursorOutside.start(world.d, folder, world.children,
    { sessionId: s.id, roots, terminal: placeOf(s) === 'terminal', hints: editorHints(world, s) })
  state.cursor.set(s.key, cursor)
  await cursor.hook('start')
  return cursor.shellPid
}

/** A Cursor agent leaves as Cursor ends it: its sessionEnd hook, then its process, gone whatever the hook did. */
async function endCursor(cursor: CursorOutside): Promise<void> {
  try {
    await cursor.hook('end')
  } finally {
    await cursor.close()
  }
}

/**
 * V12's Claude Code: in a tmux session of the person's on the daemon's private server (ownTmux.ts InOwnTmux), going on in
 * the session's own conversation, its client attached from a terminal of the editor. That terminal's shell, as the window
 * reports it, is the client's.
 */
async function inTmux(world: TierBWorld, state: State, s: SessionDef, folder: string): Promise<number> {
  const { d } = world
  const name = `eval-${s.key}`
  // At once, so the driver's last resort can end it as it kills the editor; one already gone fails nothing.
  const killed = (): void => { spawnSync('tmux', ['-S', d.tmux.socket, '-f', '/dev/null', 'kill-session', '-t', name], { env: d.tmux.env }) }
  state.tmux.set(s.key, { end: async () => killed(), kill: killed })
  const own = await InOwnTmux.start(d, name, folder, { resume: s.id, env: { ...guardEnv(d), ...editorHints(world, s), FAKE_CLAUDE_SESSION_TITLE: s.title } })
  // As in every process of the daemon: its hooks are its children.
  guardLoaded(d.env[NET_GUARD_FILE_ENV]!, `${name} pane's Claude Code`, [own.pid], 'node')
  const client = await tabClient(d, name, s.app as Editor)
  state.tmux.set(s.key, {
    end: async () => {
      await client.close()
      killed()
    },
    kill: () => {
      killed()
      try { process.kill(client.pid, 'SIGKILL') } catch { /* already gone */ }
    },
  })
  return client.pid
}

/** The session's agent started in its folder, the catalog's on this daemon (TierBWorld.folder), and its start hook run. */
async function startSession(world: TierBWorld, key: SessionKey): Promise<void> {
  const state = editorOf(world)
  const s = world.session(key)
  const cwd = world.folder(s.cwd)
  // A multi-root workspace's other folders are there too, as tier A makes them: Cursor's folder row opens only one that is.
  for (const folder of s.folders ?? []) world.folder(folder)
  let shell: number | undefined
  if (s.tmux) shell = await inTmux(world, state, s, basename(cwd))
  else {
    switch (engineOf(s)) {
      case 'claude': shell = (await startClaude(world, appOf(world, EDITOR_HOST), key)).outside.shellPid; break
      case 'codex': shell = await startCodex(world, state, s, basename(cwd)); break
      case 'cursor': shell = await startCursor(world, state, s, basename(cwd)); break
    }
  }
  if (shell !== undefined) state.shells.set(key, shell)
  state.running.push(key)
}

/** The session's agent leaves: Claude Code as it does when its terminal closes it (appEvalClaude.ts), a Codex's process
 *  and tab, a Cursor agent as Cursor ends it, a tmux session and its client. */
async function endSession(world: TierBWorld, key: SessionKey): Promise<void> {
  const state = editorOf(world)
  state.running = state.running.filter((one) => one !== key)
  state.shells.delete(key)
  const codex = state.codex.get(key)
  const cursor = state.cursor.get(key)
  const tmux = state.tmux.get(key)
  state.codex.delete(key)
  state.cursor.delete(key)
  state.tmux.delete(key)
  if (codex) await codex.end()
  else if (cursor) await endCursor(cursor)
  else if (tmux) await tmux.end()
  else await claudeSteps.hook(world, { kind: 'hook', session: key, event: 'end' })
}

/** The shell of a session the step names, which must run in a terminal. */
function shellNamed(world: TierBWorld, state: State, window: string, key: SessionKey): number {
  const shell = state.shells.get(key)
  if (shell === undefined) throw new Error(`scenario ${world.scenario.id}: window ${window} names ${key}, which runs in no terminal`)
  return shell
}

/** The window opens a new stream, `eval-<window>-<n>`: its loop started, told how the window looks, and connected. */
async function openWindow(world: TierBWorld, key: string, look: Look): Promise<void> {
  const state = editorOf(world)
  const told: WindowState = {
    terminals: look.terminals.map((session) => shellNamed(world, state, key, session)),
    active: look.active === null ? null : shellNamed(world, state, key, look.active), focused: look.focused,
  }
  const n = (state.opens.get(key) ?? 0) + 1
  state.opens.set(key, n)
  const id = `eval-${key}-${n}`
  const loop = startEditorWindow(world.d, world.children, guardEnv(world.d))
  loop.onLine(windowRecords(id, (pid) => keyOfShell(state, pid), (line, at) => world.stream(id, line, at)))
  state.windows.delete(key)
  state.windows.set(key, { ...look, id, loop })
  loop.set(told)
  await until(`${id} connected`, () => loop.states.at(-1) === 'connected', CONNECT_MS, 50)
  // As in every process of the daemon: the loop asks the CLI's `link`, and reads its window's streams.
  guardLoaded(world.d.env[NET_GUARD_FILE_ENV]!, `${id} window`, [loop.pid], 'node')
}

/** The window's stream ends: its loop stops, as when VS Code closes the window or reloads it. */
async function endWindow(world: TierBWorld, key: string): Promise<Open> {
  const state = editorOf(world)
  const open = state.windows.get(key)
  if (!open) throw new Error(`scenario ${world.scenario.id}: no window ${key} is open`)
  state.windows.delete(key)
  await open.loop.stop()
  world.stream(open.id, { ended: 'gone' })
  return open
}

/** The open window that holds the session's shell: of those that list it, the one whose state came last. */
function holding(state: State, session: SessionKey): [string, Open] | undefined {
  return [...state.windows].reverse().find(([, open]) => open.terminals.includes(session))
}

function editorNamed(world: TierBWorld, app: App): Editor {
  if (!(EDITORS as readonly App[]).includes(app)) throw new Error(`scenario ${world.scenario.id}: the editors' steps quit and relaunch no ${app} app`)
  return app as Editor
}

export const vscodeSteps: AppSteps = {
  hook: async (world, step) => {
    const s = world.session(step.session)
    if (step.event === 'start') return startSession(world, step.session)
    if (step.event === 'end') return endSession(world, step.session)
    const cursor = editorOf(world).cursor.get(step.session)
    // Cursor's hooks say no wait on the person (CURSOR_HOOK_SETTINGS).
    if (cursor && step.event !== 'needs-input') return cursor.hook(step.event, step.lastAnswer)
    if (engineOf(s) !== 'claude' || s.tmux) throw new Error(`scenario ${world.scenario.id}: tier B's ${step.session} runs no ${step.event} hook`)
    return claudeSteps.hook(world, step)
  },
  voice: async (world, step) => {
    hear(world)
    await speak(world, step)
  },
  /** Its windows close and its agents end, at once, as when the editor quits; both are kept for its relaunch. */
  quit: async (world, step) => {
    const app = editorNamed(world, step.app)
    const state = editorOf(world)
    const windows = [...state.windows].filter(([, open]) => open.app === app)
    await Promise.all(windows.map(([key]) => endWindow(world, key)))
    const sessions = state.running.filter((key) => world.session(key).app === app)
    await Promise.all(sessions.map((key) => endSession(world, key)))
    state.quit.set(app, { sessions, windows: windows.map(([key, { terminals, active, focused }]) => [key, { app, terminals, active, focused }]) })
  },
  /** Its agents start again in the order they had, then each window its quit closed opens a new stream with their shells. */
  relaunch: async (world, step) => {
    const app = editorNamed(world, step.app)
    const state = editorOf(world)
    const quit = state.quit.get(app)
    state.quit.delete(app)
    for (const key of quit?.sessions ?? []) await startSession(world, key)
    for (const [key, look] of quit?.windows ?? []) {
      const terminals = look.terminals.filter((session) => state.shells.has(session))
      await openWindow(world, key, { ...look, terminals, active: look.active !== null && terminals.includes(look.active) ? look.active : null })
    }
  },
  'editor.window': async (world, step) => {
    if (noExtension(world)) return
    const state = editorOf(world)
    const inWindow = world.scenario.sessions.filter((s) => s.window === step.window)
    // Its terminals are the running ones the scenario puts in it, in the scenario's order, unless the step names them.
    const terminals = step.terminals ?? inWindow.filter((s) => state.shells.has(s.key)).map((s) => s.key)
    // A window's app is its sessions' (the plan's Decision 5).
    const app = (inWindow[0]?.app ?? world.scenario.app) as Editor
    await openWindow(world, step.window, { app, terminals, active: step.active, focused: step.focused })
  },
  'editor.focus': async (world, step) => {
    if (noExtension(world)) return
    const state = editorOf(world)
    const held = holding(state, step.session)
    if (!held) throw new Error(`scenario ${world.scenario.id}: no open window holds ${step.session}'s terminal`)
    const [key, open] = held
    const shell = shellNamed(world, state, key, step.session)
    state.windows.delete(key)
    state.windows.set(key, { ...open, active: step.session, focused: true })
    open.loop.set({ active: shell, focused: true })
    await until(`${open.id} to take ${step.session}'s terminal active`, () => {
      const took = open.loop.took.at(-1)
      return took?.active === shell && took.focused
    }, TOOK_MS, 50)
  },
  'editor.reload': async (world, step) => {
    if (noExtension(world)) return
    const { app, terminals, active, focused } = await endWindow(world, step.window)
    await openWindow(world, step.window, { app, terminals, active, focused })
  },
  'editor.close': async (world, step) => {
    if (noExtension(world)) return
    await endWindow(world, step.window)
  },
}

/** Cursor's scenarios run on the same steps: each session's engine and place decide its agent, and its app its editor. */
export const cursorSteps: AppSteps = vscodeSteps
