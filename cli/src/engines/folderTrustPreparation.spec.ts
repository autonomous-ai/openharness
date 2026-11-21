import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFolderTrustPreparation } from './folderTrustPreparation.js'
import { publishNativeHookFiles } from './kit/nativeHookPublication.js'
import type { NativeSetup } from './kit/nativeSetup.js'
import { prepareNativeTrust } from '../services/nativeSetupTrust.js'

// Real snapshots, staged writes and renames; durability/failure is the native-file suite's contract.
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(null)),
}))
let root: string, home: string, cwd: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'folder-trust-boundary-'))
  home = join(root, 'home'); cwd = join(root, 'workspace')
  mkdirSync(home); mkdirSync(cwd)
  writeFileSync(join(home, 'config.toml'), 'model = "fixture"\n')
  writeFileSync(join(home, '.claude.json'), '{"unrelated":{"kept":true}}')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const local: Pick<NativeSetup, 'prepareTrust'> = { prepareTrust: async (input, _request, current) => prepareNativeTrust(input, current) }
const request = (engine: 'claude' | 'codex' = 'codex') => ({ engine, cwd, profile: home, environment: { HOME: home, CODEX_HOME: home }, empty: true as const })
function gate() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}

it.each(['claude', 'codex'] as const)('preserves a symlinked %s config and unrelated settings', async engine => {
  const file = join(home, engine === 'claude' ? '.claude.json' : 'config.toml'), target = join(root, 'dotfile')
  renameSync(file, target); symlinkSync(target, file)
  expect(await createFolderTrustPreparation(local)(request(engine), () => true)).toBe(true)
  expect(lstatSync(file).isSymbolicLink()).toBe(true)
  const text = readFileSync(target, 'utf8')
  if (engine === 'codex') { expect(text).toContain('model = "fixture"'); expect(text).toContain('trust_level = "trusted"') }
  else expect(JSON.parse(text)).toMatchObject({ unrelated: { kept: true }, projects: { [cwd]: { hasTrustDialogAccepted: true } } })
})

it('allows its own MCP settings creation only after trust commits, recording no approvals', async () => {
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { undecided: {}, approved: {}, rejected: {} } }))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['rejected'], unrelated: 1 }))
  expect(await createFolderTrustPreparation(local)(request('claude'), () => true)).toBe(true)
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects[cwd].hasTrustDialogAccepted).toBe(true)
  expect(JSON.parse(readFileSync(join(cwd, '.claude/settings.local.json'), 'utf8'))).toEqual({ disabledMcpjsonServers: ['undecided'] })
  expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).unrelated).toBe(1)
})

it.each(['entry', 'replacement', 'revoked', 'config', 'alias'] as const)('refuses %s changed while the worker prepared trust', async change => {
  const entered = gate(), release = gate(), file = join(home, 'config.toml')
  let current = true
  const prepare = createFolderTrustPreparation({ prepareTrust: async (input, _request, active) => {
    const candidate = prepareNativeTrust(input, active); entered.resolve(); await release.promise; return candidate
  } })
  const pending = prepare(request(), () => current)
  await entered.promise
  if (change === 'entry') writeFileSync(join(cwd, 'user-code'), 'mine')
  if (change === 'replacement') { renameSync(cwd, cwd + '-old'); mkdirSync(cwd) }
  if (change === 'revoked') current = false
  if (change === 'config') writeFileSync(file, 'model = "newer"\n')
  if (change === 'alias') { renameSync(file, file + '-old'); symlinkSync(file + '-old', file) }
  release.resolve()
  expect(await pending).toBe(false)
  expect(readFileSync(file, 'utf8')).not.toContain('trust_level')
})

it('does not replace a live hook reservation with optional trust or lose its completed edit', async () => {
  const entered = gate(), release = gate(), file = join(home, 'config.toml')
  const hook = publishNativeHookFiles({ engine: 'codex', environment: { CODEX_HOME: home }, port: 1234 }, [{ file }], {
    prepareFiles: async input => { entered.resolve(); await release.promise
      return { version: 1, files: [{ index: 0, content: input.files[0].content + 'hook = "kept"\n' }] }
    },
  })
  await entered.promise
  expect(await createFolderTrustPreparation(local)(request(), () => true)).toBe(false)
  release.resolve(); expect(await hook).toBe(true)
  expect(await createFolderTrustPreparation(local)(request(), () => true)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('hook = "kept"')
  expect(readFileSync(file, 'utf8')).toContain('trust_level = "trusted"')
})

it('a competing hook revokes an uncommitted trust candidate instead of overwriting newer bytes', async () => {
  const entered = gate(), release = gate(), file = join(home, 'config.toml')
  const prepare = createFolderTrustPreparation({ prepareTrust: async (input, _request, current) => {
    const candidate = prepareNativeTrust(input, current); entered.resolve(); await release.promise; return candidate
  } })
  const trust = prepare(request(), () => true); await entered.promise
  const hook = () => publishNativeHookFiles({ engine: 'codex', environment: {}, port: 1234 }, [{ file }], {
    prepareFiles: async input => ({ version: 1, files: [{ index: 0, content: input.files[0].content + 'hook = "newer"\n' }] }),
  })
  expect(await hook()).toBe(false)
  release.resolve(); expect(await trust).toBe(false)
  expect(await hook()).toBe(true)
  expect(readFileSync(file, 'utf8')).not.toContain('trust_level')
})

it('inherits only a source already trusted in the captured native profile', async () => {
  const source = join(root, 'source'); mkdirSync(source)
  const prepare = createFolderTrustPreparation(local)
  expect(await prepare({ ...request(), source, empty: undefined }, () => true)).toBe(false)
  writeFileSync(join(home, 'config.toml'), `[projects.${JSON.stringify(source)}]\ntrust_level = "trusted"\n`)
  expect(await prepare({ ...request(), source, empty: undefined }, () => true)).toBe(true)
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain(`[projects.${JSON.stringify(cwd)}]`)
})

it('rejects inherited trust when a repository boundary appears after the worker reply was prepared', async () => {
  const source = join(root, 'source'); mkdirSync(source)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }))
  const entered = gate(), release = gate()
  const prepare = createFolderTrustPreparation({ prepareTrust: async (input, _request, current) => {
    const candidate = prepareNativeTrust(input, current)
    expect(candidate).not.toBeNull(); entered.resolve(); await release.promise; return candidate
  } })
  const pending = prepare({ ...request('claude'), source, empty: undefined }, () => true)
  await entered.promise
  mkdirSync(join(source, '.git'))
  release.resolve()
  expect(await pending).toBe(false)
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects).not.toHaveProperty(cwd)
})

it.each(['created', 'edited'] as const)('does not overwrite a user MCP decision %s during preparation', async change => {
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"chosen":{}}}')
  const file = join(home, 'settings.json')
  if (change === 'edited') writeFileSync(file, '{}')
  const entered = gate(), release = gate()
  const prepare = createFolderTrustPreparation({ prepareTrust: async (input, _request, current) => {
    const candidate = prepareNativeTrust(input, current); entered.resolve(); await release.promise; return candidate
  } })
  const pending = prepare(request('claude'), () => true)
  await entered.promise
  writeFileSync(file, '{"enabledMcpjsonServers":["chosen"]}')
  release.resolve()
  expect(await pending).toBe(false)
  expect(existsSync(join(cwd, '.claude/settings.local.json'))).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{"enabledMcpjsonServers":["chosen"]}')
})

it('preserves native prompts with old, off, malformed or rejected optional setup', async () => {
  for (const setup of [{}, { prepareTrust: async () => null }, { prepareTrust: async () => { throw Error('fixture unavailable') } },
    { prepareTrust: async () => ({ version: 1 as const, files: [{ index: 99, content: 'unowned' }] }) }]) {
    expect(await createFolderTrustPreparation(setup)(request(), () => true)).toBe(false)
  }
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "fixture"\n')
  expect(existsSync(join(cwd, '.claude'))).toBe(false)
})
