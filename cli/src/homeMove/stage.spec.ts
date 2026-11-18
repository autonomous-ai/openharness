import * as fs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planMove, type MoveEntry, type MovePlan } from './plan.js'
import { commitRoot, dropOriginals, mergeRecreated, stageEntry, uncommitRoot, unstageEntry, type StageIo } from './stage.js'

const NODE_FS: StageIo = {
  renameSync: fs.renameSync, symlinkSync: fs.symlinkSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync, unlinkSync: fs.unlinkSync,
  lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, cpSync: fs.cpSync, chmodSync: fs.chmodSync, utimesSync: fs.utimesSync,
  openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync,
}

// A time in whole seconds long before any test runs: a time kept is told from one the move made, and a copy keeps it exactly.
const OLD = 1_600_000_000

/** A ~/.harness holding [names]: computer-id a 600 file; any other a 700 folder with a 600 file, a folder and a link inside. */
function legacyHome(names: string[]): MovePlan {
  const home = mkdtempSync(join(tmpdir(), 'move-stage-'))
  mkdirSync(join(home, '.harness'))
  // The entries made here: what the table holds besides is staged by move.spec.ts.
  const planned = planMove(home, {}, names)
  const plan = { ...planned, entries: planned.entries.filter((entry) => names.includes(entry.name)) }
  for (const { name, from } of plan.entries) {
    if (name === 'computer-id') {
      writeFileSync(from, 'c0ffee', { mode: 0o600 })
      utimesSync(from, OLD, OLD)
      continue
    }
    mkdirSync(join(from, 'inner'), { recursive: true, mode: 0o700 })
    writeFileSync(join(from, 'session.json'), `{"of":"${name}"}`, { mode: 0o600 })
    writeFileSync(join(from, 'inner', 'a.log'), 'line\n', { mode: 0o644 })
    symlinkSync('../session.json', join(from, 'inner', 'session'))
    for (const inside of ['session.json', 'inner/a.log', 'inner']) utimesSync(join(from, inside), OLD, OLD)
  }
  return plan
}

const entryOf = (plan: MovePlan, name: string): MoveEntry => plan.entries.find((entry) => entry.name === name)!

/** Each path under [root], [root] itself as '': its mode, its bytes or its link's text, and, inside, a file's or a folder's modification time. */
function snapshot(root: string): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (path: string): void => {
    const st = lstatSync(path), at = relative(root, path)
    const what = st.isSymbolicLink() ? `-> ${readlinkSync(path)}` : st.isDirectory() ? 'folder' : readFileSync(path, 'utf8')
    const time = at === '' || st.isSymbolicLink() ? '' : ` at ${Math.trunc(st.mtimeMs)}`
    seen[at] = `${(st.mode & 0o777).toString(8)} ${what}${time}`
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(root)
  return seen
}

const mode = (path: string): number => statSync(path).mode & 0o777
const failure = (code: string): Error => Object.assign(new Error(code), { code })

/** An io whose first rename of [entry] fails as across filesystems, and whose first copy runs [during] once it is done. */
function acrossDisks(entry: MoveEntry, during: () => void = () => {}): StageIo {
  let renamed = false, copied = false
  return {
    ...NODE_FS,
    renameSync: (from, to) => {
      if (from === entry.from && !renamed) {
        renamed = true
        throw failure('EXDEV')
      }
      fs.renameSync(from, to)
    },
    cpSync: (from, to, options) => {
      fs.cpSync(from, to, options)
      if (copied) return
      copied = true
      during()
    },
  }
}

describe('staging an entry', () => {
  it('an entry is renamed into <root>.moving and a link to its final place is left', () => {
    const plan = legacyHome(['auth', 'logs'])
    const auth = entryOf(plan, 'auth')
    const before = snapshot(auth.from)
    expect(stageEntry(auth, plan, NODE_FS, Date.now())).toEqual({ copied: false, bytes: 0 })
    expect(readlinkSync(auth.from)).toBe(`${plan.data}/auth`)
    expect(snapshot(auth.staged)).toEqual(before)
    expect(before).toMatchObject({ '': '700 folder', 'session.json': `600 {"of":"auth"} at ${OLD * 1000}`, inner: `700 folder at ${OLD * 1000}` })
    // The staging folders are the account's own, as the roots they become.
    expect(mode(`${plan.data}.moving`)).toBe(0o700)
    expect(existsSync(`${plan.state}.moving`)).toBe(false)
  })

  it('a file entry (computer-id) moves the same way', () => {
    const plan = legacyHome(['computer-id'])
    const id = entryOf(plan, 'computer-id')
    stageEntry(id, plan, NODE_FS, Date.now())
    expect(readlinkSync(id.from)).toBe(`${plan.data}/computer-id`)
    expect(snapshot(id.staged)).toEqual({ '': '600 c0ffee' })
    expect(lstatSync(id.staged).mtimeMs).toBe(OLD * 1000)
  })

  it('a folder recreated at an old path is merged', () => {
    const plan = legacyHome(['logs'])
    const logs = entryOf(plan, 'logs')
    let recreated = false
    // A hook that ran between the rename and the link wrote its event offline, where the folder was.
    const io: StageIo = {
      ...NODE_FS,
      renameSync: (from, to) => {
        fs.renameSync(from, to)
        if (from !== logs.from || recreated) return
        recreated = true
        mkdirSync(join(logs.from, 'inner'), { recursive: true })
        writeFileSync(join(logs.from, 'offline.json'), '{"event":1}')
        writeFileSync(join(logs.from, 'session.json'), '{"of":"the hook"}')
        utimesSync(join(logs.from, 'session.json'), OLD + 10, OLD + 10)
        writeFileSync(join(logs.from, 'inner', 'a.log'), 'stale\n')
        utimesSync(join(logs.from, 'inner', 'a.log'), OLD - 10, OLD - 10)
      },
    }
    stageEntry(logs, plan, io, Date.now())
    expect(readlinkSync(logs.from)).toBe(`${plan.state}/logs`)
    expect(readFileSync(join(logs.staged, 'offline.json'), 'utf8')).toBe('{"event":1}')
    // A file both sides hold keeps the newer.
    expect(readFileSync(join(logs.staged, 'session.json'), 'utf8')).toBe('{"of":"the hook"}')
    expect(readFileSync(join(logs.staged, 'inner', 'a.log'), 'utf8')).toBe('line\n')
    // Once the link is in, nothing is left to merge.
    expect(mergeRecreated(logs, NODE_FS)).toBe(0)
    expect(readlinkSync(logs.from)).toBe(`${plan.state}/logs`)
  })

  it('across filesystems the entry is copied, then swapped, then what changed during the copy is copied again', () => {
    const plan = legacyHome(['auth'])
    const auth = entryOf(plan, 'auth')
    const io = acrossDisks(auth, () => {
      writeFileSync(join(auth.from, 'late.json'), 'written during the copy', { mode: 0o600 })
      writeFileSync(join(auth.from, 'session.json'), 'changed during the copy')
      utimesSync(join(auth.from, 'late.json'), OLD + 20, OLD + 20)
      utimesSync(join(auth.from, 'session.json'), OLD + 10, OLD + 10)
    })
    const bytes = ['written during the copy', 'changed during the copy', 'line\n'].reduce((sum, text) => sum + text.length, 0)
    expect(stageEntry(auth, plan, io, Date.now())).toEqual({ copied: true, bytes })
    expect(readlinkSync(auth.from)).toBe(`${plan.data}/auth`)
    // The original is kept beside, as it was when its link went in, until the finish.
    const kept = join(plan.legacy, '.move-old', 'auth')
    expect(snapshot(auth.staged)).toEqual(snapshot(kept))
    expect(snapshot(auth.staged)).toMatchObject({
      '': '700 folder', 'late.json': `600 written during the copy at ${(OLD + 20) * 1000}`, inner: `700 folder at ${OLD * 1000}`,
      'inner/session': expect.stringMatching(/ -> \.\.\/session\.json$/),
    })
    expect(mode(join(plan.legacy, '.move-old'))).toBe(0o700)
    dropOriginals(plan, NODE_FS)
    expect(existsSync(join(plan.legacy, '.move-old'))).toBe(false)
    expect(readFileSync(join(auth.staged, 'session.json'), 'utf8')).toBe('changed during the copy')
  })

  it.each([
    ['its link cannot go in, as a hook made the folder again', (): StageIo => ({
      ...NODE_FS,
      symlinkSync: (_target, path) => {
        mkdirSync(path)
        writeFileSync(join(String(path), 'offline.json'), '{"event":2}', { mode: 0o600 })
        utimesSync(join(String(path), 'offline.json'), OLD, OLD)
        throw failure('EEXIST')
      },
    }), { 'offline.json': `600 {"event":2} at ${OLD * 1000}` }],
    ['the disk fills during its copy', (entry: MoveEntry): StageIo => acrossDisks(entry, () => { throw failure('ENOSPC') }), {}],
  ])('a failure partway puts the entry back: %s', (_, ioFor, written) => {
    const plan = legacyHome(['auth'])
    const auth = entryOf(plan, 'auth')
    const before = snapshot(auth.from)
    expect(() => stageEntry(auth, plan, ioFor(auth), Date.now())).toThrow()
    expect(snapshot(auth.from)).toEqual({ ...before, ...written })
    expect(readdirSync(plan.legacy)).toEqual(['auth'])
    expect(readdirSync(`${plan.data}.moving`)).toEqual([])
  })
})

describe('the commit', () => {
  it('commit renames the state root, then the data root', () => {
    const plan = legacyHome(['auth', 'logs'])
    for (const entry of plan.entries) stageEntry(entry, plan, NODE_FS, Date.now())
    commitRoot(plan, 'state', NODE_FS)
    expect(readdirSync(plan.state)).toEqual(['logs'])
    expect(existsSync(`${plan.state}.moving`)).toBe(false)
    expect(readFileSync(join(plan.legacy, 'logs', 'session.json'), 'utf8')).toBe('{"of":"logs"}')
    // Before the data root's rename, nothing of the data resolves: the rule still reads ~/.harness.
    expect(existsSync(plan.data)).toBe(false)
    expect(existsSync(join(plan.legacy, 'auth'))).toBe(false)
    commitRoot(plan, 'data', NODE_FS)
    expect(readFileSync(join(plan.legacy, 'auth', 'session.json'), 'utf8')).toBe('{"of":"auth"}')
    expect([mode(plan.data), mode(plan.state)]).toEqual([0o700, 0o700])
    // Done already: a second commit finds it so and does nothing.
    commitRoot(plan, 'state', NODE_FS)
    commitRoot(plan, 'data', NODE_FS)
    expect([readdirSync(plan.data), readdirSync(plan.state)]).toEqual([['auth'], ['logs']])
  })

  it('uncommit puts each back', () => {
    const plan = legacyHome(['auth', 'logs'])
    const before = snapshot(plan.legacy)
    for (const entry of plan.entries) stageEntry(entry, plan, NODE_FS, Date.now())
    commitRoot(plan, 'state', NODE_FS)
    commitRoot(plan, 'data', NODE_FS)
    uncommitRoot(plan, 'data', NODE_FS)
    expect(existsSync(plan.data)).toBe(false)
    expect(readdirSync(`${plan.data}.moving`)).toEqual(['auth'])
    uncommitRoot(plan, 'state', NODE_FS)
    expect(existsSync(plan.state)).toBe(false)
    expect(readdirSync(`${plan.state}.moving`)).toEqual(['logs'])
    uncommitRoot(plan, 'state', NODE_FS)
    for (const entry of plan.entries) unstageEntry(entry, false, NODE_FS)
    expect(snapshot(plan.legacy)).toEqual(before)
  })
})

describe('unstaging an entry', () => {
  it('an entry not there at the move is linked alone; unstaged, its link goes, and what a late writer made there comes back', () => {
    const home = mkdtempSync(join(tmpdir(), 'move-stage-'))
    mkdirSync(join(home, '.harness'))
    const plan = planMove(home, {}, [])
    const logs = entryOf(plan, 'logs')
    expect(stageEntry(logs, plan, NODE_FS, Date.now())).toEqual({ copied: false, bytes: 0 })
    expect([readlinkSync(logs.from), existsSync(logs.staged)]).toEqual([logs.to, false])
    unstageEntry(logs, false, NODE_FS)
    expect(readdirSync(plan.legacy)).toEqual([])
    // A late writer's folder, merged in at the end of the move.
    stageEntry(logs, plan, NODE_FS, Date.now())
    fs.unlinkSync(logs.from)
    mkdirSync(logs.from)
    writeFileSync(join(logs.from, 'late.log'), 'late\n')
    mergeRecreated(logs, NODE_FS)
    unstageEntry(logs, false, NODE_FS)
    expect([lstatSync(logs.from).isDirectory(), readFileSync(join(logs.from, 'late.log'), 'utf8'), existsSync(logs.staged)]).toEqual([true, 'late\n', false])
  })

  it.each([
    ['renamed', false, (): StageIo => NODE_FS],
    ['copied', true, (entry: MoveEntry): StageIo => acrossDisks(entry)],
  ])('unstage restores the exact entry, %s', (_, copied, ioFor) => {
    const plan = legacyHome(['auth', 'computer-id'])
    const before = snapshot(plan.legacy)
    for (const entry of plan.entries) expect(stageEntry(entry, plan, ioFor(entry), Date.now()).copied).toBe(copied)
    for (const entry of plan.entries) unstageEntry(entry, copied, NODE_FS)
    expect(snapshot(plan.legacy)).toEqual(before)
    expect(readdirSync(plan.legacy).sort()).toEqual(['auth', 'computer-id'])
    expect(readdirSync(`${plan.data}.moving`)).toEqual([])
    // Undone already: a second unstage finds it so and does nothing.
    for (const entry of plan.entries) unstageEntry(entry, copied, NODE_FS)
    expect(snapshot(plan.legacy)).toEqual(before)
  })
})
