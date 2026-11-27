import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RECORD_BYTES, readRecord } from './record.js'

let home: string
let projects: string
let sessions: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'record-'))
  projects = join(home, 'projects')
  sessions = join(home, 'sessions')
  mkdirSync(projects)
  mkdirSync(sessions)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/** Writes `<dir>/<pid>.json`: an object as JSON, a string as it is. */
function record(pid: number, content: object | string, dir = sessions): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${pid}.json`)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

const named = { pid: 11, sessionId: 's', cwd: '/x', status: 'idle', name: 'Tho', nameSource: 'user' }
const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
/** The Claude app's record: the title it gave the session, with no nameSource, and the app's own id of it. */
const app = { pid: 11, sessionId: 's', cwd: '/x', status: 'idle', name: 'Tho', entrypoint: 'claude-desktop', hostSessionId: LOCAL }
const read = (path: string, pid = 11, records = [sessions]) => readRecord({ pid, record: path, sessionId: 's' }, { records })

describe('readRecord', () => {
  it('reads the name the person gave', async () => {
    expect((await read(record(11, named))).name).toBe('Tho')
  })

  it('reads the title the Claude app gave its session', async () => {
    expect((await read(record(11, app))).name).toBe('Tho')
    expect((await read(record(11, { ...app, name: '  Fix \t login ' }))).name).toBe('Fix login')
  })

  it('reads the record at the path the provider builds, in the first records folder and in a moved home\'s', async () => {
    const moved = join(home, 'moved', 'sessions')
    record(11, named, moved)
    expect((await read(join(moved, '11.json'), 11, [sessions, moved])).name).toBe('Tho')
    record(11, named)
    expect((await read(join(sessions, '11.json'), 11, [sessions, moved])).name).toBe('Tho')
  })

  it('a record in an Orca home\'s sessions folder is named', async () => {
    // An Orca account's home, as `orca account list` gives it: its records are in its own sessions folder.
    const orca = join(home, 'orca', 'accounts', 'a1', 'claude')
    expect((await read(record(11, named, join(orca, 'sessions')), 11, [sessions, join(orca, 'sessions')])).name).toBe('Tho')
  })

  it('a record outside every records folder is refused', async () => {
    const orca = join(home, 'orca', 'accounts', 'a1', 'claude')
    expect((await read(record(11, named, join(orca, 'sessions')), 11, [sessions])).name).toBeUndefined()
  })

  it('a record one folder below a records folder is refused', async () => {
    expect((await read(record(11, named, join(sessions, 'nested')))).name).toBeUndefined()
  })

  it.each<[string, () => string]>([
    ['a derived name', () => record(11, { ...named, nameSource: 'derived' })],
    ['no nameSource', () => record(11, { ...named, nameSource: undefined })],
    ['a nameSource of 7', () => record(11, { ...named, nameSource: 7 })],
    ['a nameSource of User', () => record(11, { ...named, nameSource: 'User' })],
    ['a record a /clear moved to another session', () => record(11, { ...named, sessionId: 't' })],
    ['a cli record with no nameSource', () => record(11, { ...app, entrypoint: 'cli' })],
    ['an sdk-cli record with no nameSource', () => record(11, { ...app, entrypoint: 'sdk-cli' })],
    ['no entrypoint and no nameSource', () => record(11, { ...app, entrypoint: undefined })],
    ['a Claude app record with a derived name', () => record(11, { ...app, nameSource: 'derived' })],
    ['a Claude app record with a nameSource of 7', () => record(11, { ...app, nameSource: 7 })],
    ['an entrypoint of 7', () => record(11, { ...app, entrypoint: 7 })],
    ['an entrypoint of Claude-Desktop', () => record(11, { ...app, entrypoint: 'Claude-Desktop' })],
    ['a Claude app record a /clear moved to another session', () => record(11, { ...app, sessionId: 't' })],
    ['no sessionId', () => record(11, { ...named, sessionId: undefined })],
    ['a sessionId of 7', () => record(11, { ...named, sessionId: 7 })],
    ['no name', () => record(11, { ...named, name: undefined })],
    ['a name of 7', () => record(11, { ...named, name: 7 })],
    ['a null name', () => record(11, { ...named, name: null })],
    ['a name that is an object', () => record(11, { ...named, name: { text: 'Tho' } })],
    ['a name that is a list', () => record(11, { ...named, name: ['Tho'] })],
    ['an empty name', () => record(11, { ...named, name: '' })],
    ['a blank name', () => record(11, { ...named, name: ' \t ' })],
    ['a name with a control character', () => record(11, { ...named, name: 'Th\u0007o' })],
    ['a record cut mid-write', () => record(11, '{"pid":11,"name":"Tho","nameSou')],
    ['a list', () => record(11, '[{"name":"Tho","nameSource":"user"}]')],
    ['null', () => record(11, 'null')],
    ['a string', () => record(11, '"Tho"')],
    ['no file at the path', () => join(sessions, '11.json')],
    ['a folder at the path', () => {
      mkdirSync(join(sessions, '11.json'))
      return join(sessions, '11.json')
    }],
  ])('gives none for %s', async (_, path) => {
    expect((await read(path())).name).toBeUndefined()
  })

  it('cleans and cuts the name as the hook\'s title', async () => {
    for (const [name, shown] of [
      ['  Fix \t\n login   screen ', 'Fix login screen'],
      ['😀'.repeat(40), '😀'.repeat(32)],
      ['Thơ "gà" \\ 数学 🙂', 'Thơ "gà" \\ 数学 🙂'],
    ]) {
      expect((await read(record(11, { ...named, name }))).name).toBe(shown)
    }
  })

  it('reads a record of 16 KiB and not one a byte larger', async () => {
    const fill = MAX_RECORD_BYTES - JSON.stringify({ ...app, pad: '' }).length
    expect((await read(record(11, { ...app, pad: 'x'.repeat(fill) }))).name).toBe('Tho')
    expect(await read(record(11, { ...app, pad: 'x'.repeat(fill + 1) }))).toEqual({})
  })

  it.each<[string, () => string, number?]>([
    ['an owner claimed from its arguments', () => {
      record(11, app)
      return ''
    }],
    ['another process\'s record', () => record(12, app), 11],
    ['a file of another kind', () => {
      writeFileSync(join(sessions, '11.jsonl'), JSON.stringify(app))
      return join(sessions, '11.jsonl')
    }],
    ['a file of the same name in a project', () => record(11, app, join(projects, '-x'))],
    ['a file of the same name in another sessions folder', () => record(11, app, join(home, 'other', 'sessions'))],
    ['the record by another spelling', () => {
      record(11, app)
      return `${sessions}/../sessions/11.json`
    }],
  ])('reads nothing at %s', async (_, path, pid) => {
    expect(await read(path(), pid)).toEqual({})
  })

  it('a Claude app record gives its title and its host session', async () => {
    expect(await read(record(11, app))).toEqual({ name: 'Tho', hostSession: LOCAL })
  })

  it('a Claude app record whose name is refused still gives its host session', async () => {
    expect(await read(record(11, { ...app, nameSource: 'derived' }))).toEqual({ hostSession: LOCAL })
  })

  it('a CLI record gives no host session', async () => {
    expect(await read(record(11, { ...named, entrypoint: 'cli', hostSessionId: LOCAL }))).toEqual({ name: 'Tho' })
  })

  // Only the Claude app's own record: its name is the person's here, so only the host session can differ.
  it.each<[unknown]>([['sdk-cli'], [undefined], [7], ['Claude-Desktop'], ['claude-desktop ']])(
    'a record whose entrypoint is %j gives no host session', async (entrypoint) => {
      expect(await read(record(11, { ...app, nameSource: 'user', entrypoint }))).toEqual({ name: 'Tho' })
    })

  it('a Claude app record for another session gives neither', async () => {
    expect(await read(record(11, { ...app, sessionId: 't' }))).toEqual({})
  })

  it('an older Claude app record with no hostSessionId gives its name alone', async () => {
    expect(await read(record(11, { ...app, hostSessionId: undefined }))).toEqual({ name: 'Tho' })
  })

  it.each<[unknown]>([[''], [7], [null], [true], [{ id: LOCAL }], [[LOCAL]]])('a hostSessionId of %j gives none', async (hostSessionId) => {
    expect(await read(record(11, { ...app, hostSessionId }))).toEqual({ name: 'Tho' })
  })

  it('the host session is taken as written, for the adapter to check', async () => {
    expect((await read(record(11, { ...app, hostSessionId: ' local_a&x=1 ' }))).hostSession).toBe(' local_a&x=1 ')
  })
})
