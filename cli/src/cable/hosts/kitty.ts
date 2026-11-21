/**
 * A kitty window (docs/plans/2026-11-19-dial-linux-design.md § 3.3): a tap focuses it by kitty's remote control, then
 * kitty comes forward as every app does, and the dial's words are typed into it by `send-text`, then Enter. The
 * daemon runs outside kitty, so each command names the socket kitty listens on (`--to`), which kitty sets only with
 * remote control on (`allow_remote_control`, `listen_on`). The window and the socket came from a hook, so both are checked
 * against their form before each command, which runs with no shell, and a socket at a path is spoken to only when it is
 * this account's. Linux's abstract socket has no owner to read, so it takes a tap alone. kitty's binary is found as the
 * core finds tmux (kittyFinder): the master's PATH may hold none.
 *
 * kitty's tab of an outer place (docs/plans/2026-11-21-dial-linux-followups-design.md, "The tab"): the kitty window
 * holding a multiplexer's client, focused by its own process on the socket the agent's hints name, after kitty is in
 * front. kitty matches a window by its own process alone (RECORDED_KITTY.focusWindowPid), and its `ls` is never read:
 * it holds the windows' environment.
 */
import { dirname, join } from 'node:path'
import { binaryOnPath, resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { binaryFinder } from '../../lib/binaryFinder.js'
import { resolveViaLoginShell, tmuxInstallDirectories, type TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { CONTROL, MAX_TEXT, RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'
import { parentChain, readPtyMaker, type ProcessName } from './scannedApp.js'
import { PID } from './tmux.js'
import type { PaneSwitch } from './types.js'

const APP_KITTEN = '/Applications/kitty.app/Contents/MacOS/kitten'
const WINDOW_ID = /^[0-9]{1,9}$/
// kitty's two socket forms: `unix:` and an absolute path, or Linux's abstract socket `unix:@<name>`. Each is kept to
// characters no argument parser reads as anything else, and to the hook's 64 characters.
const PATH_SOCKET = /^unix:(\/[A-Za-z0-9._/-]{1,58})$/
const ABSTRACT_SOCKET = /^unix:@[A-Za-z0-9._-]{1,58}$/
// A window that holds the agent's terminal but is not its own: words typed there land in whatever that window shows.
const HELD = 'held:'
/** `<window>@<socket>`, held or not. A window id holds no `@`, so the first one ends it. */
const PANE = /^(held:)?([0-9]{1,9})@(.+)$/
/** `<client's pid>@<socket>`: a tab of an outer place. */
const TAB = /^([1-9][0-9]{0,9})@(.+)$/

export interface KittyDeps {
  run: OrcaDeps['run']
  /** Where kitty's remote control is (kittyFinder); it never rejects. */
  kitty(): Promise<TmuxPathOutcome>
  platform: NodeJS.Platform
  log(line: string): void
  /** This process's uid: a socket at a path is spoken to only when it is this account's. */
  uid: number
  /** The uid owning the socket at [path]; null when none is there, it is no socket, or on any error. */
  socketOwner(path: string): number | null
}

/** A kitten in a folder the core looks in for tmux without a shell, else on macOS kitty.app's own. */
const installed = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined =>
  [...tmuxInstallDirectories(env, platform).map((dir) => join(dir, 'kitten')), ...(platform === 'darwin' ? [APP_KITTEN] : [])]
    .find((path) => binaryOnPath(path, env))

/** kitty's remote control as the core finds tmux (binaryFinder.ts): kitten on this process's PATH, else where the
 *  person's login shell finds it, else in a folder the core looks in, else on macOS kitty.app's own; else kitty on the
 *  PATH, as `kitty @` (an older kitty ships no kitten; `kitty +kitten @` fails on 0.32.2, RECORDED_KITTY.kittyAt). Under
 *  launchd or systemd the master's PATH holds no Homebrew folder and none of the person's own. None found is asked again
 *  once one is in one of those places. */
export function kittyFinder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): () => Promise<TmuxPathOutcome> {
  return binaryFinder(async () => {
    if (binaryOnPath('kitten', env)) return { state: 'present' }
    const path = (await resolveViaLoginShell('kitten')) ?? installed(env, platform) ?? resolveBinaryOnPath('kitty', env)
    return path ? { state: 'adopted', path, from: dirname(path) } : { state: 'absent', reason: 'kitty was not found' }
  }, () => binaryOnPath('kitten', env) || installed(env, platform) !== undefined || binaryOnPath('kitty', env))
}

/** The socket in its form, and its path when it has one; nothing out of form. Abstract sockets are Linux's alone. */
function socketOf(platform: NodeJS.Platform, listenOn: string): { listenOn: string; path?: string } | undefined {
  const path = PATH_SOCKET.exec(listenOn)?.[1]
  if (path) return { listenOn, path }
  return platform === 'linux' && ABSTRACT_SOCKET.test(listenOn) ? { listenOn } : undefined
}

// Another account's socket would take the dial's words to that account's kitty. An abstract socket has no owner to read,
// and once kitty is gone any account may take its name: a tap there costs a look, words would run at that account's
// prompt. So only a socket at a path that is this account's takes words.
const ours = (deps: KittyDeps, path: string | undefined): boolean => path === undefined || deps.socketOwner(path) === deps.uid

/** One `@` command to the window's kitty where kitty was found; false when none was or it did not exit 0. */
async function remote(deps: KittyDeps, listenOn: string, args: string[]): Promise<boolean> {
  const found = await deps.kitty()
  if (found.state === 'absent') return false
  return (await deps.run(found.state === 'adopted' ? found.path : 'kitten', ['@', '--to', listenOn, ...args], RUN_TIMEOUT_MS)).code === 0
}

export function createKittyAdapter(deps: KittyDeps): HostAdapter & Required<Pick<HostAdapter, 'type' | 'canType'>> {
  // Per window, the words being typed: two sends at once would mix in its prompt. Busy queues nothing.
  const sending = new Set<string>()
  let toldOff = false

  const windowOf = (pane: Pane): { own: boolean; id: string; listenOn: string; path?: string } | undefined => {
    const parts = PANE.exec(pane.id)
    const socket = parts && socketOf(deps.platform, parts[3])
    return socket ? { own: !parts[1], id: parts[2], ...socket } : undefined
  }
  const typable = (pane: Pane) => {
    const at = windowOf(pane)
    return at?.own && at.path !== undefined ? at : undefined
  }

  return {
    id: 'kitty',
    tap: 'before',
    bundle: APP_BUNDLES.kitty,
    paneOf(place: Place): Pane | undefined {
      if (deps.platform === 'win32') return undefined
      const id = place.hints.KITTY_WINDOW_ID
      if (!id || !WINDOW_ID.test(id)) return undefined
      const listenOn = place.hints.KITTY_LISTEN_ON
      if (listenOn === undefined) {
        // kitty sets no socket with remote control off, its default: the person turns it on in kitty.conf (docs/cli.md).
        if (!toldOff) deps.log('[device] kitty · remote control off')
        toldOff = true
        return undefined
      }
      if (!socketOf(deps.platform, listenOn)) return undefined
      // A multiplexer, a terminal or an editor started in a kitty window keeps its variables, and that window shows
      // whichever of their panes is in front, or a shell that runs what is typed: only a window kitty made the agent's
      // terminal for takes words. Any other only focuses.
      const windowId = `${id}@${listenOn}`
      return place.ptyOwner === 'kitty' ? { adapter: 'kitty', id: windowId } : { adapter: 'kitty', id: `${HELD}${windowId}`, held: true }
    },
    // Whether kitty is found is asked at the verb, and a tap that finds none brings its app forward.
    canFocus: (pane) => windowOf(pane) !== undefined,
    async focus(pane) {
      const at = windowOf(pane)
      return !!at && ours(deps, at.path) && await remote(deps, at.listenOn, ['focus-window', '--match', `id:${at.id}`])
    },
    canType: (pane) => typable(pane) !== undefined,
    async type(pane, text) {
      const at = typable(pane)
      if (text === '' || text.length > MAX_TEXT || !at || sending.has(pane.id) || !ours(deps, at.path)) return false
      sending.add(pane.id)
      try {
        // kitty reads Python escapes in send-text (RECORDED_KITTY.sendTextBackslash): each backslash doubled lands as
        // typed. `--` keeps words that start with a dash from being read as flags; Enter, sent on its own, submits them.
        // Enter is send-text's `\r` escape, not send-key, which goes to the active window whatever --match names
        // (RECORDED_KITTY.sendKeyOtherActive).
        const words = text.replace(CONTROL, ' ').replaceAll('\\', '\\\\')
        const send = (typed: string) => remote(deps, at.listenOn, ['send-text', '--match', `id:${at.id}`, '--', typed])
        return await send(words) && await send('\\r')
      } finally {
        sending.delete(pane.id)
      }
    },
  }
}

/** The kitty window holding a multiplexer's client, by the client's process: a rest focuses it while kitty is in front,
 *  and a tap once kitty came forward. Windows' kitty has no remote control the hints name. */
export function createKittyTabAdapter(deps: KittyDeps & {
  front(): string | undefined; processes(): Promise<readonly ProcessName[]>
  /** The terminal a process runs on (readTtyName); none on none. */
  tty(pid: number): Promise<string | undefined> }):
HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show'>> {
  const tabOf = (pane: Pane): { pid: number; listenOn: string; path?: string } | undefined => {
    const parts = deps.platform === 'win32' ? null : TAB.exec(pane.id)
    const socket = parts && socketOf(deps.platform, parts[2])
    return socket ? { pid: Number(parts[1]), ...socket } : undefined
  }
  // kitty matches a window by its own process, kitty's child, never by one below it (RECORDED_KITTY
  // focusWindowPidDescendant): of the client and its parents, the one started by the kitty that made the client's
  // terminal. A kitty further up holds a terminal started from its window (an xterm, an Alacritty), whose window the
  // agent is not in. One table read a verb.
  const focus = async (pane: Pane): Promise<boolean> => {
    const at = tabOf(pane)
    if (!at || !ours(deps, at.path)) return false
    const rows = await deps.processes().catch(() => undefined)
    if (!rows) return false
    const maker = await readPtyMaker(at.pid, rows, deps.tty).catch(() => undefined)
    if (maker?.host !== 'kitty') return false
    const own = parentChain(at.pid, new Map(rows.map((p) => [p.pid, p]))).find((p) => p.ppid === maker.pid)
    return own !== undefined && await remote(deps, at.listenOn, ['focus-window', '--match', `pid:${own.pid}`])
  }
  return {
    id: 'kitty-tab',
    tap: 'after',
    paneOf(place: Place): Pane | undefined {
      const pid = place.outer?.app === 'kitty' ? place.outer.pid : undefined
      const listenOn = place.hints.KITTY_LISTEN_ON
      if (deps.platform === 'win32' || pid === undefined || !PID.test(String(pid)) || listenOn === undefined) return undefined
      return socketOf(deps.platform, listenOn) ? { adapter: 'kitty-tab', id: `${pid}@${listenOn}` } : undefined
    },
    canFocus: (pane) => tabOf(pane) !== undefined,
    canShow: (pane) => tabOf(pane) !== undefined && deps.front() === 'kitty',
    focus,
    show: async (pane): Promise<PaneSwitch> => (await focus(pane) ? 'ok' : 'failed'),
  }
}
