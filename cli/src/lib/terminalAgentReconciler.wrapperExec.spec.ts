/**
 * An agent launched through a wrapper that `exec`s into another name (#4259): `sh hermes` is bound, becomes `unshare`
 * with the same pid and start, and the real Hermes shows up later as its child. Process rows through the real probe.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const processRows = vi.hoisted(() => vi.fn())
vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime: vi.fn(async () => ({ kind: null })) }))
vi.mock('./processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv: vi.fn(async () => null) }))
vi.mock('./processMounts.js', async (real) => ({ ...await real<object>(), processView: vi.fn(async () => ({ state: 'same' })) }))
vi.mock('./processTable.js', async (real) => ({ ...await real<typeof import('./processTable.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))

const { TerminalAgentReconciler } = await import('./terminalAgentReconciler.js')

const START = 'Fri Nov 13 14:22:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable, startMarker = START): ProcessRow =>
  ({ pid, parentPid, executable, startMarker, args })
const pane: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const SHELL = row(10, 5, 'zsh', '-zsh')
const WRAPPER = row(11, 10, 'hermes', '/bin/sh /usr/local/bin/hermes')
/** The wrapper after its `exec`: the same pid and start, a name no engine has. */
const UNSHARE = row(11, 10, 'unshare', '/usr/bin/unshare --fork -- /usr/local/bin/hermes-ns')
const HERMES = row(12, 11, 'python3', '/opt/hermes-agent/hermes')

function rig() {
  const current = {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: 'local-4259', boundAt: 1, engine: 'hermes',
    transcriptPath: null, projectDir: 'work', cwd: '/work', runtimes: [pane], primaryRuntimeKey: terminalRouteKey(pane),
    tmuxPane: '%1', source: null, title: null, model: null, cliVersion: null, launch: { state: 'ready' },
    processIdentity: { pid: 11, executable: 'hermes', startMarker: START },
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  } as RegisteredSession
  const onDiscovered = vi.fn()
  const onObserved = vi.fn((observed: DiscoveredTerminalAgent) => { current.processIdentity = observed.processIdentity })
  const onDormant = vi.fn(() => { current.active = false })
  const backend = { name: 'tmux', instanceId: 'tmux:default',
    inventory: async () => ({ state: 'available', roots: [{ runtime: pane, rootPid: 10, cwd: '/work' }] }) } as unknown as TerminalBackend
  const reconciler = new TerminalAgentReconciler({ current: () => [current], backends: [backend], backendOrder: ['tmux'],
    daemonPid: 999, onDiscovered, onObserved, onDormant, onRemoved: vi.fn() })
  const pass = async (...rows: ProcessRow[]) => { processRows.mockResolvedValue(rows); await reconciler.trigger() }
  return { current, onDiscovered, onObserved, onDormant, pass }
}

describe('an agent whose bound process execs into another name', () => {
  it('stays while that process runs in its pane, then is re-recorded to the engine below it', async () => {
    const r = rig()
    await r.pass(SHELL, WRAPPER)
    for (let n = 0; n < 3; n++) await r.pass(SHELL, UNSHARE)
    expect(r.onDormant).not.toHaveBeenCalled()
    await r.pass(SHELL, UNSHARE, HERMES)
    expect(r.current.processIdentity).toMatchObject({ pid: 12, startMarker: START })
    expect(r.onObserved).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'hermes' }), r.current)
    expect(r.onDiscovered).not.toHaveBeenCalled()
    // Hermes ends, and `unshare` with it: stopped as before, after two passes.
    await r.pass(SHELL)
    expect(r.onDormant).not.toHaveBeenCalled()
    await r.pass(SHELL)
    expect(r.onDormant).toHaveBeenCalledOnce()
  })

  it('counts a reused pid as a miss, and does not take the engine below it for its own', async () => {
    const r = rig()
    const reused = row(11, 10, 'unshare', UNSHARE.args, 'Fri Nov 13 15:00:00 2026')
    await r.pass(SHELL, reused, HERMES)
    await r.pass(SHELL, reused, HERMES)
    expect(r.onDormant).toHaveBeenCalledOnce()
    expect(r.onObserved).not.toHaveBeenCalled()
    expect(r.onDiscovered).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: expect.objectContaining({ pid: 12 }) }))
  })

  it('counts a miss when that process runs outside the agent\'s pane', async () => {
    const r = rig()
    const elsewhere = { ...UNSHARE, parentPid: 5 }
    await r.pass(SHELL, elsewhere)
    await r.pass(SHELL, elsewhere)
    expect(r.onDormant).toHaveBeenCalledOnce()
  })
})
