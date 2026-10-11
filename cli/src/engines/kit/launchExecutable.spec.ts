import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
let root = ''
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (root) rmSync(root, { recursive: true, force: true }); root = '' })
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'launch-executable-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  vi.stubEnv('HOME', root); vi.stubEnv('PATH', bin); vi.stubEnv('OPENCODE_PATH', '')
  vi.resetModules()
  return { bin, ...await import('./launchExecutable.js') }
}
it('captures an absolute executable once and detects its replacement', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  const file = join(bin, 'opencode'); writeFileSync(file, 'fixture', { mode: 0o700 })
  const result = await captureLaunchExecutable('opencode', '')
  expect(result.state).toBe('ready')
  if (result.state !== 'ready') throw new Error('fixture was held')
  expect(result.executable.command).toBe(file)
  expect(result.executable.current()).toBe(true)
  writeFileSync(file, 'upgraded fixture')
  expect(result.executable.current()).toBe(false)
})
it('distinguishes complete absence from inaccessible or ambiguous candidates', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'install' })
  const file = join(bin, 'opencode'); writeFileSync(file, 'fixture'); chmodSync(file, 0o600)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
  rmSync(file); mkdirSync(file)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
  vi.stubEnv('PATH', 'relative')
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})
it('never installs over an explicitly configured missing executable', async () => {
  await fixture()
  vi.stubEnv('OPENCODE_PATH', join(root, 'absent'))
  vi.resetModules()
  const { captureLaunchExecutable } = await import('./launchExecutable.js')
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})

it('holds dangling command aliases instead of authorizing an installation over them', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  symlinkSync(join(root, 'unavailable-engine'), join(bin, 'opencode'))
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})
it('permits complete absence through a valid search-directory alias', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  const alias = join(root, 'path-alias'); symlinkSync(bin, alias); vi.stubEnv('PATH', alias)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'install' })
})
