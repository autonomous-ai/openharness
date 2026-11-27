import * as fs from 'node:fs'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetJournal, openJournal, readJournal, writeWhole, type Done, type Journal, type OpenIo } from './journal.js'
import { draftOf, planMove } from './plan.js'

vi.mock('node:fs', async (real) => ({ ...await real<object>() }))

afterEach(() => { vi.restoreAllMocks() })

const NODE_FS: OpenIo = {
  openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync, rmSync: fs.rmSync,
  mkdirSync: fs.mkdirSync,
}

function legacyHome(): { home: string; legacy: string } {
  const home = mkdtempSync(join(tmpdir(), 'move-journal-'))
  mkdirSync(join(home, '.harness'))
  return { home, legacy: join(home, '.harness') }
}

/** A removal of a draft (a path ending .next) that fails, as one of a file another program holds does (EBUSY). */
const heldDrafts = () => {
  const rm = fs.rmSync, unlink = fs.unlinkSync
  const busy = () => Object.assign(new Error('EBUSY: fixture'), { code: 'EBUSY' })
  vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => { if (String(path).endsWith('.next')) throw busy(); rm(path, options) })
  vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => { if (String(path).endsWith('.next')) throw busy(); unlink(path) })
}

/** What [run] threw. */
const thrown = (run: () => unknown): unknown => {
  try { run() } catch (error) { return error }
  throw new Error('nothing thrown')
}

const journalOf = (home: string): Journal => ({
  version: 1, startedAt: 1_763_400_000_000, plan: planMove(home, {}, ['cli', 'logs']), oldTag: 'old-tag', newTag: 'new-tag', done: [],
})

// One of each kind of step.
const STEPS: Done[] = [
  { did: 'stage', entry: 'cli', copied: false },
  { did: 'file', path: '/h/.local/share/harness.moving/cli/data/registry.json', before: Buffer.from('{"agents":[]}').toString('base64') },
  { did: 'file', path: '/h/.local/share/harness.moving/cli/data/dial-setup.json', before: null },
  { did: 'aside', path: '/h/.local/share/harness.moving/cli/data/.adopted', aside: '/h/.local/share/harness.moving/cli/data/.adopted.before-move' },
  { did: 'link', path: '/h/.local/bin/hn', before: '/h/.harness/bin/hn' },
  { did: 'reload' },
  { did: 'pane', id: '%3' },
  { did: 'commit', root: 'state' },
  { did: 'commit', root: 'data' },
  { did: 'bridge' },
]

describe('the move\'s journal', () => {
  it('each step is on disk before the next begins, a file\'s previous bytes beside it; a pane\'s line is flushed with the next', () => {
    const { home, legacy } = legacyHome()
    const opened = new Map<number, string>(), calls: string[] = []
    const io: OpenIo = {
      ...NODE_FS,
      openSync: ((path: string, flags: string, mode?: number) => {
        const fd = fs.openSync(path, flags, mode)
        opened.set(fd, basename(path))
        return fd
      }) as typeof fs.openSync,
      fsyncSync: (fd) => {
        calls.push(`sync ${opened.get(fd)}`)
        fs.fsyncSync(fd)
      },
      renameSync: (from, to) => {
        calls.push(`rename ${basename(String(from))} ${basename(String(to))}`)
        fs.renameSync(from, to)
      },
    }
    const journal = journalOf(home)
    const open = openJournal(journal, io)
    expect(readJournal(legacy)).toEqual(journal)
    STEPS.forEach((step, at) => {
      open.add(step)
      expect(readJournal(legacy)).toEqual({ ...journal, done: STEPS.slice(0, at + 1) })
    })
    expect(calls).toEqual([
      // Its head: a draft synced, renamed into place, and the rename synced in the folder.
      'sync .move.json.next', 'rename .move.json.next .move.json', 'sync .harness',
      'sync .move.json',
      // registry.json's previous bytes, kept beside the journal as its second step's.
      'sync 1', 'sync .move-before', 'sync .move.json',
      'sync .move.json', 'sync .move.json', 'sync .move.json', 'sync .move.json',
      // None for the pane: a power cut that loses its line ends the pane too.
      'sync .move.json', 'sync .move.json', 'sync .move.json',
    ])
    expect(readFileSync(join(legacy, '.move-before', '1'), 'utf8')).toBe('{"agents":[]}')
  })

  it('a step writes itself, not the journal again: what an add writes does not grow with the steps before it', () => {
    const { home } = legacyHome()
    const written: number[] = []
    let adding = false
    const io: OpenIo = {
      ...NODE_FS,
      writeFileSync: ((file: number, data: string | Uint8Array) => {
        if (adding) written[written.length - 1] += Buffer.byteLength(data)
        fs.writeFileSync(file, data)
      }) as typeof fs.writeFileSync,
    }
    const open = openJournal(journalOf(home), io)
    const before = Buffer.alloc(4_000, 'x').toString('base64')
    for (let at = 0; at < 50; at++) {
      written.push(0)
      adding = true
      open.add({ did: 'file', path: `/h/.local/share/harness.moving/cli/data/stopped-agents/${at}.json`, before })
      adding = false
    }
    expect(Math.max(...written)).toBeLessThan(5_000)
  })

  it('a journal cut off mid-write reads as the steps whole before it, and a step added after the cut is read', () => {
    const { home, legacy } = legacyHome()
    let writes = 0
    const io: OpenIo = {
      ...NODE_FS,
      writeFileSync: ((file: number, text: string) => {
        writes += 1
        if (writes !== 3) return fs.writeFileSync(file, text)
        fs.writeFileSync(file, text.slice(0, 20))
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }) as typeof fs.writeFileSync,
    }
    const journal = journalOf(home)
    const open = openJournal(journal, io)
    open.add(STEPS[0])
    expect(() => open.add(STEPS[4])).toThrow('no space left on device')
    expect(readJournal(legacy)).toEqual({ ...journal, done: [STEPS[0]] })
    // A crash cuts a line short too.
    appendFileSync(join(legacy, '.move.json'), '\n{"did":"pa')
    expect(readJournal(legacy)).toEqual({ ...journal, done: [STEPS[0]] })
    // The next start finishes it, adding to what it read.
    openJournal(readJournal(legacy)!, NODE_FS).add(STEPS[9])
    expect(readJournal(legacy)).toEqual({ ...journal, done: [STEPS[0], STEPS[9]] })
  })

  it('no journal reads as none, and one forgotten leaves nothing of it', () => {
    const { home, legacy } = legacyHome()
    expect(readJournal(legacy)).toBeNull()
    openJournal(journalOf(home)).add(STEPS[1])
    forgetJournal(legacy)
    expect(readJournal(legacy)).toBeNull()
    expect(readdirSync(legacy)).toEqual([])
  })

  // The previous bytes go first, the journal last (forgetJournal): a crash between them leaves a journal whose steps all
  // ran, finished or undone. Read as one, it would never be finished, and keep ~/.harness from reading as the bridge.
  it('a forget a crash cut short, its previous bytes gone and the journal left, reads as none, and is finished', () => {
    const { home, legacy } = legacyHome()
    openJournal(journalOf(home)).add(STEPS[1])
    fs.rmSync(join(legacy, '.move-before'), { recursive: true })
    expect(readJournal(legacy)).toBeNull()
    expect(readdirSync(legacy)).toEqual([])
  })

  it('it is the account\'s own', () => {
    const { home, legacy } = legacyHome()
    openJournal(journalOf(home)).add(STEPS[1])
    const mode = (...path: string[]): number => statSync(join(legacy, ...path)).mode & 0o777
    expect([mode('.move.json'), mode('.move-before'), mode('.move-before', '0')]).toEqual([0o600, 0o700, 0o600])
  })

  it('a write whose draft cannot be removed after a failed rename throws the rename\'s error', () => {
    const { legacy } = legacyHome(), denied = Object.assign(new Error('EACCES: fixture'), { code: 'EACCES' })
    heldDrafts()
    // fs.rmSync is read once held.
    const io: OpenIo = { ...NODE_FS, rmSync: fs.rmSync, renameSync: () => { throw denied } }
    expect(thrown(() => writeWhole(join(legacy, '.move.json'), '{}', io))).toBe(denied)
  })

  it('a folder at a draft\'s name is not the write\'s: it stays, and the write\'s error is thrown', () => {
    const { legacy } = legacyHome(), draft = draftOf(join(legacy, '.move.json'))
    mkdirSync(draft)
    writeFileSync(join(draft, 'notes.txt'), 'mine')
    expect(thrown(() => writeWhole(join(legacy, '.move.json'), '{}'))).toMatchObject({ code: 'EISDIR' })
    expect(readFileSync(join(draft, 'notes.txt'), 'utf8')).toBe('mine')
  })

  it('a draft a crash left in ~/.harness is not one of its entries', () => {
    expect(planMove('/h', {}, ['.move.json.next', 'cli', 'home-move.json.next']).entries.flatMap((entry) => entry.present ? [entry.name] : [])).toEqual(['cli'])
  })
})
