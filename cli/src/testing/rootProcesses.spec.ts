import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertTestRoot, codexDaemons, codexPidFiles, endRootProcesses, lsofFolders, ownFolders, rootProcesses, workingFolders, type PidRow } from './rootProcesses.js'
import { alive, commandLines, processTable, type NamedRow } from './spawnedRuns.js'

const row = (pid: number, ppid: number, pgid: number, command: string): NamedRow => ({ pid, ppid, pgid, command })
const ROOT = '/tmp/htmux-abc'
/** The caller is 50, started by 41, in the group 40 leads. */
const OWN = [row(40, 1, 40, 'node vitest'), row(41, 40, 40, 'node (vitest 1)'), row(50, 41, 40, 'node (vitest 2)')]

/** Asks [probe] every 50 ms until it answers, at most 10 s. */
async function until<T>(probe: () => T | null): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const found = probe()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error('timed out after 10000 ms')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('rootProcesses', () => {
  it('a match that leads a group gives the group, with the members that do not name the root', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abc/bin/codex app-server'), row(101, 100, 100, 'node /repo/cli/e2e/harness/fakeEngine.mjs app-server')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [100], pids: [], all: [100, 101] })
  })

  it('a match that leads no group is alone: a test\'s own tmux call is in the worker\'s group', () => {
    const table = [...OWN, row(60, 50, 40, 'tmux -S /tmp/htmux-abc/tmux-501/default list-panes')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [60], all: [60] })
  })

  it('never the caller, its parent, pid 1, or the caller\'s own group as a group', () => {
    const named = (pid: number, ppid: number, pgid: number) => row(pid, ppid, pgid, `node ${ROOT}/x`)
    expect(rootProcesses(ROOT, [named(1, 0, 1), named(40, 1, 40), named(41, 40, 40), named(50, 41, 40)], 50)).toEqual({ groups: [], pids: [40], all: [40] })
  })

  it('names nothing but a test root: an empty path, `/` or a TMPDIR would name other runs\' processes, or every one', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abc/bin/codex app-server'), row(110, 1, 110, 'node /x')]
    for (const root of ['', '/', '/tmp', 'htmux-abc', '/tmp/htmux-abc/bin']) {
      expect(() => rootProcesses(root, table, 50), root).toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${root}`)
    }
  })

  it('a root whose path begins another\'s is not that root, nor is the root named alone', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abcd/bin/codex app-server'), row(110, 1, 110, 'rm -rf /tmp/htmux-abc')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [], all: [] })
  })
})

// A real engine started by name in a tile names no root: `claude`, `claude --resume <id>`. Many were found on a
// developer's Mac, parented to pid 1, each with its working folder in a test's root (audit of 2026-11-15).
describe('a process whose working folder is in the root', () => {
  it('is the test\'s, alone or with the group it leads, though its command line names nothing', () => {
    const table = [...OWN, row(100, 1, 100, 'claude'), row(101, 100, 100, 'node mcp-server'), row(110, 1, 90, 'claude --resume 1'),
      row(120, 1, 120, 'sleep 600'), row(130, 1, 130, 'sleep 600'), row(140, 1, 140, 'sleep 600')]
    // 120 is in a root whose name begins this one's, 130 outside, 140 not known.
    const folders = new Map([[100, ROOT], [110, `${ROOT}/projects/a`], [120, `${ROOT}d/projects`], [130, '/tmp']])
    expect(rootProcesses(ROOT, table, 50, folders)).toEqual({ groups: [100], pids: [110], all: [100, 101, 110] })
  })

  it('is never the caller, its parent or pid 1', () => {
    const table = [row(1, 0, 1, 'launchd'), ...OWN]
    expect(rootProcesses(ROOT, table, 50, new Map([[1, ROOT], [40, ROOT], [41, ROOT], [50, `${ROOT}/x`]]))).toEqual({ groups: [], pids: [40], all: [40] })
  })

  it('is read from lsof\'s fields, and kept only for a process of this account', () => {
    const rows = lsofFolders(`p100\nu501\nfcwd\nn${ROOT}/a b\np200\nu0\nfcwd\nn${ROOT}\np300\nu501\nfcwd\nn/\n`)
    expect(rows).toEqual([{ pid: 100, uid: 501, folder: `${ROOT}/a b` }, { pid: 200, uid: 0, folder: ROOT }, { pid: 300, uid: 501, folder: '/' }])
    expect([...ownFolders(rows, 501)]).toEqual([[100, `${ROOT}/a b`], [300, '/']])
    // Another account's process in the root is judged by its command line alone.
    const table = [...OWN, row(100, 1, 100, 'sleep 600'), row(200, 1, 200, 'sleep 600')]
    expect(rootProcesses(ROOT, table, 50, ownFolders(rows, 501))).toEqual({ groups: [100], pids: [], all: [100] })
  })

  it('is read for this process, on this machine', () => {
    expect(workingFolders([process.pid]).get(process.pid)).toBe(realpathSync(process.cwd()))
  })

  it.runIf(process.platform === 'darwin')('is unknown, said once, when lsof cannot run: the sweep then goes by command line', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('PATH', '/nowhere')
    try {
      expect(workingFolders([process.pid])).toEqual(new Map())
      expect(said.mock.calls).toEqual([[expect.stringMatching(/^\[e2e sweep\] no working folders read \(lsof: .+\): swept by command line alone$/)]])
    } finally { vi.unstubAllEnvs(); said.mockRestore() }
  })
})

describe('a test root', () => {
  let made: string[] = []
  afterEach(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); made = [] })
  /** A temporary folder with a root in it, a home and a checkout beside them: all made up. */
  const places = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    made.push(base)
    for (const name of ['tmp/htmux-abc', 'home', 'repo/cli/src/testing']) mkdirSync(join(base, name), { recursive: true })
    return { base, root: join(base, 'tmp', 'htmux-abc'), at: { tmp: join(base, 'tmp'), home: join(base, 'home'), checkout: join(base, 'repo', 'cli', 'src', 'testing') } }
  }

  it('is a folder isolatedTmux made, given as its real path, there or already removed', () => {
    const { root, at } = places()
    expect(() => assertTestRoot(root, at)).not.toThrow()
    rmSync(root, { recursive: true })
    expect(() => assertTestRoot(root, at)).not.toThrow()
  })

  it('is nothing else: not a folder outside the temporary one or deeper in it, a link, the home, or what holds the checkout', () => {
    const { base, root, at } = places()
    mkdirSync(join(root, 'htmux-deeper'))
    symlinkSync(join(base, 'home'), join(at.tmp, 'htmux-link'))
    const refused = (path: string, where = at) => expect(() => assertTestRoot(path, where), path).toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
    for (const path of ['', '/', at.tmp, 'htmux-abc', join(at.tmp, 'htmux-'), join(at.tmp, 'other'), join(base, 'htmux-abc'), join(root, 'htmux-deeper'), join(at.tmp, 'htmux-link')]) refused(path)
    // A temporary folder that is the home's parent, or the checkout's: the root would be the home, or hold the checkout.
    refused(root, { ...at, home: root })
    refused(root, { ...at, checkout: join(root, 'repo', 'cli', 'src', 'testing') })
    // Given through a link to the temporary folder: not its real path.
    symlinkSync(at.tmp, join(base, 'tmp-link'))
    refused(join(base, 'tmp-link', 'htmux-abc'))
  })
})

describe('endRootProcesses', () => {
  let root: string | undefined
  let leader: ChildProcess | undefined
  let started: ChildProcess[] = []
  // Only what this spec started, by its own pids: other sessions run end-to-end daemons on this machine.
  afterEach(() => {
    if (leader?.pid) { try { process.kill(-leader.pid, 'SIGKILL') } catch { /* the group is gone */ } }
    for (const child of started) child.kill('SIGKILL')
    if (root) rmSync(root, { recursive: true, force: true })
    root = leader = undefined
    started = []
  })

  it('ends a group that left its parent and a process of the caller\'s own group, and nothing else', async () => {
    const dir = root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-'))), idle = 'setInterval(() => {}, 1 << 30)'
    // A group of its own whose child names nothing of the root, as `codex app-server` is started (lib/codexRateLimits.ts).
    const group = leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); ${idle}`, join(dir, 'bin', 'codex')], { stdio: 'ignore', detached: true })
    // In this spec's own group, as a test's `tmux -S <root>/…` call is; and one under a root whose path begins this one's.
    const own = spawn(process.execPath, ['-e', idle, join(dir, 'own')], { stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', idle, `${dir}x/other`], { stdio: 'ignore' })
    started = [own, other]
    // Until each one runs its own command line: a process not yet past its exec still shows this worker's.
    const members = await until(() => {
      const rows = processTable().filter((each) => each.pgid === group.pid)
      const commands = commandLines([own.pid!, other.pid!])
      const running = (pid: number | undefined, path: string) => commands.get(pid!)?.includes(path)
      return rows.length === 2 && running(own.pid, join(dir, 'own')) && running(other.pid, `${dir}x/other`) ? rows.map((each) => each.pid) : null
    })
    // Each a child of this worker, in its tree: nothing needs to have been seen before.
    expect(await endRootProcesses(dir, new Map())).toEqual([])
    expect([...members, own.pid!].filter(alive)).toEqual([])
    expect(alive(other.pid!)).toBe(true)
  })

  it('ends a process left in the root whose command line names nothing, and none in a folder whose name begins the root\'s', async () => {
    const dir = root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    mkdirSync(join(dir, 'projects'))
    mkdirSync(`${dir}x`)
    const inside = spawn('sleep', ['600'], { cwd: join(dir, 'projects'), stdio: 'ignore' }), beside = spawn('sleep', ['600'], { cwd: `${dir}x`, stdio: 'ignore' })
    started = [inside, beside]
    await until(() => [...commandLines([inside.pid!, beside.pid!]).values()].filter((command) => command === 'sleep 600').length === 2 || null)
    try {
      expect(await endRootProcesses(dir, new Map())).toEqual([])
      expect([alive(inside.pid!), alive(beside.pid!)]).toEqual([false, true])
      // A second close of the same daemon: the root is gone, and nothing is left to end.
      rmSync(dir, { recursive: true, force: true })
      expect(await endRootProcesses(dir, new Map())).toEqual([])
    } finally { rmSync(`${dir}x`, { recursive: true, force: true }) }
  })

  it('signals nothing, and says which, for a root that is not a test\'s', async () => {
    const outer = root = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    const link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    mkdirSync(join(outer, 'htmux-abc'))
    symlinkSync(outer, link)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      for (const path of ['/', realpathSync(tmpdir()), outer, join(outer, 'htmux-abc'), link]) {
        await expect(endRootProcesses(path, new Map()), path).rejects.toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
      }
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      // The link itself: Node 23 to 24.3's rmSync refuses a link to a folder without `recursive` (ERR_FS_EISDIR).
      unlinkSync(link)
    }
  })
})

// Codex's managed app server detaches itself, names no root and need not work in it: a real one from the tester of #4660
// and #4668 outlived close(), launchd's. Codex records it in <CODEX_HOME>/app-server-daemon/daemon.pid.
describe('a Codex app server a pid file in the root names', () => {
  const IDLE = 'setInterval(() => {}, 1 << 30)'
  let made: string[] = []
  afterEach(() => { for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true }) })
  const folder = (prefix = 'codex-pid-files-') => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    made.push(path)
    return path
  }
  const pidFile = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  const daemonPid = (pid: number) => JSON.stringify({ pid, processStartTime: 'Mon Nov 23 10:00:03 2026' })
  /** Past any pid a real machine gives: macOS's are under 100000, Linux's at most 4194304. */
  const NO_SUCH_PID = 4_194_305

  it('is the test\'s while it is this account\'s, an app server, and started no sooner than the second before the root', () => {
    // The root made at 10:00:00.400; `ps` gives a start to the second.
    const root = Date.parse('Mon Nov 23 10:00:00 2026') + 400
    const server = 'codex app-server --managed-daemon'
    const pidRow = (pid: number, started: string, command = server, uid = 501): PidRow => ({ pid, uid, started, command })
    const rows = [
      pidRow(10, 'Mon Nov 23 10:00:03 2026'),
      // Linux's start can name the second before the one the clock was in (spawnedRuns.ts daemonOf).
      pidRow(11, 'Mon Nov 23 09:59:59 2026'),
      pidRow(12, 'Mon Nov 23 10:00:03 2026', 'node /x/node_modules/@openai/codex/bin/codex.js app-server --managed-daemon'),
      pidRow(20, 'Mon Nov 23 10:00:03 2026', server, 502),
      pidRow(21, 'Mon Nov 23 09:59:58 2026'),
      pidRow(22, 'Mon Nov 23 10:00:03 2026', 'node /x/node_modules/vitest/dist/workers/forks.js'),
      pidRow(23, 'Mon Nov 23 10:00:03 2026', 'codex exec hi'),
      pidRow(24, 'Mon Nov 23 10:00:03 2026', '/x/codex-tools app-server'),
      pidRow(25, ''),
    ]
    expect(codexDaemons(rows, root, 501)).toEqual([10, 11, 12])
  })

  it('is read from a pid file 4 folders below the root at most, never through a link, soft or hard', () => {
    const root = folder(), outside = folder()
    pidFile(join(root, 'home', 'codex', 'app-server-daemon', 'daemon.pid'), daemonPid(1001))
    pidFile(join(root, 'b1', 'h', 'x', 'app-server-daemon', 'daemon.pid'), daemonPid(1002))
    pidFile(join(root, 'a', 'b', 'c', 'd', 'app-server-daemon', 'daemon.pid'), daemonPid(1003))
    pidFile(join(outside, 'codex', 'app-server-daemon', 'daemon.pid'), daemonPid(1004))
    symlinkSync(outside, join(root, 'link'))
    symlinkSync(join(outside, 'codex', 'app-server-daemon'), join(root, 'home', 'app-server-daemon'))
    mkdirSync(join(root, 'c', 'app-server-daemon'), { recursive: true })
    symlinkSync(join(outside, 'codex', 'app-server-daemon', 'daemon.pid'), join(root, 'c', 'app-server-daemon', 'daemon.pid'))
    // A hard link is the file outside the root under a second name.
    mkdirSync(join(root, 'd', 'app-server-daemon'), { recursive: true })
    linkSync(join(outside, 'codex', 'app-server-daemon', 'daemon.pid'), join(root, 'd', 'app-server-daemon', 'daemon.pid'))
    expect(codexPidFiles(root).sort()).toEqual([1001, 1002])
  })

  it('is no text that is not JSON, nor a pid that is not a safe integer over 1, nor a file over 16 KiB', () => {
    const root = folder()
    const texts = ['not json', 'null', '{}', '{"pid":1}', '{"pid":0}', '{"pid":-5}', '{"pid":"1005"}', '{"pid":10.5}', `{"pid":${2 ** 53}}`]
    texts.forEach((text, n) => pidFile(join(root, `h${n}`, 'app-server-daemon', 'daemon.pid'), text))
    pidFile(join(root, 'good', 'app-server-daemon', 'daemon.pid'), daemonPid(1005))
    // Over 16 KiB, as the product reads none (lib/harnessResources.ts).
    pidFile(join(root, 'large', 'app-server-daemon', 'daemon.pid'), daemonPid(1006) + ' '.repeat(16_384))
    expect(codexPidFiles(root)).toEqual([1005])
  })

  it('is read from 16 pid files and 2,000 folders at most, a bound reached said once', () => {
    const root = folder(), wide = folder()
    for (let n = 0; n < 20; n++) pidFile(join(root, `h${n}`, 'app-server-daemon', 'daemon.pid'), daemonPid(2000 + n))
    for (let n = 0; n <= 2_000; n++) mkdirSync(join(wide, `f${n}`))
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(codexPidFiles(root)).toHaveLength(16)
      expect(codexPidFiles(wide)).toEqual([])
      expect(said.mock.calls).toEqual([
        [`[e2e sweep] read 16 Codex app server pid files under ${root}: looked no further`],
        [`[e2e sweep] read 2000 folders of ${wide} for Codex app server pid files: looked no further`],
      ])
    } finally { said.mockRestore() }
  })

  describe.skipIf(process.platform === 'win32')('in a real root', () => {
    let server: number | undefined
    // Only the stand-in this spec started, by its own pid: the person's own Codex app servers run on this machine.
    afterEach(() => {
      if (server !== undefined && alive(server)) process.kill(server, 'SIGKILL')
      server = undefined
    })

    /** A stand-in for `codex app-server --managed-daemon`, as it starts: detached by a launcher that writes its pid file
     *  at [file] and exits. Its pid, once it runs its own command line. */
    async function standIn(file: string): Promise<number> {
      const launch = `const { execFileSync, spawn } = require('node:child_process'), { mkdirSync, writeFileSync } = require('node:fs')
const server = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, 'app-server', '--managed-daemon'], { argv0: 'codex', detached: true, stdio: 'ignore', cwd: ${JSON.stringify(tmpdir())} })
mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true })
const processStartTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(server.pid)], { encoding: 'utf8' }).trim()
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: server.pid, processStartTime }))
server.unref()`
      const launcher = spawn(process.execPath, ['-e', launch], { stdio: 'ignore' })
      expect((await once(launcher, 'exit'))[0]).toBe(0)
      const pid = server = (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid
      // Until it runs its own command line: a process not yet past its exec still shows its launcher's.
      await until(() => commandLines([pid]).get(pid)?.includes('app-server --managed-daemon') || null)
      return pid
    }

    it('is ended by the close sweep, though it left the test\'s tree, names nothing of the root and works outside it', async () => {
      const root = folder('htmux-')
      const pid = await standIn(join(root, 'home', 'codex', 'app-server-daemon', 'daemon.pid'))
      expect(await endRootProcesses(root, new Map())).toEqual([])
      expect(alive(pid)).toBe(false)
    })

    // macOS's `ps -p` given one pid of 100000 or over prints nothing of any pid asked with it, and exits 1.
    it('is ended though another pid file names a pid no machine gives', async () => {
      const root = folder('htmux-')
      pidFile(join(root, 'home', 'stale', 'app-server-daemon', 'daemon.pid'), daemonPid(NO_SUCH_PID))
      const pid = await standIn(join(root, 'home', 'codex', 'app-server-daemon', 'daemon.pid'))
      expect(await endRootProcesses(root, new Map())).toEqual([])
      expect(alive(pid)).toBe(false)
    })

    it('is never the worker a pid file names, as e2e/harness/sharedCodex.ts writes one', async () => {
      const root = folder('htmux-')
      pidFile(join(root, 'home', 'codex', 'app-server-daemon', 'daemon.pid'), daemonPid(process.pid))
      const real = process.kill.bind(process)
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === process.pid || real(pid, signal))
      try {
        expect(await endRootProcesses(root, new Map())).toEqual([])
        expect(kill.mock.calls.filter(([pid]) => pid === process.pid)).toEqual([])
      } finally { kill.mockRestore() }
    })
  })
})
