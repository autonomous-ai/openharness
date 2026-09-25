/**
 * The web-search status, end to end on the daemon side: the plan-driven fake `grid` answers (or
 * refuses) `mcp config`, the launch is built from what it said, the registry keeps what the launch
 * decided, and the per-agent frame the app rebuilds itself from carries it — or, once the agent is
 * back on its own login, carries no grid block at all.
 *
 * One spec across four modules on purpose. Each has its own unit spec; what none of them can say is
 * that the value the app reads is the value the launch decided, with no hand-off in between that
 * forgets it (the registry rebuilds its row from an explicit field list on load AND on the first
 * hook bind, and `agentFrame` picks its fields explicitly — three places a field can silently drop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeGridAnswers, installFakeGrid, type FakeGrid, type FakeGridPlan } from './__fixtures__/fakeGrid.js'
import { agentFrame } from './agentFrame.js'
import { buildLaunchOverrides, type LaunchOverridesDeps } from './launchOverrides.js'
import { clearGridMcpUrlCache } from './gridMcpUrl.js'
import { resolveGridTarget } from './gridTarget.js'

const { gridName: GRID, baseUrl: BASE_URL, mcpUrl: MCP_URL, plan } = fakeGridAnswers()

let fake: FakeGrid | null = null
let dataDir = ''

function install(overrides: FakeGridPlan = {}): FakeGrid {
  fake = installFakeGrid({ ...plan, ...overrides })
  return fake
}

/** The registry, fresh, on its own state directory — the same way `registry.spec.ts` loads it. */
async function loadRegistry() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  const { registry } = await import('./registry.js')
  registry.load()
  return registry
}

const DEPS: LaunchOverridesDeps = {
  machine: () => ({ hermesSystemManaged: false }),
  writeGridConfigDir: async (key) => `/state/grid-engine-config/${key}`,
  tmuxSupportsSessionEnv: async () => true,
  installCodexHooks: () => {},
}

const IDENTITY = { pid: 4242, executable: 'claude', startMarker: 'boot-1' }

/**
 * What `agent_retarget` does with a resolved target, minus the pane: build the launch, and keep it —
 * status included — on the row the frame is built from.
 */
async function retargetOntoGrid(registry: Awaited<ReturnType<typeof loadRegistry>>, agentId: string, model: string) {
  const target = await resolveGridTarget(GRID, model)
  if (!target) throw new Error('the fake grid did not resolve')
  const built = await buildLaunchOverrides(DEPS, 'claude', { gridLaunch: target }, agentId)
  if (!built.ok || !built.overrides.gridLaunchRecord) throw new Error(built.ok ? 'no grid launch was built' : built.detail)
  registry.updateProcessIdentity(agentId, IDENTITY, null, { baseUrl: BASE_URL, model })
  registry.setGridLaunch(agentId, built.overrides.gridLaunchRecord)
  return built.overrides.gridLaunchRecord.webSearch
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'grid-websearch-frame-'))
})

afterEach(() => {
  fake?.dispose()
  fake = null
  clearGridMcpUrlCache()
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
  delete process.env.CLAUDE_PROJECTS_DIR
  delete process.env.CODEX_HOME
  delete process.env.CURSOR_HOME
})

describe('the web-search status on the per-agent frame', () => {
  it('carries "unavailable" when the `grid` on this machine is too old for `mcp config`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install({ mcp: { exit: 2, stderr: "grid: error: invalid choice: 'mcp'\n" } })
    const registry = await loadRegistry()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/demo' })!

    expect(await retargetOntoGrid(registry, row.agentId, 'GLM-4.7-Flash')).toBe('unavailable')

    const frame = await agentFrame(registry.byAgent(row.agentId)!, { selectedModel: null, terminalAvailable: true })
    expect(frame.grid).toEqual({ baseUrl: BASE_URL, model: 'GLM-4.7-Flash', webSearch: 'unavailable' })
  })

  it('carries "on" when the config was obtained and the engine wired it', async () => {
    install()
    const registry = await loadRegistry()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/demo' })!

    expect(await retargetOntoGrid(registry, row.agentId, 'GLM-4.7-Flash')).toBe('on')

    const frame = await agentFrame(registry.byAgent(row.agentId)!, { selectedModel: null, terminalAvailable: true })
    expect(frame.grid).toEqual({ baseUrl: BASE_URL, model: 'GLM-4.7-Flash', webSearch: 'on' })
    // The url reached the launch and the frame never carries it — nor the token behind it.
    expect(JSON.stringify(frame)).not.toContain(MCP_URL)
    expect(JSON.stringify(frame)).not.toContain('apiKey')
  })

  it('carries no grid block, and so no status, once the agent is back on its own login', async () => {
    install()
    const registry = await loadRegistry()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/demo' })!
    await retargetOntoGrid(registry, row.agentId, 'GLM-4.7-Flash')

    // The move home: the respawned process reads as "on no grid", and the launch is cleared.
    registry.updateProcessIdentity(row.agentId, { ...IDENTITY, startMarker: 'boot-2' }, null, null)
    registry.setGridLaunch(row.agentId, null)

    const frame = await agentFrame(registry.byAgent(row.agentId)!, { selectedModel: null, terminalAvailable: true })
    expect(frame).toHaveProperty('grid', null)
    expect(JSON.stringify(frame)).not.toContain('webSearch')
  })

  it('survives a daemon restart — the status is on the row, not in memory', async () => {
    install()
    let registry = await loadRegistry()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/demo' })!
    await retargetOntoGrid(registry, row.agentId, 'GLM-4.7-Flash')

    registry = await loadRegistry()
    const frame = await agentFrame(registry.byAgent(row.agentId)!, { selectedModel: null, terminalAvailable: true })
    expect(frame.grid).toMatchObject({ webSearch: 'on' })
  })

  it('survives the first hook bind, which rebuilds the row', async () => {
    install()
    const registry = await loadRegistry()
    const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/demo' })!
    await retargetOntoGrid(registry, row.agentId, 'GLM-4.7-Flash')

    // The engine's SessionStart hook: a real transcript, bound onto the pane the launch opened.
    const transcriptPath = join(dataDir, 'session-1.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const bound = registry.register({ sessionId: 'session-1', transcriptPath, tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(bound?.entry.agentId).toBe(row.agentId)
    const frame = await agentFrame(bound!.entry, { selectedModel: null, terminalAvailable: true })
    expect(frame.grid).toMatchObject({ webSearch: 'on' })
  })

  it('says nothing about web search for a grid agent the daemon merely discovered', async () => {
    // Someone ran `ANTHROPIC_BASE_URL=… claude` by hand: the daemon sees the grid on the process but
    // built no launch, so it has no status to report — and must not invent one.
    const registry = await loadRegistry()
    const opened = registry.openProcessAgent({
      engine: 'claude',
      processIdentity: IDENTITY,
      runtimes: [{ backend: 'tmux', paneId: '%2' }],
      cwd: '/tmp/demo',
      grid: { baseUrl: BASE_URL, model: null },
    })
    const frame = await agentFrame(opened!.entry, { selectedModel: null, terminalAvailable: true })
    expect(frame.grid).toEqual({ baseUrl: BASE_URL, model: null })
  })
})
