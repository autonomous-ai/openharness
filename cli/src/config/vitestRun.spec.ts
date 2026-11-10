/**
 * Each Vitest run has a temporary folder of its own (__fixtures__/vitestRun.ts), and vitest.tmpdir.ts gives each of its workers a
 * folder in it. Runs going at once, as several gates on one Mac do, shared vw1, vw2…, and each one's fixtures changed the others'
 * ancestors.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import startRun, { createRun, removeRun, RUN_FILE, sweepEndedRuns } from '../__fixtures__/vitestRun.js'

let base: string | undefined
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined }
})
/** A folder standing in for the system's temporary folder. */
const scratch = () => (base = mkdtempSync(join(tmpdir(), 'runs-')))

// On Windows os.tmpdir() reads TEMP, which vitest.tmpdir.ts has never set.
it.skipIf(process.platform === 'win32')('runs each worker in a folder of its own in its run\'s folder', () => {
  const root = process.env.HARNESS_TEST_ROOT!
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

it('removes the folders runs left when they were killed more than a day ago, and no other folder', () => {
  const folder = scratch()
  const run = (pid: number, hoursAgo: number) => {
    const root = createRun(folder), file = join(root, RUN_FILE), then = new Date(Date.now() - hoursAgo * 3_600_000)
    writeFileSync(file, String(pid)); utimesSync(file, then, then)
    return basename(root)
  }
  const ended = 4_194_305 // Past any system's process ids, so no process has it.
  run(ended, 25)
  const recent = run(ended, 23), live = run(process.pid, 25)
  for (const other of ['vAbC123', 'vite-abc123']) mkdirSync(join(folder, other))
  sweepEndedRuns(folder)
  expect(readdirSync(folder).sort()).toEqual([recent, live, 'vAbC123', 'vite-abc123'].sort())
})

it('makes the run\'s folder for its workers, and removes it when the run\'s process exits', () => {
  const folder = scratch()
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, folder)
  vi.stubEnv('HARNESS_TEST_ROOT', undefined)
  const once = vi.spyOn(process, 'once').mockImplementation(() => process)
  startRun()
  const root = process.env.HARNESS_TEST_ROOT!
  expect(dirname(root)).toBe(folder)
  expect(once).toHaveBeenCalledWith('exit', expect.any(Function))
  ;(once.mock.calls[0]![1] as () => void)()
  expect(existsSync(root)).toBe(false)
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says which run folder it could not remove', () => {
  const root = createRun(scratch())
  mkdirSync(join(root, '1')); writeFileSync(join(root, '1', 'fixture'), '')
  chmodSync(join(root, '1'), 0o500)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    removeRun(root)
    // EACCES on Linux, ENOTEMPTY on macOS.
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/: E[A-Z]+$/)]])
    expect(warn.mock.calls[0]![0]).toContain(`vitestRun.ts could not remove ${root}: `)
  } finally { chmodSync(join(root, '1'), 0o700) }
})
