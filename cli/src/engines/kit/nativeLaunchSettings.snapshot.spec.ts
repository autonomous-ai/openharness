import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareLaunchSettings } from './nativeLaunchSettings.js'
import { launchSettingsArgs } from './launchValues.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'optional-snapshot-')); roots.push(root)
  const dataDir = join(root, 'data'); mkdirSync(dataDir); mkdirSync(join(root, '.codex'))
  const source = join(root, '.codex', 'config.toml'); writeFileSync(source, 'developer_instructions = "before"\n')
  const values = { instructions: 'before plus optional', settings: null }
  const prepareSettings = vi.fn(async () => ({ version: 2, values }))
  const setup = { prepareSettings, prepareFiles: vi.fn(async () => ({ version: 1, values, files: [] })) }
  let owner = true, native = true
  return { root, dataDir, source, setup, prepareSettings,
    revokeOwner: () => { owner = false }, revokeNative: () => { native = false },
    prepare: () => prepareLaunchSettings('codex', { HOME: root }, root, setup,
      { dataDir, runtimeNode: process.execPath, platform: 'darwin', gitBash: null, owner: null,
        current: () => owner, nativeCurrent: () => native }) }
}

it('sends only launch context to optional setup, without reading source files in core', async () => {
  const f = fixture()
  // The component can omit an unreadable optional source. The core must not inspect it first.
  rmSync(f.source); mkdirSync(f.source)
  const prepared = await f.prepare()
  expect(prepared?.values.instructions).toBe('before plus optional')
  expect(f.setup.prepareFiles).not.toHaveBeenCalled()
  expect(f.prepareSettings).toHaveBeenCalledExactlyOnceWith({ purpose: 'launchSettings', version: 2,
    engine: 'codex', environment: { HOME: f.root }, cwd: f.root, runtimeNode: process.execPath,
    platform: 'darwin', gitBash: null, owner: null }, expect.any(String), expect.any(Function))
})

it('uses the baseline optional snapshot after a config edit during the later receipt wait', async () => {
  const f = fixture(), prepared = await f.prepare()
  expect(prepared).not.toBeNull()
  // A's literal optional argv preceded prepareInstructions. V2 deliberately restores that snapshot contract.
  await Promise.resolve().then(() => writeFileSync(f.source, 'developer_instructions = "after"\n'))
  expect(launchSettingsArgs('codex', ['--base'], prepared)).toEqual(['--base', '-c', 'developer_instructions="before plus optional"'])
})

it.each(['owner', 'native'] as const)('retains final %s authority after the optional snapshot is returned', async kind => {
  const f = fixture(), prepared = await f.prepare()
  expect(prepared).not.toBeNull()
  if (kind === 'owner') f.revokeOwner(); else f.revokeNative()
  expect(launchSettingsArgs('codex', ['--base'], prepared)).toEqual(['--base'])
})

it('keeps filesystem and optional policy implementation out of the core settings helper', () => {
  const source = readFileSync(new URL('./nativeLaunchSettings.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/from ['"](?:node:fs|node:path|\.\/nativeHookFiles\.js|\.\/nativeHookPublication\.js|\.\.\/launches\.js)/)
})
