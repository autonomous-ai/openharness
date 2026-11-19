import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDED_GNOME_SHELL } from '../../testing/recordedGnomeShell.js'
import { RECORDED_KWIN } from '../../testing/recordedKwin.js'
import { desktopLine, findLinuxDesktop, linuxDesktopDeps, type LinuxDesktop, type LinuxDesktopDeps } from './linuxDesktop.js'

const UID = 1000
const RUNTIME = '/run/user/1000'
const BUS = `unix:path=${RUNTIME}/bus`
const TOOLS = ['swaymsg', 'hyprctl', 'dbus-send', 'gdbus', 'wmctrl']

type Entry = { type: 'socket' | 'file' | 'folder'; uid: number }
type Answer = { code: number | null; stdout: string }
interface Call { file: string; args: string[]; timeoutMs: number }

const socket = (uid = UID): Entry => ({ type: 'socket', uid })
const file = (uid = UID): Entry => ({ type: 'file', uid })

interface Login {
  env?: LinuxDesktopDeps['env']
  files?: Record<string, Entry>
  tools?: string[]
  answers?: Record<string, Answer>
}

/** A made-up login: its variables (XDG_RUNTIME_DIR set unless the case says otherwise), its files by path (a folder's
 *  entries are the next names under it), its programs on PATH, and what each command answers by its whole argv, else
 *  exit 1. Nothing reads or runs anything of the developer's own desktop. */
function login({ env = {}, files = {}, tools = TOOLS, answers = {} }: Login = {}) {
  const calls: Call[] = []
  const deps: LinuxDesktopDeps = {
    env: { XDG_RUNTIME_DIR: RUNTIME, ...env },
    uid: UID,
    home: '/home/u',
    list: (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))],
    kind: (path) => files[path] ?? null,
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return answers[[file, ...args].join(' ')] ?? { code: 1, stdout: '' }
    },
    onPath: (name) => (tools.includes(name) ? `/usr/bin/${name}` : null),
  }
  return { calls, find: () => findLinuxDesktop(deps) }
}

const swayAsk = (path: string) => `/usr/bin/swaymsg -s ${path} -t get_version`
const sway = (...paths: string[]): Record<string, Answer> =>
  Object.fromEntries(paths.map((path) => [swayAsk(path), { code: 0, stdout: '{}' }]))

/** T5's call, on [bus]. */
const kwinAsk = (bus = BUS) =>
  ['/usr/bin/dbus-send', ...RECORDED_KWIN.nameHasOwner.args.slice(1).map((arg) => (arg.startsWith('--bus=') ? `--bus=${bus}` : arg))].join(' ')
const kwin = (bus = BUS, owned = true): Record<string, Answer> =>
  ({ [kwinAsk(bus)]: { code: 0, stdout: owned ? RECORDED_KWIN.nameHasOwner.stdout : RECORDED_KWIN.nameHasNoOwner.stdout } })

/** T6's calls, on [bus] in place of `--session`: the daemon may have no session bus variable of its own. */
const gdbusAsk = (args: readonly string[], bus: string) =>
  ['/usr/bin/gdbus', ...args.flatMap((arg) => (arg === '--session' ? ['--address', bus] : [arg]))].join(' ')
const gnome = (bus = BUS, extension = true): Record<string, Answer> => ({
  ...kwin(bus, false),
  [gdbusAsk(RECORDED_GNOME_SHELL.shellOwned.args, bus)]: { code: 0, stdout: RECORDED_GNOME_SHELL.shellOwned.stdout },
  [gdbusAsk(RECORDED_GNOME_SHELL.introspect.args, bus)]: extension
    ? { code: RECORDED_GNOME_SHELL.introspect.code, stdout: RECORDED_GNOME_SHELL.introspect.stdout }
    : { code: RECORDED_GNOME_SHELL.introspectWithout.code, stdout: RECORDED_GNOME_SHELL.introspectWithout.stdout },
})

const SWAY_SOCKET = `${RUNTIME}/sway-ipc.1000.42.sock`
const HYPR_SOCKET = (signature: string) => `${RUNTIME}/hypr/${signature}/.socket.sock`
const NO_SESSION: LinuxDesktop = { kind: 'none', why: 'no desktop session' }

describe('findLinuxDesktop', () => {
  it.each<[string, Login, LinuxDesktop]>([
    // sway
    ['sway from SWAYSOCK', { env: { SWAYSOCK: '/work/sway.sock' }, files: { '/work/sway.sock': socket() }, answers: sway('/work/sway.sock') },
      { kind: 'sway', socket: '/work/sway.sock' }],
    ['sway from its socket alone', { files: { [SWAY_SOCKET]: socket() }, answers: sway(SWAY_SOCKET) }, { kind: 'sway', socket: SWAY_SOCKET }],
    ['a relative SWAYSOCK is no sway', { env: { SWAYSOCK: 'sway.sock' }, files: { 'sway.sock': socket() }, answers: sway('sway.sock') }, NO_SESSION],
    ['a SWAYSOCK of another uid is no sway', { env: { SWAYSOCK: '/work/sway.sock' }, files: { '/work/sway.sock': socket(1001) }, answers: sway('/work/sway.sock') },
      NO_SESSION],
    ['a sway socket of another uid is no sway', { files: { [SWAY_SOCKET]: socket(1001) }, answers: sway(SWAY_SOCKET) }, NO_SESSION],
    ['a sway socket named for another uid is no sway',
      { files: { [`${RUNTIME}/sway-ipc.1001.42.sock`]: socket() }, answers: sway(`${RUNTIME}/sway-ipc.1001.42.sock`) }, NO_SESSION],
    ['a sway socket that is a file is no sway', { files: { [SWAY_SOCKET]: file() }, answers: sway(SWAY_SOCKET) }, NO_SESSION],
    ['two sway sockets of which the second answers: the second',
      { files: { [`${RUNTIME}/sway-ipc.1000.41.sock`]: socket(), [SWAY_SOCKET]: socket() }, answers: sway(SWAY_SOCKET) },
      { kind: 'sway', socket: SWAY_SOCKET }],
    ['a stale SWAYSOCK beside a live socket: the live one',
      { env: { SWAYSOCK: '/work/sway.sock' }, files: { '/work/sway.sock': socket(), [SWAY_SOCKET]: socket() }, answers: sway(SWAY_SOCKET) },
      { kind: 'sway', socket: SWAY_SOCKET }],
    ['a sway socket with no swaymsg', { files: { [SWAY_SOCKET]: socket() }, tools: ['wmctrl'] }, { kind: 'none', why: 'no swaymsg' }],
    ['sway beside a DISPLAY is sway', { env: { DISPLAY: ':0' }, files: { [SWAY_SOCKET]: socket() }, answers: sway(SWAY_SOCKET) },
      { kind: 'sway', socket: SWAY_SOCKET }],
    // Hyprland
    ['Hyprland from HYPRLAND_INSTANCE_SIGNATURE',
      { env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc_2' }, files: { [HYPR_SOCKET('abc_1')]: socket(), [HYPR_SOCKET('abc_2')]: socket() } },
      { kind: 'hyprland', signature: 'abc_2' }],
    ['Hyprland from its folder alone', { files: { [HYPR_SOCKET('abc_1')]: socket() } }, { kind: 'hyprland', signature: 'abc_1' }],
    ['a signature out of form is no Hyprland',
      { env: { HYPRLAND_INSTANCE_SIGNATURE: '../../tmp/x' }, files: { '/run/user/tmp/x/.socket.sock': socket() } }, NO_SESSION],
    ['a stale signature beside a live folder: the folder',
      { env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc_9' }, files: { [HYPR_SOCKET('abc_1')]: socket() } }, { kind: 'hyprland', signature: 'abc_1' }],
    ['a Hyprland socket of another uid is no Hyprland',
      { env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc_1' }, files: { [HYPR_SOCKET('abc_1')]: socket(1001) } }, NO_SESSION],
    ['a Hyprland socket with no hyprctl', { files: { [HYPR_SOCKET('abc_1')]: socket() }, tools: ['wmctrl'] }, { kind: 'none', why: 'no hyprctl' }],
    // KDE
    ['KDE from DBUS_SESSION_BUS_ADDRESS',
      { env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/work/bus' }, files: { '/work/bus': socket() }, answers: kwin('unix:path=/work/bus') },
      { kind: 'kwin', bus: 'unix:path=/work/bus', runtimeDir: RUNTIME }],
    ['KDE on an abstract bus, its guid left off',
      { env: { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-AbC,guid=0123' }, answers: kwin('unix:abstract=/tmp/dbus-AbC') },
      { kind: 'kwin', bus: 'unix:abstract=/tmp/dbus-AbC', runtimeDir: RUNTIME }],
    ['KDE from the runtime bus alone', { files: { [`${RUNTIME}/bus`]: socket() }, answers: kwin() }, { kind: 'kwin', bus: BUS, runtimeDir: RUNTIME }],
    ['a bus out of form: the runtime bus',
      { env: { DBUS_SESSION_BUS_ADDRESS: 'tcp:host=box,port=1' }, files: { [`${RUNTIME}/bus`]: socket() }, answers: kwin() },
      { kind: 'kwin', bus: BUS, runtimeDir: RUNTIME }],
    ['a bus socket of another uid is no KDE',
      { env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/work/bus' }, files: { '/work/bus': socket(1001), [`${RUNTIME}/bus`]: socket(1001) },
        answers: { ...kwin('unix:path=/work/bus'), ...kwin() } }, NO_SESSION],
    ['KWin not on the bus is no KDE', { files: { [`${RUNTIME}/bus`]: socket() }, answers: kwin(BUS, false) }, NO_SESSION],
    ['KDE with no dbus-send is no KDE', { files: { [`${RUNTIME}/bus`]: socket() }, tools: ['gdbus', 'wmctrl'], answers: kwin() }, NO_SESSION],
    ['KDE with no runtime dir is no KDE',
      { env: { XDG_RUNTIME_DIR: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-AbC' }, answers: kwin('unix:abstract=/tmp/dbus-AbC') },
      NO_SESSION],
    // GNOME
    ['GNOME from DBUS_SESSION_BUS_ADDRESS',
      { env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/work/bus', WAYLAND_DISPLAY: 'wayland-0' }, files: { '/work/bus': socket() },
        answers: gnome('unix:path=/work/bus') }, { kind: 'gnome', bus: 'unix:path=/work/bus' }],
    ['GNOME from the runtime bus alone', { files: { [`${RUNTIME}/bus`]: socket(), [`${RUNTIME}/wayland-0`]: socket() }, answers: gnome() },
      { kind: 'gnome', bus: BUS }],
    ['GNOME without the extension, from WAYLAND_DISPLAY',
      { env: { WAYLAND_DISPLAY: 'wayland-0' }, files: { [`${RUNTIME}/bus`]: socket() }, answers: gnome(BUS, false) },
      { kind: 'none', why: 'gnome without the extension' }],
    ['GNOME without the extension, from the Wayland socket alone',
      { files: { [`${RUNTIME}/bus`]: socket(), [`${RUNTIME}/wayland-0`]: socket() }, answers: gnome(BUS, false) },
      { kind: 'none', why: 'gnome without the extension' }],
    ['GNOME without the extension on X11 is X11',
      { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/bus`]: socket() }, answers: gnome(BUS, false) }, { kind: 'x11', display: ':0' }],
    ['GNOME with no gdbus is an unknown compositor',
      { env: { WAYLAND_DISPLAY: 'wayland-0' }, files: { [`${RUNTIME}/bus`]: socket() }, tools: ['dbus-send', 'wmctrl'], answers: gnome() },
      { kind: 'none', why: 'unknown compositor' }],
    // X11
    ['X11 from DISPLAY', { env: { DISPLAY: ':1.0' } }, { kind: 'x11', display: ':1.0' }],
    ['X11 from its socket alone, the lowest of root\'s and this uid\'s, never a third uid\'s',
      { files: { '/tmp/.X11-unix/X0': socket(1001), '/tmp/.X11-unix/X2': socket(), '/tmp/.X11-unix/X1': socket(0) } }, { kind: 'x11', display: ':1' }],
    ['an X socket of a third uid is no X11', { files: { '/tmp/.X11-unix/X0': socket(1001) } }, NO_SESSION],
    ['DISPLAY=localhost:10.0 is no display', { env: { DISPLAY: 'localhost:10.0' } }, NO_SESSION],
    ['an X socket named out of form is no X11', { files: { '/tmp/.X11-unix/X01': socket() } }, NO_SESSION],
    ['a display with no wmctrl', { env: { DISPLAY: ':0' }, tools: ['swaymsg'] }, { kind: 'none', why: 'no wmctrl' }],
    ['X11 with XAUTHORITY', { env: { DISPLAY: ':0', XAUTHORITY: '/work/xauth' }, files: { '/work/xauth': file(), '/home/u/.Xauthority': file() } },
      { kind: 'x11', display: ':0', xauthority: '/work/xauth' }],
    ['a relative XAUTHORITY: the home\'s', { env: { DISPLAY: ':0', XAUTHORITY: 'xauth' }, files: { xauth: file(), '/home/u/.Xauthority': file() } },
      { kind: 'x11', display: ':0', xauthority: '/home/u/.Xauthority' }],
    ['an XAUTHORITY that is not there: the home\'s', { env: { DISPLAY: ':0', XAUTHORITY: '/work/xauth' }, files: { '/home/u/.Xauthority': file() } },
      { kind: 'x11', display: ':0', xauthority: '/home/u/.Xauthority' }],
    ['X11 with the session\'s Xwayland auth', { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/.mutter-Xwaylandauth.AbC123`]: file() } },
      { kind: 'x11', display: ':0', xauthority: `${RUNTIME}/.mutter-Xwaylandauth.AbC123` }],
    ['X11 with the session\'s xauth_ file', { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/xauth_AbCdEf`]: file() } },
      { kind: 'x11', display: ':0', xauthority: `${RUNTIME}/xauth_AbCdEf` }],
    ['an auth file of another uid is none', { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/xauth_AbCdEf`]: file(1001) } },
      { kind: 'x11', display: ':0' }],
    // Nothing above
    ['a DISPLAY beside WAYLAND_DISPLAY is an unknown compositor', { env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } },
      { kind: 'none', why: 'unknown compositor' }],
    ['a DISPLAY beside a Wayland socket alone is an unknown compositor', { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/wayland-1`]: socket() } },
      { kind: 'none', why: 'unknown compositor' }],
    ['a Wayland socket of another uid is no Wayland', { env: { DISPLAY: ':0' }, files: { [`${RUNTIME}/wayland-1`]: socket(1001) } },
      { kind: 'x11', display: ':0' }],
    ['nothing at all', {}, NO_SESSION],
    ['a relative XDG_RUNTIME_DIR is ignored',
      { env: { XDG_RUNTIME_DIR: 'run/user/1000' }, files: { 'run/user/1000/sway-ipc.1000.42.sock': socket(), 'run/user/1000/wayland-0': socket() },
        answers: sway('run/user/1000/sway-ipc.1000.42.sock') }, NO_SESSION],
  ])('%s', async (_, setup, desktop) => {
    await expect(login(setup).find()).resolves.toEqual(desktop)
  })

  it('asks at most four sway sockets', async () => {
    const paths = [1, 2, 3, 4, 5].map((n) => `${RUNTIME}/sway-ipc.1000.${n}.sock`)
    const { calls, find } = login({ files: Object.fromEntries(paths.map((path) => [path, socket()])), answers: sway(paths[4]) })
    await expect(find()).resolves.toEqual(NO_SESSION)
    expect(calls.map(({ args }) => args[1])).toEqual(paths.slice(0, 4))
  })

  it('every command runs within 10 s', async () => {
    const { calls, find } = login({ files: { [SWAY_SOCKET]: socket(), [`${RUNTIME}/bus`]: socket() }, answers: gnome() })
    await expect(find()).resolves.toEqual({ kind: 'gnome', bus: BUS })
    expect(calls.map(({ file, timeoutMs }) => [file, timeoutMs])).toEqual([
      ['/usr/bin/swaymsg', 10_000], ['/usr/bin/dbus-send', 10_000], ['/usr/bin/gdbus', 10_000], ['/usr/bin/gdbus', 10_000],
    ])
  })

  it('a command that rejects answers no', async () => {
    const deps: LinuxDesktopDeps = {
      env: { XDG_RUNTIME_DIR: RUNTIME },
      uid: UID,
      home: '/home/u',
      list: () => ['sway-ipc.1000.42.sock'],
      kind: () => socket(),
      run: () => Promise.reject(new Error('spawn')),
      onPath: (name) => `/usr/bin/${name}`,
    }
    await expect(findLinuxDesktop(deps)).resolves.toEqual(NO_SESSION)
  })
})

describe('desktopLine', () => {
  it.each<[LinuxDesktop, string]>([
    [{ kind: 'sway', socket: SWAY_SOCKET }, '[device] raise · sway'],
    [{ kind: 'hyprland', signature: 'abc_1' }, '[device] raise · hyprland'],
    [{ kind: 'kwin', bus: BUS, runtimeDir: RUNTIME }, '[device] raise · kwin'],
    [{ kind: 'gnome', bus: BUS }, '[device] raise · gnome'],
    [{ kind: 'x11', display: ':0', xauthority: '/home/u/.Xauthority' }, '[device] raise · x11'],
    [{ kind: 'none', why: 'no desktop session' }, '[device] raise · none · no desktop session'],
    [{ kind: 'none', why: 'gnome without the extension' }, '[device] raise · none · gnome without the extension'],
    [{ kind: 'none', why: 'unknown compositor' }, '[device] raise · none · unknown compositor'],
    [{ kind: 'none', why: 'no swaymsg' }, '[device] raise · none · no swaymsg'],
    [{ kind: 'none', why: 'no hyprctl' }, '[device] raise · none · no hyprctl'],
    [{ kind: 'none', why: 'no wmctrl' }, '[device] raise · none · no wmctrl'],
  ])('%o says %s', (desktop, line) => expect(desktopLine(desktop)).toBe(line))
})

describe('linuxDesktopDeps', () => {
  let folder: string | undefined
  afterEach(() => {
    vi.unstubAllEnvs()
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  it('reads this process\'s own variables, uid and home, and hands on the apps\' runner and PATH', () => {
    const values = {
      SWAYSOCK: '/work/sway.sock', HYPRLAND_INSTANCE_SIGNATURE: 'abc_1', XDG_RUNTIME_DIR: RUNTIME, WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: BUS, DISPLAY: ':0', XAUTHORITY: '/work/xauth',
    }
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
    const apps = { run: async () => ({ code: 0, stdout: '' }), onPath: () => null }
    const deps = linuxDesktopDeps(apps)
    expect(deps.env).toEqual(values)
    expect(deps.uid).toBe(process.getuid?.())
    expect(deps.home).toBe(homedir())
    expect(deps.run).toBe(apps.run)
    expect(deps.onPath).toBe(apps.onPath)
  })

  it('says what a path is and whose, and lists a folder, on the real file system', async () => {
    folder = mkdtempSync(join(tmpdir(), 'linuxDesktop-'))
    writeFileSync(join(folder, 'f'), '')
    mkdirSync(join(folder, 'd'))
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(join(folder!, 's'), () => resolve()))
    try {
      const deps = linuxDesktopDeps({ run: async () => ({ code: 0, stdout: '' }), onPath: () => null })
      const uid = process.getuid!()
      expect(deps.kind(join(folder, 'f'))).toEqual({ type: 'file', uid })
      expect(deps.kind(join(folder, 'd'))).toEqual({ type: 'folder', uid })
      expect(deps.kind(join(folder, 's'))).toEqual({ type: 'socket', uid })
      expect(deps.kind(join(folder, 'gone'))).toBeNull()
      expect(deps.list(folder).sort()).toEqual(['d', 'f', 's'])
      expect(deps.list(join(folder, 'gone'))).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
