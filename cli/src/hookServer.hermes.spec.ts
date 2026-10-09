/** Real hook admission and private SQLite homes; no daemon, tmux server or native user home. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

let root = ''
let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (root) rmSync(root, { recursive: true, force: true })
})
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'hermes-admission-'))
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), HERMES_HOME: join(root, 'home', '.hermes'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime') })) vi.stubEnv(key, value)
  vi.resetModules()
  const { registry } = await import('./lib/registry.js')
  const { startHookServer } = await import('./hookServer.js')
  const { readHookCredential } = await import('./lib/hookAuth.js')
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
  const started = await startHookServer(0, { onRegistered: registered, onSessionEnd: () => {} })
  server = started.server
  const hook = async (sessionId: string) => {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/session-start`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(join(root, 'data'))! },
      body: JSON.stringify({ engine: 'hermes', tmuxPane: '%1', sessionId, cwd: root, hookEvent: 'SessionStart' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pending: true })
  }
  const current = () => registry.byAgent(agent.agentId)!
  return { home, store, hook, current, registered, logs }
}

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

it('cannot let an unreadable home hide a delegated session in a healthy profile', async () => {
  const f = await fixture()
  mkdirSync(f.home, { recursive: true })
  writeFileSync(join(f.home, 'state.db'), 'not SQLite')
  const child = '20261009_120000_bbbbbb'
  f.store(join(f.home, 'profiles', 'work'), [[child, 'tool']])
  await f.hook(child)
  await vi.waitFor(() => expect(f.logs.some(line => line.includes('ignored · hermes_subagent'))).toBe(true))
  expect(f.current().sessionId).toBe('')
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
