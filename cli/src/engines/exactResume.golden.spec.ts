/** Exact resume answers recorded on main before bounding its native search.
 * Linux, UTC, fixed time and private stores; optional readers and host binaries are forbidden. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: () => { throw new Error('Host binaries are forbidden in this golden') },
  execFileSync: () => { throw new Error('Host binaries are forbidden in this golden') },
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, realpath: (name: string) => fs.realpath(name.startsWith('/work/') ? join(root, 'workspaces', name.slice(6)) : name) }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const mapped = (name: string) => name.startsWith('/work/') ? join(root, 'workspaces', name.slice(6)) : name
  return { ...fs, realpathSync: (name: string) => fs.realpathSync(mapped(name)), statSync: (name: string) => fs.statSync(mapped(name)) }
})
vi.mock('./inProcess.js', async original => ({ ...await original<object>(),
  loadEngine: () => { throw new Error('Optional engine loading is forbidden in this golden') },
}))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/exact-resume.golden.json', import.meta.url))
const RECORD = process.env.RECORD_EXACT_RESUME_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const captured: Record<string, unknown> = {}
const id = (n: number) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
let root = ''
let expected: Record<string, unknown>
let repair: typeof import('../lib/sessionRepair.js')
let homes: typeof import('../lib/engineHomes.js')
let identities: typeof import('./repairIdentities.js')
const path = (...parts: string[]) => join(root, ...parts)
function file(name: string, value: unknown): string {
  mkdirSync(dirname(name), { recursive: true })
  writeFileSync(name, JSON.stringify(value) + '\n')
  return name
}
const claude = (home: string, n: number) => file(join(home, 'projects', `project-${n}`, `${id(n)}.jsonl`), { cwd: path('work'), sessionId: id(n) })
const codex = (home: string, n: number) => file(join(home, 'sessions', '2026', '10', '09', `rollout-2026-10-09T12-00-00-${id(n)}.jsonl`),
  { type: 'session_meta', payload: { id: id(n), cwd: path('work'), source: 'cli' } })
async function check(key: string, value: Promise<unknown>): Promise<void> {
  captured[key] = JSON.parse(JSON.stringify(await value ?? null).split(root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'exact-resume-golden-')))
  for (const cwd of ['pi/a-b', 'pi-a/b']) mkdirSync(path('workspaces', cwd), { recursive: true })
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'PI_HOME', 'MUSE_HOME', 'HERMES_HOME', 'CURSOR_HOME', 'COPILOT_HOME', 'GROK_HOME', 'AGY_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) vi.stubEnv(name, path(name))
  vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
  vi.stubEnv('TZ', 'UTC')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-09T12:00:00Z') })
  vi.resetModules()
  repair = await import('../lib/sessionRepair.js')
  homes = await import('../lib/engineHomes.js')
  identities = await import('./repairIdentities.js')
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  homes?.resetEngineHomes(); vi.useRealTimers(); vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform)
  rmSync(root, { recursive: true, force: true })
})

it('records exact files, moved homes, explicit profiles and proven absence', async () => {
  claude(path('CLAUDE_CONFIG_DIR'), 1); codex(path('CODEX_HOME'), 1)
  claude(path('moved-claude'), 2); codex(path('moved-codex'), 2); codex(path('profile'), 3)
  for (const engine of ['claude', 'codex'] as const) {
    await check(`${engine}:own`, repair.findResumedTranscript(engine, id(1)))
    await check(`${engine}:unadopted`, repair.findResumedTranscript(engine, id(2)))
    await check(`${engine}:absent`, repair.findResumedTranscript(engine, id(4)))
    await check(`${engine}:invalid`, repair.findResumedTranscript(engine, '../escape'))
  }
  homes.adoptHomes({ CLAUDE_CONFIG_DIR: path('moved-claude'), CODEX_HOME: path('moved-codex') })
  for (const engine of ['claude', 'codex'] as const) await check(`${engine}:moved`, repair.findResumedTranscript(engine, id(2)))
  await check('codex:profile', repair.findResumedTranscript('codex', id(3), { codexHome: path('profile') }))
  await check('codex:profile-excludes-own', repair.findResumedTranscript('codex', id(1), { codexHome: path('profile') }))
  await check('codex:missing-profile', repair.findResumedTranscript('codex', id(1), { codexHome: path('missing') }))
  await check('unsupported', repair.findResumedTranscript('cursor', id(1)))
})

it('records Pi custom ids, lossy folders and unwritten conversations', async () => {
  const cwd = '/work/pi-a/b', collision = '/work/pi/a-b'
  const directory = path('PI_HOME', 'agent', 'sessions', identities.piSessionFolder(cwd))
  file(join(directory, '2026-10-09_custom.id-12.jsonl'), { type: 'session', id: 'custom.id-12', cwd })
  file(join(directory, '2026-10-09_other.id-12.jsonl'), { type: 'session', id: 'other.id-12', cwd: collision })
  await check('pi:exact', repair.findResumedTranscript('pi', 'custom.id-12', { cwd }))
  await check('pi:other-cwd', repair.findResumedTranscript('pi', 'custom.id-12', { cwd: collision }))
  await check('pi:unwritten', repair.findResumedTranscript('pi', 'not-written', { cwd }))
  await check('pi:missing-directory', repair.findResumedTranscript('pi', 'not-written', { cwd: path('absent') }))
})
it('records every observation', () => { if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort()) })

// Filesystem durability deadlines are exercised separately from these deterministic fixture reads.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
