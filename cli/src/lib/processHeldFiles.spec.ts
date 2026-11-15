/**
 * A fixture `/proc` under a temporary folder (`<proc>/<pid>/fd/<n>` are symbolic links to paths that need not exist,
 * `<proc>/<pid>/stat` says when the process started) and a fake `lsof`: no real process is ever listed.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { ProcessView } from './processMounts.js'
import type { ProcessIdentity } from './terminalTypes.js'

// Every call into `node:fs/promises`, by its name and the path it was given: what a listing touched. `onCall` is the
// case's own step, run before each one.
const calls = vi.hoisted(() => [] as string[])
const fsHook = vi.hoisted(() => ({ onCall: null as null | ((name: string, path: string) => void) }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(fs).map(([name, value]) => [name, typeof value === 'function'
    ? (...args: unknown[]) => {
      calls.push(`${name} ${String(args[0])}`)
      fsHook.onCall?.(name, String(args[0]))
      return Reflect.apply(value, fs, args)
    }
    : value]))
})

// The case's clock, the view each process is given, what the fake lsof prints for a pid, and each pid it was run for.
// One run for several pids prints each one's section in turn, and fails when any of them does.
const mocks = vi.hoisted(() => {
  const state = {
    t: 0,
    view: (): ProcessView => ({ state: 'same' }),
    lsof: new Map<string, string | Error>(),
    ran: [] as Array<{ pid: string; at: number }>,
  }
  const execFile = vi.fn((_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const pids = args[args.indexOf('-p') + 1]!.split(',')
    state.ran.push(...pids.map((pid) => ({ pid, at: state.t })))
    const outputs = pids.map((pid) => state.lsof.get(pid) ?? `p${pid}\nfcwd\nn/work\n`)
    const error = outputs.find((output) => output instanceof Error)
    if (error) done(error, '', '')
    else done(null, outputs.join(''), '')
  })
  return { state, execFile, processView: vi.fn(async () => state.view()) }
})
vi.mock('./processMounts.js', () => ({ processView: mocks.processView }))
vi.mock('node:child_process', async (original) => ({ ...await original<object>(), execFile: mocks.execFile }))

// Each case loads the module, so a run without it fails case by case, by name.
let held: typeof import('./processHeldFiles.js')

const STORE = /^(.+)\/state\.db$/, ROLLOUT = /^(.+)\/sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/
const TICKS = 7_000
const id = (pid: number, startMarker = 'Sun Nov 15 10:00:00 2026'): ProcessIdentity => ({ pid, startMarker, executable: 'codex', startTicks: TICKS })
const now = () => mocks.state.t
let proc = ''
const linux = (selected: ProcessIdentity, file: RegExp, children?: () => readonly ProcessIdentity[]) =>
  held.heldHome(selected, file, children, { platform: 'linux', proc, now })
const mac = (selected: ProcessIdentity, file: RegExp, children?: () => readonly ProcessIdentity[]) =>
  held.heldHome(selected, file, children, { platform: 'darwin', proc, now })

// `unlinkSync`, not `rmSync`: the fixture's links point at nothing, and Node 23's `rmSync` leaves such a link in place.
function unlink(file: string) {
  try { unlinkSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
// `/proc/<pid>/stat`: field 22, the 20th after the command, is when the process started, in ticks since boot.
const started = (pid: number, ticks: number) =>
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (codex) S 1 ${'0 '.repeat(17)}${ticks} 0 0\n`)
function hold(pid: number, fd: number, target: string) {
  const folder = join(proc, String(pid), 'fd')
  mkdirSync(folder, { recursive: true })
  if (!existsSync(join(proc, String(pid), 'stat'))) started(pid, TICKS)
  unlink(join(folder, String(fd)))
  symlinkSync(target, join(folder, String(fd)))
}
const release = (pid: number, fd: number) => unlink(join(proc, String(pid), 'fd', String(fd)))
// A path under the case's own folder, and a file made there: lsof names a file by its path, which is looked up.
const disk = (path: string) => join(proc, 'disk', path)
function file(path: string): string {
  mkdirSync(dirname(disk(path)), { recursive: true })
  writeFileSync(disk(path), '')
  return disk(path)
}
const listedPids = () => mocks.state.ran.map((run) => run.pid)

// What the reader says of a listing that gave no home.
let warn: MockInstance<typeof console.warn>
const said = () => warn.mock.calls.map((args) => args.join(' '))

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  held = await import('./processHeldFiles.js')
  held.clearHeldHomes()
  proc = mkdtempSync(join(tmpdir(), 'process-held-files-'))
  mocks.state.t = 0
  mocks.state.view = () => ({ state: 'same' })
  mocks.state.lsof.clear()
  mocks.state.ran.length = 0
  mocks.execFile.mockClear()
  mocks.processView.mockClear()
  calls.length = 0
  fsHook.onCall = null
})
afterEach(() => {
  warn.mockRestore()
  rmSync(proc, { recursive: true, force: true })
})

it('names the folder of the one file that matches, on Linux, from the links alone', async () => {
  hold(4242, 0, '/dev/pts/3')
  hold(4242, 3, '/h/.hermes/state.db')
  hold(4242, 4, '/h/.hermes/state.db-wal')
  hold(4242, 5, '/h/old/state.db (deleted)')
  hold(4242, 6, 'socket:[1]')
  // Not a link: what a descriptor closed between the listing and its read leaves, and it says nothing.
  writeFileSync(join(proc, '4242', 'fd', '7'), '')
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
  // Nothing exists at /h: no file is opened, stat'ed or read, only the folder listed, each link read, and when the
  // process started.
  const fd = join(proc, '4242', 'fd')
  expect(calls.filter((call) => !call.startsWith(`opendir ${fd}`) && !call.startsWith(`readlink ${fd}/`)
    && call !== `readFile ${join(proc, '4242', 'stat')}`)).toEqual([])
  expect(mocks.processView).toHaveBeenCalledWith(id(4242), 'linux', proc)
  expect(mocks.execFile).not.toHaveBeenCalled()
})

it('answers nothing for two folders, and the folder for one file open twice', async () => {
  hold(4242, 3, '/h/.hermes/state.db')
  hold(4242, 4, '/p/project/state.db')
  expect(await linux(id(4242), STORE)).toBeUndefined()
  hold(4242, 4, '/h/.hermes/state.db')
  expect(await linux(id(4242, 'Sun Nov 15 11:00:00 2026'), STORE)).toBe('/h/.hermes')
})

it('lists no process that is not the one selected any more, on Linux', async () => {
  hold(4242, 3, '/h/.hermes/state.db')
  // The pid is another process's now: its files are not listed.
  started(4242, TICKS + 1)
  expect(await linux(id(4242), STORE)).toBeUndefined()
  expect(calls.filter((call) => call.includes(join(proc, '4242', 'fd')))).toEqual([])
  // It ended and its pid went to another while its files were listed: what they say is not the selected one's.
  started(4242, TICKS)
  fsHook.onCall = (name) => { if (name === 'readlink') started(4242, TICKS + 1) }
  expect(await linux(id(4242, 'replaced while listed'), STORE)).toBeUndefined()
  fsHook.onCall = null
  // Gone, and an identity that does not say when it started.
  rmSync(join(proc, '4242', 'stat'))
  expect(await linux(id(4242, 'gone'), STORE)).toBeUndefined()
  started(4242, TICKS)
  expect(await linux({ pid: 4242, startMarker: 'no ticks', executable: 'codex' }, STORE)).toBeUndefined()
  expect(await linux(id(4242, 'the same process'), STORE)).toBe('/h/.hermes')
})

it('asks again of a process that held nothing 5 s later, and never again of one that answered', async () => {
  hold(4242, 0, '/dev/pts/3')
  expect(await linux(id(4242), STORE)).toBeUndefined()
  hold(4242, 3, '/h/.hermes/state.db')
  mocks.state.t = 4_999
  expect(await linux(id(4242), STORE)).toBeUndefined()
  mocks.state.t = 5_000
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
  release(4242, 3)
  mocks.state.t += 86_400_000
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
})

it('waits by a clock that a step of the wall clock does not move', async () => {
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1_000_000)
  const wall = vi.spyOn(Date, 'now').mockReturnValue(0)
  try {
    const ask = () => held.heldHome(id(4242), STORE, undefined, { platform: 'linux', proc })
    hold(4242, 0, '/dev/pts/3')
    expect(await ask()).toBeUndefined()
    hold(4242, 3, '/h/.hermes/state.db')
    // The wall clock is set a day ahead: no time has passed, and the wait is not over.
    wall.mockReturnValue(86_400_000)
    expect(await ask()).toBeUndefined()
    monotonic.mockReturnValue(1_005_000)
    expect(await ask()).toBe('/h/.hermes')
  } finally {
    monotonic.mockRestore()
    wall.mockRestore()
  }
})

it('gives a sandbox\'s folder at the daemon\'s path, and nothing for one with no path here or a namespace it cannot read', async () => {
  mocks.state.view = () => ({ state: 'sandbox', cwd: '/work', toHost: (path) => path === '/tmp/home/.hermes' ? '/data/agents/a1/.hermes' : null })
  hold(4242, 3, '/tmp/home/.hermes/state.db')
  expect(await linux(id(4242), STORE)).toBe('/data/agents/a1/.hermes')
  expect(mocks.processView).toHaveBeenCalledWith(id(4242), 'linux', proc)
  hold(4242, 3, '/tmp/agent/.hermes/state.db')
  expect(await linux(id(4242, 'no path here'), STORE)).toBeUndefined()
  mocks.state.view = () => ({ state: 'unreadable' })
  hold(4242, 3, '/tmp/home/.hermes/state.db')
  expect(await linux(id(4242, 'unreadable'), STORE)).toBeUndefined()
})

it('picks no home in a sandbox when one store has a path here and another has none', async () => {
  mocks.state.view = () => ({ state: 'sandbox', cwd: '/work', toHost: (path) => path === '/data/project' ? path : null })
  hold(4242, 3, '/tmp/home/.hermes/state.db')   // its own store, on a tmpfs the daemon has no path to
  hold(4242, 4, '/data/project/state.db')       // another state.db, at the same path here
  expect(await linux(id(4242), STORE)).toBeUndefined()
})

it('lists a process on macOS with lsof -Fn, less and less often until it answers, and never after', async () => {
  const store = file('h/.hermes/state.db')
  mocks.state.lsof.set('4242', `p4242\nfcwd\nn/work\nf3\nn${store}\nf4\nn${store}-wal\n`)
  expect(await mac(id(4242), STORE)).toBe(dirname(store))
  expect(mocks.execFile).toHaveBeenCalledWith('lsof', ['-n', '-P', '-w', '-p', '4242', '-Fn'],
    expect.objectContaining({ timeout: 2_000, maxBuffer: 1 << 20 }), expect.any(Function))
  for (let day = 1; day <= 3; day++) {
    mocks.state.t = day * 86_400_000
    expect(await mac(id(4242), STORE)).toBe(dirname(store))
  }
  expect(mocks.execFile).toHaveBeenCalledTimes(1)
  // No file is opened or read through its path: at most looked up.
  expect(calls.every((call) => call.startsWith('lstat '))).toBe(true)

  const start = mocks.state.t
  mocks.state.lsof.set('4243', 'p4243\nfcwd\nn/work\n')
  for (let second = 0; second <= 200; second++) {
    mocks.state.t = start + second * 1_000
    expect(await mac(id(4243), STORE)).toBeUndefined()
  }
  const runs = mocks.state.ran.filter((run) => run.pid === '4243').map((run) => (run.at - start) / 1_000)
  expect(runs).toEqual([0, 5, 15, 35, 75, 135, 195])
  expect(held.HELD_RETRY_MS).toEqual({ first: 5_000, most: 60_000 })
})

it('answers nothing when lsof fails or its output is cut', async () => {
  mocks.state.lsof.set('4242', Object.assign(new Error('Command failed: lsof'), { code: 1 }))
  expect(await mac(id(4242), STORE)).toBeUndefined()
  mocks.state.lsof.set('4243', 'p4243\nf3\nn/h/.hermes/state.db')
  expect(await mac(id(4243), STORE)).toBeUndefined()
})

it('takes the spelling that exists when lsof escapes a name', async () => {
  const disk = join(proc, 'disk')
  mkdirSync(join(disk, 'nhà', '.hermes'), { recursive: true })
  writeFileSync(join(disk, 'nhà', '.hermes', 'state.db'), '')
  mocks.state.lsof.set('4242', `p4242\nf3\nn${disk}/nh\\xc3\\xa0/.hermes/state.db\n`)
  expect(await mac(id(4242), STORE)).toBe(join(disk, 'nhà', '.hermes'))

  // Both spellings on disk, or neither: that descriptor says nothing.
  mkdirSync(join(disk, 'nh\\xc3\\xa0', '.hermes'), { recursive: true })
  writeFileSync(join(disk, 'nh\\xc3\\xa0', '.hermes', 'state.db'), '')
  expect(await mac(id(4242, 'both'), STORE)).toBeUndefined()
  mocks.state.lsof.set('4242', `p4242\nf3\nn${disk}/nh\\xc3\\xa1/.hermes/state.db\n`)
  expect(await mac(id(4242, 'neither'), STORE)).toBeUndefined()

  // A name too long to be a path says nothing either, and the listing still answers.
  const store = file('h/.hermes/state.db')
  mocks.state.lsof.set('4242', `p4242\nf3\nn/${'a'.repeat(16_400)}/state.db\nf4\nn${store}\n`)
  expect(await mac(id(4242, 'long'), STORE)).toBe(dirname(store))
})

it('takes no folder from a spelling that is not on disk, nor from two that are', async () => {
  // lsof leaves a backslash in a name as it is, so `evil\x2fsessions\x2frollout-1.jsonl`, one file's name, decodes to
  // a rollout in a folder `evil`. That spelling is not on disk, and the name itself is no rollout.
  const name = file('evil\\x2fsessions\\x2frollout-1.jsonl')
  mocks.state.lsof.set('4242', `p4242\nfcwd\nn/work\nf3\nn${name}\n`)
  expect(await mac(id(4242), ROLLOUT)).toBeUndefined()
  // Both spellings of the one descriptor whose decoded name matches are looked up, and nothing else is.
  expect([...calls].sort()).toEqual([`lstat ${name}`, `lstat ${disk('evil/sessions/rollout-1.jsonl')}`].sort())
  // Both on disk: which one the process holds cannot be told.
  file('evil/sessions/rollout-1.jsonl')
  expect(await mac(id(4242, 'both'), ROLLOUT)).toBeUndefined()
  // A rollout gone from disk while held says nothing, as its `(deleted)` path says nothing on Linux.
  mocks.state.lsof.set('4243', `p4243\nf3\nn${disk('gone/sessions/rollout-1.jsonl')}\n`)
  expect(await mac(id(4243), ROLLOUT)).toBeUndefined()
})

it('refuses a home whose path steps back out of a folder', async () => {
  // `..\x2fc\x2fsessions\x2frollout-1.jsonl`, one file's name, decodes to a path out of `evil` and into `c`, where
  // that rollout is on disk: the decoded spelling is the only one there, and its home is no home.
  mkdirSync(disk('evil'), { recursive: true })
  file('c/sessions/rollout-1.jsonl')
  mocks.state.lsof.set('4242', `p4242\nf3\nn${disk('evil')}/..\\x2fc\\x2fsessions\\x2frollout-1.jsonl\n`)
  expect(await mac(id(4242), ROLLOUT)).toBeUndefined()
})

it('lists nothing on Windows, asks for no children there, and keeps nothing of having been asked', async () => {
  hold(4242, 3, '/h/.hermes/state.db')
  const children = vi.fn(() => [id(4243)])
  expect(await held.heldHome(id(4242), STORE, children, { platform: 'win32', proc, now })).toBeUndefined()
  expect(children).not.toHaveBeenCalled()
  expect(mocks.execFile).not.toHaveBeenCalled()
  expect(calls).toEqual([])
  // No wait was kept: the same process, at the same time, where it can be listed, is listed.
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
})

it('lists no process whose pid is not a positive whole number', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    expect(await linux(id(pid), STORE)).toBeUndefined()
    expect(await mac(id(pid), STORE)).toBeUndefined()
    expect(await mac(id(4242, `child ${pid}`), STORE, () => [id(pid)])).toBeUndefined()
  }
  expect(calls).toEqual([])
  expect(mocks.execFile).not.toHaveBeenCalled()
})

it('takes no pattern with a g or y flag, whose exec would go on from where the last path matched', async () => {
  for (const flags of ['g', 'y']) await expect(linux(id(4242), new RegExp(STORE.source, flags))).rejects.toThrow(TypeError)
})

it('reads the engine\'s children too, and answers nothing when the launcher disagrees or one cannot be listed', async () => {
  // npm's Codex 0.169.0: the launcher and one of its two codex children hold no rollout, the other holds it.
  hold(4242, 0, '/dev/pts/3')
  hold(4243, 7, '/c/sessions/2026/11/15/rollout-a.jsonl')
  hold(4244, 0, '/dev/null')
  const children = vi.fn(() => [id(4243), id(4244)])
  expect(await linux(id(4242), ROLLOUT, children)).toBe('/c')
  expect(children).toHaveBeenCalledTimes(1)
  mocks.state.t = 86_400_000
  expect(await linux(id(4242), ROLLOUT, children)).toBe('/c')
  expect(children).toHaveBeenCalledTimes(1)

  hold(4242, 9, '/other/sessions/rollout-b.jsonl')
  expect(await linux(id(4242, 'launcher disagrees'), ROLLOUT, () => [id(4243), id(4244)])).toBeUndefined()
  release(4242, 9)
  rmSync(join(proc, '4244'), { recursive: true })
  expect(await linux(id(4242, 'one gone'), ROLLOUT, () => [id(4243), id(4244)])).toBeUndefined()
})

it('picks no home when two children hold files of two homes', async () => {
  hold(4242, 0, '/dev/pts/3')
  hold(4243, 7, '/c/sessions/rollout-a.jsonl')
  hold(4244, 7, '/d/sessions/rollout-b.jsonl')
  expect(await linux(id(4242), ROLLOUT, () => [id(4243), id(4244)])).toBeUndefined()
  expect(await linux(id(4242, 'the other way round'), ROLLOUT, () => [id(4244), id(4243)])).toBeUndefined()
  // Two rollouts of one home are one home.
  hold(4244, 7, '/c/sessions/rollout-b.jsonl')
  expect(await linux(id(4242, 'one home'), ROLLOUT, () => [id(4243), id(4244)])).toBe('/c')
})

it('lists the selected process and the children it is given, and no other process', async () => {
  mocks.state.lsof.set('4243', `p4243\nfcwd\nn/work\nf7\nn${file('c/sessions/rollout-a.jsonl')}\n`)
  const children = vi.fn(() => [id(4243), id(4244)])
  expect(await mac(id(4242), ROLLOUT, children)).toBe(disk('c'))
  expect(listedPids()).toEqual(['4242', '4243', '4244'])
  expect(children).toHaveBeenCalledTimes(1)

  hold(4242, 0, '/dev/pts/3')
  hold(4243, 7, '/c/sessions/rollout-a.jsonl')
  hold(4244, 0, '/dev/null')
  hold(4250, 7, '/d/sessions/rollout-z.jsonl')   // a process under 4243
  hold(4251, 7, '/d/sessions/rollout-z.jsonl')   // a shell beside 4243
  expect(await linux(id(4242, 'linux'), ROLLOUT, () => [id(4243), id(4244)])).toBe('/c')
  expect(await linux(id(4242, 'alone'), ROLLOUT)).toBeUndefined()
  expect(calls.filter((call) => call.includes(join(proc, '4250')) || call.includes(join(proc, '4251')))).toEqual([])
})

it('lists four children at most, and ignores a fifth', async () => {
  mocks.state.lsof.set('4243', `p4243\nf7\nn${file('c/sessions/rollout-a.jsonl')}\n`)
  mocks.state.lsof.set('4247', `p4247\nf7\nn${file('e/sessions/rollout-z.jsonl')}\n`)
  expect(await mac(id(4242), ROLLOUT, () => [4243, 4244, 4245, 4246, 4247].map((pid) => id(pid)))).toBe(disk('c'))
  expect(listedPids()).toEqual(['4242', '4243', '4244', '4245', '4246'])
})

it('refuses a process with more than 4,096 descriptors, and keeps at most 256 processes', async () => {
  for (let fd = 0; fd < 4_095; fd++) hold(4242, fd, '/dev/null')
  hold(4242, 4_095, '/h/.hermes/state.db')
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
  hold(4242, 4_096, '/dev/null')
  expect(await linux(id(4242, 'one more'), STORE)).toBeUndefined()

  hold(4300, 3, '/h/.hermes/state.db')
  held.clearHeldHomes()
  const nth = (n: number) => id(4300, `start ${n}`)
  for (let n = 0; n < 256; n++) expect(await linux(nth(n), STORE)).toBe('/h/.hermes')
  release(4300, 3)
  expect(await linux(nth(0), STORE)).toBe('/h/.hermes')
  expect(await linux(nth(256), STORE)).toBeUndefined()
  expect(await linux(nth(0), STORE)).toBeUndefined()
})

it('lists a launcher and its children with one lsof, and answers nothing when it leaves one out', async () => {
  mocks.state.lsof.set('4243', `p4243\nf7\nn${file('c/sessions/rollout-a.jsonl')}\n`)
  expect(await mac(id(4242), ROLLOUT, () => [id(4243), id(4244)])).toBe(disk('c'))
  expect(mocks.execFile).toHaveBeenCalledTimes(1)
  expect(mocks.execFile).toHaveBeenCalledWith('lsof', ['-n', '-P', '-w', '-p', '4242,4243,4244', '-Fn'],
    expect.objectContaining({ timeout: 2_000 }), expect.any(Function))
  // It exits 0 with no section for one of them: that one could not be listed.
  mocks.state.lsof.set('4244', '')
  expect(await mac(id(4242, 'one left out'), ROLLOUT, () => [id(4243), id(4244)])).toBeUndefined()
  // It fails for one of them: none is listed.
  mocks.state.lsof.set('4244', Object.assign(new Error('Command failed: lsof'), { code: 1 }))
  expect(await mac(id(4242, 'one failed'), ROLLOUT, () => [id(4243), id(4244)])).toBeUndefined()
})

it('lsofPaths keeps the n lines that are paths, by process', async () => {
  expect(held.lsofPaths('p1\nf3\nn/a/b\nf4\nnpipe\np2\nf5\nn/c d\n', [1, 2])).toEqual(new Map([[1, ['/a/b']], [2, ['/c d']]]))
  expect(() => held.lsofPaths('p1\nf3\nn/a/b', [1])).toThrow('lsof failed')
  // Each process asked of has a section of its own, and no other process has one.
  expect(() => held.lsofPaths('p1\nf3\nn/a/b\n', [1, 2])).toThrow('lsof failed')
  expect(() => held.lsofPaths('p1\np2\n', [1])).toThrow('lsof failed')
  expect(() => held.lsofPaths('p1\np1\n', [1])).toThrow('lsof failed')
  expect(() => held.lsofPaths('f3\nn/a/b\np1\n', [1])).toThrow('lsof failed')
  // The bound is on one process's descriptors, as on Linux, and each one has an `f` line and an `n` line.
  expect(held.lsofPaths(`p1\n${'f3\nn/a\n'.repeat(4_096)}`, [1])?.get(1)).toHaveLength(4_096)
  expect(() => held.lsofPaths(`p1\n${'f3\nn/a\n'.repeat(4_097)}`, [1])).toThrow('too many descriptors')
  expect(held.lsofPaths(`p1\n${'f3\nn/a\n'.repeat(4_096)}p2\n${'f3\nn/a\n'.repeat(4_096)}`, [1, 2])?.get(2)).toHaveLength(4_096)
})

it('says once for each process why its listing gave no home, and names no path', async () => {
  // On Linux: two homes, asked twice; a pid another process has now; a sandbox's store with no path here; a process
  // whose descriptors cannot be read.
  hold(4242, 3, '/h/.hermes/state.db')
  hold(4242, 4, '/p/project/state.db')
  expect(await linux(id(4242), STORE)).toBeUndefined()
  mocks.state.t = 5_000
  expect(await linux(id(4242), STORE)).toBeUndefined()
  hold(4243, 3, '/h/.hermes/state.db')
  started(4243, TICKS + 1)
  expect(await linux(id(4243), STORE)).toBeUndefined()
  mocks.state.view = () => ({ state: 'sandbox', cwd: '/work', toHost: () => null })
  hold(4244, 3, '/tmp/home/.hermes/state.db')
  expect(await linux(id(4244), STORE)).toBeUndefined()
  mocks.state.view = () => ({ state: 'same' })
  mkdirSync(join(proc, '4245'))
  started(4245, TICKS)
  expect(await linux(id(4245), STORE)).toBeUndefined()
  // On macOS: lsof fails, or is killed at its timeout; a process with too many descriptors; a home that steps out of
  // a folder; a child whose pid is no pid; and a process that holds no store yet, which is no failure.
  mocks.state.lsof.set('4246', Object.assign(new Error('Command failed: lsof'), { code: 1 }))
  mocks.state.lsof.set('4247', Object.assign(new Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM' }))
  mocks.state.lsof.set('4248', `p4248\n${'f3\nn/a\n'.repeat(4_097)}`)
  mkdirSync(disk('evil'), { recursive: true })
  file('c/sessions/rollout-1.jsonl')
  mocks.state.lsof.set('4249', `p4249\nf3\nn${disk('evil')}/..\\x2fc\\x2fsessions\\x2frollout-1.jsonl\n`)
  for (const pid of [4246, 4247, 4248]) expect(await mac(id(pid), STORE)).toBeUndefined()
  expect(await mac(id(4249), ROLLOUT)).toBeUndefined()
  expect(await mac(id(4250), STORE, () => [id(0)])).toBeUndefined()
  expect(await mac(id(4251), STORE)).toBeUndefined()

  expect(said()).toEqual([
    '[held-files] pid 4242: two homes',
    '[held-files] pid 4243: pid changed',
    '[held-files] pid 4244: unmappable',
    '[held-files] pid 4245: unreadable',
    '[held-files] pid 4246: lsof failed',
    '[held-files] pid 4247: lsof timed out',
    '[held-files] pid 4248: too many descriptors',
    '[held-files] pid 4249: home with ..',
    '[held-files] pid 4250: bad pid',
  ])
})
