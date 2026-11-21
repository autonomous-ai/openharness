/** The worker's store request must reuse successful discovery without making a reader hint native authority. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import { closeSqliteHandles } from '../../lib/sqliteBuiltin.js'
import * as sqlite from '../../lib/sqliteRead.js'
import * as homes from '../hermes/home.js'
import { STREAM_STORE, STREAM_VERSION } from '../worker/otherStreamProtocol.js'
import { otherStreamRequests } from './streamRequests.js'
import type { OtherStreams } from './streams.js'

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...args: string[]): void }
    close(): void
  }
}
const CORE = { owner: true, local: true }
let home: string, profile: string, otherProfile: string, previousHome: string
const id = (n = 0) => `20261116_100000_${n.toString(16).padStart(6, '0')}`
const reply = (location: string, discovered = location !== home) => ({
  version: STREAM_VERSION, answer: { store: homes.hermesDbPath(location), ...(discovered ? { home: location } : {}) },
})
let clock = 0

function edit(location: string, sql: string, ...params: string[]): void {
  mkdirSync(location, { recursive: true })
  const db = new DatabaseSync(homes.hermesDbPath(location))
  try { if (params.length) db.prepare(sql).run(...params); else db.exec(sql) } finally { db.close() }
}
function store(location: string, ids: string[] = []): void {
  edit(location, 'CREATE TABLE sessions (id TEXT PRIMARY KEY)')
  for (const sessionId of ids) edit(location, 'INSERT INTO sessions VALUES (?)', sessionId)
}
function setup() {
  const requests = otherStreamRequests({ streams: { onMade: () => {} } as unknown as OtherStreams })
  return {
    requests,
    read: (sessionId = id(), hermesHome?: string | null, signal?: AbortSignal) => requests[STREAM_STORE]({
      version: STREAM_VERSION, session: { engine: 'hermes', sessionId, hermesHome },
    }, CORE, signal),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  // Windows' default is under LOCALAPPDATA, outside vitest's throwaway HOME. Delete only this case's own folder.
  previousHome = env.HERMES_HOME
  home = mkdtempSync(join(tmpdir(), 'hermes-store-'))
  ;(env as { HERMES_HOME: string }).HERMES_HOME = home
  profile = join(home, 'profiles', 'one')
  otherProfile = join(home, 'profiles', 'two')
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  homes.forgetHermesHomes()
  store(home)
})
afterEach(() => {
  vi.restoreAllMocks()
  closeSqliteHandles()
  ;(env as { HERMES_HOME: string }).HERMES_HOME = previousHome
  homes.forgetHermesHomes()
  rmSync(home, { recursive: true, force: true })
})

describe('Hermes store lookup in the other engines worker', () => {
  it('reuses a successful default lookup for repeated null and omitted homes without another indexed read', async () => {
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    expect(await t.read()).toEqual(reply(home))
    expect(await t.read(id(), null)).toEqual(reply(home))
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledExactlyOnceWith(homes.hermesDbPath(home),
      'SELECT id FROM sessions WHERE id = ? LIMIT 1;', [id()], { maxBuffer: 1 << 16 })
  })

  it('keeps discoveries for different profile conversations separate', async () => {
    store(profile, [id(1)]); store(otherProfile, [id(2)])
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    expect(await t.read(id(1))).toEqual(reply(profile))
    expect(await t.read(id(2))).toEqual(reply(otherProfile))
    const discoveryReads = query.mock.calls.length
    expect(discoveryReads).toBe(5)
    expect(await t.read(id(2))).toEqual(reply(otherProfile))
    expect(await t.read(id(1))).toEqual(reply(profile))
    expect(query).toHaveBeenCalledTimes(discoveryReads)
  })

  it('omits a differently spelled default home on discovery and a memo hit', async () => {
    const spelling = `${home}/`
    const discover = vi.spyOn(homes, 'findHermesHomeForSession').mockResolvedValue(spelling)
    const t = setup()
    expect(await t.read()).toEqual(reply(spelling, false))
    expect(await t.read()).toEqual(reply(spelling, false))
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'unavailable'] as const)('retries a %s result instead of remembering its default fallback', async kind => {
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    if (kind === 'unavailable') query.mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const t = setup()
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(1)
    store(profile, [id()]); homes.forgetHermesHomes()
    expect(await t.read()).toEqual(reply(profile))
    expect(query).toHaveBeenCalledTimes(3)
    expect(await t.read()).toEqual(reply(profile))
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('reports a thrown lookup and lets the next request discover its actual home', async () => {
    const discover = vi.spyOn(homes, 'findHermesHomeForSession').mockRejectedValueOnce(new Error('private path'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup()
    expect(await t.read()).toEqual({ version: STREAM_VERSION, error: 'ENGINE_UNAVAILABLE' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('[engine-others] store lookup unavailable · Error')
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    expect(await t.read()).toEqual(reply(home))
    expect(await t.read()).toEqual(reply(home))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('always uses the explicit native home and never lets explicit profiles poison an implicit hint for the same ID', async () => {
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    store(profile, [id()]); store(otherProfile, [id()])
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    expect(await t.read(id(), profile)).toEqual(reply(profile, false))
    expect(await t.read(id(), otherProfile)).toEqual(reply(otherProfile, false))
    expect(query).not.toHaveBeenCalled()
    expect(await t.read()).toEqual(reply(home))
    expect(await t.read(id(), otherProfile)).toEqual(reply(otherProfile, false))
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('keeps hints within one handler lifetime', async () => {
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const first = setup(), second = setup()
    expect(await first.read()).toEqual(reply(home))
    expect(await first.read()).toEqual(reply(home))
    expect(await second.read()).toEqual(reply(home))
    expect(await second.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('expires from lookup start without refreshing on hits, then rediscovers a moved or deleted conversation', async () => {
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    store(profile)
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    expect(await t.read()).toEqual(reply(home))
    edit(home, 'DELETE FROM sessions WHERE id = ?', id())
    edit(profile, 'INSERT INTO sessions VALUES (?)', id())
    clock = 29_999
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(1)
    clock = 30_000
    expect(await t.read()).toEqual(reply(profile))
    expect(query).toHaveBeenCalledTimes(3)
    edit(profile, 'DELETE FROM sessions WHERE id = ?', id())
    clock = 60_000
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(5)
    // Deletion is a miss, so the same ID reappearing in the default store is found immediately.
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    expect(await t.read()).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(6)
  })

  it('bounds remembered conversations at 512 and evicts the oldest insertion despite a recent hit', async () => {
    // One transaction avoids doing 513 durable fixture writes just to exercise request admission.
    edit(home, `BEGIN; ${Array.from({ length: 513 }, (_, n) => `INSERT INTO sessions VALUES ('${id(n)}');`).join('')} COMMIT;`)
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    for (let n = 0; n < 512; n++) expect(await t.read(id(n))).toEqual(reply(home))
    expect(await t.read(id(0))).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(512)
    expect(await t.read(id(512))).toEqual(reply(home))
    expect(await t.read(id(1))).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(513)
    expect(await t.read(id(0))).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(514)
  })

  it('evicts within the 1 MiB string budget before the entry limit on long platform-valid paths', async () => {
    // These protocol-sized paths need no actual filesystem leaf; the query-count tests above use real stores.
    const longHome = join(home, 'long').padEnd(32_740, 'x')
    const discover = vi.spyOn(homes, 'findHermesHomeForSession').mockResolvedValue(longHome)
    const t = setup()
    for (let n = 0; n < 16; n++) expect(await t.read(id(n))).toEqual(reply(longHome))
    expect(await t.read(id(0))).toEqual(reply(longHome))
    expect(discover).toHaveBeenCalledTimes(16)
    expect(await t.read(id(16))).toEqual(reply(longHome))
    expect(await t.read(id(1))).toEqual(reply(longHome))
    expect(discover).toHaveBeenCalledTimes(17)
    expect(await t.read(id(0))).toEqual(reply(longHome))
    expect(discover).toHaveBeenCalledTimes(18)
  })

  it('does not remember an out-of-protocol discovery result', async () => {
    const oversized = join(home, 'long').padEnd(32_769, 'x')
    const discover = vi.spyOn(homes, 'findHermesHomeForSession').mockResolvedValue(oversized)
    const t = setup()
    expect(await t.read()).toEqual(reply(oversized))
    expect(await t.read()).toEqual(reply(oversized))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('lets concurrent misses finish independently without a later reply overwriting the first remembered success', async () => {
    const old = deferred<string>(), fresh = deferred<string>()
    const oldStarted = deferred<void>(), freshStarted = deferred<void>()
    const discover = vi.spyOn(homes, 'findHermesHomeForSession')
      .mockImplementationOnce(() => { oldStarted.resolve(); return old.promise })
      .mockImplementationOnce(() => { freshStarted.resolve(); return fresh.promise })
      .mockResolvedValue(otherProfile)
    const t = setup()
    const first = t.read(); await oldStarted.promise
    const second = t.read(); await freshStarted.promise
    fresh.resolve(profile)
    expect(await second).toEqual(reply(profile))
    old.resolve(home)
    expect(await first).toEqual(reply(home))
    expect(await t.read()).toEqual(reply(profile))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it.each(['expired', 'aborted'] as const)('does not remember an %s in-flight lookup', async kind => {
    const work = deferred<string>(), started = deferred<void>()
    const discover = vi.spyOn(homes, 'findHermesHomeForSession')
      .mockImplementationOnce(() => { started.resolve(); return work.promise }).mockResolvedValue(profile)
    const t = setup(), controller = new AbortController()
    const first = t.read(id(), null, controller.signal); await started.promise
    if (kind === 'expired') clock = 30_000
    else controller.abort()
    work.resolve(home)
    expect(await first).toEqual(reply(home))
    expect(await t.read()).toEqual(reply(profile))
    expect(await t.read()).toEqual(reply(profile))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('does not let an implicit lookup arriving after an explicit request change that request or later explicit reads', async () => {
    const work = deferred<string>(), started = deferred<void>()
    const discover = vi.spyOn(homes, 'findHermesHomeForSession').mockImplementation(() => { started.resolve(); return work.promise })
    const t = setup()
    const first = t.read(); await started.promise
    expect(await t.read(id(), profile)).toEqual(reply(profile, false))
    work.resolve(home)
    expect(await first).toEqual(reply(home))
    expect(await t.read(id(), profile)).toEqual(reply(profile, false))
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('checks the caller and fields before discovery or a cached reply, and never queries invalid Hermes IDs', async () => {
    edit(home, 'INSERT INTO sessions VALUES (?)', id())
    const query = vi.spyOn(sqlite, 'sqliteReadAll')
    const t = setup()
    expect(await t.read()).toEqual(reply(home))
    const payload = { version: STREAM_VERSION, session: { engine: 'hermes', sessionId: id() } }
    for (const who of [{ ...CORE, owner: false }, { ...CORE, local: false }, { ...CORE, connection: 'client' }]) {
      expect(await t.requests[STREAM_STORE](payload, who)).toEqual({ version: STREAM_VERSION, error: 'ENGINE_INVALID_REQUEST' })
    }
    for (const session of [{ ...payload.session, sessionId: 'x'.repeat(201) }, { ...payload.session, hermesHome: 'relative' },
      { ...payload.session, pid: -1 }, { ...payload.session, engine: 'claude' }]) {
      expect(await t.requests[STREAM_STORE]({ ...payload, session }, CORE)).toEqual({ version: STREAM_VERSION, error: 'ENGINE_INVALID_REQUEST' })
    }
    expect(await t.read('unknown')).toEqual(reply(home))
    expect(await t.read('unknown')).toEqual(reply(home))
    expect(query).toHaveBeenCalledTimes(1)
  })
})
