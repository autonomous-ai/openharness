/** Pending discovery through the exact compiled storage entry, with private receipts and actual child loss. */
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fingerprint } from '../src/harnessd/bundleFingerprint.js'
import { LEAN_CORE_ENTRY, readLeanBundle } from '../src/harnessd/leanBundle.js'
import type { SessionStorage } from '../src/lib/sessionStorage.js'
import { processTable } from '../src/testing/spawnedRuns.js'

let root: string, storage: SessionStorage | undefined
const children = new Map<ChildProcess, Promise<unknown>>()
const ownedPids = new Set<number>()
const request = { privateText: 'fixture request contents stay inside storage' }
const held = { service: 'models', detail: 'Waiting for fixture dependency.' }

beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'pending-packaged-'))
  for (const name of ['HOME', 'USERPROFILE', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_PROJECTS_DIR',
    'CODEX_HOME', 'CURSOR_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(name, root)
})

function own(child: ChildProcess): Promise<unknown> {
  const known = children.get(child)
  if (known) return known
  if (child.pid) ownedPids.add(child.pid)
  const settled = Promise.all([once(child, 'exit'), once(child, 'close'),
    child.connected ? once(child, 'disconnect') : Promise.resolve()])
  void settled.catch(() => {})
  children.set(child, settled)
  return settled
}
const currentChild = () => (storage as unknown as { child?: ChildProcess } | undefined)?.child
async function closeStorage(): Promise<void> {
  const child = currentChild(), settled = child ? own(child) : undefined
  const done = await Promise.allSettled([storage?.close(), settled])
  const errors = done.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Pending storage child cleanup failed')
}

afterEach(async () => {
  const errors: unknown[] = []
  const child = currentChild()
  if (child) own(child)
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch (error) { errors.push(error) }
  }
  const cleanup = await Promise.allSettled([closeStorage(), ...children.values()])
  for (const value of cleanup) if (value.status === 'rejected') errors.push(value.reason)
  try { expect(processTable().filter(row => ownedPids.has(row.pid))).toEqual([]) }
  catch (error) { errors.push(error) }
  storage = undefined; children.clear(); ownedPids.clear()
  vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Pending packaged cleanup did not settle')
  rmSync(root, { recursive: true, force: true })
  expect(existsSync(root)).toBe(false)
})

function entry(kind: 'full' | 'lean'): string {
  const file = process.env.E2E_BUNDLE_PATH
  if (!file) throw new Error('Pending creation acceptance requires an exact packaged artifact')
  if (kind === 'full') return file
  const lean = readLeanBundle(readFileSync(file))
  if (!lean) throw new Error('Packaged lean cohort missing')
  const directory = join(root, 'cohort')
  mkdirSync(directory, { mode: 0o700 })
  for (const [name, bytes] of lean.files) writeFileSync(join(directory, name), bytes, { mode: 0o600 })
  return join(directory, LEAN_CORE_ENTRY)
}

it.each(['full', 'lean'] as const)('%s pending discovery survives child loss and finds later legacy receipts', async kind => {
  const file = entry(kind), directory = join(root, 'agent-creations')
  mkdirSync(directory, { mode: 0o700 })
  const [{ SessionStorage }, { AgentCreationReceipts, creationFingerprint }] = await Promise.all([
    import('../src/lib/sessionStorage.js'), import('../src/lib/agentCreationReceipt.js'),
  ])
  storage = new SessionStorage(root, () => ({ file, sha256: fingerprint(file)! }))
  const hash = creationFingerprint(request), id = 'pending-packaged-first', later = 'pending-packaged-later'
  const legacy = new AgentCreationReceipts(directory)
  await legacy.runIntent(id, hash, request, held, async () => null)
  for (let n = 0; n < 140; n++) writeFileSync(join(directory, `completed-history-${n}.json`), JSON.stringify({
    version: 1, fingerprint: hash, outcome: { state: 'created', agentId: `fixture-${n}` },
  }), { mode: 0o600 })
  await storage.creations.ensure(id)
  const scan = storage.creations.scan()
  expect(await scan.next()).toMatchObject({ value: id, done: false })
  const original = currentChild()!, settled = own(original)
  expect(original.pid).not.toBe(process.pid)
  original.kill('SIGKILL'); await settled
  expect(currentChild()).toBeUndefined()
  await expect((async () => { for await (const _id of scan) { /* Drain only the bounded credited page. */ } })())
    .rejects.toMatchObject({ code: 'changed' })
  const found = async (): Promise<string[]> => {
    const ids = new Set<string>()
    for await (const id of storage!.creations.scan()) if (id) ids.add(id)
    return [...ids].sort()
  }
  expect(await found()).toEqual([id])
  const replacement = currentChild()!; own(replacement)
  expect(replacement.pid).not.toBe(original.pid)
  const before = statSync(directory)
  await legacy.runIntent(later, hash, request, held, async () => null)
  utimesSync(directory, before.atime, before.mtime)
  expect(existsSync(join(directory, '.pending-v1', later))).toBe(false)
  expect(await found()).toEqual([id, later])
  expect(statSync(join(directory, '.pending-v1', later)).size).toBe(0)
  const modern = new AgentCreationReceipts(directory, storage.creations.ensure)
  const effect = vi.fn(async () => ({ state: 'created' as const, agentId: 'fixture-created' }))
  const first = modern.runIntent(id, hash, request, held, async () => effect)
  const duplicate = modern.runIntent(id, hash, request, held, async () => effect)
  expect(await first).toEqual({ state: 'created', agentId: 'fixture-created' })
  expect(await duplicate).toEqual({ state: 'created', agentId: 'fixture-created' })
  expect(effect).toHaveBeenCalledOnce()
  expect(await found()).toEqual([later])
  expect(existsSync(join(directory, '.pending-v1', id))).toBe(false)
  await closeStorage()
  // Terminal replay cannot depend on the derived index, even after its child is permanently closed.
  expect(await modern.runIntent(id, hash, request, held, async () => effect))
    .toEqual({ state: 'created', agentId: 'fixture-created' })
  expect(effect).toHaveBeenCalledOnce()
  expect(currentChild()).toBeUndefined()
})
