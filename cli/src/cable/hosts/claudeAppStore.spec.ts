import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCOUNT, ORG, claudeAppFixture, type FixturePlace, type FixtureSession } from '../../testing/claudeAppFixture.js'
import { ClaudeAppStore, MAX_FILE_BYTES, type StoreRead } from './claudeAppStore.js'

/** A fixed mtime in ms: a whole second, so every mtime set from it reads back exactly. */
const T = 1_763_000_000_000
const pad = (n: number) => String(n).padStart(12, '0')
/** The n-th app's id and Claude Code id of a session, zero-padded so name order is number order. */
const local = (n: number) => `local_aaaaaaaa-0000-4000-8000-${pad(n)}`
const cli = (n: number) => `cccccccc-0000-4000-8000-${pad(n)}`
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const localIds = (read: StoreRead) => read.sessions.map((session) => session.localId)
const NOTHING: StoreRead = { sessions: [], parsed: 0, skipped: 0, over: 0, more: false }

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fixture store in a temp folder of its own, and a reader of it. */
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-app-store-'))
  made.push(dir)
  const root = join(dir, 'claude-code-sessions')
  mkdirSync(root)
  const fixture = claudeAppFixture(root)
  /** Writes the n-th session at `T - n * 1000`, its lastActivityAt the same, unless told otherwise. Its path. */
  const put = (n: number, over: Partial<FixtureSession> = {}, place: FixturePlace = {}) => fixture.write(
    { localId: local(n), cliSessionId: cli(n), cwd: `/work/p${n}`, lastActivityAt: T - n * 1000, ...over },
    { mtime: T - n * 1000, ...place },
  )
  /** Writes text of its own as the n-th session's file, at `T - n * 1000`. */
  const text = (n: number, body: string) => {
    const path = join(fixture.org(), `${local(n)}.json`)
    writeFileSync(path, body)
    utimesSync(path, (T - n * 1000) / 1000, (T - n * 1000) / 1000)
    return path
  }
  /** A good session's file outside the store, named as the n-th. */
  const elsewhere = (n: number) => {
    const path = join(dir, `${local(n)}.json`)
    writeFileSync(path, JSON.stringify({ sessionId: local(n), cliSessionId: cli(n), cwd: '/work/away', lastActivityAt: T }))
    return path
  }
  return { dir, fixture, put, text, elsewhere, reader: new ClaudeAppStore(root) }
}
type Store = ReturnType<typeof store>

async function loaded(reader: ClaudeAppStore): Promise<StoreRead> {
  await reader.folders()
  await reader.files()
  return reader.read()
}

/** Every entry under a folder: its path, size and mtime, read without following a link. */
function tree(folder: string): Array<[string, number, number]> {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort().map((name) => {
    const stats = lstatSync(join(folder, name))
    return [name, stats.size, stats.mtimeMs]
  })
}

describe.skipIf(process.platform === 'win32')('the Claude app\'s store', () => {
  describe('fields', () => {
    it('a session gives its five fields and nothing else', async () => {
      const s = store()
      s.put(1, { title: 'Fix the build', more: { messages: ['secret'], prompt: 'secret' } })
      const read = await loaded(s.reader)
      expect(read.sessions).toEqual([
        { localId: local(1), sessionId: cli(1), cwd: '/work/p1', title: 'Fix the build', lastActivityAt: T - 1000 },
      ])
      expect(Object.keys(read.sessions[0]!).sort()).toEqual(['cwd', 'lastActivityAt', 'localId', 'sessionId', 'title'])
      expect(JSON.stringify(read)).not.toContain('secret')
    })

    it('a title that is no string is none; a lastActivityAt that is no finite number is the file\'s mtime', async () => {
      const s = store()
      s.put(1, { title: 7, lastActivityAt: 'x' })
      s.put(2, { title: null, lastActivityAt: null })
      s.text(3, `{"sessionId":"${local(3)}","cliSessionId":"${cli(3)}","cwd":"/work/p3","lastActivityAt":1e999}`)
      const { sessions } = await loaded(s.reader)
      expect(sessions.map((session) => [session.localId, 'title' in session, session.lastActivityAt])).toEqual([
        [local(1), false, T - 1000], [local(2), false, T - 2000], [local(3), false, T - 3000],
      ])
    })
  })

  describe('gone', () => {
    it('an archived session is not listed and not counted skipped, whatever its other fields', async () => {
      const s = store()
      s.put(1)
      s.put(2, { isArchived: true, cliSessionId: 'x', cwd: '' })
      s.put(3, { isArchived: true, more: { cliSessionId: undefined, cwd: undefined } })
      const read = await loaded(s.reader)
      expect(localIds(read)).toEqual([local(1)])
      expect(read.skipped).toBe(0)
    })

    it('a deleted session\'s tombstone is never a session', async () => {
      const s = store()
      s.put(1)
      s.put(2)
      expect(localIds(await loaded(s.reader))).toEqual([local(1), local(2)])
      s.fixture.remove(local(2))
      await s.reader.touch(s.fixture.org(), `${local(2)}.json`)
      await s.reader.touch(s.fixture.org(), `deleted_${local(2).slice('local_'.length)}`)
      const touched = await s.reader.read()
      expect(localIds(touched)).toEqual([local(1)])
      expect(touched.skipped).toBe(0)
      await s.reader.files()
      const listed = await s.reader.read()
      expect(localIds(listed)).toEqual([local(1)])
      expect(listed.skipped).toBe(0)
    })
  })

  describe('skipped and counted', () => {
    it.each<[string, (s: Store) => void]>([
      ['half a JSON text (the app mid-write)', (s) => s.text(2, `{"sessionId":"${local(2)}","cliSessionId":"${cli(2)}","cwd":"/wo`)],
      ['a file of 1 MiB + 1 byte', (s) => s.put(2, {}, { bytes: MAX_FILE_BYTES + 1 })],
      ['a link named local_….json to a good file elsewhere', (s) => symlinkSync(s.elsewhere(2), join(s.fixture.org(), `${local(2)}.json`))],
      ['a sessionId of another local id', (s) => s.put(2, { more: { sessionId: local(9) } })],
      ['a cliSessionId of x', (s) => s.put(2, { cliSessionId: 'x' })],
      ['an upper-case cliSessionId', (s) => s.put(2, { cliSessionId: cli(2).toUpperCase() })],
      ['a cliSessionId of 7', (s) => s.put(2, { more: { cliSessionId: 7 } })],
      ['no cliSessionId', (s) => s.put(2, { more: { cliSessionId: undefined } })],
      ['a cwd of nothing', (s) => s.put(2, { cwd: '' })],
      ['a cwd of 7', (s) => s.put(2, { more: { cwd: 7 } })],
      ['no cwd', (s) => s.put(2, { more: { cwd: undefined } })],
      ['a cwd of 4,097 characters', (s) => s.put(2, { cwd: `/${'a'.repeat(4096)}` })],
      ['an isArchived of yes', (s) => s.put(2, { isArchived: 'yes' })],
      ['an isArchived of 1', (s) => s.put(2, { isArchived: 1 })],
    ])('%s gives no session and is counted skipped', async (_, write) => {
      const s = store()
      s.put(1)
      write(s)
      const read = await loaded(s.reader)
      expect(localIds(read)).toEqual([local(1)])
      expect(read.skipped).toBe(1)
    })

    it('a file of exactly 1 MiB is read', async () => {
      const s = store()
      s.put(1, {}, { bytes: MAX_FILE_BYTES })
      const read = await loaded(s.reader)
      expect(localIds(read)).toEqual([local(1)])
      expect(read.skipped).toBe(0)
    })

    it('a file skipped mid-write is listed once it is whole', async () => {
      const s = store()
      s.text(1, `{"sessionId":"${local(1)}","cliSe`)
      expect((await loaded(s.reader)).skipped).toBe(1)
      const path = s.put(1, {}, { mtime: T })
      await s.reader.touch(s.fixture.org(), basename(path))
      const read = await s.reader.read()
      expect(localIds(read)).toEqual([local(1)])
      expect(read.skipped).toBe(0)
    })

    it('JSON that is no object is skipped and counted', async () => {
      const s = store()
      ;['null', '[]', '42', '"x"'].forEach((body, i) => s.text(i + 1, body))
      const read = await loaded(s.reader)
      expect(read.sessions).toEqual([])
      expect(read.skipped).toBe(4)
    })

    it('a file swapped for a link between its stat and its read is not followed', async () => {
      const s = store()
      const path = s.put(1)
      await s.reader.folders()
      await s.reader.files()
      rmSync(path)
      symlinkSync(s.elsewhere(1), path)
      const read = await s.reader.read()
      expect(read.sessions).toEqual([])
      expect(read.skipped).toBe(1)
    })

    it('a file grown past 1 MiB between its stat and its read is not read whole', async () => {
      const s = store()
      s.put(1)
      await s.reader.folders()
      await s.reader.files()
      s.put(1, {}, { bytes: 2 * MAX_FILE_BYTES })
      const read = await s.reader.read()
      expect(read.sessions).toEqual([])
      expect(read.skipped).toBe(1)
    })
  })

  describe('names', () => {
    it('only local_….json names are held', async () => {
      const s = store()
      const org = s.fixture.org()
      const good = (sessionId: string) => JSON.stringify({ sessionId, cliSessionId: cli(1), cwd: '/work/p1', lastActivityAt: T })
      for (const name of [`deleted_${local(1).slice('local_'.length)}`, 'archived-sessions.idx', 'scheduled-tasks.json', 'local_a.json.tmp']) {
        writeFileSync(join(org, name), good(name.replace(/\.json$/, '')))
      }
      mkdirSync(join(org, 'waiting-input'))
      writeFileSync(join(org, 'waiting-input', `${local(2)}.json`), good(local(2)))
      s.fixture.write({ localId: 'LOCAL_a', cliSessionId: cli(3), cwd: '/work/p3', lastActivityAt: T }, { mtime: T })
      s.fixture.write({ localId: 'local_a b', cliSessionId: cli(4), cwd: '/work/p4', lastActivityAt: T }, { mtime: T })
      const read = await loaded(s.reader)
      expect(read.sessions).toEqual([])
      expect(read.skipped).toBe(0)
    })

    it('two files with one cliSessionId give one session, the newest lastActivityAt\'s', async () => {
      // The first file reached (the newer mtime) holds the older activity, so the walk must replace it.
      const one = store()
      one.put(1, { cliSessionId: cli(9), lastActivityAt: T - 5000 })
      one.put(2, { cliSessionId: cli(9), lastActivityAt: T - 3000 })
      const read = await loaded(one.reader)
      expect(localIds(read)).toEqual([local(2)])
      expect(read.skipped).toBe(1)

      const two = store()
      two.put(1, { cliSessionId: cli(9), lastActivityAt: T - 5000 })
      two.put(2, { cliSessionId: cli(9), lastActivityAt: T - 3000 }, { account: 'other-account' })
      const across = await loaded(two.reader)
      expect(localIds(across)).toEqual([local(2)])
      expect(across.skipped).toBe(1)
    })
  })

  it('only new or changed files are parsed', async () => {
    const s = store()
    s.put(1)
    s.put(2)
    s.put(3)
    const first = await loaded(s.reader)
    expect(first.parsed).toBe(3)
    const again = await s.reader.read()
    expect(again.parsed).toBe(0)
    expect(again.sessions).toEqual(first.sessions)
    await s.reader.files()
    expect((await s.reader.read()).parsed).toBe(0)
    const path = s.put(2, { title: 'Renamed' }, { mtime: T - 1500 })
    await s.reader.touch(s.fixture.org(), basename(path))
    const changed = await s.reader.read()
    expect(changed.parsed).toBe(1)
    expect(changed.sessions.map((session) => session.title)).toEqual([undefined, 'Renamed', undefined])
  })

  describe('the walk, over 20 files', () => {
    /** 20 sessions, the n-th at `T - n * 1000`, after a first read. */
    async function twenty(over: Record<number, Partial<FixtureSession>> = {}) {
      const s = store()
      for (const n of range(1, 20)) s.put(n, over[n])
      return { ...s, first: await loaded(s.reader) }
    }
    const touched = async (s: Store, path: string) => {
      await s.reader.touch(dirname(path), basename(path))
      return s.reader.read()
    }

    it('it stops once 16 are counted and the next file is older', async () => {
      const s = await twenty()
      expect(s.first.parsed).toBe(16)
      expect(localIds(s.first)).toEqual(range(1, 16).map(local))
      expect((await s.reader.read()).parsed).toBe(0)
    })

    it('a newer write is parsed', async () => {
      const s = await twenty()
      const read = await touched(s, s.put(20, { lastActivityAt: T + 1000 }, { mtime: T + 1000 }))
      expect(read.parsed).toBe(1)
      expect(localIds(read)).toEqual([local(20), ...range(1, 15).map(local)])
    })

    it('archiving one of the 16 parses the next', async () => {
      const s = await twenty()
      const read = await touched(s, s.put(3, { isArchived: true }))
      expect(read.parsed).toBe(2)
      expect(localIds(read)).toEqual([1, 2, ...range(4, 17)].map(local))
    })

    it('a file rewritten with no new activity sorts by its lastActivityAt', async () => {
      const s = await twenty()
      const read = await touched(s, s.put(18, { lastActivityAt: T - 18_000 }, { mtime: T + 1000 }))
      expect(read.parsed).toBe(1)
      expect(localIds(read)).toEqual(range(1, 16).map(local))
    })

    it('a lastActivityAt ahead of the file\'s mtime sorts by the mtime', async () => {
      const s = await twenty({ 2: { lastActivityAt: T + 9_000_000 } })
      for (const read of [s.first, await s.reader.read()]) {
        expect(localIds(read)).toEqual(range(1, 16).map(local))
        expect(read.sessions[1]!.lastActivityAt).toBe(T + 9_000_000)
      }
    })
  })

  it('a walk cut at 256 asks for one more read', async () => {
    const s = store()
    for (const n of range(1, 300)) s.put(n, { isArchived: true })
    for (const n of range(301, 316)) s.put(n)
    const first = await loaded(s.reader)
    expect(first).toEqual({ ...NOTHING, parsed: 256, more: true, over: 60 })
    const second = await s.reader.read()
    expect(second).toMatchObject({ parsed: 60, skipped: 0, more: false, over: 0 })
    expect(localIds(second)).toEqual(range(301, 316).map(local))
  })

  describe('bounds', () => {
    it('9 account folders: 8 are read, in name order, and over counts one', async () => {
      const s = store()
      // Made last to first, the last named holding the newest session: a reader that took them unsorted would list it.
      for (const k of range(1, 9).reverse()) s.put(10 - k, {}, { account: `account-${k}` })
      const folders = await s.reader.folders()
      expect(folders?.accounts).toEqual(range(1, 8).map((k) => join(s.fixture.root, `account-${k}`)))
      await s.reader.files()
      const read = await s.reader.read()
      expect(localIds(read)).toEqual(range(2, 9).map(local))
      expect(read.over).toBe(1)
    })

    it('9 org folders in an account: over counts one', async () => {
      const s = store()
      for (const k of range(1, 9).reverse()) s.put(10 - k, {}, { org: `org-${k}` })
      const folders = await s.reader.folders()
      expect(folders?.orgs).toEqual(range(1, 8).map((k) => join(s.fixture.root, ACCOUNT, `org-${k}`)))
      await s.reader.files()
      const read = await s.reader.read()
      expect(localIds(read)).toEqual(range(2, 9).map(local))
      expect(read.over).toBe(1)
    })

    it('1,030 names in a folder: 1,024 are held and over counts six', async () => {
      const s = store()
      // The six past the bound in name order are the newest: held, they would be listed first.
      for (const n of range(1, 1030)) s.put(n, { lastActivityAt: T + n * 1000 }, { mtime: T + n * 1000 })
      const read = await loaded(s.reader)
      expect(localIds(read)).toEqual(range(1009, 1024).reverse().map(local))
      expect(read.over).toBe(6)
    })

    it('an account or an org folder that is a link is not read', async () => {
      const s = store()
      s.put(1)
      const away = claudeAppFixture(join(s.dir, 'away'))
      away.write({ localId: local(2), cliSessionId: cli(2), cwd: '/work/p2', lastActivityAt: T }, { mtime: T })
      symlinkSync(join(away.root, ACCOUNT), join(s.fixture.root, 'linked-account'))
      symlinkSync(join(away.root, ACCOUNT, ORG), join(s.fixture.root, ACCOUNT, 'linked-org'))
      expect(await s.reader.folders()).toEqual({
        accounts: [join(s.fixture.root, ACCOUNT)], orgs: [join(s.fixture.root, ACCOUNT, ORG)],
      })
      await s.reader.files()
      expect(localIds(await s.reader.read())).toEqual([local(1)])
    })

    it('a root that is a link, a file or not there gives no folders, and a read of nothing', async () => {
      const s = store()
      s.put(1)
      const linked = join(s.dir, 'linked')
      symlinkSync(s.fixture.root, linked)
      const file = join(s.dir, 'file')
      writeFileSync(file, '')
      for (const root of [linked, file, join(s.dir, 'none')]) {
        const reader = new ClaudeAppStore(root)
        expect(await reader.folders()).toBeUndefined()
        await reader.files()
        expect(await reader.read()).toEqual(NOTHING)
      }
      // A root that left takes every file it held with it.
      expect(localIds(await loaded(s.reader))).toEqual([local(1)])
      rmSync(s.fixture.root, { recursive: true })
      expect(await s.reader.folders()).toBeUndefined()
      expect(await s.reader.read()).toEqual(NOTHING)
    })
  })

  it('touch: a name outside the form, or a folder not read, does nothing', async () => {
    const s = store()
    s.put(1)
    await loaded(s.reader)
    // A folder made after the listing, and a name the form refuses that would otherwise be a session.
    const late = s.put(2, {}, { account: 'late-account' })
    s.fixture.write({ localId: 'LOCAL_a', cliSessionId: cli(3), cwd: '/work/p3', lastActivityAt: T }, { mtime: T })
    await s.reader.touch(dirname(late), basename(late))
    await s.reader.touch(s.fixture.org(), 'LOCAL_a.json')
    await s.reader.touch(s.fixture.org(), `../../late-account/${ORG}/${basename(late)}`)
    const read = await s.reader.read()
    expect(localIds(read)).toEqual([local(1)])
    expect(read.skipped).toBe(0)
  })

  it('forget drops everything: the next read parses again', async () => {
    const s = store()
    for (const n of range(1, 3)) s.put(n)
    expect((await loaded(s.reader)).parsed).toBe(3)
    s.reader.forget()
    expect(await s.reader.read()).toEqual(NOTHING)
    expect((await loaded(s.reader)).parsed).toBe(3)
  })

  it('nothing in the store is written', async () => {
    const s = store()
    s.put(1)
    s.put(2, { isArchived: true })
    s.text(3, `{"sessionId":"${local(3)}"`)
    s.put(4)
    s.fixture.remove(local(4))
    const before = tree(s.fixture.root)
    await loaded(s.reader)
    await s.reader.touch(s.fixture.org(), `${local(1)}.json`)
    await s.reader.read()
    expect(tree(s.fixture.root)).toEqual(before)
  })
})
