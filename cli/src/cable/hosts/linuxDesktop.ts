/**
 * Which desktop this login exposes, for the dial's raise (docs/plans/2026-11-19-dial-linux-design.md § 2.3): the
 * compositor's own IPC first (sway, Hyprland, KWin, GNOME Shell), X11 last, since under Wayland the X11 socket is
 * Xwayland's and sees only X11 windows. The daemon may run under systemd before the session imported its variables, so
 * each desktop is also found from this login's own sockets in $XDG_RUNTIME_DIR, and never from another process's
 * environment (cli/AGENTS.md rule 4). A socket another account owns is never used: what answers on it is someone
 * else's desktop. Every command runs with no shell, each value one argument, and none of them throws here.
 */
import { lstatSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { RUN_TIMEOUT_MS, type OrcaDeps } from './orca.js'

export type LinuxDesktop =
  | { kind: 'sway'; socket: string }
  | { kind: 'hyprland'; signature: string }
  | { kind: 'kwin'; bus: string; runtimeDir: string }
  | { kind: 'gnome'; bus: string }
  | { kind: 'x11'; display: string; xauthority?: string }
  | { kind: 'none'; why: 'no desktop session' | 'gnome without the extension' | 'unknown compositor' | 'no swaymsg' | 'no hyprctl' | 'no wmctrl' }

export interface LinuxDesktopDeps {
  env: Readonly<Partial<Record<'SWAYSOCK' | 'HYPRLAND_INSTANCE_SIGNATURE' | 'XDG_RUNTIME_DIR' | 'WAYLAND_DISPLAY' | 'DBUS_SESSION_BUS_ADDRESS' | 'DISPLAY' | 'XAUTHORITY', string>>>
  uid: number
  home: string
  /** A folder's entry names; none when it cannot be read. */
  list(dir: string): string[]
  /** What the path is and whose: null when it is not there, or a link, unless [follow] looks through it. */
  kind(path: string, follow?: boolean): { type: 'socket' | 'file' | 'folder'; uid: number } | null
  run: OrcaDeps['run']
  onPath: OrcaDeps['onPath']
}

type Why = Extract<LinuxDesktop, { kind: 'none' }>['why']

// sway names its socket for its uid and pid, Hyprland its folder for its instance; one left by a compositor that crashed
// stays. Four of each bound the calls that ask whether one answers a folder of stale ones could cost.
const SWAY_SOCKET = /^sway-ipc\.([0-9]+)\.[0-9]+\.sock$/
const ASKED = 4
// Hyprland's `<commit>_<unix time>_<random>`: `hyprctl -i` reads a value with no `_` as an instance's number, so a
// signature without them would name another instance (RECORDED_HYPRLAND.signatureWithoutUnderscore).
const HYPRLAND_SIGNATURE = /^(?=.{1,128}$)[A-Za-z0-9]+(_[A-Za-z0-9]+){2,}$/
// Unanchored at the end: a `,guid=…` or a second address after `;` is left off, so only the checked part reaches a
// command line.
const SESSION_BUS = /^unix:(path|abstract)=[^,;\s]{1,200}/
const WINDOW_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WAYLAND_SOCKET = /^wayland-[0-9]+$/
const DISPLAY = /^:[0-9]{1,3}(\.[0-9]{1,2})?$/
const X11_SOCKETS = '/tmp/.X11-unix'
// No leading zero: `X01` would be read as display 1, whose socket is `X1`.
const X11_SOCKET = /^X(0|[1-9][0-9]{0,2})$/
// GNOME's (mutter) and SDDM's auth files for this login's X server.
const SESSION_XAUTH = /^(\.mutter-Xwaylandauth\.|xauth_)/
const GNOME_EXTENSION = '/de/lucaswerkmeister/ActivateWindowByTitle'
// GDBus answers an introspection of any path, with an empty node where nothing is: only the extension's own interface
// says it is on (RECORDED_GNOME_SHELL.introspectWithout).
const GNOME_INTERFACE = 'interface de.lucaswerkmeister.ActivateWindowByTitle '

/** A bus as every raise hands it to a command: anchored, since a `,guid=…` or a second address after `;` would let the call
 *  reach another bus. */
export const isSessionBus = (bus: string): boolean => SESSION_BUS.exec(bus)?.[0] === bus
/** A window class as every raise takes it: no leading `-`, which gdbus reads as an option, and nothing JSON escapes in a
 *  KWin script. */
export const isWindowClass = (spelling: string): boolean => WINDOW_CLASS.test(spelling)
/** A process whose window may be an agent's: a whole number, and above 1, as pid 1 holds every orphan and a window that
 *  names no process shows 0. */
export const isAgentPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 1

export async function findLinuxDesktop(deps: LinuxDesktopDeps): Promise<LinuxDesktop> {
  const { env, uid } = deps
  const none = (why: Why): LinuxDesktop => ({ kind: 'none', why })
  const own = (path: string, type: 'socket' | 'file') => {
    const found = deps.kind(path)
    return found?.type === type && found.uid === uid
  }
  const answer = (file: string, args: string[]) => deps.run(file, args, RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' }))
  const runtime = env.XDG_RUNTIME_DIR !== undefined && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : undefined
  const inRuntime = runtime ? deps.list(runtime).map((name) => ({ name, path: join(runtime, name) })) : []

  // A SWAYSOCK the session exported can outlive its sway: the runtime dir's own sockets are asked after it.
  const swaySockets = [...new Set([
    ...(env.SWAYSOCK !== undefined && isAbsolute(env.SWAYSOCK) ? [env.SWAYSOCK] : []),
    ...inRuntime.filter(({ name }) => SWAY_SOCKET.exec(name)?.[1] === String(uid)).slice(0, ASKED).map(({ path }) => path),
  ])].filter((path) => own(path, 'socket'))
  if (swaySockets.length > 0) {
    const swaymsg = deps.onPath('swaymsg')
    if (!swaymsg) return none('no swaymsg')
    for (const socket of swaySockets) {
      if ((await answer(swaymsg, ['-s', socket, '-t', 'get_version'])).code === 0) return { kind: 'sway', socket }
    }
  }

  if (runtime) {
    // As sway's: the exported signature can outlive its Hyprland, and the first folder whose Hyprland answers wins.
    const hypr = join(runtime, 'hypr')
    const exported = env.HYPRLAND_INSTANCE_SIGNATURE
    const signatures = [...new Set([
      ...(exported !== undefined ? [exported] : []),
      ...deps.list(hypr).filter((name) => HYPRLAND_SIGNATURE.test(name)).slice(0, ASKED),
    ])].filter((signature) => HYPRLAND_SIGNATURE.test(signature) && own(join(hypr, signature, '.socket.sock'), 'socket'))
    if (signatures.length > 0) {
      const hyprctl = deps.onPath('hyprctl')
      if (!hyprctl) return none('no hyprctl')
      for (const signature of signatures) {
        if ((await answer(hyprctl, ['-i', signature, 'version'])).code === 0) return { kind: 'hyprland', signature }
      }
    }
  }

  // A path's socket must be this account's. An abstract socket has no file, so no owner to check: the bus daemon itself
  // refuses a client of another uid.
  const exportedBus = env.DBUS_SESSION_BUS_ADDRESS?.match(SESSION_BUS)?.[0]
  const bus = exportedBus !== undefined && (!exportedBus.startsWith('unix:path=') || own(exportedBus.slice('unix:path='.length), 'socket'))
    ? exportedBus
    : runtime && own(join(runtime, 'bus'), 'socket') ? `unix:path=${join(runtime, 'bus')}` : undefined
  // A session that exported its display says whether it runs Wayland, by this account's socket WAYLAND_DISPLAY names: a
  // compositor that crashed leaves its socket behind, which would turn an X11 login's DISPLAY into an unknown
  // compositor. A daemon started before the session exported either (design § 2.3) goes by the runtime dir's sockets.
  const named = env.WAYLAND_DISPLAY ? (isAbsolute(env.WAYLAND_DISPLAY) ? env.WAYLAND_DISPLAY : runtime && join(runtime, env.WAYLAND_DISPLAY)) : undefined
  const wayland = env.WAYLAND_DISPLAY || env.DISPLAY
    ? !!named && own(named, 'socket')
    : inRuntime.some(({ name, path }) => WAYLAND_SOCKET.test(name) && own(path, 'socket'))
  if (bus !== undefined) {
    // KDE's raise writes its script to a file in the runtime dir (KWin takes a script only as a file).
    const dbusSend = deps.onPath('dbus-send')
    if (runtime && dbusSend) {
      const { code, stdout } = await answer(dbusSend, [
        `--bus=${bus}`, '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner',
        'string:org.kde.KWin',
      ])
      if (code === 0 && /^\s*boolean true$/m.test(stdout)) return { kind: 'kwin', bus, runtimeDir: runtime }
    }
    const gdbus = deps.onPath('gdbus')
    if (gdbus) {
      const shell = await answer(gdbus, [
        'call', '--address', bus, '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.gnome.Shell',
      ])
      if (shell.code === 0 && shell.stdout.trim() === '(true,)') {
        const extension = await answer(gdbus, ['introspect', '--address', bus, '--dest', 'org.gnome.Shell', '--object-path', GNOME_EXTENSION])
        if (extension.code === 0 && extension.stdout.includes(GNOME_INTERFACE)) return { kind: 'gnome', bus }
        // On X11 the same Shell is raised through wmctrl, below.
        if (wayland) return none('gnome without the extension')
      }
    }
  }

  if (!wayland) {
    const display = env.DISPLAY !== undefined && DISPLAY.test(env.DISPLAY) ? env.DISPLAY : lowestXSocket(deps)
    if (display !== undefined) {
      if (!deps.onPath('wmctrl')) return none('no wmctrl')
      // Through a link: wmctrl reads the cookie as this account, so a link gives it nothing this account could not read.
      const file = (path: string) => deps.kind(path, true)?.type === 'file'
      const home = join(deps.home, '.Xauthority')
      const xauthority = env.XAUTHORITY !== undefined && isAbsolute(env.XAUTHORITY) && file(env.XAUTHORITY) ? env.XAUTHORITY
        : file(home) ? home
        : inRuntime.find(({ name, path }) => SESSION_XAUTH.test(name) && own(path, 'file'))?.path
      return xauthority === undefined ? { kind: 'x11', display } : { kind: 'x11', display, xauthority }
    }
  }
  return none(wayland ? 'unknown compositor' : 'no desktop session')
}

/** The lowest X server socket root or this account owns, as a display: another account's X server is not this login's. */
function lowestXSocket(deps: LinuxDesktopDeps): string | undefined {
  const numbers = deps.list(X11_SOCKETS).flatMap((name) => {
    const number = X11_SOCKET.exec(name)?.[1]
    const found = number === undefined ? null : deps.kind(join(X11_SOCKETS, name))
    return found?.type === 'socket' && (found.uid === deps.uid || found.uid === 0) ? [Number(number)] : []
  })
  return numbers.length > 0 ? `:${Math.min(...numbers)}` : undefined
}

/** The line the daemon's log says for it (Global Constraints): a fixed word, never a socket, bus or display. */
export function desktopLine(desktop: LinuxDesktop): string {
  return desktop.kind === 'none' ? `[device] raise · none · ${desktop.why}` : `[device] raise · ${desktop.kind}`
}

/** This process's own: its environment, uid and home, the real file system, `apps`' runner and PATH. */
export function linuxDesktopDeps(apps: Pick<OrcaDeps, 'run' | 'onPath'>): LinuxDesktopDeps {
  const { SWAYSOCK, HYPRLAND_INSTANCE_SIGNATURE, XDG_RUNTIME_DIR, WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS, DISPLAY, XAUTHORITY } = process.env
  return {
    env: { SWAYSOCK, HYPRLAND_INSTANCE_SIGNATURE, XDG_RUNTIME_DIR, WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS, DISPLAY, XAUTHORITY },
    // No uid off POSIX: no socket is then this account's.
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    list: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    // lstat unless told to follow: a link is none of the three, so a socket or file is never followed into another
    // account's.
    kind: (path, follow) => {
      try {
        const found = (follow ? statSync : lstatSync)(path)
        const type = found.isSocket() ? 'socket' : found.isFile() ? 'file' : found.isDirectory() ? 'folder' : null
        return type && { type, uid: found.uid }
      } catch {
        return null
      }
    },
    run: apps.run,
    onPath: apps.onPath,
  }
}
