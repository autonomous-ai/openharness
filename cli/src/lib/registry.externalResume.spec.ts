import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExternalResumeIntent } from './externalResume.js'
import type { RegisteredSession } from './registry.js'
import { createExternalResumes } from '../core/agents/externalResume.js'
import { stopExternalOwner } from '../core/agents/externalOwner.js'
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'linux:12345678-1234-1234-1234-123456789012' }))

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-adoption-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', root)
  writeFileSync(join(root, 'record.jsonl'), '{}\n')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
const intent = (extra: Partial<ExternalResumeIntent> = {}): ExternalResumeIntent => ({
  token: '12345678-1234-1234-1234-123456789012', request: { engine: 'claude', sessionId: 'alias' }, takeOver: null, phase: 'waiting', ...extra,
})
const fact = () => ({ engine: 'claude' as const, sessionId: 'canonical', aliases: ['alias', 'other-alias'], cwd: root,
  origin: 'terminal' as const, title: 'Saved conversation', mtime: 1, transcriptPath: join(root, 'record.jsonl') })
async function load() { vi.resetModules(); const mod = await import('./registry.js'); mod.registry.load(); return mod.registry }
const disk = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
const write = (rows: RegisteredSession[]) => writeFileSync(join(root, 'registry.json'), JSON.stringify(rows), { mode: 0o600 })
const pending = async (extra: Partial<ExternalResumeIntent> = {}) => {
  const registry = await load()
  const row = registry.openPendingAgent({ engine: 'claude', cwd: null, runtimes: [{ backend: 'tmux', paneId: '%1' }], externalResume: intent(extra) })!
  expect(row).toBeTruthy()
  return { registry, row }
}

it('persists an unbound held intent atomically, reserves all aliases and survives a reload through strict dispatch', async () => {
  let { registry, row } = await pending()
  expect(disk()).toMatchObject([{ agentId: row.agentId, active: false, sessionId: '', launch: { state: 'held' }, externalResume: intent() }])
  expect(registry.get('alias')).toBeUndefined()
  registry = await load(); row = registry.byAgent(row.agentId)!
  expect(registry.externalConflict(['alias'])).toBe(row)
  const pinned = intent({ session: fact() })
  expect(registry.setExternalResume(row.agentId, pinned)).toBeTruthy()
  for (const id of ['canonical', 'alias', 'other-alias']) {
    expect(registry.externalConflict([id])?.agentId).toBe(row.agentId)
    expect(registry.openPendingAgent({ engine: 'claude', cwd: null, runtimes: [{ backend: 'tmux', paneId: '%2' }], externalResume: intent({ request: { engine: 'claude', sessionId: id } }) })).toBeNull()
  }
  const admitted = registry.setExternalResume(row.agentId, { ...pinned, phase: 'admitted' })!
  expect(admitted).toMatchObject({ sessionId: 'canonical', cwd: root, resumeOnly: true, launch: { state: 'held' } })
  registry = await load()
  expect(registry.externalConflict(['alias'])?.agentId).toBe(row.agentId)
  expect(registry.beginExternalDispatch(row.agentId)).toMatchObject({ launch: { state: 'starting' }, externalResume: { dispatched: true } })
  expect(disk()[0]).toMatchObject({ launch: { state: 'starting' }, externalResume: { dispatched: true } })
  expect(registry.beginExternalDispatch(row.agentId)).toBeNull()
  registry = await load()
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: 'canonical', resumeOnly: true, externalResume: { phase: 'admitted', dispatched: true } })
})

it('refuses process discovery and hooks for an inert route, across engines too', async () => {
  const { registry, row } = await pending()
  for (const engine of ['claude', 'codex'] as const) {
    expect(registry.openProcessAgent({ engine, tmuxPane: '%1', cwd: root, processIdentity: { pid: 7001, executable: engine, startMarker: 'fixture' } })).toBeNull()
    expect(registry.register({ engine, sessionId: 'unexpected', tmuxPane: '%1', cwd: root, transcriptPath: join(root, 'record') })).toBeNull()
  }
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: '', processIdentity: null, launch: { state: 'held' } })
  registry.setExternalResume(row.agentId, intent({ session: fact() }))
  const other = registry.openProcessAgent({ engine: 'claude', tmuxPane: '%2', cwd: root, processIdentity: { pid: 7002, executable: 'claude', startMarker: 'fixture' } })!
  expect(registry.register({ engine: 'claude', sessionId: 'canonical', tmuxPane: '%2', transcriptPath: join(root, 'record.jsonl') })?.entry.agentId).toBe(other.entry.agentId)
  expect(registry.byAgent(other.entry.agentId)?.sessionId).toBe('canonical')
  expect(disk()).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: row.agentId, sessionId: '', externalResume: expect.objectContaining({ phase: 'waiting' }) }),
    expect.objectContaining({ agentId: other.entry.agentId, sessionId: 'canonical' }),
  ]))
  expect(registry.setExternalResume(row.agentId, intent({ session: fact(), phase: 'admitted' }))).toBeNull()
})

it('keeps a verified binding even when a provisional reservation appeared on disk after discovery', async () => {
  const { registry, row } = await pending()
  const provisional = disk()[0]
  registry.removeAgent(row.agentId)
  const other = registry.openProcessAgent({ engine: 'claude', tmuxPane: '%2', cwd: root, processIdentity: { pid: 7002, executable: 'claude', startMarker: 'fixture' } })!
  write([...disk(), provisional])
  expect(registry.register({ engine: 'claude', sessionId: 'alias', tmuxPane: '%2', transcriptPath: join(root, 'record.jsonl') })?.entry.agentId).toBe(other.entry.agentId)
  expect(disk()).toHaveLength(2)
  expect(registry.byAgent(row.agentId)?.externalResume?.phase).toBe('waiting')
  expect(registry.bySession('alias')?.agentId).toBe(other.entry.agentId)
})

it('transfers an admitted canonical binding normally and releases its old aliases atomically', async () => {
  const { registry, row } = await pending()
  registry.setExternalResume(row.agentId, intent({ session: fact(), phase: 'admitted' }))
  const original = { pid: 7001, executable: 'claude', startMarker: 'fixture' }
  registry.updateProcessIdentity(row.agentId, original)
  registry.setActive(row.agentId, true)
  expect(registry.register({ engine: 'claude', sessionId: 'canonical', tmuxPane: '%1', transcriptPath: join(root, 'record.jsonl'), processIdentity: original })).toBeTruthy()
  const other = registry.openProcessAgent({ engine: 'claude', tmuxPane: '%2', cwd: root, processIdentity: { pid: 7002, executable: 'claude', startMarker: 'fixture' } })!
  expect(registry.register({ engine: 'claude', sessionId: 'canonical', tmuxPane: '%2', transcriptPath: join(root, 'record.jsonl') })?.entry.agentId).toBe(other.entry.agentId)
  expect(registry.byAgent(row.agentId)?.externalResume).toBeUndefined()
  expect(registry.externalConflict(['alias'])).toBeUndefined()
  const reboot = await load()
  expect(reboot.bySession('canonical')?.agentId).toBe(other.entry.agentId)
  expect(reboot.byAgent(row.agentId)?.externalResume).toBeUndefined()
})

it('never revives a cancelled intent, changes its request or escalates its takeover consent', async () => {
  const { registry, row } = await pending()
  expect(registry.setExternalResume(row.agentId, intent({ takeOver: 'now' }))).toBeNull()
  expect(registry.setExternalResume(row.agentId, intent({ request: { engine: 'claude', sessionId: 'different' } }))).toBeNull()
  expect(registry.setExternalResume(row.agentId, intent({ phase: 'cancelled' }))).toBeTruthy()
  expect(registry.setExternalResume(row.agentId, intent())).toBeNull()
  expect(registry.externalConflict(['alias'])).toBeUndefined()
  const reboot = await load()
  expect(reboot.byAgent(row.agentId)?.externalResume?.phase).toBe('cancelled')
  expect(reboot.finishExternalCancellation(row.agentId)).toBe(true)
  expect(disk()).toEqual([])
  expect(reboot.finishExternalCancellation(row.agentId)).toBe(false)
})

it.each(['waiting', 'quitting', 'prepared', 'sent', 'admitted'] as const)('refuses an alias claimed on disk before %s, leaving both durable owners untouched', async phase => {
  const { registry, row } = await pending({ takeOver: 'idle' })
  const pinned = intent({ takeOver: 'idle', session: fact(), owner: { process: { engine: 'claude', pid: 101, tty: '/dev/fixture-terminal', record: '/fixture/record' }, generation: 'ps:1' } })
  const previous = disk()[0]
  const foreign = { ...previous, agentId: 'foreign-owner', externalResume: undefined, sessionId: 'canonical', boundAt: 1,
    runtimes: [{ backend: 'tmux' as const, paneId: '%2' }], primaryRuntimeKey: 'tmux\u0000%2', tmuxPane: '%2', launch: { state: 'ready' as const }, active: true }
  write([previous, foreign])
  const before = readFileSync(join(root, 'registry.json'), 'utf8')
  expect(() => registry.setExternalResume(row.agentId, { ...pinned, phase: phase === 'prepared' || phase === 'sent' ? 'quitting' : phase,
    ...(phase === 'prepared' || phase === 'sent' ? { signal: phase } : {}) })).toThrow('another durable owner')
  expect(readFileSync(join(root, 'registry.json'), 'utf8')).toBe(before)
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: '', externalResume: { phase: 'waiting' } })
})

it('never overwrites a concurrent durable cancellation or commits dispatch against a changed row', async () => {
  const { registry, row } = await pending()
  const previous = disk()[0]
  write([{ ...previous, externalResume: intent({ phase: 'cancelled' }) }])
  expect(() => registry.setExternalResume(row.agentId, intent({ session: fact(), phase: 'admitted' }))).toThrow('durable adoption changed')
  expect(disk()[0].externalResume?.phase).toBe('cancelled')
  const next = await load()
  expect(next.finishExternalCancellation(row.agentId)).toBe(true)
})

it('refuses KILL when another writer durably binds the conversation during the TERM grace period', async () => {
  const { registry, row } = await pending({ takeOver: 'idle' })
  const owner = { engine: 'claude' as const, pid: 101, tty: '/dev/fixture-terminal', record: '/fixture/record' }
  const kill = vi.fn(), launch = vi.fn()
  let written = false
  const controller = createExternalResumes({ registry, tmux: null, stopped: () => [], cancelled: () => false,
    generation: () => 1, waiting: async () => true, preflight: async () => null, announce: () => {}, forget: () => {}, launch,
    inspect: async request => ({ ok: true, request, session: fact(), owner, generation: 'ps:1', busy: false }),
    stopOwner: (target, control) => stopExternalOwner(target, { ...control, exists: () => true, generation: () => 'ps:1',
      job: async () => null, kill, sleep: async () => {
        if (written) return
        written = true
        const saved = disk()
        write([...saved, { ...saved[0], agentId: 'foreign-owner', externalResume: undefined, sessionId: 'canonical', boundAt: 1,
          runtimes: [{ backend: 'tmux', paneId: '%2' }], primaryRuntimeKey: 'tmux\u0000%2', tmuxPane: '%2', launch: { state: 'ready' }, active: true }])
      } }),
  })
  try {
    controller.open(); await controller.settled()
    expect(written).toBe(true)
    expect(kill.mock.calls).toEqual([[101, 'SIGTERM']])
    expect(launch).not.toHaveBeenCalled()
    expect(registry.byAgent(row.agentId)?.externalResume?.phase).toBe('quitting')
    expect(disk().find(value => value.agentId === 'foreign-owner')?.sessionId).toBe('canonical')
  } finally { controller.stop() }
})

it('rolls back strict persistence failures before acknowledging admission, dispatch or cleanup', async () => {
  const { registry, row } = await pending()
  const old = disk()
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  expect(() => registry.setExternalResume(row.agentId, intent({ phase: 'admitted', session: fact() }))).toThrow()
  expect(registry.byAgent(row.agentId)?.externalResume?.phase).toBe('waiting')
  write(old)
  registry.setExternalResume(row.agentId, intent({ phase: 'admitted', session: fact() }))
  const admitted = disk()
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  expect(() => registry.beginExternalDispatch(row.agentId)).toThrow()
  expect(registry.byAgent(row.agentId)).toMatchObject({ launch: { state: 'held' }, active: false, externalResume: { phase: 'admitted' } })
  expect(registry.byAgent(row.agentId)?.externalResume?.dispatched).toBeUndefined()
  write(admitted)
  const reloaded = await load()
  expect(reloaded.setExternalResume(row.agentId, intent({ phase: 'cancelled' }))).toBeNull()
  // A separate unadmitted intent has a durable cleanup boundary too.
  const other = reloaded.openPendingAgent({ engine: 'claude', cwd: null, runtimes: [{ backend: 'tmux', paneId: '%2' }], externalResume: intent({ request: { engine: 'claude', sessionId: 'second' } }) })!
  reloaded.setExternalResume(other.agentId, { ...other.externalResume!, phase: 'cancelled' })
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  expect(() => reloaded.finishExternalCancellation(other.agentId)).toThrow()
  expect(reloaded.byAgent(other.agentId)?.externalResume?.phase).toBe('cancelled')
  expect(reloaded.openPendingAgent({ engine: 'claude', cwd: null, runtimes: [{ backend: 'tmux', paneId: '%3' }], externalResume: intent({ request: { engine: 'claude', sessionId: 'third' } }) })).toBeNull()
  expect(reloaded.byPaneEngine('%3', 'claude')).toBeUndefined()
})

it('blocks malformed persisted adoption instead of silently loading a fresh launch', async () => {
  const { row } = await pending()
  for (const change of [{ externalResume: { ...intent(), session: { nonsense: true } } }, { sessionId: 'unexpected' }, { launch: { state: 'ready' } }]) {
    write([{ ...row, ...change } as RegisteredSession])
    const before = readFileSync(join(root, 'registry.json'), 'utf8')
    const registry = await load()
    expect(registry.list()).toEqual([])
    expect(registry.openPendingAgent({ engine: 'claude', cwd: null, runtimes: [{ backend: 'tmux', paneId: '%2' }] })).toBeNull()
    expect(readFileSync(join(root, 'registry.json'), 'utf8')).toBe(before)
  }
})

it('drops adoption constraints when its engine becomes a terminal', async () => {
  const { registry, row } = await pending()
  registry.setExternalResume(row.agentId, intent({ session: fact(), phase: 'admitted' }))
  const shell = registry.releaseEngine(row.agentId)!
  expect(shell.engine).toBe('terminal')
  expect(shell.externalResume).toBeUndefined()
  expect(shell.resumeOnly).toBeUndefined()
  const reboot = await load()
  expect(reboot.byAgent(row.agentId)?.engine).toBe('terminal')
  expect(reboot.externalConflict(['alias'])).toBeUndefined()
})
