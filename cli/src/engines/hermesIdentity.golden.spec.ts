/** Former Hermes pool behavior through declared homes, source reads and live repair.
 * Linux/UTC/fixed clock, private stores, built-in SQLite, no host process or engine. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: () => { throw new Error('This golden must never run a host process') },
  execFileSync: () => { throw new Error('This golden must never run a host process') },
}))
vi.mock('./inProcess.js', () => ({ loadEngine: () => { throw new Error('Hermes identity must not load an optional engine') } }))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/hermes-identity.golden.json', import.meta.url))
const RECORD = process.env.RECORD_HERMES_IDENTITY_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const AT = Date.parse('2026-10-09T12:00:00Z'), START = AT - 60_000
const ids = { own: '20261009_120000_a1b2', profile: '20261009_120001_c3d4', child: '20261009_120002_e5f6', missing: '20261009_120003_aabb' }
let root: string, expected: Record<string, unknown>
const captured: Record<string, unknown> = {}
let repair: typeof import('../lib/sessionRepair.js')
let homes: typeof import('./kit/storeHomes.js')
let source: typeof import('./kit/storeSource.js')
let contract: typeof import('./hermes/contract.js')
const home = () => join(root, 'hermes')
const cwd = (name: string) => join(root, 'work', name)
async function check(key: string, work: unknown | Promise<unknown>): Promise<void> {
  const value = JSON.parse(JSON.stringify(await work ?? null).split(root).join('<root>'))
  captured[key] = value
  if (!RECORD) expect({ key, value }).toEqual({ key, value: expected[key] })
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-identity-golden-')))
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_HOOK_ROUTES_DIR',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR',
    'COPILOT_HOME', 'GROK_HOME', 'AGY_HOME', 'AGY_CONFIG_DIR', 'PI_HOME', 'MUSE_HOME', 'COMMANDCODE_HOME',
    'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'DEVIN_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(name, join(root, name.toLowerCase()))
  }
  vi.stubEnv('HERMES_HOME', home()); vi.stubEnv('TZ', 'UTC')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: AT }); vi.resetModules()
  repair = await import('../lib/sessionRepair.js')
  homes = await import('./kit/storeHomes.js')
  source = await import('./kit/storeSource.js')
  contract = await import('./hermes/contract.js')
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void }
  }
  for (const name of ['own', 'profile', 'child', 'none', 'old', 'both', 'many']) mkdirSync(cwd(name), { recursive: true })
  for (const [path, records] of [
    [home(), [[ids.own, 'own', AT, 'cli'], ['20261009_120004_aaaa', 'both', AT, 'cli'], ['20261009_120005_bbbb', 'old', START - 60_000, 'cli']]],
    [join(home(), 'profiles', 'work'), [[ids.profile, 'profile', AT, 'tui'], [ids.child, 'child', AT, 'subagent'],
      ['20261009_120006_cccc', 'both', AT, 'cli'], ['20261009_120007_dddd', 'many', AT, 'cli'], ['20261009_120008_eeee', 'many', AT, 'cli']]],
  ] as const) {
    mkdirSync(path, { recursive: true })
    const db = new DatabaseSync(join(path, 'state.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, source TEXT);')
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
    for (const [id, dir, started, kind] of records) insert.run(id, cwd(dir), started / 1000, kind)
    db.close()
  }
  mkdirSync(join(home(), 'profiles', 'unwritten'), { recursive: true })
  writeFileSync(join(home(), 'profiles', 'unwritten', 'config.yaml'), 'model: fixture\n')
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
})

it('records complete declared homes, excluding profiles without a store', async () => {
  await check('homes', homes.readStoreHomes(contract.HERMES_HOMES, home()))
  await check('missing-home', homes.readStoreHomes(contract.HERMES_HOMES, join(root, 'missing-home')))
})
it('records live repair in the default and profile stores, with known absence and ambiguity', async () => {
  for (const name of ['own', 'profile', 'none', 'old', 'both', 'many']) {
    await check(`repair:${name}`, repair.findLiveSession('hermes', cwd(name), START))
  }
  await check('repair:born-only', repair.findLiveSession('hermes', cwd('profile'), START, { bornOnly: true }))
  await check('repair:pid', repair.findLiveSession('hermes', cwd('profile'), START, { pid: 4242 }))
})
it('records native source declarations without optional interpretation', async () => {
  for (const [label, path, id] of [
    ['own', home(), ids.own], ['profile', join(home(), 'profiles', 'work'), ids.profile],
    ['child', join(home(), 'profiles', 'work'), ids.child], ['absent', home(), ids.missing],
    ['unwritten', join(home(), 'profiles', 'unwritten'), ids.missing], ['invalid', home(), '../escape'],
  ]) await check(`source:${label}`, source.readStoreSessionSource(contract.HERMES_SOURCE, contract.hermesDbPath(path), id))
})
