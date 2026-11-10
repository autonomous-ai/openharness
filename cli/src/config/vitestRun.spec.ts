/**
 * Each Vitest run's temporary folders are its own: __fixtures__/vitestRun.ts names the run, and vitest.tmpdir.ts gives each of its workers a
 * folder. Runs going at once, as several gates on one Mac do, shared vw1, vw2…, and each one's fixtures changed the others' ancestors.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import nameRun from '../__fixtures__/vitestRun.js'

let base: string | undefined
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  if (base) { rmSync(base, { recursive: true, force: true }); base = undefined }
})

/** A temporary folder holding the named folders, standing in for the system's, as the run's own setup would see it. */
const runs = (names: string[]) => {
  base = mkdtempSync(join(tmpdir(), 'runs-'))
  for (const name of names) mkdirSync(join(base, name, 'fixture'), { recursive: true })
  vi.stubEnv('TMPDIR', base); vi.stubEnv('HARNESS_TEST_RUN', undefined)
  return base
}

it('runs each worker in a temporary folder named for its run and for itself', () => {
  // A worker's parent process runs the whole run, and no process running at the same time has its id.
  expect(process.env.HARNESS_TEST_RUN).toBe(`v${process.ppid.toString(36)}`)
  expect(basename(tmpdir())).toBe(`${process.env.HARNESS_TEST_RUN}-${process.env.VITEST_POOL_ID}`)
})

it('names a run for the process running it, and removes its folders when it ends, no other run\'s', () => {
  const run = `v${process.pid.toString(36)}`
  const folder = runs([`${run}-1`, `${run}-2`, `${run}k-1`, 'v0-1', 'vw1'])
  const end = nameRun()
  expect(process.env.HARNESS_TEST_RUN).toBe(run)
  end()
  expect(readdirSync(folder).sort()).toEqual([`${run}k-1`, 'v0-1', 'vw1'].sort())
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says which folder it could not remove, and still removes the others', () => {
  const run = `v${process.pid.toString(36)}`
  const folder = runs([`${run}-1`, `${run}-2`])
  writeFileSync(join(folder, `${run}-1`, 'fixture', 'file'), '')
  chmodSync(join(folder, `${run}-1`, 'fixture'), 0o500)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    nameRun()()
    // EACCES on Linux, ENOTEMPTY on macOS.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^vitestRun\.ts could not remove .+: E[A-Z]+$/))
    expect(warn.mock.calls[0]![0]).toContain(` ${join(folder, `${run}-1`)}: `)
    expect(readdirSync(folder)).toEqual([`${run}-1`])
  } finally { chmodSync(join(folder, `${run}-1`, 'fixture'), 0o700) }
})
