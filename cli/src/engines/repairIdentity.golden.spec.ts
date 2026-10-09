/** Muse/Pi session-control answers, recorded from main before moving their optional readers.
 * Linux, UTC, the clock, file birth/mtime, homes and input are fixed. No engine binary runs.
 * RECORD_REPAIR_IDENTITY_GOLDEN=1 records the former implementation in its own commit. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ root: '', time: Date.parse('2026-10-09T00:00:00Z') }))
vi.mock('fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, realpath: (name: string) => fs.realpath(name.startsWith('/work/') ? join(clock.root, 'workspaces', name.slice(6)) : name),
    stat: async (path: string, ...args: unknown[]) => {
    const result = await Reflect.apply(fs.stat, fs, [path, ...args])
    return String(path).startsWith(clock.root + '/')
      ? new Proxy(result, { get: (value, key) => key === 'birthtimeMs' ? clock.time : Reflect.get(value, key) })
      : result
  } }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const mapped = (name: string) => name.startsWith('/work/') ? join(clock.root, 'workspaces', name.slice(6)) : name
  return { ...fs, realpathSync: (name: string) => fs.realpathSync(mapped(name)), statSync: (name: string) => fs.statSync(mapped(name)) }
})

const GOLDEN = fileURLToPath(new URL('./__fixtures__/repair-identity.golden.json', import.meta.url))
const RECORD = process.env.RECORD_REPAIR_IDENTITY_GOLDEN === '1'
const saved: Record<string, string | undefined> = {}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const captured: Record<string, unknown> = {}
let expected: Record<string, unknown> = {}
let repair: typeof import('../lib/sessionRepair.js')
let pi: typeof import('../lib/sessionSearch/externals/pi.js')

const lines = (...values: unknown[]) => values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n'
function file(path: string, body: string, time = clock.time): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  utimesSync(path, time / 1000, time / 1000)
  return path
}
async function check(key: string, run: () => unknown | Promise<unknown>): Promise<void> {
  let value: unknown
  try { value = await run() } catch (error) { value = { error: (error as Error).message } }
  if (typeof value === 'symbol') value = '<unsettled>'
  captured[key] = JSON.parse(JSON.stringify(value ?? null).split(clock.root).join('<root>'))
  if (!RECORD) {
    // Explicit safety corrections only: keep the former nulls in the artifact, but do not
    // let an incomplete identity remove a possible competitor from a discovery pool.
    const held: Record<string, string> = {
      'muse:malformed': 'the workspace header is incomplete or invalid',
      'muse:noWorkspace': 'the workspace header is incomplete or invalid',
      'muse:wrongEnvelope': 'the workspace header is incomplete or invalid',
      'muse:incomplete': 'the run identity is incomplete or invalid',
    }
    const reason = held[key]
    if (reason) expect(expected[key], `${key} · former answer`).toBeNull()
    expect({ key, value: captured[key] }).toEqual({ key,
      value: reason ? { error: `Conversation identity is held: ${reason}.` } : expected[key] })
  }
}

beforeAll(async () => {
  clock.root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-identity-golden-')))
  for (const cwd of ['pi/resume', 'pi/a-b', 'pi-a/b']) mkdirSync(join(clock.root, 'workspaces', cwd), { recursive: true })
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: clock.time })
  const home = join(clock.root, 'home')
  for (const [key, value] of Object.entries({ HOME: home, TZ: 'UTC', ADAPTER_DATA_DIR: join(clock.root, 'data'),
    ADAPTER_RUNTIME_DIR: join(clock.root, 'runtime'), MUSE_HOME: join(home, '.muse'), PI_HOME: join(home, '.pi'),
    CLAUDE_PROJECTS_DIR: join(home, '.claude', 'projects'), CODEX_HOME: join(home, '.codex') })) {
    saved[key] = process.env[key]; process.env[key] = value
  }
  vi.resetModules()
  repair = await import('../lib/sessionRepair.js')
  pi = await import('../lib/sessionSearch/externals/pi.js')
  if (!RECORD) expected = JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
  rmSync(clock.root, { recursive: true, force: true })
})

it('records which Muse files identify a conversation', async () => {
  const root = join(process.env.MUSE_HOME!, 'sessions', '2026', '10', '09')
  const header = (cwd: unknown) => ({ payload: { record: { workspace_root: cwd } } })
  const event = (scope: string, kind: string, prompt = '') => ({ payload: { kind: scope, event: { kind, prompt } } })
  const cases = {
    spoken: (cwd: string) => lines(header(cwd), event('run', 'started', 'hello')),
    scheduled: (cwd: string) => lines(header(cwd), event('run', 'started')),
    task: (cwd: string) => lines(header(cwd), event('task', 'started')),
    reminder: (cwd: string) => lines(header(cwd), event('memory', 'memory_reminder_child_session_linked')),
    delayed: (cwd: string) => lines(header(cwd), ...Array.from({ length: 300 }, () => event('task', 'started')), event('run', 'started')),
    malformed: (cwd: string) => lines('{', header(cwd), event('run', 'started')),
    incomplete: (cwd: string) => lines(header(cwd), '{'),
    noWorkspace: () => lines(header(null), event('run', 'started')),
    wrongWorkspace: () => lines(header('/elsewhere'), event('run', 'started')),
    wrongEnvelope: (cwd: string) => lines({ workspace_root: cwd }, event('run', 'started')),
    arrayEvent: (cwd: string) => lines(header(cwd), { payload: { kind: 'run', event: [] } }),
  }
  for (const [name, body] of Object.entries(cases)) {
    const cwd = `/work/muse/${name}`
    file(join(root, name, 'session.jsonl'), body(cwd))
    await check(`muse:${name}`, () => repair.findLiveSession('muse', cwd, clock.time, { bornOnly: true }))
    // A malformed header must not affect later cases; keep spoken for the final age check.
    if (name !== 'spoken') rmSync(join(root, name), { recursive: true, force: true })
  }
  file(join(root, 'parent', 'subagent', 'session.jsonl'), lines(header('/work/muse/child'), event('run', 'started')))
  await check('muse:subagent', () => repair.findLiveSession('muse', '/work/muse/child', clock.time))
  file(join(root, 'duplicate-a', 'session.jsonl'), lines(header('/work/muse/duplicate'), event('run', 'started')))
  file(join(root, 'duplicate-b', 'session.jsonl'), lines(header('/work/muse/duplicate'), event('run', 'started')))
  await check('muse:ambiguous', () => repair.findLiveSession('muse', '/work/muse/duplicate', clock.time))
  await check('muse:older-than-process', () => repair.findLiveSession('muse', '/work/muse/spoken', clock.time + 60_000))
})

it('records Pi header authority and incomplete-file answers', async () => {
  const header = (id: unknown = 'custom.id-12', cwd: unknown = '/work/pi') => ({ type: 'session', id, cwd })
  const cases: Record<string, string> = {
    valid: lines(header()), unicode: lines(header('custom.id-12', '/work/本/../本')),
    malformedLead: lines('', '{', 'null', header()), wrongFirst: lines({ type: 'message' }, header()),
    arrayFirst: lines([], header()), stringFirst: lines('"text"', header()), empty: '', partial: JSON.stringify(header()),
    wrongId: lines(header('../escape')), shortId: lines(header('a')), longId: lines(header('a'.repeat(129))),
    fileId: lines(header('a.jsonl')), relativeCwd: lines(header('valid', 'relative')), noCwd: lines(header('valid', null)),
    large: lines({ ...header(), padding: 'x'.repeat(20 * 1024) }),
    tooLarge: lines({ ...header(), padding: 'x'.repeat(1024 * 1024) }),
  }
  for (const [name, body] of Object.entries(cases)) {
    const path = file(join(clock.root, 'headers', name + '.jsonl'), body)
    await check(`pi:header:${name}`, () => pi.readPiHead(path))
  }
  for (const cwd of ['/work/pi', '/work/pi/a-b', '/work/pi-a/b', 'C:\\work\\pi', '/work/本']) {
    await check(`pi:folder:${cwd}`, () => pi.piSessionFolder(cwd))
  }
})

it('records Pi resume identity, including what must hold Close', async () => {
  const home = join(process.env.PI_HOME!, 'agent', 'sessions')
  const put = (cwd: string, name: string, body: string) => file(join(home, pi.piSessionFolder(cwd), name), body)
  const header = (id: string, cwd: string) => lines({ type: 'session', id, cwd })
  const cwd = '/work/pi/resume'
  put(cwd, '2026-10-09_custom.id-12.jsonl', header('custom.id-12', cwd))
  await check('pi:resume:exact', () => repair.findResumedTranscript('pi', 'custom.id-12', { cwd }))
  await check('pi:resume:unwritten', () => repair.findResumedTranscript('pi', 'not-written', { cwd }))
  await check('pi:resume:missing-folder', () => repair.findResumedTranscript('pi', 'not-written', { cwd: '/work/absent' }))
  await check('pi:resume:missing-cwd', () => repair.findResumedTranscript('pi', 'custom.id-12'))
  for (const id of ['../escape', 'a', 'a.jsonl']) await check(`pi:resume:invalid:${id}`, () => repair.findResumedTranscript('pi', id, { cwd }))
  put(cwd, '2026-10-09_empty-file.jsonl', '')
  await check('pi:resume:empty', () => repair.findResumedTranscript('pi', 'empty-file', { cwd }))
  put(cwd, '2026-10-09_bad-header.jsonl', lines({ type: 'message' }))
  await check('pi:resume:bad-header', () => repair.findResumedTranscript('pi', 'bad-header', { cwd }))
  put(cwd, '2026-10-10_custom.id-12.jsonl', header('custom.id-12', cwd))
  await check('pi:resume:duplicate', () => repair.findResumedTranscript('pi', 'custom.id-12', { cwd }))
  put('/work/pi/a-b', '2026-10-09_colliding-id.jsonl', header('colliding-id', '/work/pi/a-b'))
  await check('pi:resume:folder-collision', () => repair.findResumedTranscript('pi', 'colliding-id', { cwd: '/work/pi-a/b' }))
  put(cwd, '2026-10-09_wrong-id.jsonl', header('different-id', cwd))
  await check('pi:resume:header-id-wins', () => repair.findResumedTranscript('pi', 'wrong-id', { cwd }))
})
