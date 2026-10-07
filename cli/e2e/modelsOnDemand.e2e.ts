/**
 * Models' process on demand (core/modelsWake.ts, harnessd/services.ts `models`), on the real daemon, signed out:
 * a computer that uses no grid runs no models' process, about 70 MiB it never pays, and the first request that
 * needs models starts it, waits for it and is answered by it.
 * - Idle with no grid: no process, while the others run.
 * - A models request (the saved APIs, the picker's list, the Codex profiles): the first starts it, those that
 *   come while it starts wait with it, in order, and are answered by it; killed, it comes back.
 * - Grid in use here (a managed grid, saved grid pictures, local models): asked for as the core starts.
 * - Named in `HARNESSD_SERVICES` (tests, support), it starts with the daemon, as before.
 * A core too old to ask has it started as it binds: e2e/reexec.e2e.ts, under a released core.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service models started/g)].length
const connections = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => line.includes('[services] models connected')).length
const pidsOf = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service models started \(pid (\d+)\)/g)].map((match) => Number(match[1]))

describe('models\' process, once grid is in use or asked for', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (opts: { env?: Record<string, string>; before?: (d: IsolatedDaemon) => void } = {}) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', ...opts.env } })
    daemon = d
    opts.before?.(d)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    // The others are up, and the core has had time to ask for anything it would ask for as it starts.
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    return d
  }

  it('runs no models\' process on a computer that uses no grid; its first request starts it, and the requests meanwhile wait with it', async () => {
    const d = await fresh()
    expect(starts(d), 'a models\' process on a computer that uses no grid').toBe(0)
    expect(d.log()).not.toContain('asking for models\' process')
    const window = await LocalClient.connect(d)
    // Three requests while it starts: each waits for it, and each is its answer, not SERVICE_UNAVAILABLE.
    const [apis, profiles, grid] = await Promise.all([
      window.request('api_connections', { action: 'list' }, 30_000),
      window.request('codex_profiles_list', {}, 30_000),
      window.request('grid_models_list', {}, 30_000),
    ])
    expect(apis.error, JSON.stringify(apis)).toBeUndefined()
    expect(apis).toHaveProperty('connections')
    expect(profiles.error, JSON.stringify(profiles)).toBeUndefined()
    expect(profiles).toHaveProperty('profiles')
    expect(grid.error, JSON.stringify(grid)).toBeUndefined()
    expect(starts(d)).toBe(1)
    expect(connections(d)).toBe(1)
    // Started, it stays: the next request is answered by the same process.
    expect((await window.request('codex_profiles_list', {}, 30_000)).error).toBeUndefined()
    expect(starts(d)).toBe(1)
    window.close()
  })

  it('killed once started, comes back, and is answered by again', async () => {
    const d = await fresh()
    const window = await LocalClient.connect(d)
    expect((await window.request('codex_profiles_list', {}, 30_000)).error).toBeUndefined()
    const [pid] = pidsOf(d)
    process.kill(pid, 'SIGKILL')
    await until('the master to start models again', () => d.log().includes('[harnessd] service models started (pid') && starts(d) >= 2 || null, 30_000, 200)
    await until('models to connect again', () => connections(d) >= 2 || null, 30_000, 200)
    expect((await window.request('codex_profiles_list', {}, 30_000)).error).toBeUndefined()
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  for (const [what, lay] of [
    ['a managed grid', (d: IsolatedDaemon) => { mkdirSync(d.env.ADAPTER_RUNTIME_DIR!, { recursive: true }); writeFileSync(join(d.env.ADAPTER_RUNTIME_DIR!, 'current-grid'), join(d.env.ADAPTER_RUNTIME_DIR!, 'grid-0', 'bin', 'grid')) }],
    ['local models', (d: IsolatedDaemon) => { mkdirSync(join(d.dataDir, 'local-models'), { recursive: true }); writeFileSync(join(d.dataDir, 'local-models', 'operations.json'), '[]') }],
  ] as const) {
    it(`asks for it as the core starts when grid is in use here: ${what}`, async () => {
      const d = await fresh({ before: lay })
      expect(d.log()).toContain(`[models] ${what}: asking for models' process`)
      await until('models to connect', () => connections(d) >= 1 || null, 30_000, 200)
      expect(starts(d)).toBe(1)
    })
  }

  it('named in HARNESSD_SERVICES, it starts with the daemon, with no grid', async () => {
    const d = await fresh({ env: { HARNESSD_SERVICES: 'search,models' } })
    await until('models to connect', () => connections(d) >= 1 || null, 30_000, 200)
    expect(d.log()).not.toContain('asking for models\' process')
  })
})
