/** Required storage on the exact packaged full/lean payload, with private files and fake engines only. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from '../src/harnessd/bundleFingerprint.js'
import { readLeanBundle, LEAN_CORE_ENTRY } from '../src/harnessd/leanBundle.js'
import { WORKER_COHORT_ENV, WORKER_CONTRACT, WORKER_PLAN } from '../src/harnessd/workerContract.js'
import type { SessionStorage } from '../src/lib/sessionStorage.js'
import type { StoredGridLaunch } from '../src/lib/sessionStorageWire.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { processTable } from '../src/testing/spawnedRuns.js'
import { rootProcesses } from '../src/testing/rootProcesses.js'

let root: string
let daemon: IsolatedDaemon | undefined
const stores: SessionStorage[] = []
const clients: LocalClient[] = []
const children = new Map<ChildProcess, Promise<unknown>>()
const ownedPids = new Set<number>(), ownedGroups = new Set<number>()
function ownChild(child: ChildProcess): Promise<unknown> {
  if (child.pid) ownedPids.add(child.pid)
  const settled = Promise.all([once(child, 'exit'), once(child, 'close'), child.connected ? once(child, 'disconnect') : Promise.resolve()])
  void settled.catch(() => {})
  children.set(child, settled)
  return settled
}
async function closeStorage(storage: SessionStorage): Promise<void> {
  const child = (storage as unknown as { child?: ChildProcess }).child
  const settled = child ? children.get(child) ?? ownChild(child) : undefined
  const results = await Promise.allSettled([storage.close(), settled])
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Storage child cleanup did not settle')
}
function rememberDaemon(): void {
  if (!daemon) return
  for (const child of (daemon as unknown as { groups: Set<ChildProcess> }).groups) if (child.pid) {
    ownedPids.add(child.pid); ownedGroups.add(child.pid)
  }
  const table = processTable()
  let added: boolean
  do {
    added = false
    for (const row of table) if (ownedPids.has(row.ppid) && !ownedPids.has(row.pid)) {
      ownedPids.add(row.pid); added = true
    }
  } while (added)
  if (daemon.corePid()) ownedPids.add(daemon.corePid()!)
}
const bundle = () => {
  const file = process.env.E2E_BUNDLE_PATH
  if (!file) throw new Error('Session storage acceptance requires an exact packaged artifact')
  return file
}

beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'storage-packaged-'))
  for (const name of ['HOME', 'USERPROFILE', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_PROJECTS_DIR',
    'CODEX_HOME', 'CURSOR_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(name, root)
})
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  const errors: unknown[] = []
  try { rememberDaemon() } catch (error) { errors.push(error) }
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch (error) { errors.push(error) }
  }
  const cleanup = await Promise.allSettled([daemon?.close(), ...stores.splice(0).map(closeStorage), ...children.values()])
  for (const result of cleanup) if (result.status === 'rejected') errors.push(result.reason)
  try {
    const table = processTable()
    expect(table.filter(row => ownedPids.has(row.pid) || ownedGroups.has(row.pgid)).map(row => ({ pid: row.pid, pgid: row.pgid }))).toEqual([])
    if (daemon) {
      expect(rootProcesses(daemon.root, table).all).toEqual([])
      expect(existsSync(daemon.tmux.socket)).toBe(false)
      expect(existsSync(daemon.root)).toBe(false)
    }
  } catch (error) { errors.push(error) }
  daemon = undefined; children.clear(); ownedPids.clear(); ownedGroups.clear()
  vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Packaged storage cleanup did not settle')
  rmSync(root, { recursive: true, force: true })
})

function entry(kind: 'full' | 'lean'): string {
  if (kind === 'full') return bundle()
  const lean = readLeanBundle(readFileSync(bundle()))
  if (!lean) throw new Error('Packaged lean cohort missing')
  const directory = join(root, 'cohort')
  mkdirSync(directory, { mode: 0o700 })
  for (const [name, bytes] of lean.files) writeFileSync(join(directory, name), bytes, { mode: 0o600 })
  return join(directory, LEAN_CORE_ENTRY)
}

async function storageAt(file: string, directory = join(root, 'data')): Promise<SessionStorage> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const { SessionStorage } = await import('../src/lib/sessionStorage.js')
  const storage = new SessionStorage(directory, () => ({ file, sha256: fingerprint(file)! }))
  stores.push(storage)
  return storage
}

describe('packaged required session storage', () => {
  it.each(['full', 'lean'] as const)('%s entry preserves durable offline credentials across actual child loss', async kind => {
    const file = entry(kind), storage = await storageAt(file), key = randomUUID()
    const raw = { agentId: 'fixture-agent', registeredAt: 1, title: 'before', gridLaunch: {
      networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://grid.example.test/v1', apiKey: key,
    } }
    writeFileSync(join(storage.root, 'registry.json'), JSON.stringify([raw]), { mode: 0o600 })
    const source = await storage.retain({ kind: 'registry' })
    try {
      expect(source.image.state === 'image' && source.image.json).toBe(true)
      if (source.image.state !== 'image' || !source.image.json) throw new Error('Fixture image unavailable')
      expect(JSON.stringify(source.image).includes(key)).toBe(false)
      const rows = source.image.value as Array<{ title: string; gridLaunch: StoredGridLaunch }>
      const original = structuredClone(rows[0].gridLaunch)
      rows[0].title = 'published'
      const { RegistryWriteQueue, registryFileLock } = await import('../src/lib/registryPersistence.js')
      const { prepareSessionPublication } = await import('../src/lib/sessionPublication.js')
      await new RegistryWriteQueue().run(deadline => registryFileLock(storage.root, deadline, async current => {
        const publication = await prepareSessionPublication(storage, { kind: 'registry' }, source, rows, deadline)
        try {
          current(); publication.publish(() => {})
          await publication.sync()
          current(); publication.finish()
        } finally { await publication.discard() }
      }))
      const child = (storage as unknown as { child: ChildProcess }).child
      const settled = ownChild(child)
      child.kill('SIGKILL'); await settled
      // The replacement inherits the original inode, even though publication replaced its path.
      expect((await storage.resolveSelected(original)).apiKey === key).toBe(true)
      const next = await storage.read({ kind: 'registry' })
      expect(next.state === 'image' && next.json && (next.value as Array<{ title: string }>)[0].title === 'published').toBe(true)
      expect(JSON.stringify(next).includes(key)).toBe(false)
      expect(readFileSync(join(storage.root, 'registry.json'), 'utf8').includes(key)).toBe(true)
    } finally { await source.release() }
    await closeStorage(storage)
    const restarted = await storageAt(file, storage.root)
    const image = await restarted.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('Restart image unavailable')
    expect((await restarted.resolveSelected((image.value as Array<{ gridLaunch: StoredGridLaunch }>)[0].gridLaunch)).apiKey === key).toBe(true)
  })

  it.each(['full', 'lean'] as const)('%s entry refuses altered/missing payload and a replacement-core contract', async kind => {
    const selected = entry(kind), changed = join(root, 'changed.mjs')
    copyFileSync(selected, changed)
    const hash = fingerprint(changed)!
    const { SessionStorage } = await import('../src/lib/sessionStorage.js')
    const storage = new SessionStorage(join(root, 'data'), () => ({ file: changed, sha256: hash }))
    stores.push(storage)
    writeFileSync(changed, '\n', { flag: 'a' })
    await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
    rmSync(changed)
    await expect(storage.read({ kind: 'registry' })).rejects.toMatchObject({ code: 'disconnected' })
    const child = spawn(process.execPath, [selected, '__storage'], {
      env: { HOME: root, ADAPTER_DATA_DIR: root, HARNESSD_SUPERVISED: '1',
        [WORKER_COHORT_ENV]: `${process.pid}:${WORKER_CONTRACT - 1}:${WORKER_PLAN}:${fingerprint(selected)}` },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    })
    const settled = ownChild(child)
    let ready = false, expired = false
    child.on('message', () => { ready = true })
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 5_000)
    try {
      const [code] = await once(child, 'exit')
      await settled
      expect(expired).toBe(false)
      expect(code).toBe(2)
      expect(ready).toBe(false)
    } finally { clearTimeout(timer) }
  })

  it('standalone core restarts and resumes an unsaved imported Grid offline', async () => {
    const key = randomUUID()
    daemon = await IsolatedDaemon.create({ noMaster: true, scriptPath: bundle(), env: {
      HARNESS_GRID_BIN: '/nonexistent/harness-e2e/grid', HARNESSD_SERVICES: 'none',
    } })
    await daemon.start()
    let client = await LocalClient.connect(daemon); clients.push(client)
    const cwd = join(daemon.projectsDir, 'imported-grid')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true,
      grid: { networkId: 'fixture-import', networkName: 'Fixture', baseUrl: 'http://127.0.0.1:9/v1', apiKey: key, model: 'Fixture-Q4' } }, 90_000)
    expect(created.error).toBeUndefined()
    const id = created.agent.id as string
    const row = async () => ((await client.request('agents_list', { includeStopped: true }, 30_000)).agents as Array<Record<string, any>>)
      .find(value => value.id === id)
    const turn = async (content: string, observedLaunch: unknown) => {
      const phase = ['starting', 'held', 'ready', 'failed'].includes(String(observedLaunch)) ? String(observedLaunch) : 'absent'
      const ended = client.next(frame => frame.agentId === id && (frame.type === 'turn_ended' || frame.type === 'error'),
        45_000, 'offline imported Grid input outcome')
      client.send('message', { agentId: id, content })
      const outcome = await ended
      if (outcome.type === 'error') {
        // Error frames are public text, but the fixture records only fixed categories, never arbitrary payloads.
        const categories = new Map([
          ['This agent process is no longer running.', 'runtime_gone'],
          ['This harness is no longer available.', 'agent_gone'],
          ['This harness is held until the daemon restarts.', 'held'],
          ['The message delivery could not be confirmed. Check the agent before trying again.', 'unconfirmed'],
          ['The agent did not accept the message. Please try again.', 'not_accepted'],
        ])
        throw new Error(`Offline Grid input failed: ${categories.get(String(outcome.payload?.message)) ?? 'unclassified'}; launch=${phase}`)
      }
    }
    const first = await until('imported Grid conversation ready', async () => {
      const value = await row(); return value?.status === 'active' && value.sessionId ? value : null
    }, 60_000, 250)
    expect(JSON.stringify(first).includes(key)).toBe(false)
    expect(readFileSync(join(daemon.dataDir, 'registry.json'), 'utf8').includes(key)).toBe(true)
    rememberDaemon()
    client.close(); await daemon.stop(); await daemon.tmux.run('kill-server')
    await daemon.start()
    client = await LocalClient.connect(daemon); clients.push(client)
    const restored = await until('offline imported Grid restored', async () => {
      // Restore publishes the saved conversation before its replacement process can accept input.
      const value = await row(); return value?.status === 'active' && value.sessionId === first.sessionId
        && value.launch?.state === 'ready' ? value : null
    }, 90_000, 250)
    await turn('offline imported fixture', restored.launch?.state)
    const active = await row()
    expect((await client.request('agent_close', { agentId: id, sessionId: active!.sessionId,
      createdAt: active!.createdAt, mode: 'now' }, 90_000)).closed).toBe(true)
    await until('imported Grid archived', async () => (await row())?.status === 'stopped' || null, 45_000, 250)
    expect(readFileSync(join(daemon.dataDir, 'stopped-agents', `${id}.json`), 'utf8').includes(key)).toBe(true)
    expect((await client.request('agent_resume', { agentId: id }, 90_000)).error).toBeUndefined()
    const resumed = await until('offline archived Grid resumed', async () => {
      const value = await row(); return value?.status === 'active' && value.sessionId === first.sessionId
        && value.launch?.state === 'ready' ? value : null
    }, 60_000, 250)
    await turn('offline resumed fixture', resumed.launch?.state)
    expect(daemon.log().includes(key)).toBe(false)
    expect(readFileSync(join(daemon.dataDir, 'registry.json'), 'utf8').includes(key)).toBe(true)
  })
})
