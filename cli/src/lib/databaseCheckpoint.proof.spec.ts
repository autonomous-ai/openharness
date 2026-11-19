import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, linkSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RegisteredSession } from './registry.js'
import { databaseCheckpointEvidence } from './databaseCheckpoint.js'
import { observeNativeFiles } from '../engines/kit/nativeFileObservation.js'

const { reads, opens } = vi.hoisted(() => ({ reads: [] as string[], opens: [] as string[] }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    opens.push(String(args[0])); return fs.openSync(...args)
  }, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    reads.push(String(args[0])); return fs.lstatSync(...args)
  } }
})
let root: string, home: string, database: string
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'database-proof-')))
  home = join(root, 'profiles', 'selected'); mkdirSync(home, { recursive: true })
  database = join(home, 'state.db'); writeFileSync(database, 'native history', { mode: 0o600 })
  reads.length = 0
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const session = () => ({ engine: 'hermes', sessionId: '20261120_010000_abcdef', hermesHome: home }) as RegisteredSession
const proof = async () => (await databaseCheckpointEvidence(session()))!

it('checks shared ancestors once per synchronous database proof, and reads them again on every call', async () => {
  writeFileSync(database + '-wal', 'native WAL', { mode: 0o600 })
  const held = await proof()
  reads.length = 0; held.verify(); const first = [...reads]
  expect(first.filter(path => path === home)).toHaveLength(1)
  expect(first.filter(path => path === dirname(home))).toHaveLength(1)
  expect(first.filter(path => path === database)).toHaveLength(2)
  expect(first.filter(path => path === database + '-wal')).toHaveLength(2)
  expect(first.filter(path => path === database + '-journal')).toHaveLength(1)
  reads.length = 0; held.verify(); expect(reads).toEqual(first)
  appendFileSync(database, 'changed before the next fence')
  expect(() => held.verify()).toThrow(/changed/)
})

it('fresh generations allow native flushes and WAL removal without polluting the original route', async () => {
  writeFileSync(database + '-wal', 'first WAL', { mode: 0o600 })
  const first = await proof(), source = { ...first.source }
  appendFileSync(database, 'native exit flush'); rmSync(database + '-wal')
  expect(() => first.verify()).toThrow(/changed/)
  const second = first.fresh(); expect(second.source).toEqual(source); second.verify()
  writeFileSync(database + '-wal', 'next WAL', { mode: 0o600 })
  expect(() => second.verify()).toThrow(/changed/)
  const third = second.fresh(); expect(third.source).toEqual(source); third.verify()
  renameSync(database, database + '.old'); writeFileSync(database, 'replacement', { mode: 0o600 })
  expect(() => third.verify()).toThrow(/changed/)
  expect(() => third.fresh()).toThrow(/changed|identity/)
})

it('keeps the originally selected alias across proof generations', async () => {
  const physical = home, alias = join(root, 'selected-alias'); symlinkSync(physical, alias); home = alias
  const held = await proof()
  expect(held.source?.path).toBe(database); expect(held.source?.database).toBe(join(alias, 'state.db'))
  held.fresh().verify()
  renameSync(alias, alias + '.old'); symlinkSync(physical, alias)
  expect(() => held.verify()).toThrow(/changed/)
  expect(() => held.fresh()).toThrow(/changed/)
})

it('does not adopt a new ancestor while retaining the original database inode', async () => {
  const held = await proof(), previous = home + '.old'
  renameSync(home, previous); mkdirSync(home)
  renameSync(join(previous, 'state.db'), database)
  expect(() => held.verify()).toThrow(/changed/)
  expect(() => held.fresh()).toThrow(/changed/)
})

it.each(['database mode', 'database link', 'WAL directory', 'WAL alias', 'journal removed'] as const)(
  'refuses a changed %s at the next shared fence', async kind => {
  writeFileSync(database + '-wal', 'WAL', { mode: 0o600 })
  writeFileSync(database + '-journal', 'journal', { mode: 0o600 })
  const held = await proof()
  if (kind === 'database mode') chmodSync(database, 0o400)
  else if (kind === 'database link') linkSync(database, database + '.link')
  else if (kind === 'journal removed') rmSync(database + '-journal')
  else {
    renameSync(database + '-wal', database + '-wal.old')
    if (kind === 'WAL directory') mkdirSync(database + '-wal')
    else symlinkSync(database + '-wal.old', database + '-wal')
  }
  expect(() => held.verify()).toThrow(/changed/)
})

it.each(['database removed', 'ancestor replaced', 'source alias replaced'] as const)(
  'rejects a %s before opening through a stale route', async kind => {
  if (kind === 'source alias replaced') {
    const alias = join(root, 'alias'); symlinkSync(home, alias); home = alias
  }
  const held = await proof()
  if (kind === 'database removed') rmSync(database)
  else if (kind === 'source alias replaced') {
    renameSync(home, home + '.old'); symlinkSync(dirname(database), home)
  } else {
    renameSync(home, home + '.old'); mkdirSync(home)
    renameSync(join(home + '.old', 'state.db'), database)
  }
  opens.length = 0
  expect(() => held.fresh()).toThrow(/changed/)
  expect(opens).not.toContain(database)
})

it.each([0, 4])('bounded native file group rejects %i entries before filesystem access', count => {
  reads.length = 0; opens.length = 0
  expect(() => observeNativeFiles(Array.from({ length: count }, () => ({ path: database })))).toThrow(/member limit/)
  expect(reads).toEqual([]); expect(opens).toEqual([])
})
