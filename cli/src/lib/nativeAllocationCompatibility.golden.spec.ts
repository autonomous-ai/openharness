/** Former row-2/row-3 persistence before adding permanent allocation authority.
 * Fixed platform/time/paths keep the compatibility trace independent of host. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { nativeTurnTarget, type NativeTurnIntent } from './nativeTurnIntent.js'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the allocation golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./bootId.js', () => ({ currentBootId: () => 'fixture-boot', bootChanged: () => false }))

const path = fileURLToPath(new URL('./__fixtures__/native-allocation-compatibility.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_ALLOCATION_GOLDEN === '1'
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

it.each(['linux', 'darwin'])('retains former allocation-free rows on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'allocation-compatibility-golden-')))
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
    const store = new StoppedAgentStore(join(root, 'saved'))
    const observations: Record<string, unknown> = {}
    for (const schema of [2, 3] as const) {
      for (const launch of [undefined, { state: 'ready' as const }, { state: 'held' as const, service: 'native', detail: 'Waiting.', nativeToken: 'fixture-launch-token' }]) {
        const input = { ...base, schemaVersion: schema, ...(schema === 3 ? { nativeControl: cancel } : {}), ...(launch ? { launch } : {}) }
        const row = strictPersistedRow(input)!
        const key = `${schema}:${launch?.state ?? 'absent'}`
        observations[key] = { row, target: nativeTurnTarget(row) }
        store.save(row)
        observations[key + ':saved'] = store.get(row.agentId)
        writeFileSync(join(root, 'data', 'registry.json'), JSON.stringify([row]), { mode: 0o600 })
        registry.load()
        const loaded = registry.byAgent(row.agentId)!
        observations[key + ':loaded'] = loaded
        const registered = registry.register({ engine: row.engine, sessionId: row.sessionId,
          tmuxPane: row.tmuxPane, cwd: row.cwd ?? undefined, processIdentity: row.processIdentity! })!.entry
        observations[key + ':registered'] = registered
      }
    }
    const old = { ...base }, latest = { ...base, schemaVersion: 3, nativeControl: cancel }
    const object = (row: object) => row as Record<string, unknown>
    const merged = mergedForSave(new Map([[base.agentId, object(latest)]]),
      new Map([[base.agentId, object({ ...old, title: 'Renamed' })]]),
      new Map([[base.agentId, JSON.stringify(old)]]), new Map())
    observations.staleRename = [...merged.values()]
    observations.invalid = [
      { ...base, schemaVersion: 99 }, { ...base, schemaVersion: 3 },
      { ...base, nativeControl: cancel }, { ...base, schemaVersion: 3, nativeControl: { version: 99 } },
    ].map(strictPersistedRow)
    captured[platform] = observations
    if (!record) expect(captured[platform]).toEqual(expected[platform])
  } finally {
    Object.defineProperty(process, 'platform', original)
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
afterAll(() => { if (record) writeFileSync(path, JSON.stringify(captured, null, 2) + '\n') })
