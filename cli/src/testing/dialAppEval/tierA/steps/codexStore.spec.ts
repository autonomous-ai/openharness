// codex.write on a fake world: a Codex home in a temp folder, read back with the devices' own reader. No ~/.codex.
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAppThreads, type CodexAppRead } from '../../../../cable/hosts/codexAppThreads.js'
import { builtinSqlite } from '../../../../lib/sqliteBuiltin.js'
import { codexAppFixture } from '../../../codexAppFixture.js'
import { chatgptGhost, scenario, thread } from '../../catalog.js'
import type { SessionDef, SessionKey, StepOf } from '../../types.js'
import { EVAL_EPOCH } from '../clock.js'
import type { TierAWorld } from '../world.js'
import { codexStoreSteps } from './codexStore.js'

let root: string
/** What a step held open, closed as its world closes: before the world's folder goes. */
let closing: Array<() => void>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-store-'))
  closing = []
  vi.useFakeTimers({ now: EVAL_EPOCH, toFake: ['Date'] })
})
afterEach(() => {
  for (const close of closing.splice(0)) close()
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

/** The parts of a world codex.write uses, and the files it told the store's watch of. */
function fakeWorld(sessions: SessionDef[]): { world: TierAWorld; changed: string[] } {
  const s = scenario({ id: 'T', app: 'chatgpt', title: 'Eval test', dims: ['D1'], sessions, steps: [], checks: [], probes: [] })
  const changed: string[] = []
  const world = {
    scenario: s,
    codexHome: codexAppFixture(join(root, '.codex')),
    session: (key: SessionKey) => s.sessions.find((d) => d.key === key)!,
    storeChanged: (path: string) => { changed.push(path) },
    onClose: (close: () => void) => { closing.push(close) },
  } as Partial<TierAWorld> as TierAWorld
  return { world, changed }
}

const write = (world: TierAWorld, step: Omit<StepOf<'codex.write'>, 'kind'>) =>
  codexStoreSteps['codex.write'](world, { kind: 'codex.write', ...step })

async function read(world: TierAWorld): Promise<Extract<CodexAppRead, { ok: true }>> {
  const result = await new CodexAppThreads(world.codexHome.home).read()
  if (!result.ok) throw new Error(`the read failed: ${result.kind}`)
  return result
}

/** Each row's source and archived flag, as the store holds them. */
function rows(world: TierAWorld): Record<string, { source: unknown; archived: unknown }> {
  const db = new (builtinSqlite()!)(join(world.codexHome.home, 'state_5.sqlite'), { readOnly: true })
  try {
    return Object.fromEntries(db.prepare('SELECT id, source, archived FROM threads').all()
      .map((row) => [row.id as string, { source: row.source, archived: row.archived }]))
  } finally {
    db.close()
  }
}

const id = (world: TierAWorld, key: SessionKey) => world.session(key).id

describe('codex.write', () => {
  it('writes the threads, the sidebar\'s projects and Codex\'s names, then tells the watch each file', async () => {
    const { world, changed } = fakeWorld([
      thread('t1', 30_000, { project: 'p1' }), thread('t2', 10_000), thread('c1', 20_000, { cli: true }), chatgptGhost,
    ])
    await write(world, { sessions: ['t1', 't2', 'c1'], projects: ['p1'] })
    const home = world.codexHome.home
    expect(changed).toEqual([join(home, 'state_5.sqlite'), join(home, '.codex-global-state.json'), join(home, 'session_index.jsonl')])
    const listed = (await read(world)).listed
    // The project's thread first, then Recent newest first, each last active its age ago, by Codex's name.
    expect(listed.map((t) => [t.id, t.name, t.at, t.inProject])).toEqual([
      [id(world, 't1'), 'Eval T1', EVAL_EPOCH - 30_000, true],
      [id(world, 't2'), 'Eval T2', EVAL_EPOCH - 10_000, false],
      [id(world, 'c1'), 'Eval C1', EVAL_EPOCH - 20_000, false],
    ])
    expect(rows(world)[id(world, 'c1')]!.source).toBe('cli')
    expect(rows(world)[id(world, 't1')]!.source).toBe('vscode')
    expect(rows(world)[chatgptGhost.id]).toBeUndefined()

    // A rename alone (XH1): Codex's name changes for a thread the write lists no row of, and only the index is written.
    changed.length = 0
    await write(world, { sessions: [], names: { t1: 'Eval Renamed' } })
    expect(changed).toEqual([join(home, 'session_index.jsonl')])
    expect((await read(world)).listed.find((t) => t.id === id(world, 't1'))!.name).toBe('Eval Renamed')

    // A later write of the row keeps the name Codex gave it.
    await write(world, { sessions: ['t1'] })
    expect((await read(world)).listed.find((t) => t.id === id(world, 't1'))!.name).toBe('Eval Renamed')
  })

  it('archived and ages rewrite those rows', async () => {
    const { world } = fakeWorld([...['t1', 't2', 't3'].map((key, i) => thread(key, (i + 1) * 60_000)), chatgptGhost])
    await write(world, { sessions: ['t1', 't2', 't3'] })
    vi.advanceTimersByTime(5_000)
    await write(world, { sessions: ['t2', 't3'], archived: ['t2'], ages: { t3: 1_000 } })
    expect((await read(world)).listed.map((t) => [t.id, t.at])).toEqual([
      [id(world, 't3'), EVAL_EPOCH + 5_000 - 1_000],
      [id(world, 't1'), EVAL_EPOCH - 60_000],
    ])
    expect(rows(world)[id(world, 't2')]!.archived).toBe(1)
  })

  it('walBusy keeps a write open in the WAL until the world closes', async () => {
    const { world, changed } = fakeWorld([thread('t1', 60_000), thread('t2', 120_000), chatgptGhost])
    const store = join(root, '.codex', 'state_5.sqlite')
    await write(world, { sessions: ['t1', 't2'], walBusy: true })
    expect(statSync(`${store}-wal`).size).toBeGreaterThan(0)
    expect(changed).toContain(`${store}-wal`)
    expect((await read(world)).order).toEqual([id(world, 't1'), id(world, 't2')])
    expect(existsSync(`${store}-wal`)).toBe(true)
    // The world closes: the app's writer lets the WAL go, the store kept.
    for (const close of closing.splice(0)) close()
    expect(existsSync(store)).toBe(true)
    expect(existsSync(`${store}-wal`)).toBe(false)
  })
})
