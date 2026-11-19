import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECORDED_GNOME_SHELL } from '../../testing/recordedGnomeShell.js'
import { RECORDED_HYPRLAND } from '../../testing/recordedHyprland.js'
import { RECORDED_KWIN } from '../../testing/recordedKwin.js'
import { RECORDED_SWAY } from '../../testing/recordedSway.js'
import { RECORDED_WMCTRL } from '../../testing/recordedWmctrl.js'
import type { LinuxDesktop } from './linuxDesktop.js'
import { createLinuxRaise, systemLinuxRaise, type LinuxRaiseDeps, type RaiseTarget } from './linuxRaise.js'
import type { OrcaDeps } from './orca.js'
import { WALK_PARENTS } from './scannedApp.js'

/** The paths the file system says are another account's, when a test says so: no test can make one. */
const foreign = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    lstatSync: ((path: string, options?: object) => {
      const seen = real.lstatSync(path, options)
      if (seen && foreign.has(path)) seen.uid += 1
      return seen
    }) as typeof real.lstatSync,
  }
})

const SWAY: LinuxDesktop = { kind: 'sway', socket: '/run/user/1000/sway-ipc.1000.7.sock' }
const HYPRLAND: LinuxDesktop = { kind: 'hyprland', signature: 'abc_1700000000_x' }
const NONE: LinuxDesktop = { kind: 'none', why: 'gnome without the extension' }
const GNOME: LinuxDesktop = { kind: 'gnome', bus: 'unix:abstract=/tmp/dbus-u' }
const CLASSES: Record<string, string[]> = { wezterm: ['org.wezfurlong.wezterm'], code: ['Code', 'code'] }

type Process = { pid: number; ppid: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A made-up login: each look answers the next of [desktops] (the last again once they run out), each raise answers
 *  [answer], and the process table is [table]. Nothing reads or runs anything of the developer's own desktop. */
function login({ desktops = [SWAY], answer = async () => true, table = async () => [] }: {
  desktops?: LinuxDesktop[]
  answer?: (target: RaiseTarget) => Promise<boolean>
  table?: () => Promise<readonly Process[]>
} = {}) {
  const lines: string[] = []
  const raised: { desktop: LinuxDesktop; target: RaiseTarget }[] = []
  let looks = 0
  const deps: LinuxRaiseDeps = {
    find: vi.fn(async () => desktops[Math.min(looks++, desktops.length - 1)]),
    backend: (desktop) => ({
      raise: (target) => {
        raised.push({ desktop, target })
        return answer(target)
      },
    }),
    processes: vi.fn(table),
    classes: (app) => CLASSES[app] ?? [],
    log: (line) => lines.push(line),
  }
  return { deps, lines, raised, looks: () => looks, raise: createLinuxRaise(deps) }
}

describe('createLinuxRaise', () => {
  it('logs the desktop it found once, and again only when a later look differs', async () => {
    const { raise, lines, looks } = login({ desktops: [SWAY, SWAY, HYPRLAND], answer: async () => false })
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · sway']))
    expect(await raise.raise({ app: 'wezterm' })).toBe(false)
    await vi.waitFor(() => expect(looks()).toBe(2))
    expect(await raise.raise({ app: 'wezterm' })).toBe(false)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · sway', '[device] raise · hyprland']))
  })

  it('is not ready before the first look lands, and is ready once it found a desktop', async () => {
    const look = deferred<LinuxDesktop>()
    const { deps } = login()
    deps.find = () => look.promise
    const raise = createLinuxRaise(deps)
    expect(raise.ready({ agent: true })).toBe(false)
    look.resolve(SWAY)
    await vi.waitFor(() => expect(raise.ready({ agent: true })).toBe(true))
  })

  it('is not ready when the look found no desktop, and raises nothing', async () => {
    const { raise, lines, raised } = login({ desktops: [NONE] })
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · none · gnome without the extension']))
    expect(raise.ready({ agent: true })).toBe(false)
    expect(await raise.raise({ pid: 4242, app: 'wezterm' })).toBe(false)
    expect(raised).toEqual([])
  })

  it('takes a look that throws as no desktop session, and raises nothing', async () => {
    const { deps, lines, raised } = login()
    deps.find = () => Promise.reject(new Error('look'))
    const raise = createLinuxRaise(deps)
    expect(await raise.raise({ pid: 4242, app: 'wezterm' })).toBe(false)
    expect(raise.ready({ agent: true })).toBe(false)
    // login() made a raise of its own over the same log, which found sway.
    expect(lines).toContain('[device] raise · none · no desktop session')
    expect(raised).toEqual([])
  })

  it('is ready for an agent on a desktop that raises by process, and for an app alone only with its class', async () => {
    const { raise } = login()
    await vi.waitFor(() => expect(raise.ready({ agent: true })).toBe(true))
    expect(raise.ready({ agent: true, app: 'warp' })).toBe(true)
    expect(raise.ready({ agent: false, app: 'wezterm' })).toBe(true)
    expect(raise.ready({ agent: false, app: 'warp' })).toBe(false)
    expect(raise.ready({ agent: false })).toBe(false)
  })

  // GNOME's extension matches a window by its app's class alone: an agent in an app with none has nothing to raise.
  it('on GNOME is ready only for an app with a class, and runs no backend nor a new look for one without', async () => {
    const { raise, raised, looks } = login({ desktops: [GNOME], table: async () => [{ pid: 100, ppid: 1 }] })
    await vi.waitFor(() => expect(raise.ready({ agent: true, app: 'wezterm' })).toBe(true))
    expect(raise.ready({ agent: true, app: 'warp' })).toBe(false)
    expect(raise.ready({ agent: true })).toBe(false)
    expect(await raise.raise({ pid: 100, app: 'warp' })).toBe(false)
    expect(raised).toEqual([])
    expect(await raise.raise({ pid: 100, app: 'wezterm' })).toBe(true)
    expect(raised).toEqual([{ desktop: GNOME, target: { pids: [], classes: ['org.wezfurlong.wezterm'] } }])
    expect(looks()).toBe(1)
  })

  it('waits for the look under way before it raises', async () => {
    const look = deferred<LinuxDesktop>()
    const { deps, raised } = login()
    deps.find = () => look.promise
    const raise = createLinuxRaise(deps)
    const answer = raise.raise({ app: 'code' })
    look.resolve(HYPRLAND)
    expect(await answer).toBe(true)
    expect(raised).toEqual([{ desktop: HYPRLAND, target: { pids: [], classes: ['Code', 'code'] } }])
  })

  it("passes the agent's process and its parents, nearest first, as far as parentChain walks", async () => {
    // 100 → 101 → … → 139 → 1: longer than a walk goes.
    const table = Array.from({ length: 40 }, (_, i) => ({ pid: 100 + i, ppid: i === 39 ? 1 : 101 + i }))
    const { raise, raised } = login({ table: async () => table })
    expect(await raise.raise({ pid: 100, app: 'wezterm' })).toBe(true)
    const pids = Array.from({ length: WALK_PARENTS + 1 }, (_, i) => 100 + i)
    expect(raised).toEqual([{ desktop: SWAY, target: { pids, classes: ['org.wezfurlong.wezterm'] } }])
  })

  it.each([1, 0, -5, 2.5, Number.NaN, 999])('takes no process for the pid %s, and raises by class', async (pid) => {
    const { raise, raised } = login({ table: async () => [{ pid: 100, ppid: 1 }] })
    expect(await raise.raise({ pid, app: 'code' })).toBe(true)
    expect(raised.map(({ target }) => target)).toEqual([{ pids: [], classes: ['Code', 'code'] }])
  })

  it('raises by class when the process table cannot be read', async () => {
    const { raise, raised } = login({ table: () => Promise.reject(new Error('ps')) })
    expect(await raise.raise({ pid: 4242, app: 'wezterm' })).toBe(true)
    expect(raised.map(({ target }) => target)).toEqual([{ pids: [], classes: ['org.wezfurlong.wezterm'] }])
  })

  it.each([
    ['no pid and no app', {}],
    ['no pid and an app with no class', { app: 'herdr' }],
    ['a pid not in the table and no app', { pid: 4242 }],
  ])('runs no backend for %s', async (_, window) => {
    const { raise, raised } = login({ table: async () => [{ pid: 100, ppid: 1 }] })
    expect(await raise.raise(window)).toBe(false)
    expect(raised).toEqual([])
  })

  it('looks again after a failed raise, and the next raise uses the new desktop', async () => {
    const { raise, raised, looks } = login({ desktops: [SWAY, HYPRLAND], answer: async () => raised.length > 1 })
    expect(await raise.raise({ app: 'code' })).toBe(false)
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(raised.map(({ desktop }) => desktop)).toEqual([SWAY, HYPRLAND])
    expect(looks()).toBe(2)
  })

  it('does not look again after a raise that worked', async () => {
    const { raise, looks } = login()
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(await raise.raise({ app: 'code' })).toBe(true)
    expect(looks()).toBe(1)
  })

  it('answers false when the backend throws, and looks again', async () => {
    const { raise, looks } = login({ answer: () => Promise.reject(new Error('boom')) })
    expect(await raise.raise({ app: 'code' })).toBe(false)
    await vi.waitFor(() => expect(looks()).toBe(2))
  })

  it('runs two raises at once', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const pending = [first, second]
    const { raise, raised } = login({ answer: () => pending[raised.length - 1].promise })
    const both = [raise.raise({ app: 'code' }), raise.raise({ app: 'wezterm' })]
    await vi.waitFor(() => expect(raised).toHaveLength(2))
    second.resolve(true)
    first.resolve(true)
    expect(await Promise.all(both)).toEqual([true, true])
  })
})

describe('systemLinuxRaise', () => {
  const VARIABLES = ['SWAYSOCK', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XAUTHORITY'] as const
  // Abstract: no socket on disk to make, and the session bus's own form.
  const BUS = 'unix:abstract=/tmp/dbus-u'
  let folder: string
  const servers: Server[] = []
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'linuxRaise-'))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    foreign.clear()
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
    rmSync(folder, { recursive: true, force: true })
  })

  /** This login's variables as the case gives them, every other one empty: none of the developer's own is read. */
  const session = (values: Partial<Record<typeof VARIABLES[number], string>>) => {
    for (const name of VARIABLES) vi.stubEnv(name, values[name] ?? '')
  }
  /** A socket this account owns, listening at [path]. */
  const socket = async (path: string) => {
    mkdirSync(dirname(path), { recursive: true })
    const server = createServer()
    servers.push(server)
    await new Promise<void>((done) => server.listen(path, done))
  }
  /** A machine with every program on PATH in /usr/bin, each run kept and answered by [answer] (else exit 1): the
   *  devices' own runner, so nothing of the developer's runs. */
  const machine = (answer: (args: string[]) => { code: number; stdout: string } | undefined) => {
    const runs: Array<[string, string[], number]> = []
    const lines: string[] = []
    const apps: OrcaDeps = {
      run: async (file, args, timeoutMs) => {
        runs.push([file, args, timeoutMs])
        return answer(args) ?? { code: 1, stdout: '' }
      },
      onPath: (name) => `/usr/bin/${name}`,
      exists: () => false,
      platform: 'linux',
    }
    return { runs, lines, raise: systemLinuxRaise(apps, (line) => lines.push(line)) }
  }

  it('on sway asks swaymsg for its windows over the socket found', async () => {
    const sway = join(folder, 'sway.sock')
    await socket(sway)
    session({ SWAYSOCK: sway })
    const { runs, lines, raise } = machine((args) =>
      args.includes('get_version') ? { code: 0, stdout: RECORDED_SWAY.getVersion.stdout }
        : args.includes('get_tree') ? { code: 0, stdout: RECORDED_SWAY.tree } : undefined)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · sway']))
    expect(raise.ready({ agent: true })).toBe(true)
    await raise.raise({ app: 'kitty' })
    expect(runs).toContainEqual(['/usr/bin/swaymsg', ['-s', sway, '-t', 'get_tree'], 10_000])
  })

  it('on Hyprland asks hyprctl for its windows with the instance found', async () => {
    // Made up and short: a socket's path has a length limit, and a recorded signature with this folder passes it.
    const signature = 'abc_1_x'
    await socket(join(folder, 'hypr', signature, '.socket.sock'))
    session({ XDG_RUNTIME_DIR: folder })
    // `version`'s exit code alone: no reply of it was recorded (RECORDED_HYPRLAND).
    const { runs, lines, raise } = machine((args) =>
      args.includes('version') ? { code: 0, stdout: '' }
        : args.includes('clients') ? { code: 0, stdout: RECORDED_HYPRLAND.clients.stdout } : undefined)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · hyprland']))
    await raise.raise({ app: 'kitty' })
    expect(runs).toContainEqual(['/usr/bin/hyprctl', ['-i', signature, 'clients', '-j'], 10_000])
  })

  it('on KDE writes its script to a private folder in the runtime dir, 0600, a name each raise, and removes it', async () => {
    session({ XDG_RUNTIME_DIR: folder, DBUS_SESSION_BUS_ADDRESS: BUS })
    const loaded: Array<{ file: string; mode: number; folderMode: number }> = []
    const { runs, lines, raise } = machine((args) => {
      if (args.includes('string:org.kde.KWin')) return { code: 0, stdout: RECORDED_KWIN.nameHasOwner.stdout }
      if (args.includes('org.kde.kwin.Scripting.loadScript')) {
        const file = args.find((arg) => arg.startsWith('string:/'))!.slice('string:'.length)
        loaded.push({ file, mode: statSync(file).mode & 0o777, folderMode: statSync(dirname(file)).mode & 0o777 })
        return { code: 0, stdout: RECORDED_KWIN.loadScript.stdout }
      }
      if (args.includes('org.kde.kwin.Script.run')) return { code: 0, stdout: RECORDED_KWIN.run.stdout }
      if (args.includes('org.kde.kwin.Scripting.unloadScript')) return { code: 0, stdout: RECORDED_KWIN.unloadScript.stdout }
      return undefined
    })
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · kwin']))
    expect(await raise.raise({ app: 'kitty' })).toBe(true)
    expect(await raise.raise({ app: 'kitty' })).toBe(true)
    expect(runs.filter(([file]) => file !== '/usr/bin/dbus-send')).toEqual([])
    expect(loaded.map(({ mode, folderMode }) => [mode, folderMode])).toEqual([[0o600, 0o700], [0o600, 0o700]])
    for (const { file } of loaded) {
      expect(dirname(file)).toBe(join(folder, 'harness'))
      expect(file).toMatch(new RegExp(`/raise-${process.pid}-[0-9]+\\.js$`))
      expect(existsSync(file)).toBe(false)
    }
    expect(loaded[0].file).not.toBe(loaded[1].file)
  })

  it.each([
    ['the runtime dir is not 0700', (runtime: string) => chmodSync(runtime, 0o755)],
    ['harness is a link', (runtime: string) => {
      mkdirSync(join(runtime, 'elsewhere'))
      symlinkSync(join(runtime, 'elsewhere'), join(runtime, 'harness'))
    }],
    ["harness is another account's", (runtime: string) => {
      mkdirSync(join(runtime, 'harness'), { mode: 0o700 })
      foreign.add(join(runtime, 'harness'))
    }],
  ])('on KDE writes no script and loads none when %s', async (_, arrange) => {
    arrange(folder)
    session({ XDG_RUNTIME_DIR: folder, DBUS_SESSION_BUS_ADDRESS: BUS })
    // A KWin that would load and run any script it is handed.
    const { runs, lines, raise } = machine((args) =>
      args.includes('string:org.kde.KWin') ? { code: 0, stdout: RECORDED_KWIN.nameHasOwner.stdout }
        : args.includes('org.kde.kwin.Scripting.loadScript') ? { code: 0, stdout: RECORDED_KWIN.loadScript.stdout }
          : args.includes('org.kde.kwin.Script.run') ? { code: 0, stdout: RECORDED_KWIN.run.stdout } : undefined)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · kwin']))
    expect(await raise.raise({ app: 'kitty' })).toBe(false)
    expect(runs.filter(([, args]) => args.includes('org.kde.kwin.Scripting.loadScript'))).toEqual([])
    for (const each of [join(folder, 'harness'), join(folder, 'elsewhere')]) {
      if (existsSync(each)) expect(readdirSync(each), each).toEqual([])
    }
  })

  it('on GNOME asks the extension for the app\'s class over the bus found', async () => {
    session({ DBUS_SESSION_BUS_ADDRESS: BUS })
    const { runs, lines, raise } = machine((args) =>
      args.includes('org.gnome.Shell') && args.includes('org.freedesktop.DBus.NameHasOwner') ? { code: 0, stdout: RECORDED_GNOME_SHELL.shellOwned.stdout }
        : args[0] === 'introspect' ? { code: 0, stdout: RECORDED_GNOME_SHELL.introspect.stdout }
          : args.includes('de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass') ? { code: 0, stdout: RECORDED_GNOME_SHELL.activateHit.stdout }
            : undefined)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · gnome']))
    expect(await raise.raise({ app: 'kitty' })).toBe(true)
    expect(runs.at(-1)).toEqual(['/usr/bin/gdbus', [
      'call', '--address', BUS, '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
      '--method', 'de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass', 'kitty',
    ], 10_000])
  })

  it('on X11 asks wmctrl for its windows with the display and cookie found', async () => {
    const cookie = join(folder, 'xauth')
    writeFileSync(cookie, '')
    session({ DISPLAY: ':0', XAUTHORITY: cookie })
    const { runs, lines, raise } = machine((args) => args.includes('-lpx') ? { code: 0, stdout: RECORDED_WMCTRL.lpx } : undefined)
    await vi.waitFor(() => expect(lines).toEqual(['[device] raise · x11']))
    await raise.raise({ app: 'kitty' })
    expect(runs).toContainEqual(['/usr/bin/env', ['DISPLAY=:0', `XAUTHORITY=${cookie}`, 'wmctrl', '-lpx'], 10_000])
  })
})
