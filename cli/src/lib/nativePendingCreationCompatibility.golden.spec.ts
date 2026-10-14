/** Former admitted initial rows before durable pending ownership is introduced. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { appendNativeAllocation, nativeAllocationCanReserve, parseNativeAllocation } from './nativeAllocation.js'
import { nativeCreateFingerprint, type NativeCreateRequest } from './nativeCreateRequest.js'
import { nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the pending-creation golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./bootId.js', () => ({ currentBootId: () => 'fixture-boot', bootChanged: () => false }))

const path = fileURLToPath(new URL('./__fixtures__/native-pending-creation-compatibility.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_PENDING_CREATION_GOLDEN === '1'
const expected = record ? {} : JSON.parse(readFileSync(path, 'utf8'))
const captured: Record<string, unknown> = {}
const base: RegisteredSession = {
  schemaVersion: 2, agentId: 'fixture-agent', engine: 'cursor', sessionId: 'fixture-session', active: true,
  projectDir: '/fixture/project', cwd: '/fixture/project', transcriptPath: null, defaultName: 'Fixture',
  runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\0%1', tmuxPane: '%1',
  processIdentity: { pid: 42, startMarker: 'fixture-start', executable: '<cursor>' },
  registeredAt: 100, touchedAt: 200, boundAt: 150, lastHookAt: 200, lastTranscriptAt: 200,
  source: 'hook', title: null, model: null, cliVersion: null,
}
const cancel: NativeTurnIntent = { version: 1, cancel: { processKey: null, target: nativeTurnTarget(base), request: {
  requestId: 'fixture-cancel-request', nonce: 'fixture-cancel-nonce', agentId: base.agentId, conversationId: base.sessionId,
  frontier: { index: -1, digest: null },
} } }
const request: NativeCreateRequest = { kind: 'native-create-v2', creationId: 'fixture-initial-request',
  agentId: base.agentId, launchToken: 'fixture-initial-launch', label: 'harness-cursor-fixture', local: true,
  input: { engine: 'cursor', cwd: '/fixture/project', permissionMode: 'ask', prompt: 'Original task' }, selection: null }
const receipt = { fingerprint: nativeCreateFingerprint(request), request }

it.each(['linux', 'darwin'])('retains former admitted first launches on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pending-creation-golden-')))
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_700_000_000_000)
    for (const [key, value] of Object.entries({ TZ: 'UTC', HOME: root, ADAPTER_DATA_DIR: join(root, 'data'),
      ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'),
      CURSOR_HOME: join(root, 'cursor') })) vi.stubEnv(key, value)
    mkdirSync(join(root, 'data'), { mode: 0o700 })
    writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
    vi.resetModules()
    const { strictPersistedRow, mergedForSave, registry } = await import('./registry.js')
    const { StoppedAgentStore } = await import('./stoppedAgents.js')
    const { nativeNotifyRuntime } = await import('../engines/kit/nativeNotifyCursor.js')
    const savedDirectory = join(root, 'saved')
    mkdirSync(savedDirectory, { mode: 0o700 })
    const store = new StoppedAgentStore(savedDirectory)
    const observations: Record<string, unknown> = {}
    for (const cancelled of [false, true]) {
      const allocation = appendNativeAllocation(undefined, receipt)
      const input: RegisteredSession = { ...base, schemaVersion: cancelled ? 4 : 5,
        ...(cancelled ? { nativeControl: cancel } : {}), nativeAllocation: allocation }
      const row = strictPersistedRow(input)!
      const key = cancelled ? 'cancelled' : 'initial'
      observations[key] = { row, target: nativeTurnTarget(row), allocation: parseNativeAllocation(allocation),
        repeated: appendNativeAllocation(allocation, receipt), capacity: nativeAllocationCanReserve(allocation, 'fresh-request-id') }
      try { store.save(row); observations[key + ':ordinary-save'] = 'accepted' }
      catch (error) { observations[key + ':ordinary-save'] = (error as Error).message }
      writeFileSync(join(savedDirectory, `${row.agentId}.json`), JSON.stringify({ version: 1, session: row }), { mode: 0o600 })
      store.save(row)
      observations[key + ':saved'] = store.get(row.agentId)
      writeFileSync(join(root, 'data', 'registry.json'), JSON.stringify([row]), { mode: 0o600 })
      registry.load()
      observations[key + ':loaded'] = registry.byAgent(row.agentId)
      observations[key + ':notify'] = nativeNotifyRuntime(join(root, 'data'), '%1')
      observations[key + ':registered'] = registry.register({ engine: row.engine, sessionId: row.sessionId,
        tmuxPane: row.tmuxPane, cwd: row.cwd ?? undefined, processIdentity: row.processIdentity! })!.entry
      const asObject = (value: object) => value as Record<string, unknown>
      observations[key + ':stale'] = [...mergedForSave(new Map([[row.agentId, asObject(row)]]),
        new Map([[row.agentId, asObject({ ...base, title: 'Renamed' })]]),
        new Map([[row.agentId, JSON.stringify(base)]]), new Map()).values()]
      observations[key + ':invalid'] = [
        { ...row, schemaVersion: 2 }, { ...row, schemaVersion: 3 }, { ...row, schemaVersion: 6 },
        { ...row, nativeControl: undefined }, { ...row, nativeAllocation: undefined },
        { ...row, engine: 'codex' }, { ...row, agentId: 'foreign-agent' },
        { ...row, nativeAllocation: { ...allocation, version: 1 } },
      ].map(strictPersistedRow)
    }
    captured[platform] = observations
    if (!record) expect(observations).toEqual(expected[platform])
  } finally {
    Object.defineProperty(process, 'platform', original)
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
afterAll(() => { if (record) writeFileSync(path, JSON.stringify(captured, null, 2) + '\n') })
