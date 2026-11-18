import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openJournal, readJournal, type Done, type Journal, type JournalIo } from './journal.js'
import { planMove } from './plan.js'

const NODE_FS: JournalIo = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, renameSync: fs.renameSync, rmSync: fs.rmSync }

function legacyHome(): { home: string; legacy: string } {
  const home = mkdtempSync(join(tmpdir(), 'move-journal-'))
  mkdirSync(join(home, '.harness'))
  return { home, legacy: join(home, '.harness') }
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
  it('each step is on disk before the next begins', () => {
    const { home, legacy } = legacyHome()
    const opened = new Map<number, string>(), calls: string[] = []
    const io: JournalIo = {
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
    // Each write: its draft synced, renamed into place, and the rename synced in the folder.
    const write = ['sync .move.json.next', 'rename .move.json.next .move.json', 'sync .harness']
    expect(calls).toEqual(Array.from({ length: STEPS.length + 1 }, () => write).flat())
  })

  it('a journal cut off mid-write reads as the last whole one', () => {
    const { home, legacy } = legacyHome()
    let writes = 0
    const io: JournalIo = {
      ...NODE_FS,
      writeFileSync: ((file: number, text: string) => {
        writes += 1
        if (writes < 3) return fs.writeFileSync(file, text)
        fs.writeFileSync(file, text.slice(0, 40))
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }) as typeof fs.writeFileSync,
    }
    const journal = journalOf(home)
    const open = openJournal(journal, io)
    open.add(STEPS[0])
    expect(() => open.add(STEPS[1])).toThrow('no space left on device')
    expect(readJournal(legacy)).toEqual({ ...journal, done: [STEPS[0]] })
    // A crash leaves its draft cut short: it is never read.
    writeFileSync(join(legacy, '.move.json.next'), '{"version":1,"startedAt":17')
    expect(readJournal(legacy)).toEqual({ ...journal, done: [STEPS[0]] })
  })

  it('no journal reads as none', () => {
    const { home, legacy } = legacyHome()
    expect(readJournal(legacy)).toBeNull()
    const open = openJournal(journalOf(home))
    open.add(STEPS[0])
    open.close()
    expect(readJournal(legacy)).toBeNull()
    expect(readdirSync(legacy)).toEqual([])
  })

  it('it is the account\'s own', () => {
    const { home, legacy } = legacyHome()
    openJournal(journalOf(home)).add(STEPS[1])
    expect(statSync(join(legacy, '.move.json')).mode & 0o777).toBe(0o600)
  })

  it('a draft a crash left in ~/.harness is not one of its entries', () => {
    expect(planMove('/h', {}, ['.move.json.next', 'cli', 'home-move.json.next']).entries.map((entry) => entry.name)).toEqual(['cli'])
  })
})
