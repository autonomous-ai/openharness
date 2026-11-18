import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLocalNativeSetup } from './nativeSetup.js'
import { startEngineSetup } from './engineSetup.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'optional-component-')); roots.push(root)
  const data = join(root, 'data'), home = join(root, 'home'), work = join(root, 'work')
  mkdirSync(data); mkdirSync(home); mkdirSync(work); mkdirSync(join(home, '.claude'))
  const source = join(home, '.claude', 'settings.json'), bytes = '{"statusLine":{"type":"command","command":"echo owner","padding":{"left":2}}}'
  writeFileSync(source, bytes)
  const setup = createLocalNativeSetup(join(data, 'native-installations'))
  const input = { purpose: 'launchSettings', version: 2, engine: 'claude', environment: { HOME: home }, cwd: work,
    runtimeNode: process.execPath, platform: 'darwin', gitBash: null, owner: null }
  const prepare = (commit: () => Promise<boolean> = async () => true) => {
    const operation = (setup as unknown as { prepareSettings?: (input: unknown, request: string, current: () => boolean,
      commit: () => Promise<boolean>) => Promise<{ values: { settings: string | null } } | null> }).prepareSettings
    expect(operation).toBeTypeOf('function')
    return operation!(input, 'fixture', () => true, commit)
  }
  return { root, data, home, work, source, bytes, setup, input, prepare,
    script: join(data, 'statusline', 'statusline.mjs') }
}

it('captures source policy and publishes only its own artifact inside setup', async () => {
  const f = fixture(), result = await f.prepare()
  expect(result).not.toBeNull()
  expect(JSON.parse(result!.values.settings!)).toMatchObject({ statusLine: { padding: { left: 2 }, command: expect.stringContaining('--then') } })
  expect(readFileSync(f.script, 'utf8')).toContain('rate_limits')
  expect(readFileSync(f.source, 'utf8')).toBe(f.bytes)
})

it('has no artifact effect when the launch refuses commit', async () => {
  const f = fixture()
  expect(await f.prepare(async () => false)).toBeNull()
  expect(existsSync(f.script)).toBe(false)
  expect(readFileSync(f.source, 'utf8')).toBe(f.bytes)
})

it('revalidates captured source bytes after the commit wait before any publication', async () => {
  const f = fixture()
  expect(await f.prepare(async () => { writeFileSync(f.source, '{}'); return true })).toBeNull()
  expect(existsSync(f.script)).toBe(false)
  expect(readFileSync(f.source, 'utf8')).toBe('{}')
})

it('refuses an artifact alias into a user file without modifying that file', async () => {
  const f = fixture(); mkdirSync(join(f.data, 'statusline')); symlinkSync(f.source, f.script)
  expect(await f.prepare()).toBeNull()
  expect(readFileSync(f.source, 'utf8')).toBe(f.bytes)
})

it('explicitly refuses an old captured-source optional request on the new worker', async () => {
  const f = fixture(), service = startEngineSetup(join(f.data, 'native-installations'), f.setup)
  try {
    const { version: _version, ...context } = f.input
    const old = { ...context, engine: 'codex', request: 'old', dataDir: f.data, files: [],
      sources: [{ file: join(f.data, 'agent-settings.json'), content: null },
        { file: join(f.home, '.codex', 'config.toml'), content: null },
        { file: join(f.work, '.codex', 'config.toml'), content: null },
        { file: join(f.root, '.codex', 'config.toml'), content: null },
        { file: '/private/tmp/.codex/config.toml', content: null },
        { file: '/private/.codex/config.toml', content: null }] }
    // No cwd makes this a complete old DTO, not a missing-source failure on the old renderer.
    const reply = await service.requests.setup_files_prepare!({ ...old, cwd: null }, { local: true, owner: true })
    expect(reply).toEqual({ files: null })
  } finally { service.stop() }
})
