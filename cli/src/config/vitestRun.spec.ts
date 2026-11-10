/**
 * Each Vitest run has a temporary folder of its own (__fixtures__/vitestRun.ts), and vitest.tmpdir.ts gives each of its workers a
 * folder in it. Runs going at once, as several gates on one Mac do, shared $TMPDIR/vw1, vw2…, and each one's fixtures changed the
 * others' ancestors.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, inject, it, vi } from 'vitest'
import { beginRun, createRun, removeRun, RUN_FILE, sweep } from '../__fixtures__/vitestRun.js'

let base: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined }
})
/** A folder standing in for /tmp, or for the system's temporary folder. */
const scratch = () => (base = mkdtempSync(join(tmpdir(), 'runs-')))
/** Sets a file's or folder's times to that many hours ago. */
const age = (path: string, hours: number) => { const then = new Date(Date.now() - hours * 3_600_000); utimesSync(path, then, then) }
/** A run's folder in `folder` whose file says `pid` runs it, written that many hours ago. */
const run = (folder: string, pid: number | string, hours: number) => {
  const root = createRun(folder)
  writeFileSync(join(root, RUN_FILE), String(pid)); age(join(root, RUN_FILE), hours)
  return basename(root)
}
const ENDED = 4_194_305 // Past any system's process ids, so no process has it.

// On Windows os.tmpdir() reads TEMP, which vitest.tmpdir.ts leaves alone.
it.skipIf(process.platform === 'win32')('runs each worker in a folder of its own in its run\'s folder', () => {
  const root = inject('runFolder')
  expect(tmpdir()).toBe(join(root, process.env.VITEST_POOL_ID!))
  // The run's file names a process that is running: the one running this run.
  expect(() => process.kill(Number(readFileSync(join(root, RUN_FILE), 'utf8')), 0)).not.toThrow()
})

it('gives every run a new folder, even two runs whose processes have the same id', () => {
  const folder = scratch()
  const [a, b] = [createRun(folder), createRun(folder)]
  expect(a).not.toBe(b)
  expect([dirname(a), dirname(b)]).toEqual([folder, folder])
  expect(readFileSync(join(a, RUN_FILE), 'utf8')).toBe(String(process.pid))
})

it('removes what ended runs left: their folders after a day, and the folders every run shared before, and nothing else', () => {
  const folder = scratch()
  run(folder, ENDED, 25); run(folder, '', 25)
  const recent = run(folder, ENDED, 23), live = run(folder, process.pid, 25)
  for (const name of ['vw1', 'vw2', 'vwx', 'vw3x', 'vw12345', 'vAbC123', 'vite-abc123']) mkdirSync(join(folder, name))
  for (const name of ['vw1', 'vwx', 'vw3x', 'vw12345', 'vAbC123']) age(join(folder, name), 25)
  sweep(folder)
  expect(readdirSync(folder).sort()).toEqual([recent, live, 'vw2', 'vwx', 'vw3x', 'vw12345', 'vAbC123', 'vite-abc123'].sort())
})

it.skipIf(process.platform === 'win32')('reads no run file that is not a plain file, so a pipe left there cannot hang a run', () => {
  const folder = scratch()
  const root = createRun(folder)
  rmSync(join(root, RUN_FILE)); execFileSync('mkfifo', [join(root, RUN_FILE)]); age(join(root, RUN_FILE), 25)
  sweep(folder)
  expect(readdirSync(folder)).toEqual([basename(root)])
})

it('says which folder it could not read, and goes on', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const gone = join(scratch(), 'gone')
  sweep(gone)
  expect(warn).toHaveBeenCalledWith(`vitestRun.ts could not read ${gone}: ENOENT`)
})

it('starts a run in a new folder for its workers, and removes it when the run\'s process exits', () => {
  const folder = scratch()
  const once = vi.spyOn(process, 'once').mockImplementation(() => process)
  const ended = run(folder, ENDED, 25)
  const [first, second] = [beginRun(folder, folder), beginRun(folder, folder)]
  expect([dirname(first), dirname(second)]).toEqual([folder, folder])
  expect(existsSync(join(folder, ended))).toBe(false)
  expect(once.mock.calls.map(([event]) => event)).toEqual(['exit', 'exit'])
  ;(once.mock.calls[0]![1] as () => void)()
  expect([existsSync(first), existsSync(second)]).toEqual([false, true])
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says which folder it could not remove, and keeps its run file for a later run', () => {
  const root = createRun(scratch())
  mkdirSync(join(root, '1')); writeFileSync(join(root, '1', 'fixture'), '')
  chmodSync(join(root, '1'), 0o500)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    removeRun(root)
    // EACCES on Linux, ENOTEMPTY on macOS.
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/: E[A-Z]+$/)]])
    expect(warn.mock.calls[0]![0]).toContain(`vitestRun.ts could not remove ${root}: `)
    expect(existsSync(join(root, RUN_FILE))).toBe(true)
  } finally { chmodSync(join(root, '1'), 0o700) }
})
