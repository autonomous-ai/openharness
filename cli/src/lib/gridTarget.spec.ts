/**
 * `resolveGridTarget` against the plan-driven fake `grid`: the order of its calls, and what the
 * resolved target carries. There was no spec for this module before web tools gave it a second
 * subprocess whose ORDER matters — `mcp config` renews the token, `info --env` reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeGridAnswers, installFakeGrid, type FakeGrid, type FakeGridPlan } from './__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache } from './gridMcpUrl.js'
import { listAllGridModels, resetGridModels, type GridModelsService } from './gridModels.js'
import { resolveGridTarget } from './gridTarget.js'

const { gridName: GRID, networkId, baseUrl: BASE_URL, mcpUrl: MCP_URL, token: TOKEN, plan } = fakeGridAnswers()
const GRID_URL = `https://grid.autonomous.ai/${networkId}`

let fake: FakeGrid | null = null
function install(overrides: FakeGridPlan = {}): FakeGrid {
  fake = installFakeGrid({ ...plan, ...overrides })
  return fake
}

/** The grid's public overview, answered here so no test reaches the network; anything else is a 404. */
let overview: unknown = { nodes: [], models: [] }
const relayFetch = vi.fn(async (url: string | URL, _init?: RequestInit) =>
  String(url).endsWith('/relay/v1/grid/overview')
    ? new Response(JSON.stringify(overview), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 404 }))
let root: string, service: GridModelsService
beforeEach(() => {
  overview = { nodes: [], models: [] }
  relayFetch.mockClear()
  vi.stubGlobal('fetch', relayFetch)
  root = mkdtempSync(join(tmpdir(), 'grid-target-'))
  service = resetGridModels({ dataDir: () => join(root, 'data'), gridHome: () => join(root, 'grid-home'), email: () => null })
})

afterEach(async () => {
  await service.settled()
  fake?.dispose()
  fake = null
  clearGridMcpUrlCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveGridTarget', () => {
  it('fills mcpUrl with the printed url, calling `mcp config` BEFORE `info --env`', async () => {
    const grid = install()
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toEqual({
      networkId,
      networkName: GRID,
      baseUrl: BASE_URL,
      apiKey: TOKEN,
      model: 'GLM-4.7-Flash',
      mcpUrl: MCP_URL,
    })
    // `mcp config` may renew the token and persist it; `info --env` then reads the renewed one. The
    // other order can hand inference an older token than the one the web tools hold.
    expect(grid.verbs()).toEqual(['mcp', 'info', 'ls'])
    expect(grid.calls()[0]).toEqual(['--remote', 'mcp', 'config', GRID, '--json'])
  })

  it('still resolves, without mcpUrl, when the binary is too old for `mcp config`', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install({ mcp: { exit: 2, stderr: "grid: error: invalid choice: 'mcp'\n" } })
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toMatchObject({ baseUrl: BASE_URL, apiKey: TOKEN, model: 'GLM-4.7-Flash' })
    expect(target).not.toHaveProperty('mcpUrl')
  })

  it('does not call `mcp config` again on a second retarget with a fresh entry', async () => {
    const grid = install()
    await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    const again = await resolveGridTarget(GRID, 'DeepSeek-V4-Flash-0731')
    expect(again?.mcpUrl).toBe(MCP_URL)
    expect(grid.verbs()).toEqual(['mcp', 'info', 'ls', 'info', 'ls'])
  })

  it('still answers null, untouched, when `info --env` fails', async () => {
    // The retarget error path is not this feature's to change: no endpoint → GRID_UNAVAILABLE, as today.
    install({ info: { exit: 1, stderr: 'no access token locally\n' } })
    expect(await resolveGridTarget(GRID, 'GLM-4.7-Flash')).toBeNull()
  })

  // ── the model's context window ─────────────────────────────────────────────────────────────────
  //
  // A coding agent compacts only inside the window it believes, and it believes nothing true about
  // a grid model — so the target carries the grid's figure for the engine to be told. It comes from the
  // picture the model list keeps, read WITHOUT a credential: it used to be a signed-in read of the
  // relay's `/models` on every move, which woke a sleeping grid and held the click while the grid booted
  // (grid-reads-without-waking issue 03).

  /** The grid seen once by the model list — the credential-less overview read every picker makes. */
  async function seen(body: unknown): Promise<void> {
    install({ [`info ${GRID} --json`]: { stdout: JSON.stringify({ grid: GRID, status: null, grid_url: GRID_URL }) } })
    overview = body
    await listAllGridModels(null)
    await service.settled()
  }
  const capable = (id: string, window: unknown) =>
    ({ name: 'rig', engine: 'llama.cpp', models: [id.toLowerCase()], model_capabilities: { [id.toLowerCase()]: { context_length: window } } })

  it('carries the window the grid last reported for the chosen model, and asks the relay nothing', async () => {
    await seen({ nodes: [capable('GLM-4.7-Flash', 131072), capable('DeepSeek-V4-Flash-0731', 262144)], models: [{ id: 'GLM-4.7-Flash' }] })

    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')

    expect(target?.contextWindow).toBe(131072)
    // Only the model list's own credential-less reads went out — no signed-in `/models`.
    expect(relayFetch.mock.calls.some(([url]) => String(url).endsWith('/relay/v1/models'))).toBe(false)
    for (const [, init] of relayFetch.mock.calls) expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })

  it('takes the largest figure among the curated entry and the nodes serving it, whatever its case', async () => {
    await seen({ nodes: [capable('glm-4.7-flash', 65536)], models: [{ id: 'GLM-4.7-Flash', context_length: 131072 }] })
    expect((await resolveGridTarget(GRID, 'glm-4.7-FLASH'))?.contextWindow).toBe(131072)
  })

  it.each([
    ['the grid reports no window', { nodes: [{ name: 'rig', engine: 'llama.cpp', models: ['glm-4.7-flash'] }], models: [] }],
    ['the window is not a number', { nodes: [capable('GLM-4.7-Flash', '131072')], models: [] }],
    ['the window is implausibly small', { nodes: [capable('GLM-4.7-Flash', 512)], models: [] }],
    ['the model is not listed', { nodes: [capable('Other', 131072)], models: [] }],
  ])('resolves without a window when %s', async (_case, body) => {
    await seen(body)
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toMatchObject({ baseUrl: BASE_URL, model: 'GLM-4.7-Flash' })
    expect(target).not.toHaveProperty('contextWindow')
  })

  it('resolves without a window when the grid has never been seen', async () => {
    install()
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toMatchObject({ apiKey: TOKEN, model: 'GLM-4.7-Flash' })
    expect(target).not.toHaveProperty('contextWindow')
    expect(relayFetch).not.toHaveBeenCalled()
  })

  it('asks nothing of `grid` without a grid name or a model', async () => {
    const grid = install()
    expect(await resolveGridTarget(null, 'GLM-4.7-Flash')).toBeNull()
    expect(await resolveGridTarget(GRID, '  ')).toBeNull()
    expect(grid.calls()).toEqual([])
  })
})
