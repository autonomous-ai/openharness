import { describe, expect, it, vi } from 'vitest'
import { reconcileGridAttach, createGridAccess, setUpWithin, type GridAttachDeps, type GridAttachResult } from './gridAttach.js'
import type { GridHandoffResult } from './gridHandoff.js'
import type { EnsureResult } from './gridEnsure.js'

const NAME = 'someone-7f3a91c4'
const EMAIL = 'someone@autonomous.ai'

const OK_HANDOFF: GridHandoffResult = { code: 'OK', exitCode: 0, message: '', stdout: '', stderr: '' }
const MISSING_HANDOFF: GridHandoffResult = {
  code: 'GRID_CLI_MISSING', exitCode: 1, message: 'no grid', stdout: '', stderr: '',
}
const EXISTED: EnsureResult = { status: 'existed', message: '' }
const CREATED: EnsureResult = { status: 'created', message: '' }

/** Deps with every seam a no-op success, so a test overrides only the one it is about. */
function deps(over: Partial<GridAttachDeps> = {}): GridAttachDeps & {
  handoff: ReturnType<typeof vi.fn>
  ensure: ReturnType<typeof vi.fn>
  onName: ReturnType<typeof vi.fn>
} {
  const base = {
    installCli: async () => {},
    gridAvailable: () => true,
    mintName: async () => NAME,
    accessToken: async () => 'tok',
    signedInEmail: () => EMAIL,
    gridNames: async () => [NAME],
    handoff: vi.fn(async () => OK_HANDOFF),
    ensure: vi.fn(async () => EXISTED),
    onName: vi.fn(),
    log: () => {},
  }
  return { ...base, ...over } as never
}

describe('reconcileGridAttach — bringing grid into line for a grid feature', () => {
  it('does nothing but publish the name when already signed in as the right account with the grid present', async () => {
    const d = deps()
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('converged')
    expect(r.name).toBe(NAME)
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('re-signs in and ensures when the account name is not known locally (never created, or not synced here)', async () => {
    // The name is not in the local `grid ls`, so the machine cannot be proven to be set up — it
    // (re)signs in as this account and ensures the grid rather than acting on a weaker guess.
    const d = deps({ gridNames: async () => [], ensure: vi.fn(async () => CREATED) })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledWith('tok')
    expect(d.ensure).toHaveBeenCalledWith(NAME)
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('does not false-positive across two accounts sharing an email local-part', async () => {
    // Signed in to grid as `someone@personal` (grid `someone-11112222`) while the harness account is
    // `someone@company` (minted `someone-7f3a91c4`). The names differ, so the local `grid ls` does
    // NOT contain the harness account's name — this must overwrite, not skip.
    const d = deps({ signedInEmail: () => 'someone@personal.example', gridNames: async () => ['someone-11112222'] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('hands the token over, then ensures, when this machine has no grid sign-in', async () => {
    const d = deps({ signedInEmail: () => null, gridNames: async () => [] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledWith('tok')
    expect(d.ensure).toHaveBeenCalledWith(NAME)
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('overwrites a different account: signed in as someone else means a hand-off', async () => {
    // The signed-in email's pattern does not match the account's minted name.
    const d = deps({ signedInEmail: () => 'other@elsewhere.io', gridNames: async () => ['other-11112222'] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('signs in again when the local grid list cannot be read — an unreadable registry is not "no grids"', async () => {
    const d = deps({ gridNames: async () => { throw new Error('grid ls exited 1') } })
    const r = await reconcileGridAttach(d)

    // It must NOT treat the failed read as proof of anything: the safe direction is to sign in
    // again, which rewrites the registry the next start reads.
    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('does nothing and reports no-cli when there is no grid binary', async () => {
    const d = deps({ gridAvailable: () => false, mintName: vi.fn() as never })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-cli')
    expect(d.onName).not.toHaveBeenCalled()
    expect((d.mintName as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('stops at no-name on an older backend that mints none, without touching grid', async () => {
    const d = deps({ mintName: async () => null })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-name')
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).not.toHaveBeenCalled()
  })

  it('stops at no-name when the control plane is unreachable — and will try again next start', async () => {
    const d = deps({ mintName: async () => { throw new Error('ECONNREFUSED') } })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-name')
    expect(r.detail).toContain('ECONNREFUSED')
    expect(d.handoff).not.toHaveBeenCalled()
  })

  it('reports handoff-failed without ensuring, leaving the harness sign-in untouched', async () => {
    const d = deps({ signedInEmail: () => null, handoff: vi.fn(async () => MISSING_HANDOFF) })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('handoff-failed')
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).not.toHaveBeenCalled()
  })

  it('installs grid before checking the binary', async () => {
    const order: string[] = []
    let releaseRuntime = (): void => {}
    const runtime = new Promise<void>((res) => { releaseRuntime = () => { order.push('runtime'); res() } })
    const d = deps({
      installCli: () => runtime,
      gridAvailable: () => { order.push('available'); return false },
    })

    const done = reconcileGridAttach(d)
    // The binary check must not have run before the runtime promise settled.
    await Promise.resolve()
    expect(order).toEqual([])
    releaseRuntime()
    await done
    expect(order).toEqual(['runtime', 'available'])
  })

  it('does not let a failed install throw — the binary check says what is missing', async () => {
    const d = deps({ installCli: async () => { throw new Error('download failed') }, gridAvailable: () => false })
    await expect(reconcileGridAttach(d)).resolves.toMatchObject({ status: 'no-cli' })
  })

  it("signs in without making a grid when the feature needs no grid of the account's own", async () => {
    const d = deps({ signedInEmail: () => null, gridNames: async () => [] })
    const r = await reconcileGridAttach(d, { ownGrid: false })
    expect(r).toMatchObject({ status: 'signed-in', name: NAME })
    expect(r).not.toHaveProperty('ownGrid')
    expect(d.handoff).toHaveBeenCalledWith('tok')
    expect(d.ensure).not.toHaveBeenCalled()
  })

  it('reports what making the own grid came to', async () => {
    const d = deps({ signedInEmail: () => null, gridNames: async () => [], ensure: vi.fn(async () => CREATED) })
    expect(await reconcileGridAttach(d, { ownGrid: true })).toMatchObject({ status: 'signed-in', ownGrid: 'created' })
    expect(await reconcileGridAttach(deps(), { ownGrid: true })).toMatchObject({ status: 'converged', ownGrid: 'existed' })
  })

  it('signed in earlier this run: a feature with no own grid to make needs nothing more', async () => {
    // No own grid yet, so the gate cannot prove the account — the earlier sign-in this run does.
    const d = deps({ gridNames: async () => [] })
    expect(await reconcileGridAttach(d, { ownGrid: false, signedInThisRun: true })).toMatchObject({ status: 'converged' })
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).not.toHaveBeenCalled()
  })

  it('signed in earlier this run and now the own grid is wanted: made, without a second hand-off', async () => {
    // Every hand-off rotates the account's grid token; one per sign-in is the whole budget.
    const d = deps({ gridNames: async () => [], ensure: vi.fn(async () => CREATED) })
    expect(await reconcileGridAttach(d, { ownGrid: true, signedInThisRun: true })).toMatchObject({ status: 'signed-in', ownGrid: 'created' })
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })
})

/**
 * The coordination half: when a reconcile runs — on demand, one at a time, never twice for what is
 * already done, and never as a remembered failure.
 */
describe('createGridAccess — grid set up when a feature asks', () => {
  const result = (status: GridAttachResult['status'], ownGrid?: GridAttachResult['ownGrid']): GridAttachResult =>
    ({ status, name: NAME, detail: '', ...(ownGrid ? { ownGrid } : {}) })

  function access(answers: GridAttachResult[], signedIn = () => true) {
    const attempt = vi.fn(async (_request: { ownGrid: boolean; signedInThisRun: boolean }) => answers.shift() ?? result('converged', 'existed'))
    return { attempt, grid: createGridAccess({ attempt, signedIn, log: () => {} }) }
  }

  it('remembers a sign-in: asking again for the same costs nothing', async () => {
    const { attempt, grid } = access([result('signed-in')])
    await grid.ensure()
    await grid.ensure()
    expect(attempt.mock.calls).toEqual([[{ ownGrid: false, signedInThisRun: false }]])
  })

  it('asks again for the own grid, telling the reconcile this run is already signed in', async () => {
    const { attempt, grid } = access([result('signed-in'), result('signed-in', 'created')])
    await grid.ensure({ ownGrid: false })
    await grid.ensure({ ownGrid: true })
    await grid.ensure({ ownGrid: true })
    expect(attempt.mock.calls).toEqual([
      [{ ownGrid: false, signedInThisRun: false }],
      [{ ownGrid: true, signedInThisRun: true }],
    ])
  })

  it('one at a time: a Set up and a Get pressed together make one sign-in', async () => {
    let finish: (r: GridAttachResult) => void = () => {}
    const attempt = vi.fn(() => new Promise<GridAttachResult>((resolve) => { finish = resolve }))
    const grid = createGridAccess({ attempt, signedIn: () => true, log: () => {} })
    const first = grid.ensure({ ownGrid: true })
    const second = grid.ensure({ ownGrid: false })
    await Promise.resolve()
    finish(result('signed-in', 'created'))
    expect((await first).status).toBe('signed-in')
    expect((await second).status).toBe('signed-in')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failure: the next ask is a person acting again, so it tries again', async () => {
    const { attempt, grid } = access([result('handoff-failed'), result('signed-in')])
    expect((await grid.ensure()).status).toBe('handoff-failed')
    expect((await grid.ensure()).status).toBe('signed-in')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('an own grid that could not be made is asked for again next time', async () => {
    const { attempt, grid } = access([result('signed-in', 'failed'), result('signed-in', 'created')])
    expect((await grid.ensure({ ownGrid: true })).ownGrid).toBe('failed')
    expect((await grid.ensure({ ownGrid: true })).ownGrid).toBe('created')
    expect(attempt.mock.calls[1]).toEqual([{ ownGrid: true, signedInThisRun: true }])
  })

  it('forgets everything once grid holds no sign-in — a `grid logout` run by hand', async () => {
    let signedIn = true
    const { attempt, grid } = access([result('signed-in', 'created'), result('signed-in', 'existed')], () => signedIn)
    await grid.ensure({ ownGrid: true })
    signedIn = false
    await grid.ensure({ ownGrid: true })
    expect(attempt.mock.calls).toEqual([
      [{ ownGrid: true, signedInThisRun: false }],
      [{ ownGrid: true, signedInThisRun: false }],
    ])
  })

  it('an attempt that throws resolves as a failed hand-off — it never rejects on the caller', async () => {
    const grid = createGridAccess({ attempt: async () => { throw new Error('boom') }, signedIn: () => true, log: () => {} })
    await expect(grid.ensure()).resolves.toMatchObject({ status: 'handoff-failed', detail: 'boom' })
  })
})

describe('setUpWithin: a set-up a create waits for, but not for long', () => {
  it('answers done once a quick set-up lands', async () => {
    await expect(setUpWithin(async () => ({ status: 'converged' }), 1_000)).resolves.toBe('done')
  })

  it('stops waiting at the bound and leaves the set-up running', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const running = new Promise<void>((resolve) => { finish = resolve })
      let landed = false
      const waited = setUpWithin(() => running.then(() => { landed = true }), 8_000)
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(waited).resolves.toBe('pending')
      finish()
      await running
      await Promise.resolve()
      expect(landed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never throws: a failed set-up is for the next use of grid to say', async () => {
    await expect(setUpWithin(async () => { throw new Error('offline') }, 1_000)).resolves.toBe('done')
  })
})
