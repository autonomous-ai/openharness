/**
 * `resolveGridMcpUrl` against the plan-driven fake `grid` — which argv it sends, what it keeps, and
 * what it never keeps. The token `grid mcp config --json` prints is the one thing this module must
 * read and then forget, so every test that hands it one also asserts it went nowhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeGridAnswers, fakeJwt, installFakeGrid, type FakeGrid, type FakeGridPlan } from './__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache, MCP_URL_RENEW_MARGIN_MS, resolveGridMcpUrl } from './gridMcpUrl.js'

/** The grid's name and its web-tools mount (trailing slash and all — the mount answers 307
 *  without it). The token varies per test here, so each one builds its own `mcp config` answer. */
const { gridName: GRID, mcpUrl: URL } = fakeGridAnswers()
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1000
const secondsAt = (ms: number): number => Math.floor(ms / 1000)

/** What `grid mcp config <grid> --json` prints for `token`. */
function mcpConfig(token: string): string {
  return JSON.stringify({ server: 'grid-web', url: URL, authorization: `Bearer ${token}` }, null, 2)
}

let fake: FakeGrid | null = null
let warned: string[] = []

function install(plan: FakeGridPlan): FakeGrid {
  fake = installFakeGrid(plan)
  return fake
}

beforeEach(() => {
  warned = []
  vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => { warned.push(parts.map(String).join(' ')) })
})

afterEach(() => {
  fake?.dispose()
  fake = null
  clearGridMcpUrlCache()
  vi.restoreAllMocks()
})

describe('resolveGridMcpUrl', () => {
  it('asks `grid mcp config <grid> --json` and hands back the url exactly as printed', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 300 * DAY_MS) })
    const grid = install({ mcp: { stdout: mcpConfig(token) } })
    expect(await resolveGridMcpUrl(GRID, NOW)).toBe(URL)
    expect(grid.calls()).toEqual([['--remote', 'mcp', 'config', GRID, '--json']])
  })

  it('does not call again while the entry is fresh', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 300 * DAY_MS) })
    const grid = install({ mcp: { stdout: mcpConfig(token) } })
    await resolveGridMcpUrl(GRID, NOW)
    expect(await resolveGridMcpUrl(GRID, NOW + DAY_MS)).toBe(URL)
    expect(grid.calls()).toHaveLength(1)
  })

  it('calls again once the token is within 30 days of expiry, which is when `mcp config` renews it', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 300 * DAY_MS) })
    const grid = install({ mcp: { stdout: mcpConfig(token) } })
    await resolveGridMcpUrl(GRID, NOW)
    const justInside = NOW + 300 * DAY_MS - MCP_URL_RENEW_MARGIN_MS + 1000
    expect(await resolveGridMcpUrl(GRID, justInside)).toBe(URL)
    expect(grid.calls()).toHaveLength(2)
  })

  it('calls every time when the token cannot be decoded', async () => {
    const grid = install({ mcp: { stdout: mcpConfig('not-a-jwt') } })
    expect(await resolveGridMcpUrl(GRID, NOW)).toBe(URL)
    expect(await resolveGridMcpUrl(GRID, NOW)).toBe(URL)
    expect(grid.calls()).toHaveLength(2)
  })

  it('treats a boolean or missing exp as undecodable rather than as the epoch', async () => {
    // `exp: true` would read as 1 through a careless numeric check — 1970, renew forever.
    const grid = install({ mcp: { stdout: mcpConfig(fakeJwt({ exp: true })) } })
    await resolveGridMcpUrl(GRID, NOW)
    await resolveGridMcpUrl(GRID, NOW)
    expect(grid.calls()).toHaveLength(2)
  })

  it('is emptied by sign-out', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 300 * DAY_MS) })
    const grid = install({ mcp: { stdout: mcpConfig(token) } })
    await resolveGridMcpUrl(GRID, NOW)
    clearGridMcpUrlCache()
    await resolveGridMcpUrl(GRID, NOW)
    expect(grid.calls()).toHaveLength(2)
  })

  it('is keyed by grid name, so a re-minted name never hits a stale entry', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 300 * DAY_MS) })
    const grid = install({ mcp: { stdout: mcpConfig(token) } })
    await resolveGridMcpUrl(GRID, NOW)
    await resolveGridMcpUrl('someone-0badf00d', NOW)
    expect(grid.calls().map((argv) => argv[3])).toEqual([GRID, 'someone-0badf00d'])
  })

  it('answers undefined, logs the reason, and caches nothing when the binary is too old', async () => {
    // argparse exits 2 on the unknown subcommand, before any handler runs — `GRID_CLI_OUTDATED`.
    const grid = install({ mcp: { exit: 2, stderr: 'grid: error: argument command: invalid choice: \'mcp\'\n' } })
    expect(await resolveGridMcpUrl(GRID, NOW)).toBeUndefined()
    expect(await resolveGridMcpUrl(GRID, NOW)).toBeUndefined()
    expect(grid.calls()).toHaveLength(2)
    expect(warned.join('\n')).toMatch(/older than/)
  })

  it('answers undefined with grid\'s own words when the sign-in is missing or the grid unknown', async () => {
    install({ mcp: { exit: 1, stderr: 'Not logged in. Run `grid login` first.\n' } })
    expect(await resolveGridMcpUrl(GRID, NOW)).toBeUndefined()
    expect(warned.join('\n')).toContain('Not logged in')
  })

  it('answers undefined when the output is not a usable address', async () => {
    for (const url of ['', 'v1/grid/web-mcp/', 'file:///etc/passwd']) {
      clearGridMcpUrlCache()
      fake?.dispose()
      install({ mcp: { stdout: JSON.stringify({ server: 'grid-web', url, authorization: 'Bearer x' }) } })
      expect(await resolveGridMcpUrl(GRID, NOW), url).toBeUndefined()
    }
  })

  it('answers undefined when there is no `grid` at all, and never throws', async () => {
    process.env.HARNESS_GRID_BIN = '/definitely/not/a/grid'
    expect(await resolveGridMcpUrl(GRID, NOW)).toBeUndefined()
    delete process.env.HARNESS_GRID_BIN
  })

  it('never lets the token reach a log line', async () => {
    const token = fakeJwt({ exp: secondsAt(NOW + 5 * DAY_MS), sub: 'someone' })
    install({ mcp: { stdout: mcpConfig(token) } })
    const logged: string[] = []
    for (const method of ['log', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(' ')) })
    }
    await resolveGridMcpUrl(GRID, NOW)
    await resolveGridMcpUrl(GRID, NOW) // inside the margin: a second call, a second chance to leak
    for (const line of [...logged, ...warned]) expect(line).not.toContain(token)
  })
})
