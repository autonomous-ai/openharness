/**
 * The model list against a fake relay and a fake `grid` first on PATH — the seam a desktop, an old
 * desktop and the Model Manager all read through (grid-reads-without-waking issue 02).
 *
 * Every assertion is on what leaves the seam: the sections a picker is given, and the requests that
 * reached the relay (method, path, headers), recorded by the relay itself. The clock is the service's
 * own injected `now`, so the 15s / 120s / 150s rules are exercised without waiting for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeGrid, type FakeGrid, type FakeGridPlan, type FakeGridTurn } from './__fixtures__/fakeGrid.js'
import { forgetGridModels, gridInventory, listAllGridModels, listGridModels, resetGridModels, type GridModelsService, type GridSection } from './gridModels.js'

const OWN = 'mine', OWN_ID = 'net-own', TEAM = 'team', TEAM_ID = 'net-team'
const EMAIL = 'me@example.com'
const OVERVIEW = '/relay/v1/grid/overview', DISCOVER = '/nodes/discover'

interface Seen { method: string; path: string; headers: IncomingHttpHeaders }
interface Answer { status: number; body?: unknown; delayMs?: number }

let server: Server, base: string, seen: Seen[], answers: Map<string, Answer>
let root: string, gridHome: string, grid: FakeGrid, service: GridModelsService, clock: number

const answer = (gridId: string, path: string, value: Answer): void => { answers.set(`/g/${gridId}${path}`, value) }
const node = (name: string, models: string[], extra: Record<string, unknown> = {}) =>
  ({ name, engine: 'llama.cpp', models, online: true, provider_email: EMAIL, ...extra })
const awake = (nodes: unknown[], curated: string[] = []): Answer => ({ status: 200, body: { nodes, models: curated.map((id) => ({ id })) } })
const asleep = (lastKnown?: unknown): Answer =>
  ({ status: 503, body: { detail: 'resting', code: 'grid_asleep', ...(lastKnown === undefined ? {} : { last_known: lastKnown }) } })
const record = (ageSeconds: number, nodes: Array<{ name: string; models: string[] }>, ids: string[] = []) =>
  ({ age_seconds: ageSeconds, nodes: nodes.map((n) => ({ engine: 'llama.cpp', ...n })), ids })

/** A grid's `grid info --json`, as the public CLI prints it (a member sees no status). */
const info = (name: string, status: string | null, url: string): FakeGridTurn =>
  ({ stdout: JSON.stringify({ grid: name, type: '', status, grid_url: url }) })

function plan(options: { grids?: 'own' | 'both'; ownStatus?: string | null; ownUrl?: string; teamUrl?: string; models?: FakeGridTurn } = {}): FakeGridPlan {
  const rows = [{ grid: OWN, id: OWN_ID, type: 'permissioned-public' }]
  if (options.grids !== 'own') rows.push({ grid: TEAM, id: TEAM_ID, type: 'permissioned-providers' })
  return {
    ls: { stdout: JSON.stringify(rows) },
    [`info ${OWN}`]: info(OWN, options.ownStatus === undefined ? 'running' : options.ownStatus, options.ownUrl ?? `${base}/g/${OWN_ID}`),
    [`info ${TEAM}`]: info(TEAM, null, options.teamUrl ?? `${base}/g/${TEAM_ID}`),
    ...(options.models ? { models: options.models } : {}),
  }
}

const reads = (gridId: string, path = OVERVIEW): number => seen.filter((r) => r.path === `/g/${gridId}${path}`).length
const section = (sections: GridSection[], name: string): GridSection => sections.find((s) => s.name === name)!
const ids = (s: GridSection): string[] => s.models.map((m) => m.id)

/** Ask as a picker does, then let every read it started land, then ask again for what they produced. */
async function look(own: string | null = OWN): Promise<GridSection[]> {
  await listAllGridModels(own)
  await service.settled()
  return listAllGridModels(own, { refresh: false })
}

/** Move the clock past every memo a read could be sitting in. */
const later = (seconds = 125): void => { clock += seconds * 1000 }

/** A run record `grid join` writes for this computer on grid `gridId`. */
function runRecord(gridId: string, file: string, fields: Record<string, unknown>): void {
  const dir = join(gridHome, 'run', 'engines', gridId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify({ engines: [], advertise_as: [], ...fields }))
}
const removeRecord = (gridId: string, file: string): void => rmSync(join(gridHome, 'run', 'engines', gridId, file), { force: true })

/** A pid that existed a moment ago and no longer does. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

beforeEach(async () => {
  seen = []
  answers = new Map()
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    const found = answers.get(req.url ?? '') ?? { status: 404, body: { detail: 'Not Found' } }
    setTimeout(() => {
      res.writeHead(found.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(found.body ?? {}))
    }, found.delayMs ?? 0)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  root = mkdtempSync(join(tmpdir(), 'grid-reads-'))
  gridHome = join(root, 'grid-home')
  mkdirSync(gridHome, { recursive: true })
  clock = Date.parse('2026-09-24T10:00:00Z')
  service = resetGridModels({ now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => EMAIL })
  grid = installFakeGrid(plan())
})

afterEach(async () => {
  await service.settled()
  grid.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('no automatic read carries a credential', () => {
  it('the model list, the Model Manager and a launch check read with no Authorization and no x-api-key', async () => {
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'], { provider_email: 'teammate@example.com' })]))
    answer(TEAM_ID, DISCOVER, { status: 200, body: { providers: [] } })

    await look()
    await gridInventory(OWN, true)
    forgetGridModels()
    await listGridModels(TEAM)

    expect(seen.length).toBeGreaterThanOrEqual(4)
    for (const request of seen) {
      expect(request.method).toBe('GET')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['x-api-key']).toBeUndefined()
      expect(request.headers['user-agent']).toMatch(/^autonomous-harness\/\S+ \(read\)$/)
    }
    // The credentialed model-list read is gone, and so is the only place its credential came from.
    expect(seen.some((r) => r.path.endsWith('/relay/v1/models'))).toBe(false)
    expect(grid.calls().some((argv) => argv.includes('--env'))).toBe(false)
  })

  it('parsing a sleep record sends nothing of its own', async () => {
    grid.replan(plan({ grids: 'own' }))
    answer(OWN_ID, OVERVIEW, asleep(record(3600, [{ name: 'mac', models: ['small-q4'] }], ['Small-Q4'])))

    const sections = await look()

    expect(seen.map((r) => r.path)).toEqual([`/g/${OWN_ID}${OVERVIEW}`])
    expect(section(sections, OWN)).toMatchObject({ state: 'asleep', models: [{ id: 'Small-Q4', node: 'mac' }], lastKnownAge: 3600 })
  })
})

describe('what an answer means', () => {
  it('a 200 reads awake, and a 503 whose code is grid_asleep reads asleep', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])], ['Big-Model']))
    expect(section(await look(), TEAM)).toMatchObject({ state: 'awake', models: [{ id: 'Big-Model', node: 'rig' }], lastKnownAge: 0 })
    later()
    answer(TEAM_ID, OVERVIEW, asleep())
    expect(section(await look(), TEAM)).toMatchObject({ state: 'asleep', models: [{ id: 'Big-Model', node: 'rig' }] })
  })

  it.each<[string, Answer]>([
    ['a codeless 503', { status: 503, body: { detail: 'upstream unavailable' } }],
    ['grid_stopped', { status: 503, body: { detail: 'stopped by its owner', code: 'grid_stopped' } }],
    ['grid_master_down', { status: 503, body: { detail: 'master down', code: 'grid_master_down' } }],
    ['a 410', { status: 410, body: { detail: 'deleted', code: 'grid_deleted' } }],
    ['an asleep code on a 200', { status: 200, body: { code: 'grid_asleep' } }],
    ['a 200 that is not JSON', { status: 200, body: undefined }],
  ])('%s reads "not answering" and keeps the last known list', async (_name, failure) => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])], ['Big-Model']))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, failure.body === undefined ? { status: 200, body: 'not an overview' } : failure)

    expect(section(await look(), TEAM)).toMatchObject({ state: 'unknown', models: [{ id: 'Big-Model', node: 'rig' }] })
  })

  it('a refused connection reads "not answering", keeps the list, and falls back to `grid` once, with --no-wake', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])], ['Big-Model']))
    await look()
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const refused = `http://127.0.0.1:${(closed.address() as { port: number }).port}`
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    grid.replan(plan({ teamUrl: refused, models: { exit: 1, stderr: 'Could not reach grid team\n' } }))
    forgetGridModels()

    expect(section(await look(), TEAM)).toMatchObject({ state: 'unknown', models: [{ id: 'Big-Model', node: 'rig' }] })
    expect(grid.calls().filter((argv) => argv.includes('models'))).toEqual([['--remote', 'models', TEAM, '--no-wake', '--json']])
  })

  it('the fallback reads asleep when `grid` refuses with the grid_asleep code, and awake from its rows', async () => {
    grid.replan(plan({ grids: 'own', ownUrl: 'ftp://nowhere.example', models: { exit: 1, stderr: `${JSON.stringify({ error: { code: 'grid_asleep', message: 'asleep', status: 503 } })}\n` } }))
    expect(section(await look(), OWN).state).toBe('asleep')

    grid.replan(plan({ grids: 'own', ownUrl: 'ftp://nowhere.example', models: { stdout: JSON.stringify([
      { model: 'auto', engine: 'grid-router', node: '' }, { model: 'Small-Q4', engine: 'llama.cpp', node: 'mac' },
    ]) } }))
    forgetGridModels()
    later()
    expect(section(await look(), OWN)).toMatchObject({ state: 'awake', models: [{ id: 'Small-Q4', node: 'mac' }] })
    expect(seen).toEqual([])
  })

  it('a `grid` too old for --no-wake yields no read, and is never asked again without the flag', async () => {
    grid.replan(plan({ grids: 'own', ownUrl: 'ftp://nowhere.example', models: { exit: 2, stderr: 'grid: error: unrecognized arguments: --no-wake\n' } }))

    expect(section(await look(), OWN)).toMatchObject({ state: 'unknown', models: [] })
    later(); forgetGridModels()
    await look()

    const asked = grid.calls().filter((argv) => argv.includes('models'))
    expect(asked).toHaveLength(2)
    expect(asked.every((argv) => argv.includes('--no-wake'))).toBe(true)
    expect(seen).toEqual([])
  })
})

describe('the own grid while its owner status says asleep', () => {
  it('is read exactly once per asleep episode, and not again until the status changes', async () => {
    grid.replan(plan({ grids: 'own', ownStatus: 'asleep' }))
    answer(OWN_ID, OVERVIEW, asleep(record(600, [{ name: 'mac', models: ['small-q4'] }])))

    expect(section(await look(), OWN).state).toBe('asleep')
    for (let i = 0; i < 6; i++) { later(); await look() }
    expect(reads(OWN_ID)).toBe(1)

    grid.replan(plan({ grids: 'own', ownStatus: 'running' }))
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    later()
    expect(section(await look(), OWN).state).toBe('awake')
    expect(reads(OWN_ID)).toBe(2)

    grid.replan(plan({ grids: 'own', ownStatus: 'asleep' }))
    answer(OWN_ID, OVERVIEW, asleep())
    later(); await look()
    for (let i = 0; i < 4; i++) { later(); await look() }
    expect(reads(OWN_ID)).toBe(3)
  })

  it('a launch check during the episode makes no read of its own, and does not restart the episode', async () => {
    grid.replan(plan({ grids: 'own', ownStatus: 'asleep' }))
    answer(OWN_ID, OVERVIEW, asleep(record(600, [{ name: 'mac', models: ['small-q4'] }], ['Small-Q4'])))
    await look()

    later()
    expect(await listGridModels(OWN)).toEqual([{ id: 'Small-Q4', node: 'mac' }])
    later(); await look()
    expect(reads(OWN_ID)).toBe(1)
  })

  it('a member grid, whose status nobody but its owner can read, is read on its own memo', async () => {
    answer(TEAM_ID, OVERVIEW, asleep())
    await look()
    later(60); await look()
    expect(reads(TEAM_ID)).toBe(1)
    later(61); await look()
    expect(reads(TEAM_ID)).toBe(2)
  })
})

describe('exact case', () => {
  it('comes from the curated ids, this computer\'s run records and discovery — .gguf stripped, case kept', async () => {
    grid.replan(plan({ grids: 'own' }))
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4', 'qwen3.6-35b-a3b', 'glm-4.7-flash'])], ['GLM-4.7-Flash']))
    answer(OWN_ID, DISCOVER, { status: 200, body: { providers: [
      { models: ['provider:a'], capabilities: { models: { 'provider:a': { raw_model_id: 'Qwen3.6-35B-A3B.GGUF' } } } },
    ] } })

    expect(ids(section(await look(), OWN))).toEqual(['Small-Q4', 'Qwen3.6-35B-A3B', 'GLM-4.7-Flash'])
    later(20); await look()
    expect(reads(OWN_ID, DISCOVER)).toBe(1)
  })

  it('is never replaced by a lower-case form, and discovery is not asked when every id is spelled', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['glm-4.7-flash'])], ['GLM-4.7-Flash']))
    await look()
    later()
    answer(TEAM_ID, OVERVIEW, asleep(record(10, [{ name: 'rig', models: ['glm-4.7-flash'] }], ['glm-4.7-flash'])))

    expect(ids(section(await look(), TEAM))).toEqual(['GLM-4.7-Flash'])
    expect(reads(TEAM_ID, DISCOVER)).toBe(0)
  })
})

describe('the picture', () => {
  it('a cold wake that answers empty blanks nothing; a model leaves after 150s across two awake reads', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model', 'small-model'])]))
    await look()
    clock += 3 * 3600_000
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['small-model'])]))

    expect(ids(section(await look(), TEAM))).toEqual(['small-model', 'big-model'])
    later(20); expect(ids(section(await look(), TEAM))).toEqual(['small-model', 'big-model'])
    later(20); expect(ids(section(await look(), TEAM))).toEqual(['small-model', 'big-model'])
    later(111); expect(ids(section(await look(), TEAM))).toEqual(['small-model'])
  })

  it('the 150s run from the first answer that missed a model, not from when it was last seen', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later(600)
    answer(TEAM_ID, OVERVIEW, awake([]))
    expect(ids(section(await look(), TEAM))).toEqual(['big-model'])
    later(16)
    expect(ids(section(await look(), TEAM))).toEqual(['big-model'])
    later(134)
    expect(ids(section(await look(), TEAM))).toEqual([])
  })

  it('a sleep record older than the last awake read does not replace it; a newer one does', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    later(300)
    answer(TEAM_ID, OVERVIEW, asleep(record(400, [{ name: 'other', models: ['ghost'] }])))
    expect(ids(section(await look(), TEAM))).toEqual(['big-model'])

    later()
    answer(TEAM_ID, OVERVIEW, asleep(record(30, [{ name: 'other', models: ['fresh-model'] }])))
    expect(section(await look(), TEAM)).toMatchObject({ state: 'asleep', models: [{ id: 'fresh-model', node: 'other' }], lastKnownAge: 30 })
  })

  it('a record older than 29 days is ignored', async () => {
    answer(TEAM_ID, OVERVIEW, asleep(record(30 * 86400, [{ name: 'rig', models: ['ancient'] }])))
    expect(section(await look(), TEAM)).toMatchObject({ state: 'asleep', models: [], lastKnownAge: null })
    later()
    answer(TEAM_ID, OVERVIEW, asleep(record(28 * 86400, [{ name: 'rig', models: ['recent'] }])))
    expect(ids(section(await look(), TEAM))).toEqual(['recent'])
  })

  it('waits for the first read of a grid it has never seen only so long, and the read lands behind', async () => {
    service = resetGridModels({ now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => EMAIL, firstReadWaitMs: 50 })
    const changed: number[] = []
    service.onChange(() => changed.push(1))
    grid.replan(plan({ grids: 'own' }))
    answer(OWN_ID, OVERVIEW, { ...awake([node('mac', ['small-q4'])]), delayMs: 1_500 })

    // Answered before the read could land: nothing is known yet, and it says so — no clock is asserted,
    // so a loaded machine cannot turn this into a flake.
    const first = section(await listAllGridModels(OWN), OWN)
    expect(first).toMatchObject({ state: 'unknown', models: [], lastKnownAge: null })

    await service.settled()
    expect(section(await listAllGridModels(OWN, { refresh: false }), OWN)).toMatchObject({ state: 'awake', models: [{ id: 'small-q4', node: 'mac' }] })
    await vi.waitFor(() => expect(changed).toEqual([1]))
  })

  it('is answered at once from what was read before, even by a daemon that just started', async () => {
    answer(TEAM_ID, OVERVIEW, awake([node('rig', ['big-model'])]))
    await look()
    service = resetGridModels({ now: () => clock, dataDir: () => join(root, 'data'), gridHome: () => gridHome, email: () => EMAIL })
    answer(TEAM_ID, OVERVIEW, asleep())
    later()

    // The first answer is the persisted picture; the read it started lands behind it.
    expect(ids(section(await listAllGridModels(OWN), TEAM))).toEqual(['big-model'])
    await service.settled()
    expect(section(await listAllGridModels(OWN, { refresh: false }), TEAM).state).toBe('asleep')
  })
})

describe('this computer\'s own models while a grid is not awake (servedHere)', () => {
  /** The own grid read awake with `nodes`, then asleep with no record. */
  async function ownAwakeThenAsleep(nodes: unknown[]): Promise<void> {
    grid.replan(plan({ grids: 'own' }))
    answer(OWN_ID, OVERVIEW, awake(nodes))
    await look()
    later()
    answer(OWN_ID, OVERVIEW, asleep())
    await look()
  }

  it('shows a model this computer serves under its name, though the grid never listed it', async () => {
    grid.replan(plan({ grids: 'own' }))
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
    answer(OWN_ID, OVERVIEW, asleep())

    expect(section(await look(), OWN)).toMatchObject({ state: 'asleep', models: [{ id: 'Small-Q4', node: 'mac' }] })
  })

  it('takes a model paused on this computer out at once', async () => {
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, models: ['Small-Q4.gguf'] })
    await ownAwakeThenAsleep([node('mac', ['small-q4']), node('studio', ['big-model'])])
    removeRecord(OWN_ID, 'remote.json')

    expect(ids(section(await listAllGridModels(OWN, { refresh: false }), OWN))).toEqual(['big-model'])
  })

  it('takes it out at once when its process died, and while the grid is awake too', async () => {
    grid.replan(plan({ grids: 'own' }))
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
    answer(OWN_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
    await look()
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: deadPid(), advertise_as: ['Small-Q4'] })
    answer(OWN_ID, OVERVIEW, awake([]))
    later(20)

    expect(ids(section(await look(), OWN))).toEqual([])
  })

  it('a model served by two nodes survives the removal of one', async () => {
    runRecord(OWN_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
    await ownAwakeThenAsleep([node('mac', ['small-q4']), node('studio', ['small-q4'])])
    removeRecord(OWN_ID, 'remote.json')

    expect(section(await listAllGridModels(OWN, { refresh: false }), OWN).models).toEqual([{ id: 'Small-Q4', node: 'studio' }])
  })

  it.each<[string, () => Promise<void>]>([
    ['a teammate\'s same-named node on a shared grid', async () => {
      runRecord(TEAM_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
      answer(TEAM_ID, OVERVIEW, awake([node('mac', ['small-q4'], { provider_email: 'teammate@example.com' })]))
      await look()
      later()
      answer(TEAM_ID, OVERVIEW, asleep())
      await look()
      removeRecord(TEAM_ID, 'remote.json')
    }],
    ['an empty records directory', async () => {
      mkdirSync(join(gridHome, 'run', 'engines', TEAM_ID), { recursive: true })
      answer(TEAM_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
      await look()
      later()
      answer(TEAM_ID, OVERVIEW, asleep())
      await look()
    }],
    ['a pid-0 record (a join mid-spawn)', async () => {
      runRecord(TEAM_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
      answer(TEAM_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
      await look()
      later()
      answer(TEAM_ID, OVERVIEW, asleep())
      await look()
      runRecord(TEAM_ID, 'remote.json', { meta_name: 'mac', pid: 0, advertise_as: ['Small-Q4'] })
    }],
    ['a stale heartbeat sidecar beside a parked provider', async () => {
      runRecord(TEAM_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
      const sidecar = join(gridHome, 'run', 'engines', TEAM_ID, 'remote.heartbeat')
      writeFileSync(sidecar, '')
      utimesSync(sidecar, new Date(0), new Date(0))
      answer(TEAM_ID, OVERVIEW, awake([node('mac', ['small-q4'])]))
      await look()
      later()
      answer(TEAM_ID, OVERVIEW, asleep())
      await look()
    }],
    ['two same-named entries', async () => {
      runRecord(TEAM_ID, 'remote.json', { meta_name: 'mac', pid: process.pid, advertise_as: ['Small-Q4'] })
      answer(TEAM_ID, OVERVIEW, awake([node('mac', ['small-q4']), node('mac', ['small-q4'], { engine: 'vllm' })]))
      await look()
      later()
      answer(TEAM_ID, OVERVIEW, asleep())
      await look()
      removeRecord(TEAM_ID, 'remote.json')
    }],
  ])('removes nothing for %s', async (_name, arrange) => {
    await arrange()
    expect(ids(section(await listAllGridModels(OWN, { refresh: false }), TEAM)).map((id) => id.toLowerCase())).toEqual(['small-q4'])
  })
})

describe('the grid list', () => {
  it('never passes a name that reads as a flag, or carries a control character, to `grid`', async () => {
    grid.replan({ ...plan({ grids: 'own' }), ls: { stdout: JSON.stringify([
      { grid: OWN, id: OWN_ID, type: 'permissioned-public' }, { grid: '--json', id: 'x' }, { grid: 'a\nb', id: 'y' },
    ]) } })
    answer(OWN_ID, OVERVIEW, awake([]))

    expect((await look()).map((s) => s.name)).toEqual([OWN])
    expect(grid.calls().filter((argv) => argv[1] === 'info').map((argv) => argv[2])).toEqual([OWN])
  })
})

describe('what an older desktop reads', () => {
  it('every section stays a valid {name, own, models:[{id,node}]}, and a sleeping one keeps its models', async () => {
    answer(OWN_ID, OVERVIEW, asleep(record(60, [{ name: 'mac', models: ['small-q4'] }])))
    answer(TEAM_ID, OVERVIEW, { status: 503, body: { detail: 'down' } })

    const sections = await look()

    expect(sections.map((s) => [s.name, s.own])).toEqual([[OWN, true], [TEAM, false]])
    for (const s of sections) {
      expect(typeof s.name).toBe('string')
      expect(typeof s.own).toBe('boolean')
      for (const row of s.models) expect(Object.keys(row).sort()).toEqual(['id', 'node'])
    }
    expect(section(sections, OWN).models).toEqual([{ id: 'small-q4', node: 'mac' }])
  })
})
