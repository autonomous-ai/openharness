/** Former admitted rearm rows before initial allocations join the same ledger. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { appendNativeAllocation, nativeAllocationCanReserve, parseNativeAllocation } from './nativeAllocation.js'
import { nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the first-allocation golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./bootId.js', () => ({ currentBootId: () => 'fixture-boot', bootChanged: () => false }))

const path = fileURLToPath(new URL('./__fixtures__/native-first-allocation-compatibility.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_FIRST_ALLOCATION_GOLDEN === '1'
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
const receipt = (n: number, source = true) => {
  const choice = { kind: 'native-rearm', agentId: base.agentId, operation: 'resume', source: 'live' }
  return { fingerprint: creationFingerprint(choice), request: { ...choice, creationId: `fixture-original-${n}`,
    launchToken: `fixture-launch-token-${n}`, target: 'a'.repeat(64), ...(source ? { sourceProcess: { processKey: null } } : {}) } }
}

it.each(['linux', 'darwin'])('retains former rearm allocation rows on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'first-allocation-golden-')))
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
    for (const source of [false, true]) {
      let allocation = appendNativeAllocation(undefined, receipt(0, source))
      for (let n = 1; n < 4; n++) allocation = appendNativeAllocation(allocation, receipt(n, source))
      const input: RegisteredSession = { ...base, schemaVersion: 4, nativeControl: cancel, nativeAllocation: allocation }
      const row = strictPersistedRow(input)!
      const key = source ? 'original-source' : 'legacy-omission'
      observations[key] = { row, target: nativeTurnTarget(row), allocation: parseNativeAllocation(allocation),
        repeated: appendNativeAllocation(allocation, receipt(0, source)), capacity: nativeAllocationCanReserve(allocation, 'fresh-request-id') }
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
        { ...row, schemaVersion: 2 }, { ...row, schemaVersion: 3 }, { ...row, schemaVersion: 5 },
        { ...row, nativeControl: undefined }, { ...row, nativeAllocation: undefined },
        { ...row, engine: 'codex' }, { ...row, agentId: 'foreign-agent' },
        { ...row, nativeAllocation: { ...allocation, version: 2 } },
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
