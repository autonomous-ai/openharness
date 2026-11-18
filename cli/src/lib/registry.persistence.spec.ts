import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { on, once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownProcessGroup } from './windows/noWindow.js'
import type { registry as Registry } from './registry.js'

const cleanup = vi.hoisted(() => ({ file: '', published: false, wait: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    if (String(args[1]) === cleanup.file) cleanup.published = true
  } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), read = handle.read.bind(handle)
    handle.read = (async (...options: Parameters<typeof handle.read>) => {
      const result = await read(...options)
      if (cleanup.published && String(args[0]) === cleanup.file + '.lock/owner.json') await cleanup.wait?.()
      return result
    }) as typeof handle.read
    return handle
  } }
})

let directory: string
let registry: typeof Registry
let holder: ChildProcess | undefined
let exitFlush: Promise<void> | undefined
const input = { agentId: 'persisted-agent', engine: 'claude' as const, tmuxPane: '%1',
  processIdentity: { pid: 101, executable: '/fixture/claude', startMarker: 'fixture-101' } }
const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation',
  requestedAt: 1790900000000, state: 'waiting' as const }
const rows = () => JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8'))

beforeEach(async () => {
  vi.resetModules()
  exitFlush = undefined
  directory = mkdtempSync(join(tmpdir(), 'registry-persistence-'))
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  registry.load()
  ;(await registry.openProcessAgent(input))
  await registry.flush()
})

afterEach(async () => {
  cleanup.wait = undefined; cleanup.file = ''; cleanup.published = false
  vi.useRealTimers()
  vi.restoreAllMocks()
  let settled = false
  try {
    if (holder) await stopHolder(holder)
    holder = undefined
    await bounded(Promise.resolve(exitFlush ?? registry?.flush()), 10_000, 'registry teardown flush')
    settled = true
  } finally {
    vi.unstubAllEnvs()
    // Never erase the fixture while an unconfirmed writer still owns its files.
    if (settled) rmSync(directory, { recursive: true, force: true })
  }
})

async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2_000)
  try { child.kill(); await exited } finally { clearTimeout(force) }
}

async function holderMessage(label: string): Promise<unknown> {
  const child = holder!
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(label + ' exited before ready')
  const controller = new AbortController()
  const options = { signal: controller.signal }
  try {
    // A lock holder that finds the lock still taken reports 'waiting' first. Both messages
    // can arrive in one read, so iterate the buffered stream rather than listening twice.
    return await bounded(Promise.race([
      (async () => { for await (const [message] of on(child, 'message', options)) if (message !== 'waiting') return message })(),
      once(child, 'exit', options).then(() => { throw new Error(label + ' exited before ready') }),
    ]), 10_000, label)
  } finally { controller.abort() }
}

async function locked(mode?: 'ignore-term') {
  holder = fork(fileURLToPath(new URL('./__fixtures__/registryLockOwner.cjs', import.meta.url)), [directory, ...(mode ? [mode] : [])], {
    ...ownProcessGroup(), execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  holder.stderr?.resume()
  expect(await holderMessage('legacy lock holder')).toBe('locked')
}

// Windows terminates on SIGTERM without delivering a catchable signal to the fixture.
it.skipIf(process.platform === 'win32')('reaps a fixture that ignores TERM before releasing its private registry', async () => {
  await locked('ignore-term')
  const child = holder!, kill = vi.spyOn(child, 'kill')
  const ignored = once(child, 'message', { signal: AbortSignal.timeout(10_000) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const stopping = stopHolder(child)
  void stopping.catch(() => {})
  try {
    expect((await ignored)[0]).toBe('ignored-term')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    await stopping
    expect(child.signalCode).toBe('SIGKILL')
  } finally {
    vi.useRealTimers()
    if (child.exitCode === null && child.signalCode === null) {
      const reaped = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
      child.kill('SIGKILL'); await reaped
    }
    await stopping
    holder = undefined
  }
})

it('keeps the event loop responsive while an older process owns the registry lock', async () => {
  await locked()
  let heartbeats = 0
  const heartbeat = new Promise<void>(resolve => setImmediate(() => {
    heartbeats++
    holder!.send('release')
    resolve()
  }))
  const committed = Promise.resolve().then(() => registry.setClosePlan(input.agentId, plan))
  const [result] = await Promise.allSettled([committed, heartbeat])
  expect(result).toMatchObject({ status: 'fulfilled', value: { closePlan: plan } })
  expect(heartbeats).toBe(1)
  expect(rows()[0].closePlan).toEqual(plan)
})

it('awaits a durable close and preserves observations arriving while its lock is queued', async () => {
  await locked()
  const original = registry.byAgent(input.agentId)!
  const committed = registry.setClosePlan(input.agentId, plan)
  expect(committed).toBeInstanceOf(Promise)
  expect(rows()[0].closePlan).toBeUndefined()
  registry.setCwd(input.agentId, '/fixture/new-project')
  holder!.send('release')
  await committed
  await registry.flush()
  expect(registry.byAgent(input.agentId)).toBe(original)
  expect(rows()[0]).toMatchObject({ cwd: '/fixture/new-project', closePlan: plan })
})

it('does not publish a strict candidate after its operation was cancelled while waiting', async () => {
  await locked()
  let current = true
  const committed = registry.setClosePlan(input.agentId, plan, { current: () => current })
  expect(committed).toBeInstanceOf(Promise)
  current = false
  const removed = removeRegistryAgent(registry, input.agentId)
  holder!.send('release')
  await expect(committed).rejects.toThrow()
  await removed
  await registry.flush()
  expect(registry.byAgent(input.agentId)).toBeUndefined()
  expect(rows()).toEqual([])
})

it('applies a synchronous route-swap transaction before yielding and awaits its durability', async () => {
  await locked()
  const committed = registry.transaction(() => {
    registry.updateRuntimes(input.agentId, [{ backend: 'tmux', paneId: '%2' }])
    registry.updateProcessIdentity(input.agentId, { ...input.processIdentity, startMarker: 'replacement' })
  })
  expect(registry.byAgent(input.agentId)?.runtimes).toEqual([{ backend: 'tmux', paneId: '%2' }])
  expect(rows()[0].runtimes).toEqual([{ backend: 'tmux', paneId: '%1' }])
  holder!.send('release')
  await committed
  expect(rows()[0].runtimes).toEqual([{ backend: 'tmux', paneId: '%2' }])
})

it('preserves later field deletion and explicit undefined without restoring a captured value', async () => {
  ;(await registry.setLaunchModel(input.agentId, { model: 'fixture-model', effort: null }))
  registry.setBypassPermission(input.agentId, true)
  await registry.flush()
  await locked()
  const committed = registry.setClosePlan(input.agentId, plan)
  expect(committed).toBeInstanceOf(Promise)
  const live = registry.byAgent(input.agentId)!
  delete live.launchModel
  live.bypassPermission = undefined
  holder!.send('release')
  await committed
  await registry.flush()
  expect(registry.byAgent(input.agentId)).toBe(live)
  expect(rows()[0]).not.toHaveProperty('launchModel')
  expect(rows()[0]).not.toHaveProperty('bypassPermission')
})

it('keeps a later repeated cancellation intent when an earlier commit finishes', async () => {
  await registry.setClosePlan(input.agentId, plan)
  await locked()
  const first = registry.setClosePlan(input.agentId, null)
  expect(first).toBeInstanceOf(Promise)
  const second = registry.setClosePlan(input.agentId, null)
  holder!.send('release')
  await Promise.all([first, second])
  await registry.flush()
  expect(registry.byAgent(input.agentId)).not.toHaveProperty('closePlan')
  expect(rows()[0]).not.toHaveProperty('closePlan')
})

it('starts a legacy lock holder while an earlier write is still releasing the lock', async () => {
  // A write's result arrives before its lock cleanup; hold that cleanup so the lock is still taken.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  cleanup.file = join(directory, 'registry.json'); cleanup.published = false
  cleanup.wait = async () => { cleanup.wait = undefined; await held }
  await registry.setClosePlan(input.agentId, plan)
  const ready = locked()
  holder!.on('message', message => { if (message === 'waiting') release() })
  try { await ready } finally { release() }
})

it('owns its candidate values while preserving later edits through a live row alias', async () => {
  await locked()
  const candidate: NonNullable<ReturnType<typeof registry.byAgent>>['closePlan'] = { ...plan }
  const committed = registry.setClosePlan(input.agentId, candidate)
  expect(committed).toBeInstanceOf(Promise)
  candidate.state = 'failed'
  const live = registry.byAgent(input.agentId)!
  live.launchArgs = ['--fixture-first']
  live.launchArgs.push('--fixture-second')
  holder!.send('release')
  await committed
  await registry.flush()
  expect(rows()[0]).toMatchObject({ closePlan: plan, launchArgs: ['--fixture-first', '--fixture-second'] })
})

it('publishes a resumed owner only after durability and rejects cancelled resume authority', async () => {
  const saved = structuredClone(registry.byAgent(input.agentId)!)
  ;(await removeRegistryAgent(registry, input.agentId))
  await registry.flush()
  await locked()
  let current = true
  const resumed = registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%2' }], undefined, { current: () => current })
  expect(resumed).toBeInstanceOf(Promise)
  expect(registry.byAgent(input.agentId)).toBeUndefined()
  current = false
  holder!.send('release')
  expect(await resumed).toBeNull()
  expect(registry.byAgent(input.agentId)).toBeUndefined()
  expect(rows()).toEqual([])
})

it.each(['ownerless', 'prepared', 'published'])('recovers a real writer killed at %s without losing peer metadata', async phase => {
  holder = fork(fileURLToPath(new URL('./__fixtures__/registryCrashWriter.ts', import.meta.url)), [directory, phase], {
    ...ownProcessGroup(), execArgv: ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ADAPTER_DATA_DIR: directory },
  })
  let diagnostic = ''
  holder.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4_096) })
  const reached = await holderMessage('crash fixture').catch(error => { throw new Error(String(error) + ': ' + diagnostic) })
  expect(reached).toBe(phase)
  const exited = once(holder, 'exit', { signal: AbortSignal.timeout(5_000) })
  holder.kill('SIGKILL')
  await exited
  holder = undefined
  if (phase === 'ownerless') {
    const stale = new Date(Date.now() - 6_000)
    utimesSync(join(directory, 'registry.json.lock'), stale, stale)
  }
  expect(rows()[0].title).toBe(phase === 'published' ? 'peer crash metadata' : null)
  const committed = await registry.setClosePlan(input.agentId, plan)
  expect(committed?.closePlan).toEqual(plan)
  expect(rows()[0].title).toBe(phase === 'published' ? 'peer crash metadata' : null)
  expect(rows()[0].closePlan).toEqual(plan)
})

it('does not transfer a queued registration to a replacement route owner', async () => {
  writeFileSync(join(directory, 'queued-conversation.jsonl'), '{}\n')
  await locked()
  const first = registry.setClosePlan(input.agentId, plan).catch(error => error)
  const preceding = registry.flush()
  const replaced = registry.openProcessAgent({ ...input, agentId: 'replacement-agent', engine: 'codex',
    processIdentity: { ...input.processIdentity, pid: 102, startMarker: 'replacement' } })
  const registration = registry.register({ engine: 'claude', sessionId: 'queued-conversation', tmuxPane: '%1',
    transcriptPath: join(directory, 'queued-conversation.jsonl') })
  const settled = registration.catch(error => error)
  holder!.send('release')
  await first
  await preceding
  await replaced
  expect(String(await settled)).toContain('registry owner changed')
  expect(registry.byAgent('replacement-agent')?.sessionId).toBe('')
  expect(registry.byAgent('replacement-agent')?.processIdentity?.pid).toBe(102)
})

it('retains a durably published result past reply expiry while cleanup keeps the writer occupied', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  cleanup.file = join(directory, 'registry.json'); cleanup.published = false
  cleanup.wait = async () => { cleanup.wait = undefined; entered(); await held }
  let failure: unknown
  const first = registry.setClosePlan(input.agentId, plan).catch(error => { failure = error; return null })
  await arrived
  expect(rows()[0].closePlan).toEqual(plan)
  let nextRan = false
  let second: Promise<unknown> | undefined
  try {
    await vi.advanceTimersByTimeAsync(5_000)
    second = registry.setClosePlan(input.agentId, null).then(row => { nextRan = true; return row })
    expect(nextRan).toBe(false)
    expect(failure).toBeUndefined()
  } finally {
    release()
    await first
    await second?.catch(() => {})
  }
  expect((await first)?.closePlan).toEqual(plan)
})

it.each(['registry.json', 'agent-names.json'])('does not expose private malformed %s contents through async failures', async name => {
  const file = join(directory, name), before = readFileSync(file, 'utf8'), sentinel = 's3cr3t-leak'
  const errors: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.map(String).join(' ')) })
  writeFileSync(file, sentinel)
  try {
    const result = await registry.flush().catch(error => error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).not.toContain(sentinel)
    if (name === 'registry.json') {
      const refused = await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%2' }] }).catch(error => error)
      expect(String(refused)).toContain('registry storage contains invalid JSON')
      expect(String(refused)).not.toContain(sentinel)
      expect(errors.join(' ')).not.toContain(sentinel)
    }
  } finally { writeFileSync(file, before) }
})

it('seals exit admission before awaiting accepted writes and rejects later observations explicitly', async () => {
  await locked()
  const accepted = registry.setClosePlan(input.agentId, plan)
  exitFlush = registry.flush({ exiting: true })
  const late = registry.setClosePlan(input.agentId, null).catch(error => error)
  try {
    expect(() => registry.setCwd(input.agentId, '/late-observation')).toThrow('registry is closing')
  } finally { holder!.send('release'); await accepted; await exitFlush }
  expect(await late).toBeInstanceOf(Error)
  expect(rows()[0].closePlan).toEqual(plan)
  expect(rows()[0].cwd).not.toBe('/late-observation')
})

it('waits for final exit publication cleanup before releasing its caller', async () => {
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  cleanup.file = join(directory, 'registry.json'); cleanup.published = false
  cleanup.wait = async () => { cleanup.wait = undefined; entered(); await held }
  registry.byAgent(input.agentId)!.cwd = '/final-observation'
  let finished = false
  exitFlush = registry.flush({ exiting: true }).then(() => { finished = true })
  await arrived
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(rows()[0].cwd).toBe('/final-observation')
    expect(finished).toBe(false)
  } finally { release(); await exitFlush }
})

it('retains exit ownership after its write deadline until an active cleanup settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  cleanup.file = join(directory, 'registry.json'); cleanup.published = false
  cleanup.wait = async () => { cleanup.wait = undefined; entered(); await held }
  const accepted = registry.setClosePlan(input.agentId, plan)
  await arrived
  let settled = false
  exitFlush = registry.flush({ exiting: true }).catch(() => {}).then(() => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBe(false)
  } finally { release(); await accepted; await exitFlush }
})
