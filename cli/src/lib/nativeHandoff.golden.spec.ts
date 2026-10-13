/** Former-code Change agent output through both service compositions, with actual private history. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { ServiceFrame } from '../core/serviceLinks.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the handoff golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-handoff.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_HANDOFF_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', CHANGE = '1'.repeat(32), AT = Date.parse('2026-10-10T09:00:00Z')

it.each(['linux', 'darwin'])('keeps the former handoff service outcomes on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-handoff-golden-')))
  const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }) }
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: AT })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 }); vi.stubEnv(name, join(root, name))
    }
    vi.stubEnv('TZ', 'UTC'); vi.resetModules()
    for (const transport of ['inline', 'process']) for (const mode of ['own', 'fork', 'discovery']) {
      // Each observation starts a separate daemon state with its own explicit Change agent intent.
      const dataDir = join(root, `data-${transport}-${mode}`); mkdirSync(dataDir, { mode: 0o700 })
      vi.stubEnv('ADAPTER_DATA_DIR', dataDir); vi.resetModules()
    const { fakeCore } = await import('../testing/fakeCore.js')
    const { conversationReads, answerConversationQuery } = await import('../core/conversationQueries.js')
    const { createServiceLinks } = await import('../core/serviceLinks.js')
    const { handoffCoreApi } = await import('../services/handoffProcess.js')
    const { startHandoff } = await import('../services/handoff.js')
    const { createHandoffDependencies } = await import('../core/handoffDependencies.js')
    const { validTranscriptPath } = await import('./registry.js')
      const cwd = join(root, `${transport}-${mode}`); mkdirSync(cwd)
      const path = join(root, 'CODEX_HOME', 'sessions', `${mode}-${ID}.jsonl`)
      write(path, [
        { type: 'session_meta', payload: { id: ID, cwd, source: 'cli' } },
        { timestamp: '2026-10-10T08:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Keep the native conversation' } },
        { timestamp: '2026-10-10T08:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The native conversation is retained.' } },
        { timestamp: '2026-10-10T08:00:02Z', type: 'event_msg', payload: { type: 'task_complete' } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n')
      write(join(dataDir, 'engine-homes.json'), '{}')
      const parent = { agentId: 'parent', sessionId: ID, engine: 'codex', cwd, transcriptPath: path,
        registeredAt: AT, boundAt: AT - 60_000, codexHome: null, hermesHome: null,
        processIdentity: null, runtimes: [{ backend: 'tmux', paneId: '%1' }] } as RegisteredSession
      const source = mode === 'own' ? { ...parent, agentId: 'selected' } : { ...parent, agentId: 'selected', sessionId: '', transcriptPath: null,
        ...(mode === 'fork' ? { forkedFrom: { agentId: 'parent', name: 'Parent', sessionId: ID, transcriptPath: path } }
          : { processIdentity: { pid: 4242, executable: 'codex', startMarker: '2026-10-10T08:00:00Z' } }) }
      const deps = createHandoffDependencies({
        registry: { resolve: id => id === 'selected' ? source : id === 'parent' ? parent : undefined,
          byAgent: () => source, bySession: () => undefined },
        stopped: { get: () => null, ids: () => [] }, mirror: { recentAsks: () => [], lastFullText: () => undefined, recent: () => [] },
        databaseHistory: () => undefined, findLiveSession: async () => ({ sessionId: ID, transcriptPath: path }),
        processSession: async () => null, isRecentlyDeleted: () => false, findResumedTranscript: async () => path, validTranscriptPath,
      }, dataDir)
      const core = fakeCore({ dataDir, conversations: conversationReads(deps), daemon: { port: 0 } })
      const request = { agentId: 'selected', changeId: CHANGE, targetEngine: 'claude' }
      const owner = { owner: true, local: true, connection: 'fixture-owner', requestId: 'fixture-request' }
      let result: unknown
      if (transport === 'inline') result = await startHandoff(core).agent_handoff_prepare!(request, owner)
      else {
        const queries = new Map<string, (reply: Record<string, unknown>) => void>(); let next = 0
        const links = createServiceLinks({ token: 'fixture-token', owned: { handoff: ['agent_handoff_prepare'] }, log: () => {},
          answer: (_service, query, payload, authority) => answerConversationQuery(core, query, json(payload), authority) })
        const processCore = handoffCoreApi(core.dataDir, (query, payload) => new Promise(resolve => {
          const requestId = `query-${++next}`; queries.set(requestId, resolve)
          link.receive(json({ type: 'service_query', payload: { ...payload, query, requestId } }))
        }))
        const handlers = startHandoff(processCore)
        const link = links.accept('handoff', 'fixture-token', { sendFrame(frame: ServiceFrame) {
          const wire = json(frame)
          if (wire.type === 'service_query_result') queries.get(String(wire.payload!.requestId))!(wire.payload!)
          else if (wire.type === 'agent_handoff_prepare') void Promise.resolve(handlers.agent_handoff_prepare!(wire.payload!, owner))
            .then(reply => link.receive(json({ type: wire.type + '_result', payload: { ...reply, requestId: wire.payload!.requestId } })))
          return true
        } }, () => {})!
        result = await new Promise(resolve => links.route('agent_handoff_prepare', request, owner, resolve))
        link.closed()
      }
      const folder = join(cwd, '.harness', 'handoff')
      const value = { result, files: readdirSync(folder).filter(name => name.startsWith('selected-')).sort()
        .map(name => ({ name, text: readFileSync(join(folder, name), 'utf8') })) }
      const key = `${platform}:${transport}:${mode}`
      captured[key] = JSON.parse(JSON.stringify(value).split(root).join('<root>'))
      if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
    }
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules(); Object.defineProperty(process, 'platform', original)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000) // Six durable filesystem transactions per platform; each request retains its own 5 s deadline.
afterAll(() => { if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n') })
