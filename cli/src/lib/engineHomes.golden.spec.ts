/** Healthy saved-home answers recorded on main before removing the catalog's stamp cache.
 * Linux, UTC, fixed time and private homes; no host binary or login-shell probe. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({ environment: {} as NodeJS.ProcessEnv }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.environment }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw new Error('Host binaries are forbidden in this golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const GOLDEN = fileURLToPath(new URL('./__fixtures__/engine-homes.golden.json', import.meta.url))
const RECORD = process.env.RECORD_ENGINE_HOMES_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const captured: Record<string, unknown> = {}
let expected: Record<string, unknown>, root = ''
let homes: typeof import('./engineHomes.js')
let config: typeof import('../config/env.js')
const path = (...parts: string[]) => join(root, ...parts)
const saved = () => path('ADAPTER_DATA_DIR', 'engine-homes.json')
function check(key: string, value: unknown): void {
  captured[key] = JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-homes-golden-')))
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    vi.stubEnv(name, path(name))
    mkdirSync(path(name), { recursive: true })
  }
  vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
  vi.stubEnv('TZ', 'UTC')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-09T17:00:00Z') })
  vi.resetModules()
  homes = await import('./engineHomes.js')
  config = await import('../config/env.js')
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  homes?.resetEngineHomes(); shell.environment = {}; vi.useRealTimers(); vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
})

it('records declared roots, durable adoption, profiles and bound-home selection', () => {
  const { env } = config
  check('default:own', [homes.ownHomeOf('claude'), homes.ownHomeOf('codex')])
  check('default:roots', [homes.nativeSessionRoots('claude'), homes.nativeSessionRoots('codex'), homes.nativeSessionRoots('pi')])
  check('default:moved', homes.movedEngineHomes())
  check('default:ignored', homes.adoptHomes({ CLAUDE_CONFIG_DIR: dirname(env.CLAUDE_PROJECTS_DIR), CODEX_HOME: `${env.CODEX_HOME}/` }))
  for (const value of ['relative', '~/elsewhere', '   ', undefined]) {
    check(`ignored:${String(value)}`, homes.adoptHomes({ CLAUDE_CONFIG_DIR: value, CODEX_HOME: value }))
  }
  const claude = path('moved-claude'), codex = path('moved-codex'), profile = path('profile')
  check('adopt:both', homes.adoptHomes({ CLAUDE_CONFIG_DIR: ` ${claude}/ `, CODEX_HOME: `${codex}/` }))
  homes.resetEngineHomes()
  check('adopt:saved', homes.movedEngineHomes())
  check('adopt:duplicate', homes.adoptHomes({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }))
  check('adopt:roots', [homes.nativeSessionRoots('claude'), homes.nativeSessionRoots('codex')])
  check('adopt:home-roots', [homes.homeRoots('CODEX_HOME'), homes.homeRoots('CLAUDE_PROJECTS_DIR')])
  check('profile:roots', [homes.nativeSessionRoots('claude', profile), homes.nativeSessionRoots('codex', profile), homes.nativeSessionRoots('pi', profile)])
  check('profile:environment', [homes.profileEnvironment('claude', profile), homes.profileEnvironment('codex', profile), homes.profileEnvironment('pi', profile)])
  check('unknown:moved', [homes.movedHomes('pi'), homes.movedHomes('toString')])
  homes.resetEngineHomes()
  check('restart:before-shell', homes.movedEngineHomes())
  const extra = path('second-codex')
  writeFileSync(`${saved()}.draft`, JSON.stringify({ claude: [claude], codex: [codex, extra] }))
  renameSync(`${saved()}.draft`, saved())
  check('refresh:atomic-replacement', homes.movedEngineHomes())
  check('refresh:search-roots', [homes.claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR), homes.codexHomeRoots(env.CODEX_HOME)])
  shell.environment = { CLAUDE_CONFIG_DIR: path('new-claude'), CODEX_HOME: path('new-codex') }
  for (const folder of ['sessions', 'archived_sessions']) {
    const transcriptPath = join(codex, folder, 'thread.jsonl')
    check(`bound:${folder}`, [homes.sessionCodexHome({ transcriptPath }), homes.sessionFolderOf('codex', { transcriptPath }),
      homes.sessionCodexHome({ transcriptPath, codexHome: profile })])
  }
  check('bound:claude', homes.sessionClaudeHome({ transcriptPath: join(claude, 'projects', 'workspace', 'thread.jsonl') }))
  check('bound:sibling-prefix', [homes.sessionCodexHome({ transcriptPath: join(codex, 'sessions-other', 'thread.jsonl') }),
    homes.sessionClaudeHome({ transcriptPath: join(claude, 'projects-other', 'thread.jsonl') })])
  check('launch:shell', [homes.launchCodexHome(null), homes.launchClaudeConfigDir()])
  check('launch:profile', homes.launchCodexHome(profile))
  check('launch:explicit-environment', [homes.launchCodexHome(null, { CODEX_HOME: `${codex}/` }), homes.launchClaudeConfigDir({ CLAUDE_CONFIG_DIR: claude })])
  check('launch:invalid-environment', [homes.launchCodexHome(null, { CODEX_HOME: '~/invalid' }), homes.launchClaudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative' })])
  shell.environment = {}
  check('bound:no-shell-cache', [homes.sessionCodexHome({ transcriptPath: join(extra, 'sessions', 'thread.jsonl') }),
    homes.sessionClaudeHome({ transcriptPath: join(claude, 'projects', 'workspace', 'thread.jsonl') })])
})
it('records every observation', () => { if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort()) })
