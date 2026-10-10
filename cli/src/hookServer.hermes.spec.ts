/** Real hook admission and private SQLite homes; no daemon, tmux server or native user home. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

const failures = vi.hoisted(() => new Map<string, string>())
const inspection = vi.hoisted(() => ({ read: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  const guarded = (name: 'lstat' | 'opendir') => async (path: string, ...args: unknown[]) => {
    const code = failures.get(`${name}:${path}`)
    if (code) throw Object.assign(new Error('controlled filesystem failure'), { code })
    const result = await Reflect.apply(fs[name], fs, [path, ...args])
    inspection.read?.(path)
    return result
  }
  return { ...fs, lstat: guarded('lstat'), opendir: guarded('opendir') }
})

let root = ''
let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  failures.clear()
  inspection.read = undefined
  if (root) rmSync(root, { recursive: true, force: true })
})
async function fixture(options: { waitOnResolution?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'hermes-admission-'))
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), HERMES_HOME: join(root, 'home', '.hermes'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime') })) vi.stubEnv(key, value)
  vi.resetModules()
  const { registry } = await import('./lib/registry.js')
  const { startHookServer } = await import('./hookServer.js')
  const { readHookCredential } = await import('./lib/hookAuth.js')
  const { markDeleted } = await import('./lib/deletedSessions.js')
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: string[]): void }; close(): void }
  }
  const home = join(root, 'home', '.hermes')
  const store = (dir: string, rows: Array<[string, string]>) => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'state.db')
    rmSync(file, { force: true })
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT)')
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?)')
    for (const row of rows) insert.run(...row)
    db.close()
  }
  const processIdentity = { pid: 4242, startMarker: 'Thu Oct 8 12:00:00 2026', executable: 'hermes' }
  const { entry: agent } = registry.openProcessAgent({ engine: 'hermes', tmuxPane: '%1', cwd: root, processIdentity })!
  const registered = vi.fn()
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')) })
  let resume!: () => void
  let resolutions = 0
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd: () => {},
    ...(options.waitOnResolution ? { resolveHookAgent: async ({ onWait }: { onWait?: () => void }) => {
      if (++resolutions === options.waitOnResolution) { onWait?.(); await new Promise<void>(resolve => { resume = resolve }) }
      return registry.byAgent(agent.agentId) ?? null
    } } : {}),
  })
  server = started.server
  let firedAt = Date.now()
  const hook = async (sessionId: string, status = 200, fired = ++firedAt) => {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/session-start`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(join(root, 'data'))!,
        'x-harness-hook-fired-at': String(fired) },
      body: JSON.stringify({ engine: 'hermes', tmuxPane: '%1', sessionId, cwd: root, hookEvent: 'SessionStart' }),
    })
    expect(response.status).toBe(status)
    const body = await response.json()
    if (status === 200) expect(body).toEqual({ pending: true })
    return body
  }
  const current = () => registry.byAgent(agent.agentId)!
  return { home, store, hook, current, registered, logs, markDeleted, resume: () => resume(),
    knownHome: (home: string) => registry.setHermesHome(agent.agentId, home),
    seed: (sessionId: string) => registry.register({ engine: 'hermes', sessionId, tmuxPane: '%1', cwd: root, processIdentity }),
  }
}

it('holds when the known home changes during source inspection instead of publishing the old proof', async () => {
  const f = await fixture()
  const own = '20261009_120000_aabbcc', other = join(root, 'another-home')
  f.store(f.home, [[own, 'cli']])
  f.store(other, [])
  inspection.read = path => {
    if (path !== join(f.home, 'state.db')) return
    inspection.read = undefined
    f.knownHome(other)
  }
  await f.hook(own)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('fresh evidence after the binding changed'))).toBe(true))
  expect(f.current()).toMatchObject({ sessionId: '', hermesHome: other })
  expect(f.registered).not.toHaveBeenCalled()
})

it('holds an unreadable store without binding and retries after the store recovers', async () => {
  const f = await fixture()
  const previous = '20261009_115900_eeeeee'
  f.store(f.home, [[previous, 'cli']])
  await f.hook(previous)
  await vi.waitFor(() => expect(f.current().sessionId).toBe(previous))
  f.registered.mockClear()
  writeFileSync(join(f.home, 'state.db'), 'not SQLite')
  const wanted = '20261009_120000_aaaaaa'
  await f.hook(wanted)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe(previous)
  expect(f.current().hermesHome).toBeNull()
  expect(f.registered).not.toHaveBeenCalled()
  f.store(f.home, [[wanted, 'cli']])
  await vi.waitFor(() => expect(f.current().sessionId).toBe(wanted), { timeout: 4_000 })
  expect(f.registered).toHaveBeenCalledOnce()
})

it.each(['\0tool', 'cli\0tool', 'x'.repeat(129)])('holds a malformed original source without accepting its text prefix: %j', async source => {
  const f = await fixture()
  const own = '20261009_120000_aabbcc'
  f.store(f.home, [[own, source]])
  await f.hook(own)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  expect(f.registered).not.toHaveBeenCalled()
})

it('includes the known custom home and cannot authorize its hook from a different home', async () => {
  const f = await fixture()
  const own = '20261009_120000_aabbcc'
  const custom = join(root, 'custom-home')
  f.knownHome(custom)
  f.store(f.home, [[own, 'cli']])
  mkdirSync(custom); writeFileSync(join(custom, 'state.db'), 'unreadable custom store')
  await f.hook(own)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  f.store(custom, [])
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('source in its known home'))).toBe(true), { timeout: 4_000 })
  expect(f.registered).not.toHaveBeenCalled()
  f.store(custom, [[own, 'tool']])
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ambiguous across homes'))).toBe(true), { timeout: 4_000 })
  expect(f.current().sessionId).toBe('')
  f.store(f.home, [])
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ignored · hermes_subagent'))).toBe(true), { timeout: 4_000 })
  expect(f.registered).not.toHaveBeenCalled()
})

it('holds incomplete source pools, then rejects a proven delegated session after recovery', async () => {
  const f = await fixture()
  mkdirSync(f.home, { recursive: true })
  writeFileSync(join(f.home, 'state.db'), 'not SQLite')
  const child = '20261009_120000_bbbbbb'
  f.store(join(f.home, 'profiles', 'work'), [[child, 'tool']])
  await f.hook(child)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  expect(f.registered).not.toHaveBeenCalled()
  f.store(f.home, [])
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ignored · hermes_subagent'))).toBe(true), { timeout: 4_000 })
  expect(f.registered).not.toHaveBeenCalled()
})

it('keeps a missing source row pending and replaces an older pending hook', async () => {
  const f = await fixture()
  f.store(f.home, [])
  const old = '20261009_120000_cccccc', newer = '20261009_120000_dddddd'
  await f.hook(old)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Waiting for the Hermes session source record'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  f.store(f.home, [[old, 'cli'], [newer, 'cli']])
  await f.hook(newer)
  await vi.waitFor(() => expect(f.current().sessionId).toBe(newer))
  await new Promise(resolve => setTimeout(resolve, 1_100))
  expect(f.current().sessionId).toBe(newer)
  expect(f.registered).toHaveBeenCalledOnce()
})

it('recovers a held parent after rejecting its newer delegated hook', async () => {
  const f = await fixture()
  mkdirSync(f.home, { recursive: true })
  writeFileSync(join(f.home, 'state.db'), 'not SQLite')
  const parent = '20261009_120000_111111', child = '20261009_120000_222222'
  await f.hook(parent)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held ·'))).toBe(true))
  await f.hook(child)
  f.store(f.home, [[parent, 'cli'], [child, 'tool']])
  await vi.waitFor(() => expect(f.current().sessionId).toBe(parent), { timeout: 4_000 })
  expect(f.registered).toHaveBeenCalledOnce()
  expect(f.logs.some(line => line.includes('ignored · hermes_subagent'))).toBe(true)
})

it('recovers an equal-time parent after its child has already been held', async () => {
  const f = await fixture()
  f.store(f.home, [])
  const parent = '20261009_120000_121212', child = '20261009_120000_343434'
  await f.hook(child, 200, 1000)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held ·'))).toBe(true))
  f.store(f.home, [[parent, 'cli']])
  await f.hook(parent, 200, 1000)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('unambiguous native hook order'))).toBe(true))
  f.store(f.home, [[parent, 'cli'], [child, 'tool']])
  await vi.waitFor(() => expect(f.current().sessionId).toBe(parent), { timeout: 4_000 })
  expect(f.registered).toHaveBeenCalledOnce()
})

it.each(['lstat', 'opendir'] as const)('holds incomplete %s evidence, then discovers the recovered profile afresh', async operation => {
  const f = await fixture()
  f.store(f.home, [])
  const wanted = '20261009_120000_333333'
  const first = join(f.home, 'profiles', 'a'), second = join(f.home, 'profiles', 'b')
  f.store(first, [[wanted, 'cli']]); f.store(second, [[wanted, 'cli']])
  failures.set(operation === 'lstat' ? `lstat:${join(first, 'state.db')}` : `opendir:${join(f.home, 'profiles')}`, 'EACCES')
  await f.hook(wanted)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  expect(f.current().hermesHome).toBeNull()
  expect(f.registered).not.toHaveBeenCalled()
  failures.clear()
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ambiguous across homes'))).toBe(true), { timeout: 4_000 })
  expect(f.current().sessionId).toBe('')
  f.store(second, [])
  await vi.waitFor(() => expect(f.current().sessionId).toBe(wanted), { timeout: 4_000 })
  expect(f.current().hermesHome).toBe(first)
})

it('cannot publish a different pending conversation after Stop tombstones the agent', async () => {
  const f = await fixture()
  const previous = '20261009_120000_444444', pending = '20261009_120000_555555'
  f.store(f.home, [[previous, 'cli']])
  await f.hook(previous)
  await vi.waitFor(() => expect(f.current().sessionId).toBe(previous))
  f.registered.mockClear()
  await f.hook(pending)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held ·'))).toBe(true))
  f.markDeleted(f.current().agentId)
  f.store(f.home, [[previous, 'cli'], [pending, 'cli']])
  await new Promise(resolve => setTimeout(resolve, 1_100))
  expect(f.current().sessionId).toBe(previous)
  expect(f.registered).not.toHaveBeenCalled()
})

it('contains an asynchronous onRegistered rejection after publishing exactly once', async () => {
  const f = await fixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.registered.mockRejectedValue(new Error('attachment unavailable'))
  const wanted = '20261009_120000_666666'
  f.store(f.home, [[wanted, 'cli']])
  await f.hook(wanted)
  await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[hooks] committed admission notification failed', expect.any(Error)))
  expect(f.current().sessionId).toBe(wanted)
  expect(f.registered).toHaveBeenCalledOnce()
})

it.each([false, true])('reports capacity backpressure without claiming the extra hook was queued (resolution waits: %s)', async waits => {
  const f = await fixture(waits ? { waitOnResolution: 65 } : {})
  f.store(f.home, [])
  for (let i = 0; i < 64; i++) await f.hook(`20261009_120000_${i.toString(16).padStart(6, '0')}`)
  if (waits) {
    expect(await f.hook('20261009_120000_ffffff', 202)).toMatchObject({ pending: false, retry: true })
    f.resume()
    await vi.waitFor(() => expect(f.logs.some(line => line.includes('this hook was not queued'))).toBe(true))
  } else expect(await f.hook('20261009_120000_ffffff', 429)).toEqual({
      pending: false, error: 'HOOK_ADMISSION_BUSY', detail: expect.stringContaining('was not queued'),
    })
  expect(f.current().sessionId).toBe('')
  expect(f.registered).not.toHaveBeenCalled()
})

it('cannot let the first default-home answer hide unavailable or conflicting profiles', async () => {
  const f = await fixture()
  const own = '20261009_120000_777777'
  f.store(f.home, [[own, 'cli']])
  failures.set(`opendir:${join(f.home, 'profiles')}`, 'EACCES')
  await f.hook(own)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('held · Hermes session source is unavailable'))).toBe(true))
  expect(f.current().sessionId).toBe('')
  expect(f.registered).not.toHaveBeenCalled()
  failures.clear()
  await vi.waitFor(() => expect(f.current().sessionId).toBe(own), { timeout: 4_000 })
  expect(f.current().hermesHome).toBeNull()
})

it('never lets delayed process resolution or a retry of A replace a newer accepted B', async () => {
  const f = await fixture({ waitOnResolution: 1 })
  const a = '20261009_120000_888888', b = '20261009_120000_999999'
  f.store(f.home, [[a, 'cli'], [b, 'cli']])
  expect(await f.hook(a, 202, 1000)).toMatchObject({ pending: false, retry: true })
  await f.hook(b, 200, 2000)
  await vi.waitFor(() => expect(f.current().sessionId).toBe(b))
  f.resume()
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ignored · stale_hook'))).toBe(true))
  await f.hook(a, 200, 1000)
  await vi.waitFor(() => expect(f.logs.filter(line => line.includes('ignored · stale_hook'))).toHaveLength(2))
  expect(f.current().sessionId).toBe(b)
  expect(f.registered).toHaveBeenCalledOnce()
})

it('starts with the existing binding as authority when no hook watermark exists yet', async () => {
  const f = await fixture()
  const a = '20261009_120000_aaaaaa', b = '20261009_120000_bbbbbb'
  f.store(f.home, [[a, 'cli'], [b, 'cli']])
  f.seed(b)
  const boundAt = f.current().boundAt!
  await f.hook(a, 200, boundAt - 1)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ignored · stale_hook'))).toBe(true))
  expect(f.current().sessionId).toBe(b)
  await f.hook(a, 200, boundAt + 1)
  await vi.waitFor(() => expect(f.current().sessionId).toBe(a))
  expect(f.registered).toHaveBeenCalledOnce()
})
