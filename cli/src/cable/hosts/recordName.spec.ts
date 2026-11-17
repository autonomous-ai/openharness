import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RECORD_BYTES, readRecordName } from './recordName.js'

let home: string
let projects: string
let sessions: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recordname-'))
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
const read = (path: string, pid = 11, roots = [projects]) => readRecordName({ pid, record: path, sessionId: 's' }, { roots })

describe('readRecordName', () => {
  it('reads the name the person gave', async () => {
    expect(await read(record(11, named))).toBe('Tho')
  })

  it('reads the record at the path the provider builds, in the first home and in a moved one', async () => {
    const moved = join(home, 'moved')
    record(11, named, join(moved, 'sessions'))
    expect(await read(join(moved, 'projects', '..', 'sessions', '11.json'), 11, [projects, join(moved, 'projects')])).toBe('Tho')
    record(11, named)
    expect(await read(join(projects, '..', 'sessions', '11.json'))).toBe('Tho')
  })

  it.each<[string, () => string]>([
    ['a derived name', () => record(11, { ...named, nameSource: 'derived' })],
    ['no nameSource', () => record(11, { ...named, nameSource: undefined })],
    ['a nameSource of 7', () => record(11, { ...named, nameSource: 7 })],
    ['a nameSource of User', () => record(11, { ...named, nameSource: 'User' })],
    ['a record a /clear moved to another session', () => record(11, { ...named, sessionId: 't' })],
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
    expect(await read(path())).toBeUndefined()
  })

  it('cleans and cuts the name as the hook\'s title', async () => {
    for (const [name, shown] of [
      ['  Fix \t\n login   screen ', 'Fix login screen'],
      ['😀'.repeat(40), '😀'.repeat(32)],
      ['Thơ "gà" \\ 数学 🙂', 'Thơ "gà" \\ 数学 🙂'],
    ]) {
      expect(await read(record(11, { ...named, name }))).toBe(shown)
    }
  })

  it('reads a record of 16 KiB and not one a byte larger', async () => {
    const fill = MAX_RECORD_BYTES - JSON.stringify({ ...named, pad: '' }).length
    expect(await read(record(11, { ...named, pad: 'x'.repeat(fill) }))).toBe('Tho')
    expect(await read(record(11, { ...named, pad: 'x'.repeat(fill + 1) }))).toBeUndefined()
  })

  it.each<[string, () => string, number?]>([
    ['an owner claimed from its arguments', () => {
      record(11, named)
      return ''
    }],
    ['another process\'s record', () => record(12, named), 11],
    ['a file of another kind', () => {
      writeFileSync(join(sessions, '11.jsonl'), JSON.stringify(named))
      return join(sessions, '11.jsonl')
    }],
    ['a file of the same name in a project', () => record(11, named, join(projects, '-x'))],
    ['a file of the same name in another sessions folder', () => record(11, named, join(home, 'other', 'sessions'))],
    ['the record by another spelling', () => {
      record(11, named)
      return `${sessions}/../sessions/11.json`
    }],
  ])('reads nothing at %s', async (_, path, pid) => {
    expect(await read(path(), pid)).toBeUndefined()
  })
})
