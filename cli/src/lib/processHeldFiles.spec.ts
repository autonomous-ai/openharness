/**
 * A fixture `/proc` under a temporary folder (`<proc>/<pid>/fd/<n>` are symbolic links to paths that need not exist)
 * and a fake `lsof`: no real process is ever listed.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessView } from './processMounts.js'
import type { ProcessIdentity } from './terminalTypes.js'

// Every call into `node:fs/promises`, by its name and the path it was given: what a listing touched.
const calls = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<Record<string, unknown>>()
  return Object.fromEntries(Object.entries(fs).map(([name, value]) => [name, typeof value === 'function'
    ? (...args: unknown[]) => { calls.push(`${name} ${String(args[0])}`); return Reflect.apply(value, fs, args) }
    : value]))
})

// The case's clock, the view each process is given, what the fake lsof prints for a pid, and each run of it.
const mocks = vi.hoisted(() => {
  const state = {
    t: 0,
    view: (): ProcessView => ({ state: 'same' }),
    lsof: new Map<string, string | Error>(),
    ran: [] as Array<{ pid: string; at: number }>,
  }
  const execFile = vi.fn((_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const pid = args[args.indexOf('-p') + 1]!
    state.ran.push({ pid, at: state.t })
    const output = state.lsof.get(pid) ?? `p${pid}\nfcwd\nn/work\n`
    if (output instanceof Error) done(output, '', '')
    else done(null, output, '')
  })
  return { state, execFile, processView: vi.fn(async () => state.view()) }
})
vi.mock('./processMounts.js', () => ({ processView: mocks.processView }))
vi.mock('node:child_process', async (original) => ({ ...await original<object>(), execFile: mocks.execFile }))

// Each case loads the module, so a run without it fails case by case, by name.
let held: typeof import('./processHeldFiles.js')

const STORE = /^(.+)\/state\.db$/, ROLLOUT = /^(.+)\/sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/
const id = (pid: number, startMarker = 'Sun Nov 15 10:00:00 2026'): ProcessIdentity => ({ pid, startMarker, executable: 'codex' })
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
function hold(pid: number, fd: number, target: string) {
  const folder = join(proc, String(pid), 'fd')
  mkdirSync(folder, { recursive: true })
  unlink(join(folder, String(fd)))
  symlinkSync(target, join(folder, String(fd)))
}
const release = (pid: number, fd: number) => unlink(join(proc, String(pid), 'fd', String(fd)))
const listedPids = () => mocks.state.ran.map((run) => run.pid)

beforeEach(async () => {
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
})
afterEach(() => { rmSync(proc, { recursive: true, force: true }) })

it('names the folder of the one file that matches, on Linux, from the links alone', async () => {
  hold(4242, 0, '/dev/pts/3')
  hold(4242, 3, '/h/.hermes/state.db')
  hold(4242, 4, '/h/.hermes/state.db-wal')
  hold(4242, 5, '/h/old/state.db (deleted)')
  hold(4242, 6, 'socket:[1]')
  // Not a link: what a descriptor closed between the listing and its read leaves, and it says nothing.
  writeFileSync(join(proc, '4242', 'fd', '7'), '')
  expect(await linux(id(4242), STORE)).toBe('/h/.hermes')
  // Nothing exists at /h: no file is opened, stat'ed or read, only the folder listed and each link read.
  expect(new Set(calls.map((call) => call.slice(0, call.indexOf(' '))))).toEqual(new Set(['opendir', 'readlink']))
  expect(calls.every((call) => call.includes(join(proc, '4242', 'fd')))).toBe(true)
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
  mocks.state.lsof.set('4242', 'p4242\nfcwd\nn/work\nf3\nn/h/.hermes/state.db\nf4\nn/h/.hermes/state.db-wal\n')
  expect(await mac(id(4242), STORE)).toBe('/h/.hermes')
  expect(mocks.execFile).toHaveBeenCalledWith('lsof', ['-n', '-P', '-w', '-p', '4242', '-Fn'],
    expect.objectContaining({ timeout: 2_000, maxBuffer: 1 << 20 }), expect.any(Function))
  for (let day = 1; day <= 3; day++) {
    mocks.state.t = day * 86_400_000
    expect(await mac(id(4242), STORE)).toBe('/h/.hermes')
  }
  expect(mocks.execFile).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([])

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
  mocks.state.lsof.set('4242', `p4242\nf3\nn/${'a'.repeat(16_400)}/state.db\nf4\nn/h/.hermes/state.db\n`)
  expect(await mac(id(4242, 'long'), STORE)).toBe('/h/.hermes')
})

it('lists nothing on Windows', async () => {
  hold(4242, 3, '/h/.hermes/state.db')
  expect(await held.heldHome(id(4242), STORE, () => [id(4243)], { platform: 'win32', proc, now })).toBeUndefined()
  expect(mocks.execFile).not.toHaveBeenCalled()
  expect(calls).toEqual([])
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
  mocks.state.lsof.set('4243', 'p4243\nfcwd\nn/work\nf7\nn/c/sessions/rollout-a.jsonl\n')
  const children = vi.fn(() => [id(4243), id(4244)])
  expect(await mac(id(4242), ROLLOUT, children)).toBe('/c')
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
  mocks.state.lsof.set('4243', 'p4243\nf7\nn/c/sessions/rollout-a.jsonl\n')
  mocks.state.lsof.set('4247', 'p4247\nf7\nn/e/sessions/rollout-z.jsonl\n')
  expect(await mac(id(4242), ROLLOUT, () => [4243, 4244, 4245, 4246, 4247].map((pid) => id(pid)))).toBe('/c')
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

it('lsofPaths keeps the n lines that are paths', async () => {
  expect(held.lsofPaths('p1\nf3\nn/a/b\nf4\nnpipe\nf5\nn/c d\n')).toEqual(['/a/b', '/c d'])
  expect(held.lsofPaths('p1\nf3\nn/a/b')).toBeNull()
  expect(held.lsofPaths(`p1\n${'f3\n'.repeat(4_095)}`)).toHaveLength(0)
  expect(held.lsofPaths(`p1\n${'f3\n'.repeat(4_096)}`)).toBeNull()
})
