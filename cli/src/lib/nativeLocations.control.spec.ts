/** Real control callers and private native files; no real process, home, engine or daemon. */
import { execFile } from 'node:child_process'
import * as sync from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BindDeps } from '../core/agents/bind.js'
import type { DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import type { RegisteredSession } from './registry.js'

vi.mock('node:fs', async original => {
  const actual = await original<typeof sync>()
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), statSync: vi.fn(actual.statSync) }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, stat: vi.fn(actual.stat), opendir: vi.fn(actual.opendir), readlink: vi.fn(actual.readlink) }
})
vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: vi.fn(() => { throw new Error('Unexpected host process probe') }),
}))
vi.mock('../engines/inProcess.js', () => ({ loadEngine: () => { throw new Error('Unexpected optional engine load') } }))

const A = 'aaaaaaaa-1111-4222-8333-444444444444', B = 'bbbbbbbb-1111-4222-8333-444444444444'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string, actual: typeof fs, actualSync: typeof sync
const file = (path: string, text = '{}\n') => { sync.mkdirSync(dirname(path), { recursive: true }); sync.writeFileSync(path, text); return path }
const denied = () => Object.assign(new Error('private fixture denied'), { code: 'EACCES' })
const copilotLock = (id: string, time: number) => {
  const path = file(join(root, 'copilot', 'session-state', id, 'inuse.4242.lock'))
  sync.utimesSync(path, time, time); return path
}
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>('node:fs/promises')
  actualSync = await vi.importActual<typeof sync>('node:fs')
  vi.mocked(sync.realpathSync).mockReset().mockImplementation(actualSync.realpathSync)
  vi.mocked(sync.statSync).mockReset().mockImplementation(actualSync.statSync)
  root = actualSync.realpathSync(sync.mkdtempSync(join(tmpdir(), 'native-control-')))
  const map = (path: unknown) => String(path).startsWith('/proc/') ? join(root, 'proc', String(path).slice(6)) : path
  vi.mocked(fs.opendir).mockReset().mockImplementation(((path, ...args) => Reflect.apply(actual.opendir, actual, [map(path), ...args])) as typeof fs.opendir)
  vi.mocked(fs.readlink).mockReset().mockImplementation(((path, ...args) => Reflect.apply(actual.readlink, actual, [map(path), ...args])) as typeof fs.readlink)
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat)
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_HOOK_ROUTES_DIR',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'GROK_HOME', 'HERMES_HOME', 'PI_HOME', 'MUSE_HOME',
    'COMMANDCODE_HOME', 'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'DEVIN_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) vi.stubEnv(name, join(root, name.toLowerCase()))
  for (const [name, directory] of Object.entries({ COPILOT_HOME: 'copilot', AGY_HOME: 'agy', AGY_CONFIG_DIR: 'agy',
    CURSOR_HOME: 'cursor', CURSOR_DATA_DIR: 'cursor', CURSOR_CONFIG_DIR: 'cursor' })) vi.stubEnv(name, join(root, directory))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.resetModules()
})
afterEach(() => {
  expect(execFile).not.toHaveBeenCalled()
  vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', platform); sync.rmSync(root, { recursive: true, force: true })
})

it.each(['copilot', 'agy'] as const)('repair revalidates %s ownership after transcript lookup', async engine => {
  const home = join(root, engine)
  const path = engine === 'copilot' ? file(join(home, 'session-state', A, 'events.jsonl'))
    : file(join(home, 'brain', A, '.system_generated', 'logs', 'transcript_full.jsonl'))
  const descriptor = join(root, 'proc', '4242', 'fd', '0')
  if (engine === 'copilot') { copilotLock(A, 3000); copilotLock(B, 1000) }
  else { sync.mkdirSync(dirname(descriptor), { recursive: true }); sync.symlinkSync(join(home, 'presence', `${A}.lock`), descriptor) }
  let changed = false
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === path && !changed) {
      changed = true
      if (engine === 'copilot') copilotLock(B, 5000)
      else { sync.unlinkSync(descriptor); sync.symlinkSync(join(home, 'presence', `${B}.lock`), descriptor) }
    }
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  const repair = await import('./sessionRepair.js')
  await expect(repair.findLiveSession(engine, root, 1000, { pid: 4242 })).rejects.toThrow('process conversation changed')
  await expect(repair.findLiveSession(engine, root, 1000, { pid: 4242 })).resolves.toEqual({ sessionId: B, transcriptPath: undefined })
})

it('Copilot binding retains its previous conversation when native ownership moves during transcript lookup', async () => {
  copilotLock(A, 3000); copilotLock(B, 1000)
  const path = file(join(root, 'copilot', 'session-state', A, 'events.jsonl'))
  let changed = false
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === path && !changed) { changed = true; copilotLock(B, 5000) }
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  const row = { engine: 'copilot', agentId: 'private-agent', sessionId: 'previous', registeredAt: 0, runtimes: [],
    processIdentity: { pid: 4242, executable: 'copilot', startMarker: '2026-10-09T00:00:00Z' } } as unknown as RegisteredSession
  const register = vi.fn(() => null)
  const deps = { registry: { byProcess: () => row, bySession: () => undefined, register },
    homes: { copilot: join(root, 'copilot') } } as unknown as BindDeps
  const observed: DiscoveredTerminalAgent = { engine: 'copilot', cwd: root, runtimes: [], primaryRuntimeKey: '',
    args: 'copilot', resumeSessionId: null, processIdentity: row.processIdentity! }
  const binding = (await import('../core/agents/bind.js')).createBinding(deps)
  await binding.bindObservedAgent(observed)
  expect(register).not.toHaveBeenCalled(); expect(row.sessionId).toBe('previous')
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('process conversation changed'))
  await binding.bindObservedAgent(observed)
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ sessionId: B, transcriptPath: undefined }))
})

it.each(['path', 'root', 'stat'] as const)('holds a Cursor pool when %s validation is unavailable beside a readable competitor', async failure => {
  const home = join(root, 'cursor')
  const unknown = file(join(home, 'projects', 'a', 'agent-transcripts', A, `${A}.jsonl`))
  file(join(home, 'projects', 'b', 'agent-transcripts', A, `${A}.jsonl`))
  if (failure === 'stat') vi.mocked(sync.statSync).mockImplementation(((path, ...args) => {
    if (String(path) === unknown) throw denied()
    return Reflect.apply(actualSync.statSync, actualSync, [path, ...args])
  }) as typeof sync.statSync)
  else vi.mocked(sync.realpathSync).mockImplementation(((path, ...args) => {
    if (String(path) === (failure === 'root' ? join(home, 'projects') : unknown)) throw denied()
    return Reflect.apply(actualSync.realpathSync, actualSync, [path, ...args])
  }) as typeof sync.realpathSync)
  const { transcriptOf } = await import('../engines/identities.js')
  await expect(transcriptOf('cursor', home, A)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})

it('still excludes a proven foreign Cursor file', async () => {
  const home = join(root, 'cursor')
  const foreign = file(join(root, 'foreign', 'agent-transcripts', A, `${A}.jsonl`))
  const alias = join(home, 'projects', 'a', 'agent-transcripts', A, `${A}.jsonl`)
  sync.mkdirSync(dirname(alias), { recursive: true }); sync.symlinkSync(foreign, alias)
  const expected = file(join(home, 'projects', 'b', 'agent-transcripts', A, `${A}.jsonl`))
  const { transcriptOf } = await import('../engines/identities.js')
  await expect(transcriptOf('cursor', home, A)).resolves.toBe(expected)
})
