/** Saved-home adoption answers from main, before making its writer durable and retryable. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the adoption golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const GOLDEN = fileURLToPath(new URL('./__fixtures__/engine-home-adoption.golden.json', import.meta.url))
const RECORD = process.env.RECORD_ENGINE_HOME_ADOPTION_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root = '', homes: typeof import('./engineHomes.js'), expected: Record<string, unknown>
const captured: Record<string, unknown> = {}
const path = (...parts: string[]) => join(root, ...parts)
const catalog = () => path('ADAPTER_DATA_DIR', 'engine-homes.json')
// Replay through a fresh reader: the physical persistence format is not a public catalog answer.
const durableCatalog = () => { homes.resetEngineHomes(); return homes.movedEngineHomes() }
function check(key: string, value: unknown): void {
  captured[key] = JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-home-adoption-golden-')))
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    mkdirSync(path(name), { recursive: true, mode: 0o700 })
    vi.stubEnv(name, path(name))
  }
  vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
  vi.stubEnv('TZ', 'UTC')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') })
  vi.resetModules()
  homes = await import('./engineHomes.js')
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  homes?.resetEngineHomes(); vi.useRealTimers(); vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
})

it('preserves adoption results, idempotence, merges and restart discovery', () => {
  check('new:roots', [homes.nativeSessionRoots('claude'), homes.nativeSessionRoots('codex')])
  check('new:empty-environment', homes.adoptHomes({}))
  const claude = path('claude-first'), codex = path('codex-first')
  check('adopt:first', homes.adoptHomes({ CLAUDE_CONFIG_DIR: ` ${claude}/ `, CODEX_HOME: codex }))
  check('adopt:catalog', durableCatalog())
  check('adopt:repeat', homes.adoptHomes({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: `${codex}/` }))
  check('adopt:roots', [homes.nativeSessionRoots('claude'), homes.nativeSessionRoots('codex')])
  const second = path('codex-second')
  check('adopt:second', homes.adoptHomes({ CODEX_HOME: second }))
  homes.resetEngineHomes()
  check('restart:known', homes.movedEngineHomes())
  check('restart:repeat', homes.adoptHomes({ CODEX_HOME: second }))
  const external = path('external-claude')
  const saved = durableCatalog()
  saved.claude.push(external)
  writeFileSync(`${catalog()}.external`, JSON.stringify(saved), { mode: 0o600 })
  renameSync(`${catalog()}.external`, catalog())
  check('merge:external', homes.movedEngineHomes())
  check('merge:adopt', homes.adoptHomes({ CLAUDE_CONFIG_DIR: path('claude-second') }))
  check('merge:catalog', durableCatalog())
  check('own:explicit-default', homes.adoptHomes({ CODEX_HOME: path('explicit-default') }, { codex: path('explicit-default') }))
  check('invalid:relative', homes.adoptHomes({ CODEX_HOME: 'relative', CLAUDE_CONFIG_DIR: '~/relative' }))
  homes.resetEngineHomes()
  check('restart:complete', [homes.nativeSessionRoots('claude'), homes.nativeSessionRoots('codex')])
})
it('replays every recorded observation', () => {
  if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
