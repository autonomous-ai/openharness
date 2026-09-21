/**
 * `ensureHarnessGrid` against a fake `grid` first on PATH — the same seam `gridCommand.spec.ts`
 * uses, for the same reason: the real binary talks to a control plane, and the questions worth
 * asking here are all about which argv this module sends and what it believes about the answer.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeGrid, type FakeGrid, type FakeGridPlan, type FakeGridTurn as Turn } from './__fixtures__/fakeGrid.js'

let fake: FakeGrid | null = null
afterEach(() => {
  fake?.dispose()
  fake = null
  // One test below points HARNESS_GRID_BIN at nothing by hand, with no fake to dispose of.
  delete process.env.HARNESS_GRID_BIN
})

/** The fake `grid` from `__fixtures__/fakeGrid.ts`, remembered so `afterEach` can dispose of it. */
function fakeGrid(plan: FakeGridPlan): FakeGrid {
  fake = installFakeGrid(plan)
  return fake
}

const VERSION_OK: Turn = { stdout: 'grid 0.3.46\n' }
const rows = (...names: string[]): string =>
  JSON.stringify(names.map((n) => ({ grid: n, type: 'permissioned-public', id: `grid-${n}` })))

async function ensure(name = 'someone-7f3a91c4') {
  const { ensureHarnessGrid } = await import('./gridEnsure.js')
  return ensureHarnessGrid(name)
}

describe('ensureHarnessGrid', () => {
  it('creates the grid when the account has none, as a private permissioned-public one', async () => {
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows('something-else') },
      start: {},
    })
    expect(await ensure()).toEqual({ status: 'created', message: '' })
    const start = fake.calls().find((c) => c.includes('start'))
    // The type is the whole safety property: `permissioned-providers` would open the grid to
    // strangers and switch billing on.
    expect(start).toEqual(['--remote', 'start', 'someone-7f3a91c4', '--type', 'permissioned-public'])
  })

  it('syncs AGAIN after creating, so the new grid has its access token', async () => {
    // A just-created grid has no per-grid token locally; `grid info --env` and `grid join` both
    // refuse until a refresh. Measured against the real control plane.
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows() }, start: {} })
    expect((await ensure()).status).toBe('created')
    const verbs = fake.calls().map((c) => c.find((a) => a !== '--remote'))
    expect(verbs.filter((v) => v === 'sync').length).toBe(2)
    expect(verbs.lastIndexOf('sync')).toBeGreaterThan(verbs.indexOf('start'))
  })

  it('does nothing when the grid is already there', async () => {
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows('someone-7f3a91c4') } })
    expect(await ensure()).toEqual({ status: 'existed', message: '' })
    expect(fake.calls().some((c) => c.includes('start'))).toBe(false)
  })

  it('syncs BEFORE looking, so a grid another machine made is seen', async () => {
    const fake = fakeGrid({ version: VERSION_OK, sync: {}, ls: { stdout: rows('someone-7f3a91c4') } })
    await ensure()
    const order = fake.calls().map((c) => c.find((a) => a !== '--remote'))
    expect(order.indexOf('sync')).toBeLessThan(order.indexOf('ls'))
  })

  it('adopts rather than duplicating when another machine won the create race', async () => {
    // The control plane rejects a duplicate name, and the refusal is prose — so this is resolved by
    // looking again, not by reading the error.
    const fake = fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: [{ stdout: rows() }, { stdout: rows('someone-7f3a91c4') }],
      start: { exit: 1, stderr: 'POST …/managed-networks failed (409): name already taken\n' },
    })
    expect(await ensure()).toEqual({ status: 'adopted', message: '' })
    expect(fake.calls().filter((c) => c.includes('sync')).length).toBe(2)
  })

  it('reports grid’s own words when the create really failed', async () => {
    fakeGrid({
      version: VERSION_OK,
      sync: {},
      ls: { stdout: rows() },
      start: { exit: 1, stderr: 'the control plane is unreachable\n' },
    })
    const result = await ensure()
    expect(result.status).toBe('failed')
    expect(result.message).toContain('control plane is unreachable')
  })

  it('skips, without touching the grid, when the binary is older than the floor', async () => {
    const fake = fakeGrid({ version: { stdout: 'grid 0.3.34\n' } })
    const result = await ensure()
    expect(result.status).toBe('skipped')
    expect(result.message).toContain('0.3.36')
    expect(fake.calls().some((c) => c.includes('start'))).toBe(false)
  })

  it('skips when there is no grid at all, and never throws', async () => {
    process.env.HARNESS_GRID_BIN = join(tmpdir(), 'definitely-not-a-grid-binary')
    const result = await ensure()
    expect(result.status).toBe('skipped')
  })

  it('refuses an empty name rather than creating a grid called nothing', async () => {
    fakeGrid({ version: VERSION_OK })
    expect((await ensure('   ')).status).toBe('skipped')
  })
})
