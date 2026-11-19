import { chmodSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths } from './nativePaths.js'
const observations = vi.hoisted(() => ({ reads: 0, count: false }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (observations.count) observations.reads++
    return fs.lstatSync(...args)
  } }
})
let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'native-route-group-'))) })
afterEach(() => { observations.count = false; rmSync(root, { recursive: true, force: true }) })
function observe(file: string) {
  const paths = new NativePaths(new NativeEvidenceBudget()); paths.resolveSync(file, true); return paths
}
it('returns each route with only its own aliases and absence facts', () => {
  const folder = join(root, 'folder'), alias = join(root, 'alias'); mkdirSync(folder); symlinkSync(folder, alias)
  const one = observe(join(alias, 'missing')), two = observe(join(folder, 'missing'))
  expect(NativePaths.snapshots([one, two])).toEqual([one.snapshot(), two.snapshot()])
})
it.each(['ancestor', 'alias', 'leaf mode', 'absent leaf'])('refuses conflicting %s observations even when the last one still matches disk', change => {
  const folder = join(root, 'folder'), file = join(folder, 'config'); mkdirSync(folder)
  if (change !== 'absent leaf') writeFileSync(file, '{}', { mode: 0o600 })
  const old = observe(file)
  if (change === 'ancestor' || change === 'alias') {
    renameSync(folder, join(root, 'displaced'))
    if (change === 'alias') symlinkSync(join(root, 'displaced'), folder)
    else { mkdirSync(folder); renameSync(join(root, 'displaced/config'), file) }
  } else if (change === 'leaf mode') chmodSync(file, 0o640)
  else writeFileSync(file, '{}', { mode: 0o600 })
  const fresh = observe(file)
  expect(() => fresh.snapshot()).not.toThrow()
  expect(() => NativePaths.snapshots([old, fresh])).toThrow(/changed/)
})
it('keeps every original evidence deadline in the group', () => {
  const original = observe(root), expired = original.fork(new NativeEvidenceBudget(-1))
  expect(() => NativePaths.snapshots([original, expired])).toThrow(/deadline/)
})
it('bounds the group and refuses unresolved routes', () => {
  const paths = observe(root)
  expect(() => NativePaths.snapshots([])).toThrow(/limit/)
  expect(() => NativePaths.snapshots(Array.from({ length: 33 }, () => paths))).toThrow(/limit/)
  expect(() => NativePaths.snapshots([new NativePaths(new NativeEvidenceBudget())])).toThrow(/incomplete/)
})

it('refuses different versions of the same alias inode', () => {
  const folder = join(root, 'folder'), alias = join(root, 'alias'); mkdirSync(folder); symlinkSync(folder, alias)
  const before = observe(join(alias, 'missing'))
  lutimesSync(alias, 1, 1)
  const after = observe(join(alias, 'missing'))
  expect(() => NativePaths.snapshots([before, after])).toThrow(/changed/)
})

it('charges the shared final verification to the selected original work budget', () => {
  const budget = new NativeEvidenceBudget(), steps = vi.spyOn(budget, 'step'), paths = new NativePaths(budget)
  paths.resolveSync(root)
  const facts = paths.snapshot().length
  while (steps.mock.calls.length < 32768 - 2 * facts - 1) budget.step()
  observations.reads = 0; observations.count = true
  expect(() => NativePaths.snapshots([paths, paths])).toThrow(/work limit/)
  expect(observations.reads).toBe(1)
})
