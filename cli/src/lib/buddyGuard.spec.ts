import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inspect } from 'node:util'
import { basename, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { artifactLinks, buddyAccountFile, buddyGrantLive, buddyLaunchFile, buddyLaunchOf, buddyReadsOf, forgetBuddyReads, grantBuddyWide,
  heldByOldGuard, listSentToOldGuard, revokeBuddyWide, SentListsError, writeBuddyAccount, type BuddyReads } from './buddyGuard.js'

// What is left of a Buddy's guard (task #2832): each Buddy session's list, which holds its owner's grant, and its end.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'buddy-guard-')))
afterAll(() => rmSync(parent, { recursive: true, force: true }))

// The mark beside [list] that [session] listed in it, which its end finds by name (follow-up to #2248).
const mark = (list: string, session: string) => `${list.replace(/\.json$/, '')}.${createHash('sha256').update(session).digest('hex')}.owner`

describe('a Buddy session\'s list', () => {
  const lists = join(parent, 'lists')
  const mine: BuddyReads = { file: join(lists, 'mine.json') }
  const held = () => JSON.parse(readFileSync(mine.file, 'utf8'))
  const granted = (session: string, at: number) => ({ session, account: 'person-1', launch: 'launch-1', at })
  const grant = (reads: BuddyReads, session: string, at = Date.now()) =>
    grantBuddyWide(reads, { session, wide: true, account: 'person-1', launch: 'launch-1' }, at)
  beforeEach(() => rmSync(lists, { recursive: true, force: true }))
  // Follow-up to #2389's security re-check 2: the host logs what an end failed with, and a filesystem error's message names
  // its path, under the person's home. It fails by fixed codes alone, carrying nothing of the error it caught.
  const failsWith = (session: string, codes: string[]) => {
    let thrown: unknown
    try { forgetBuddyReads(session, lists) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(SentListsError)
    expect((thrown as SentListsError).codes).toEqual(codes)
    expect((thrown as Error).message).toBe(codes.join(', '))
    expect((thrown as Error).cause).toBeUndefined()
    expect(inspect(thrown)).not.toContain(parent)
  }

  it('is kept for each Buddy session apart, in Harness\'s data folder', () => {
    expect(buddyReadsOf('session-key')).toEqual({
      file: join(process.env.ADAPTER_DATA_DIR!, 'buddy-reads', '1add55581aaea687f8c5e7919f217cb6640cba7d2c14e7e4d6d4df21460642cf.json') })
    expect(buddyReadsOf('another-session').file).not.toBe(buddyReadsOf('session-key').file)
  })

  it('holds the grant for its session, mode 600 in a folder of mode 700, with its session\'s mark beside it', () => {
    grant(mine, 'harness-1', 1_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', wide: granted('harness-1', 1_000) })
    expect(lstatSync(mine.file).mode & 0o777).toBe(0o600)
    expect(lstatSync(lists).mode & 0o777).toBe(0o700)
    expect(readdirSync(lists).sort()).toEqual([basename(mark(mine.file, 'harness-1')), 'mine.json'].sort())
    expect(readFileSync(mark(mine.file, 'harness-1'), 'utf8')).toBe('')
    expect(lstatSync(mark(mine.file, 'harness-1')).mode & 0o777).toBe(0o600)
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    expect(held()).toEqual({ version: 1, session: 'harness-1', wide: false })
  })

  it('starts again from an unreadable list rather than failing the delivery', () => {
    mkdirSync(lists)
    writeFileSync(mine.file, '{"wide": ')
    grant(mine, 'harness-1', 1_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', wide: granted('harness-1', 1_000) })
  })

  // A list an older release wrote also holds the files, links and approvals of the guard: nothing reads them, and they go.
  it('keeps nothing of an older release\'s list but its grant', () => {
    mkdirSync(lists)
    writeFileSync(mine.file, JSON.stringify({ version: 1, session: 'harness-1', files: [{ path: '/x', at: 1 }], links: [{ url: 'https://claude.ai/artifact/a', at: 1 }],
      approvals: '/approvals.json', wide: granted('harness-1', 1_000) }))
    revokeBuddyWide(mine)
    expect(held()).toEqual({ version: 1, session: 'harness-1', wide: false })
  })

  it('removes the lists of other Buddy sessions untouched for a day, and the marks of lists that are gone, and keeps the rest', () => {
    const DAY = 24 * 60 * 60 * 1000, at = Date.now()
    mkdirSync(lists)
    for (const name of ['old.json', 'old.json.0d1e.tmp', 'recent.json']) writeFileSync(join(lists, name), '{}')
    // A mark stays as long as its list does, however old, so the list's session still finds it; one whose list is gone goes.
    const kept = mark(join(lists, 'recent.json'), 'harness-2'), orphan = mark(join(lists, 'gone.json'), 'harness-3')
    for (const file of [kept, orphan]) writeFileSync(file, '')
    for (const file of [join(lists, 'old.json'), join(lists, 'old.json.0d1e.tmp'), kept]) utimesSync(file, new Date(at - DAY - 1_000), new Date(at - DAY - 1_000))
    grant(mine, 'harness-1', at)
    expect(readdirSync(lists).sort()).toEqual([basename(mark(mine.file, 'harness-1')), basename(kept), 'mine.json', 'recent.json'].sort())
  })

  it('keeps nothing another session listed under the same key', () => {
    grant(mine, 'harness-0', 1_000)
    grantBuddyWide(mine, { session: 'harness-1', wide: false }, 2_000)
    expect(held()).toEqual({ version: 1, session: 'harness-1', wide: false })
  })

  // Lead, 10-30: a Buddy removed, or its chat purged with its project, keeps nothing listed until the day is out. The Swarm
  // closes its session then (superTabs/host.ts endSession), and that session's lists go.
  // Follow-up to #2248 (Lead, 10-30): an end removes its own session's lists and nothing else, so nothing but its own holds it
  // back. One naming no session beside no mark is no session's: the host writes none, and the day's sweep removes it.
  it('forgets the lists a session the Swarm ended marked or names, and keeps every other session\'s and those that are no session\'s', () => {
    const theirs = { file: join(lists, 'theirs.json') }
    grant(mine, 'harness-1')
    grant(theirs, 'harness-2')
    // From before lists were marked: it names its session.
    writeFileSync(join(lists, 'unmarked.json'), JSON.stringify({ version: 1, session: 'harness-1', wide: granted('harness-1', Date.now()) }))
    writeFileSync(join(lists, 'broken.json'), '{"session": ')
    writeFileSync(join(lists, 'null.json'), 'null')
    writeFileSync(join(lists, 'nameless.json'), JSON.stringify({ version: 1, wide: granted('harness-1', Date.now()) }))
    writeFileSync(join(lists, 'note.txt'), 'harness-1')
    forgetBuddyReads('harness-1', lists)
    const left = [basename(mark(theirs.file, 'harness-2')), 'broken.json', 'nameless.json', 'note.txt', 'null.json', 'theirs.json'].sort()
    expect(readdirSync(lists).sort()).toEqual(left)
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists).sort()).toEqual(left)
  })

  // Follow-up to #2248 (Lead, 10-30): whose a list was that could not be read could not be told, so it held back the end of
  // every Buddy session on the machine. The mark beside a list says whose it is by its name alone: a session's own goes
  // unread, and another session's is that session's to remove.
  it('removes its own list even where it cannot be read, by the mark beside it, and fails nothing on another session\'s it cannot read', () => {
    const theirs = { file: join(lists, 'theirs.json') }
    grant(mine, 'harness-1')
    grant(theirs, 'harness-2')
    for (const list of [mine, theirs]) chmodSync(list.file, 0o000)
    try {
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(mine.file)).toBe(false)
      expect(existsSync(mark(mine.file, 'harness-1'))).toBe(false)
      expect(existsSync(theirs.file)).toBe(true)
      expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
      expect(readdirSync(lists)).toEqual([])
    } finally { for (const list of [mine, theirs]) if (existsSync(list.file)) chmodSync(list.file, 0o600) }
  })

  // Follow-up to #2248 (Lead, 10-30): a list that cannot be removed holds back its own session's end, and no other.
  it('fails the end of only the session whose own list it cannot remove, and keeps that list\'s mark to try again', () => {
    const theirs = { file: join(lists, 'theirs.json') }
    grant(mine, 'harness-1')
    grant(theirs, 'harness-2')
    // Their list can be neither removed, nor written over, nor read: a folder stands in its place, as a file the system will
    // not let go of would (one held open, on Windows).
    rmSync(theirs.file); mkdirSync(join(theirs.file, 'held'), { recursive: true })
    try {
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(mine.file)).toBe(false)
      failsWith('harness-2', ['SENT_LIST_KEPT'])
      expect(existsSync(mark(theirs.file, 'harness-2'))).toBe(true)
    } finally { rmSync(theirs.file, { recursive: true, force: true }) }
    expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('fails while the mark beside its own list cannot be removed, though the list is gone, and passes once it can', () => {
    grant(mine, 'harness-1')
    const own = mark(mine.file, 'harness-1')
    rmSync(own); mkdirSync(join(own, 'held'), { recursive: true })
    try {
      failsWith('harness-1', ['SENT_LIST_MARK_KEPT'])
      expect(existsSync(mine.file)).toBe(false)
    } finally { rmSync(own, { recursive: true, force: true }) }
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('keeps, at an earlier session\'s end, the list a later session wrote under the same key', () => {
    grant(mine, 'harness-0')
    grant(mine, 'harness-1')
    forgetBuddyReads('harness-0', lists)
    expect(held().session).toBe('harness-1')
    expect(existsSync(mark(mine.file, 'harness-0'))).toBe(false)
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  it('grants nothing when it cannot mark whose the list is', () => {
    mkdirSync(mark(mine.file, 'harness-1'), { recursive: true })
    expect(() => grant(mine, 'harness-1')).toThrow()
    expect(existsSync(mine.file)).toBe(false)
  })

  // Re-check 2 of #2248: a list the host cannot delete must still grant nothing, and the failure must reach the host, which
  // tries again before it acknowledges the end of the session.
  it('empties a list it cannot delete, so it grants nothing, fails so it is tried again, and deletes it then', () => {
    grant(mine, 'harness-1')
    chmodSync(lists, 0o500)
    try {
      failsWith('harness-1', ['SENT_LIST_KEPT'])
      expect(existsSync(mine.file)).toBe(true)
      expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
      expect(held()).toEqual({ version: 1, session: 'harness-1' })
    } finally { chmodSync(lists, 0o700) }
    forgetBuddyReads('harness-1', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  // Security reviews of #2261, folded into #2310 (Lead, 10-30): every writer of a session's list marks it first, so a list
  // that cannot be read still holds back its own session's end, and only that one.
  const writers: Array<[string, (session: string) => void]> = [
    ['grantBuddyWide, granting', (session) => grant(mine, session)],
    ['grantBuddyWide, taking back', (session) => grantBuddyWide(mine, { session, wide: false })],
    ['revokeBuddyWide', (session) => { grant(mine, session); rmSync(mark(mine.file, session)); revokeBuddyWide(mine) }],
  ]
  it.each(writers)('marks the list %s writes, so its session\'s end finds it unread, holds back on it alone, and removes it', (_, write) => {
    write('harness-1')
    expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
    chmodSync(mine.file, 0o000)
    chmodSync(lists, 0o500)
    try {
      expect(() => forgetBuddyReads('harness-2', lists)).not.toThrow()
      failsWith('harness-1', ['SENT_LIST_KEPT'])
      expect(existsSync(mine.file)).toBe(true)
    } finally { chmodSync(lists, 0o700) }
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('fails on a list it cannot read with no session\'s mark beside it, as before, and skips one beside another session\'s mark', () => {
    const orphan = join(lists, 'orphan.json')
    mkdirSync(lists, { recursive: true })
    // Another session's list, which that session's own end removes: here its mark is not written yet.
    writeFileSync(orphan, JSON.stringify({ version: 1, session: 'harness-2' }))
    chmodSync(orphan, 0o000)
    try {
      failsWith('harness-1', ['SENT_LIST_UNREAD'])
      expect(existsSync(orphan)).toBe(true)
      writeFileSync(mark(orphan, 'harness-2'), '')
      expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
      expect(existsSync(orphan)).toBe(true)
    } finally { chmodSync(orphan, 0o600) }
    forgetBuddyReads('harness-2', lists)
    expect(readdirSync(lists)).toEqual([])
  })

  it('writes the mark only as a file of its own: never through a link, and keeps one already there', () => {
    mkdirSync(lists, { recursive: true })
    const elsewhere = join(parent, 'elsewhere-target.txt')
    writeFileSync(elsewhere, 'untouched')
    // Beside no list, the sweep before each write removes the link itself, never what it points to.
    symlinkSync(elsewhere, mark(mine.file, 'harness-1'))
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
    expect(lstatSync(mark(mine.file, 'harness-1')).isFile()).toBe(true)
    // Beside its list, which the sweep keeps it for, the write refuses it.
    rmSync(mark(mine.file, 'harness-1'))
    symlinkSync(elsewhere, mark(mine.file, 'harness-1'))
    try {
      expect(() => grantBuddyWide(mine, { session: 'harness-1', wide: false })).toThrow()
      expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
    } finally { rmSync(mark(mine.file, 'harness-1')); rmSync(elsewhere) }
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    expect(lstatSync(mark(mine.file, 'harness-1')).isFile()).toBe(true)
    expect(held()).toMatchObject({ session: 'harness-1', wide: false })
  })

  it('takes the marks of other sessions away from a list a session writes', () => {
    grant(mine, 'harness-0')
    grantBuddyWide(mine, { session: 'harness-1', wide: false })
    expect(existsSync(mark(mine.file, 'harness-0'))).toBe(false)
    expect(existsSync(mark(mine.file, 'harness-1'))).toBe(true)
    // The earlier session's end no longer finds the list as its own.
    forgetBuddyReads('harness-0', lists)
    expect(held().session).toBe('harness-1')
  })

  // Follow-up to #2389's security re-check 2: a lists folder that could not be read threw the read's own error, its path with
  // it, into the daemon's log. It fails by its kind alone, deletes nothing, and the end is tried again.
  it('fails by a fixed code, with no path, when the lists folder cannot be read, deletes nothing, and finishes once it can', () => {
    grant(mine, 'harness-1')
    const before = readdirSync(lists).sort()
    chmodSync(lists, 0o000)
    try {
      failsWith('harness-1', ['SENT_LISTS_UNREAD'])
    } finally { chmodSync(lists, 0o700) }
    expect(readdirSync(lists).sort()).toEqual(before)
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(readdirSync(lists)).toEqual([])
  })

  it('names each kind of failure once, in a fixed order, when an end meets several', () => {
    grant(mine, 'harness-1')
    const orphans = ['orphan-a.json', 'orphan-b.json'].map(name => join(lists, name))
    for (const orphan of orphans) { writeFileSync(orphan, JSON.stringify({ version: 1, session: 'harness-2' })); chmodSync(orphan, 0o000) }
    chmodSync(lists, 0o500)
    try {
      failsWith('harness-1', ['SENT_LIST_UNREAD', 'SENT_LIST_KEPT'])
      for (const file of [mine.file, ...orphans]) expect(existsSync(file)).toBe(true)
    } finally { chmodSync(lists, 0o700); for (const orphan of orphans) chmodSync(orphan, 0o600) }
  })

  it('forgets nothing, and fails nothing, where no list was ever written', () => {
    expect(() => forgetBuddyReads('harness-1', lists)).not.toThrow()
    expect(existsSync(lists)).toBe(false)
  })
})

// Security reviews 1 and 2 of #2310, and #2626: the host grants a Buddy session its owner's presence at each of its owner's
// own messages, on their own machine; a relay to its owner's own sessions holds only while that grant does
// (messages/service.ts). A grant is for this launch, this account, this session and an hour.
describe('the owner\'s grant', () => {
  const dataDir = join(parent, 'grant-data'), folder = join(parent, 'grant-folder')
  const reads: BuddyReads = { file: join(dataDir, 'buddy-reads', 'session.json') }
  const accountFile = buddyAccountFile(dataDir)
  const grantFor = (at = Date.now()) => ({ session: 'harness', account: 'person-1', launch: 'launch-1', at })
  const grant = (at = Date.now()) => grantBuddyWide(reads, { session: 'harness', wide: true, account: 'person-1', launch: 'launch-1' }, at)
  const live = (at = Date.now()) => buddyGrantLive(reads, folder, at, accountFile)
  beforeEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(buddyLaunchFile(folder), 'launch-1\n')
    writeBuddyAccount('person-1', dataDir)
    grant()
  })

  it('holds once its owner has written, for this launch, this account and an hour', () => {
    expect(live()).toBe(true)
    expect(live(Date.now() + 59 * 60_000)).toBe(true)
    expect(live(Date.now() + 61 * 60_000)).toBe(false)
  })

  it.each([
    ['no list at all', () => rmSync(reads.file, { force: true })],
    ['a list with no grant', () => writeFileSync(reads.file, JSON.stringify({ version: 1, session: 'harness' }))],
    ['a grant taken back', () => grantBuddyWide(reads, { session: 'harness', wide: false })],
    ['an unreadable list', () => writeFileSync(reads.file, 'not json')],
    ['a grant from before a relaunch', () => grantBuddyWide(reads, { session: 'harness', wide: true, account: 'person-1', launch: 'launch-0' })],
    ['a grant for another account', () => grantBuddyWide(reads, { session: 'harness', wide: true, account: 'person-2', launch: 'launch-1' })],
    ['a grant over an hour old', () => grant(Date.now() - 61 * 60_000)],
    ['a grant dated ahead', () => grant(Date.now() + 10 * 60_000)],
    ['a grant naming another session than its list', () => writeFileSync(reads.file, JSON.stringify({ version: 1, session: 'harness',
      wide: { ...grantFor(), session: 'harness-0' } }))],
    ['a grant as it was written before (wide: true)', () => writeFileSync(reads.file, JSON.stringify({ version: 1, session: 'harness', wide: true }))],
    ['nobody signed in on this machine', () => writeBuddyAccount(null, dataDir)],
    ['another account signed in on this machine', () => writeBuddyAccount('person-2', dataDir)],
    ['an unreadable account file', () => writeFileSync(accountFile, 'not json')],
    ['the folder launched again', () => writeFileSync(buddyLaunchFile(folder), 'launch-2\n')],
    ['no launch id in its folder', () => rmSync(buddyLaunchFile(folder))],
  ])('holds nothing with %s', (_, set) => {
    set()
    expect(live()).toBe(false)
  })

  // Spec 2026-10-30-buddy-thread-sessions: a thread session is a Buddy of its own, in a worktree of its own. Its grant is its
  // own, at its own launch.
  it('gives a thread session no grant from the main session\'s, and the main session none from its own', () => {
    const folderB = join(parent, 'grant-folder-b'), readsB: BuddyReads = { file: join(dataDir, 'buddy-reads', 'session-b.json') }
    mkdirSync(join(folderB, '.claude'), { recursive: true })
    writeFileSync(buddyLaunchFile(folderB), 'launch-b\n')
    const liveB = () => buddyGrantLive(readsB, folderB, Date.now(), accountFile)
    expect([live(), liveB()]).toEqual([true, false])
    // The main session's list copied as its own still names the main session's launch: no grant.
    writeFileSync(readsB.file, readFileSync(reads.file, 'utf8'))
    expect(liveB()).toBe(false)
    // Its own grant, written at its own person's message: and the main session's taken back changes nothing for it.
    grantBuddyWide(readsB, { session: 'harness-b', wide: true, account: 'person-1', launch: 'launch-b' })
    expect(liveB()).toBe(true)
    revokeBuddyWide(reads)
    expect([live(), liveB()]).toEqual([false, true])
    // Its grant written into the main session's list names its own launch: the main session still has none.
    writeFileSync(reads.file, readFileSync(readsB.file, 'utf8'))
    expect(live()).toBe(false)
  })

  // Delta reviews of #2310: each launch takes back the grant its session's list held.
  it('is taken back at launch, keeping the list\'s session, and leaves no list where there was none', () => {
    revokeBuddyWide(reads)
    expect(JSON.parse(readFileSync(reads.file, 'utf8'))).toEqual({ version: 1, session: 'harness', wide: false })
    expect(live()).toBe(false)
    rmSync(reads.file)
    revokeBuddyWide(reads)
    expect(existsSync(reads.file)).toBe(false)
  })
})

describe('a Buddy\'s launch id', () => {
  const folder = join(parent, 'launch-folder')
  it('is what its folder holds, trimmed, and none where it holds nothing', () => {
    expect(buddyLaunchOf(folder)).toBeNull()
    mkdirSync(join(folder, '.claude'), { recursive: true })
    expect(buddyLaunchFile(folder)).toBe(join(folder, '.claude', 'buddy-launch'))
    writeFileSync(buddyLaunchFile(folder), 'launch-1\n')
    expect(buddyLaunchOf(folder)).toBe('launch-1')
    writeFileSync(buddyLaunchFile(folder), ' \n')
    expect(buddyLaunchOf(folder)).toBeNull()
  })
})

describe('the Artifact links in a message', () => {
  it.each([
    ['a plain link', 'See https://claude.ai/artifact/abc-123', ['https://claude.ai/artifact/abc-123']],
    ['a link in Markdown, and one at the end of a sentence', '[the plan](https://claude.ai/artifact/abc-123) and https://claude.ai/code/artifact/0b7e-8f2c.',
      ['https://claude.ai/artifact/abc-123', 'https://claude.ai/code/artifact/0b7e-8f2c']],
    ['a link with a query, a fragment or a trailing slash, as its artifact', 'https://claude.ai/artifact/a?v=2 https://claude.ai/artifact/b#top https://claude.ai/artifact/c/',
      ['https://claude.ai/artifact/a', 'https://claude.ai/artifact/b', 'https://claude.ai/artifact/c']],
    ['the preview site, and a host in capitals', 'https://preview.claude.ai/artifact/p1 HTTPS://CLAUDE.AI/artifact/p2',
      ['https://preview.claude.ai/artifact/p1', 'https://claude.ai/artifact/p2']],
    ['one link sent twice', 'https://claude.ai/artifact/x and again https://claude.ai/artifact/x', ['https://claude.ai/artifact/x']],
    ['no look-alikes', 'http://claude.ai/artifact/a https://claude.ai.example.com/artifact/b https://evil.claude.ai/artifact/c '
      + 'https://claude.ai:8443/artifact/d https://me@claude.ai/artifact/e https://claude.ai/artifact/f/files https://claude.ai/chat/g '
      + 'claude.ai/artifact/h https://claude.ai/artifact/i%2F..', []],
  ])('finds %s', (_, text, links) => {
    expect(artifactLinks(text)).toEqual(links)
  })

  it('finds at most 50', () => {
    const text = Array.from({ length: 55 }, (_, i) => `https://claude.ai/artifact/l${i}`).join(' ')
    expect(artifactLinks(text)).toEqual(Array.from({ length: 50 }, (_, i) => `https://claude.ai/artifact/l${i}`))
  })
})

// Task #3159: a Buddy launched before #2832 still runs that release's guard, which opens only what the host listed. The guard
// itself runs in superTabs/host.spec.ts; these pin the list it reads.
describe('the list for a Buddy on the guard before #2832', () => {
  const lists = join(parent, 'old-guard-lists'), drops = join(parent, 'drops'), reads: BuddyReads = { file: join(lists, 'old.json') }
  const LINK = 'https://claude.ai/artifact/abc'
  const held = () => JSON.parse(readFileSync(reads.file, 'utf8'))
  beforeEach(() => { rmSync(lists, { recursive: true, force: true }); rmSync(drops, { recursive: true, force: true }); mkdirSync(drops) })
  const drop = (name: string, text = 'png') => { const path = join(drops, name); writeFileSync(path, text); return path }

  it('lists a file in the downloads by its path, device, inode, size and bytes, and an Artifact link as itself', () => {
    const shot = drop('a-screen.png')
    listSentToOldGuard(reads, { session: 's1', files: [shot], links: [LINK] }, 1_000, drops)
    const stat = lstatSync(shot, { bigint: true })
    expect(held()).toEqual({ version: 1, session: 's1', files: [{ path: shot, dev: String(stat.dev), ino: String(stat.ino), size: '3',
      sha256: createHash('sha256').update('png').digest('hex'), at: 1_000 }], links: [{ url: LINK, at: 1_000 }] })
  })
  it('lists nothing outside the downloads, through a link, with a second name, or a link that is not an Artifact\'s own', () => {
    const outside = join(parent, 'outside.txt'); writeFileSync(outside, 'secret')
    const linked = join(drops, 'b-linked.png'); symlinkSync(outside, linked)
    const nested = join(drops, 'sub'); mkdirSync(nested); writeFileSync(join(nested, 'c.png'), 'png')
    listSentToOldGuard(reads, { session: 's1', files: [outside, linked, join(nested, 'c.png'), `${drops}/../outside.txt`],
      links: [`${LINK}?x=1`, 'https://example.com/artifact/abc'] }, 1_000, drops)
    expect(existsSync(reads.file)).toBe(false)
  })
  it('keeps what it listed through a grant and its revoke, for a day, and only for its own session', () => {
    const shot = drop('d-screen.png'), now = Date.now()
    listSentToOldGuard(reads, { session: 's1', files: [shot], links: [] }, now, drops)
    grantBuddyWide(reads, { session: 's1', wide: true, account: 'person-1', launch: 'launch-1' }, now + 1)
    expect(held().files.map((file: { path: string }) => file.path)).toEqual([shot])
    revokeBuddyWide(reads)
    expect(held().files.map((file: { path: string }) => file.path)).toEqual([shot])
    // A day on, the download is gone, and so is its entry.
    grantBuddyWide(reads, { session: 's1', wide: false }, now + 24 * 60 * 60 * 1000)
    expect(held()).toEqual({ version: 1, session: 's1', wide: false })
    // Another session listing under the same key starts from nothing.
    listSentToOldGuard(reads, { session: 's1', files: [shot], links: [] }, now, drops)
    grantBuddyWide(reads, { session: 's2', wide: false }, now + 1)
    expect(held()).toEqual({ version: 1, session: 's2', wide: false })
  })
  it('lists a file sent again once, by its newest bytes', () => {
    const shot = drop('e-screen.png')
    listSentToOldGuard(reads, { session: 's1', files: [shot], links: [] }, 1_000, drops)
    writeFileSync(shot, 'PNG2')
    listSentToOldGuard(reads, { session: 's1', files: [shot], links: [] }, 2_000, drops)
    expect(held().files).toEqual([expect.objectContaining({ path: shot, size: '4', at: 2_000 })])
  })
  it('knows the older release\'s lock by its guard and the settings that name it, and nothing else', () => {
    const root = join(parent, 'locked'), claude = join(root, '.claude')
    mkdirSync(claude, { recursive: true })
    expect(heldByOldGuard(root)).toBe(false)
    writeFileSync(join(claude, 'buddy-guard.mjs'), '// guard')
    writeFileSync(join(claude, 'settings.local.json'), '{"hooks":{}}')
    // A project's own settings that do not name this folder's guard are not Harness's lock.
    expect(heldByOldGuard(root)).toBe(false)
    writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ command: join(claude, 'buddy-guard.mjs') }))
    expect(heldByOldGuard(root)).toBe(true)
    writeFileSync(join(parent, 'elsewhere.mjs'), '// guard'); rmSync(join(claude, 'buddy-guard.mjs')); symlinkSync(join(parent, 'elsewhere.mjs'), join(claude, 'buddy-guard.mjs'))
    expect(heldByOldGuard(root)).toBe(false)
  })
})
