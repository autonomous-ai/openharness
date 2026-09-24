/**
 * `resolveGridTarget` against the plan-driven fake `grid`: the order of its calls, and what the
 * resolved target carries. There was no spec for this module before web tools gave it a second
 * subprocess whose ORDER matters — `mcp config` renews the token, `info --env` reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeGridAnswers, installFakeGrid, type FakeGrid, type FakeGridPlan } from './__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache } from './gridMcpUrl.js'
import { resolveGridTarget } from './gridModels.js'

const { gridName: GRID, networkId, baseUrl: BASE_URL, mcpUrl: MCP_URL, token: TOKEN, plan } = fakeGridAnswers()

let fake: FakeGrid | null = null
function install(overrides: FakeGridPlan = {}): FakeGrid {
  fake = installFakeGrid({ ...plan, ...overrides })
  return fake
}

/** The relay's `/models`, answered here so no test reaches the network. Empty unless a test says. */
let relayRows: unknown[] = []
const relayFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
  new Response(JSON.stringify({ data: relayRows }), { status: 200, headers: { 'content-type': 'application/json' } }))
beforeEach(() => {
  relayRows = []
  relayFetch.mockClear()
  vi.stubGlobal('fetch', relayFetch)
})

afterEach(() => {
  fake?.dispose()
  fake = null
  clearGridMcpUrlCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
  // a grid model — so the target carries the relay's figure for the engine to be told.

  it("carries the relay's context window for the chosen model", async () => {
    install()
    relayRows = [
      { id: 'DeepSeek-V4-Flash-0731', context_window: 262144 },
      { id: 'GLM-4.7-Flash', context_window: 131072 },
    ]
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target?.contextWindow).toBe(131072)
    // Asked of the relay the launch will talk to, with the credential it will use.
    expect(String(relayFetch.mock.calls[0]![0])).toBe(`${BASE_URL.replace(/\/$/, '')}/models`)
  })

  it('matches the id without regard to case only when no exact row exists', async () => {
    install()
    relayRows = [{ id: 'glm-4.7-flash', context_window: 65536 }]
    expect((await resolveGridTarget(GRID, 'GLM-4.7-Flash'))?.contextWindow).toBe(65536)
  })

  it.each([
    ['the relay lists no window', [{ id: 'GLM-4.7-Flash' }]],
    ['the window is not a number', [{ id: 'GLM-4.7-Flash', context_window: '131072' }]],
    ['the window is implausibly small', [{ id: 'GLM-4.7-Flash', context_window: 512 }]],
    ['the model is not listed', [{ id: 'Other', context_window: 131072 }]],
  ])('resolves without a window when %s', async (_case, rows) => {
    install()
    relayRows = rows
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toMatchObject({ baseUrl: BASE_URL, model: 'GLM-4.7-Flash' })
    expect(target).not.toHaveProperty('contextWindow')
  })

  it('resolves without a window when the relay cannot be asked', async () => {
    install()
    relayFetch.mockRejectedValueOnce(new Error('offline'))
    const target = await resolveGridTarget(GRID, 'GLM-4.7-Flash')
    expect(target).toMatchObject({ apiKey: TOKEN, model: 'GLM-4.7-Flash' })
    expect(target).not.toHaveProperty('contextWindow')
  })

  it('asks nothing of `grid` without a grid name or a model', async () => {
    const grid = install()
    expect(await resolveGridTarget(null, 'GLM-4.7-Flash')).toBeNull()
    expect(await resolveGridTarget(GRID, '  ')).toBeNull()
    expect(grid.calls()).toEqual([])
  })
})
