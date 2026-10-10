/** Healthy discovery before changing initial-launch absence handling. No host process is probed. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent, TerminalAgentProbe } from './terminalAgentDiscovery.js'
import { TerminalAgentReconciler } from './terminalAgentReconciler.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw new Error('Golden cannot run a host binary') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden }
})

const file = fileURLToPath(new URL('./__fixtures__/initial-launch.golden.json', import.meta.url))
const record = process.env.RECORD_INITIAL_LAUNCH_GOLDEN === '1'
const former = record ? {} : JSON.parse(readFileSync(file, 'utf8'))
const observations: Record<string, unknown> = {}

it.each(['linux', 'darwin'])('keeps healthy initial binding and later confirmed exits on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  vi.stubEnv('TZ', 'UTC')
  const runtime = { backend: 'tmux' as const, paneId: '%fixture' }
  const processIdentity = { pid: 42, executable: '/fixture/bin/codex', startMarker: 'fixture-start' }
  const current = { agentId: 'fixture-agent', sessionId: '', engine: 'codex', active: true,
    cwd: '/fixture/project', runtimes: [runtime], primaryRuntimeKey: 'tmux\u0000%fixture',
    processIdentity: null, launch: { state: 'starting' } } as RegisteredSession
  const found: DiscoveredTerminalAgent = { engine: 'codex', cwd: '/fixture/project', processIdentity,
    args: '/fixture/bin/codex', resumeSessionId: null, runtimes: [runtime], primaryRuntimeKey: 'tmux\u0000%fixture' }
  let livePane = true, agents = [found]
  const events: unknown[] = []
  const reconciler = new TerminalAgentReconciler({
    current: () => [current], backends: [], backendOrder: ['tmux'],
    probe: async (): Promise<TerminalAgentProbe> => ({ processTableAvailable: true, agents, ambiguousPlacements: new Set(),
      targets: [{ instanceId: 'tmux:default', result: { state: 'available', roots: livePane ? [{ runtime, rootPid: 1, cwd: '/fixture/project' }] : [] } }] }),
    onDiscovered: () => { throw new Error('Existing pane cannot become another agent') },
    onObserved: observed => { events.push(['observed', observed.processIdentity.pid]); current.processIdentity = observed.processIdentity; current.launch = { state: 'ready' } },
    onDormant: (_row, reason) => { events.push(['dormant', reason]); current.active = false },
    onRemoved: (_row, reason) => { events.push(['removed', reason]) },
    onTerminalAvailability: (_row, available) => { events.push(['terminal', available]) },
  })
  try {
    await reconciler.trigger()
    agents = []
    await reconciler.trigger(); await reconciler.trigger()
    livePane = false
    await reconciler.trigger(); await reconciler.trigger()
    observations[platform] = { events, active: current.active, processIdentity: current.processIdentity }
    if (!record) expect(observations[platform]).toEqual(former[platform])
  } finally { reconciler.stop(); Object.defineProperty(process, 'platform', descriptor); vi.unstubAllEnvs() }
})

afterAll(() => { if (record) writeFileSync(file, JSON.stringify(observations, null, 2) + '\n') })
