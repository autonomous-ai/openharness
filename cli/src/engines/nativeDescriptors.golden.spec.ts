/** Healthy native descriptor answers from former main. Linux, UTC, fixed time and private files;
 * every host binary is forbidden. Record before changing process or descriptor authority. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../lib/tmux.js'
import type { RegisteredSession } from '../lib/registry.js'

const fixture = vi.hoisted(() => ({ root: '', rows: [] as ProcessRow[] }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  const mapped = (path: unknown) => String(path).startsWith('/proc/')
    ? join(fixture.root, 'proc', String(path).slice('/proc/'.length)) : path
  return { ...fs,
    readdir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readdir, fs, [mapped(path), ...args]),
    opendir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.opendir, fs, [mapped(path), ...args]),
    readlink: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readlink, fs, [mapped(path), ...args]),
    stat: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.stat, fs, [mapped(path), ...args]),
  }
})
vi.mock('node:child_process', async original => {
  const forbidden = () => { throw new Error('This golden must never run a host binary') }
  return { ...await original<object>(), execFile: forbidden, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden }
})
vi.mock('../lib/tmux.js', async original => ({ ...await original<object>(), processRows: async () => fixture.rows }))
vi.mock('../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-descriptors.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_DESCRIPTORS_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const now = Date.parse('2026-10-09T12:00:00Z')
const startMarker = 'Fri Oct  9 11:59:00 2026'
const id = (n: number) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
const path = (...parts: string[]) => join(fixture.root, ...parts)
const captured: Record<string, unknown> = {}
let expected: Record<string, unknown>
let repair: typeof import('../lib/sessionRepair.js')
let capture: typeof import('../lib/captureResumeIdentity.js')['captureResumeIdentity']

function file(name: string, text = ''): string {
  mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text)
  return name
}
function rollout(n: number, options: { home?: string; cwd?: string; child?: boolean } = {}): string {
  return file(join(options.home ?? path('codex'), 'sessions', 'day', `rollout-${id(n)}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: id(n), cwd: options.cwd ?? path('work'),
      source: options.child ? { subagent: { thread_spawn: { parent_thread_id: id(99) } } } : 'cli' },
  }) + '\n')
}
function descriptors(pid: number, targets: string[]): void {
  const folder = path('proc', String(pid), 'fd')
  rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true })
  targets.forEach((target, index) => symlinkSync(target, join(folder, String(index + 3))))
}
function processRow(pid: number, parentPid: number, executable = '/fixture-tools/codex', args = executable): ProcessRow {
  return { pid, parentPid, executable, args, startMarker, startTicks: pid * 100 }
}
function row(pid = 42): RegisteredSession {
  const live = fixture.rows.find(item => item.pid === pid)!
  return { agentId: 'fixture-agent', engine: 'codex', sessionId: '', transcriptPath: null, cwd: path('work'),
    codexHome: path('codex'), processIdentity: { pid, executable: live.executable, startMarker, startTicks: live.startTicks },
    source: 'discovery', boundAt: 0 } as RegisteredSession
}
async function check(key: string, work: Promise<unknown> | unknown): Promise<void> {
  captured[key] = JSON.parse(JSON.stringify(await work ?? null).split(fixture.root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}

beforeAll(async () => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-descriptors-golden-')))
  for (const [name, value] of Object.entries({ HOME: path('home'), TZ: 'UTC',
    ADAPTER_DATA_DIR: path('data'), ADAPTER_RUNTIME_DIR: path('runtime'), CODEX_HOME: path('codex'),
    CLAUDE_CONFIG_DIR: path('claude'), CLAUDE_PROJECTS_DIR: path('claude', 'projects'),
  })) vi.stubEnv(name, value)
  for (const folder of ['home', 'data', 'runtime', 'work', 'elsewhere']) mkdirSync(path(folder), { recursive: true })
  Object.defineProperty(globalThis.process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now }); vi.resetModules()
  repair = await import('../lib/sessionRepair.js')
  capture = (await import('../lib/captureResumeIdentity.js')).captureResumeIdentity
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  Object.defineProperty(globalThis.process, 'platform', platform); vi.useRealTimers(); vi.unstubAllEnvs()
  rmSync(fixture.root, { recursive: true, force: true })
})

it('records complete private descriptor listings and one launcher child', async () => {
  const own = rollout(1), other = rollout(2), noise = file(path('notes'))
  fixture.rows = [processRow(42, 1), processRow(50, 1), processRow(51, 42)]
  descriptors(42, [noise, own, 'socket:[123]']); descriptors(50, []); descriptors(51, [other])
  await check('descriptors:native', repair.openFiles(42).then(paths => paths.sort()))
  await check('descriptors:empty', repair.openFiles(50))
  await check('descriptors:invalid', repair.openFiles(0))
  await check('process:native-ignores-nested-tool', repair.processFilesOf('codex', 42).then(paths => paths.sort()))
  await check('process:other-engine', repair.processFilesOf('claude', 42))
  fixture.rows = [processRow(42, 1, '/fixture-tools/node', 'node /fixture-tools/codex.js'), processRow(43, 42), processRow(50, 1), processRow(51, 43)]
  descriptors(42, [noise]); descriptors(43, [own]); descriptors(50, [other]); descriptors(51, [other])
  await check('process:launcher-child', repair.processFilesOf('codex', 42).then(paths => paths.sort()))
  await check('process:direct-native-child', repair.processFilesOf('codex', 43))
})

it('records healthy exact native headers, roots and exclusions', async () => {
  const own = rollout(11), child = rollout(12, { child: true }), other = rollout(13, { cwd: path('elsewhere') })
  const outside = rollout(14, { home: path('other-home') }), root = path('codex', 'sessions')
  const alias = path('rollout-alias.jsonl'); symlinkSync(own, alias)
  fixture.rows = [processRow(42, 1)]
  for (const [name, held, cwd, roots] of [
    ['one', [own], path('work'), root],
    ['repeated-descriptors', [own, own], path('work'), root],
    ['alias', [own, alias], path('work'), root],
    ['child-excluded', [own, child], path('work'), root],
    ['other-cwd-excluded', [own, other], path('work'), root],
    ['outside-profile-excluded', [own, outside], path('work'), root],
    ['only-child', [child], path('work'), root],
    ['only-other-cwd', [other], path('work'), root],
    ['empty', [], path('work'), root],
    ['moved-home', [outside], path('work'), [root, path('other-home', 'sessions')]],
  ] as const) {
    descriptors(42, [...held])
    await check(`identity:${name}`, repair.openFileSessionOf('codex', 42, typeof roots === 'string' ? roots : [...roots], cwd))
  }
  await check('identity:other-engine', repair.openFileSessionOf('claude', 42, root, path('work')))
})

it('records native and launcher capture before Stop without native writes', async () => {
  const own = rollout(21)
  fixture.rows = [processRow(42, 1)]; descriptors(42, [own])
  await check('capture:native', capture(row()))
  await check('capture:complete-binding', capture({ ...row(), sessionId: id(21), transcriptPath: own }))
  await check('capture:terminal', capture({ ...row(), engine: 'terminal' }))
  fixture.rows = [processRow(42, 1, '/fixture-tools/node', 'node /fixture-tools/codex.js'), processRow(43, 42)]
  descriptors(42, []); descriptors(43, [own])
  await check('capture:launcher', capture(row()))
  descriptors(43, [])
  await check('capture:complete-empty', capture(row()))
})
it('has exactly the recorded observations', () => { if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort()) })
