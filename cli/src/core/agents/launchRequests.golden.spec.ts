/** Public launch receipts and dispatch inputs, recorded from main before durable retry changes. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { LaunchRequestDeps } from './launches.js'

const fixture = vi.hoisted(() => ({ root: '', events: [] as unknown[] }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in this golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden }
})
vi.mock('../../engines/inProcess.js', async original => ({ ...await original<object>(),
  loadEngine: () => { throw Error('Launch requests cannot load an optional interpreter') },
}))
vi.mock('../../engines/launchPrep.js', () => ({ folderTrust: (engine: string, profile: string | null) => ({
  trusts: () => false,
  record: (path: string) => fixture.events.push(['trust', engine, profile, path]),
}) }))
vi.mock('../../lib/projectFolder.js', async original => ({ ...await original<object>(),
  projectsRoot: () => join(fixture.root, 'projects'),
  prepareProjectFolder: async (request: unknown, options: { label: string }) => {
    fixture.events.push(['prepare-folder', request, options.label])
    const path = join(fixture.root, 'prepared'); mkdirSync(path); return path
  },
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/launch-requests.golden.json', import.meta.url))
const record = process.env.RECORD_LAUNCH_REQUESTS_GOLDEN === '1'
const observations: Record<string, unknown> = {}
const former = record ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const kinds = ['create', 'codex', 'model', 'project', 'fork', 'resume', 'restart'] as const

it.each(['linux', 'darwin'])('preserves healthy launch requests and durable receipt replies on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-requests-golden-')))
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T17:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      const path = join(root, name); mkdirSync(path); vi.stubEnv(name, path)
    }
    vi.stubEnv('TZ', 'UTC'); vi.stubEnv('CLAUDE_PATH', '/fixture/bin/claude'); vi.stubEnv('CODEX_PATH', '/fixture/bin/codex')
    vi.resetModules()
    const { AgentCreationReceipts } = await import('../../lib/agentCreationReceipt.js')
    const { createLaunchRequests } = await import('./launches.js')
    for (const kind of kinds) {
      fixture.root = join(root, kind); mkdirSync(fixture.root); fixture.events = []
      const cwd = join(fixture.root, 'work'); mkdirSync(cwd)
      const directory = join(fixture.root, 'receipts')
      const creationId = `fixture-creation-${kind}`
      const replies: Record<string, unknown>[] = []
      const reply = (value: Record<string, unknown>) => { replies.push(value) }
      const engine = kind === 'codex' ? 'codex' : 'claude'
      const session = { agentId: 'fixture-agent', sessionId: 'fixture-conversation', engine, cwd } as RegisteredSession
      let finish!: () => void
      const dispatch = async (operation: string, input: unknown) => {
        fixture.events.push(['dispatch', operation, input])
        await new Promise<void>(done => { finish = done })
        return { ok: true as const, session, level: 'native' as const, resumed: operation === 'resume' }
      }
      const deps: LaunchRequestDeps = {
        receipts: new AgentCreationReceipts(directory),
        createAgent: () => input => dispatch('create', input),
        forkAgent: () => input => dispatch('fork', input),
        resumeAgent: () => (agentId, permissionMode) => dispatch('resume', { agentId, permissionMode }),
        restartAgent: () => agentId => dispatch('restart', { agentId }),
        byAgent: agentId => agentId === session.agentId ? session : undefined,
        // The frame formatter is another boundary; retain recognizable fields
        // to detect a wrong agent or a dropped reply without invoking services.
        toProject: async row => ({ id: row.agentId, engine: row.engine, cwd: row.cwd } as unknown as AgentFrame),
        modelTarget: async selection => {
          fixture.events.push(['models', selection])
          return { networkId: 'fixture-grid', networkName: 'Fixture', baseUrl: 'http://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' }
        },
      }
      const requests = createLaunchRequests(deps)
      const payload: Record<string, unknown> = kind === 'fork'
        ? { creationId, agentId: session.agentId, name: 'Fork', prompt: 'Try another approach' }
        : kind === 'resume' || kind === 'restart'
          ? { creationId, agentId: session.agentId, ...(kind === 'resume' ? { permissionMode: 'ask' } : {}) }
          : { creationId, engine, permissionMode: 'ask', prompt: 'First request', name: 'Fixture',
            ...(kind === 'codex' ? { codexHome: join(root, 'CODEX_HOME') } : {}),
            ...(kind === 'project' ? { projectSource: 'new', projectName: 'Fixture' } : { cwd }),
            ...(kind === 'model' ? { gridModel: 'fixture-model', gridName: 'fixture-grid' } : {}) }
      const invoke = () => kind === 'fork' ? requests.fork(payload, reply)
        : kind === 'resume' || kind === 'restart' ? requests.relaunch(`agent_${kind}`, payload, reply)
          : requests.create(payload, { local: true }, reply)
      await invoke()
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      await requests.createStatus({ creationId }, reply)
      await invoke() // A duplicate in flight joins the same operation.
      finish()
      await vi.waitFor(() => expect(replies).toHaveLength(3))
      await invoke() // A duplicate after completion only returns the receipt.
      await vi.waitFor(() => expect(replies).toHaveLength(4))
      const recovered = createLaunchRequests({ ...deps, receipts: new AgentCreationReceipts(directory) })
      await recovered.createStatus({ creationId }, reply)
      expect(fixture.events.filter(value => Array.isArray(value) && value[0] === 'dispatch')).toHaveLength(1)
      const key = `${platform}:${kind}`
      observations[key] = JSON.parse(JSON.stringify({ events: fixture.events, replies }).split(root).join('<root>'))
      if (!record) expect({ key, value: observations[key] }).toEqual({ key, value: former[key] })
    }
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', descriptor)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (record) writeFileSync(GOLDEN, JSON.stringify(observations, null, 2) + '\n')
  else {
    expect(Object.keys(observations).sort()).toEqual(Object.keys(former).sort())
    expect(readFileSync(GOLDEN, 'utf8')).not.toMatch(/\/Users\/|\/home\/runner|launch-requests-golden-/)
  }
})
