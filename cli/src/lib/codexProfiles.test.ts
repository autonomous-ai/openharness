import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type * as CodexProfilesModule from './codexProfiles.js'

// Pass-through, recording what the shared writer does on disk: the renames and the opens.
// And a read of [failRead] fails, as EMFILE (too many open files) does for a moment.
const disk = vi.hoisted(() => ({ events: [] as string[], failRead: '' }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (disk.failRead && args[0] === disk.failRead) throw Object.assign(new Error('EMFILE: fixture'), { code: 'EMFILE' })
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      disk.events.push(`rename ${String(args[1])}`)
      return actual.renameSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      disk.events.push(`open ${String(args[0])}`)
      return actual.openSync(...args)
    },
  }
})

const host = vi.hoisted(() => ({ win32: false }))
vi.mock('../engines/kit/windowsFiles.js', async original => {
  const actual = await original<typeof import('../engines/kit/windowsFiles.js')>()
  return { ...actual, hostPlatform: () => host.win32 ? 'win32' : actual.hostPlatform() }
})

let dataDir = ''
let home = ''

async function loadModule(): Promise<typeof CodexProfilesModule> {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./codexProfiles.js')
}

const emptyDiscovery = { home: '/nonexistent-empty-home', environment: {} }

/** An absolute path on this host, as a link takes it: a drive letter's on Windows. */
const abs = (name: string): string => process.platform === 'win32' ? `C:\\${name}` : `/${name}`

describe('codexProfiles', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-profiles-data-'))
    // By its real path: resolveCodexProfilePath realpath-resolves everything it returns, and macOS's
    // tmpdir sits behind a /var → /private/var symlink that would otherwise make the resolved path
    // disagree with the literal folder these tests just created. In the temporary folder: made in the home
    // folder, this once made and removed folders in the developer's profile (Windows reads USERPROFILE, not HOME).
    home = realpathSync(mkdtempSync(join(tmpdir(), '.codex-profiles-test-')))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('resolveCodexProfilePath rejects a relative path', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('relative/codex')).toEqual({ error: 'INVALID_PATH' })
  })

  // #4183: on Windows a CODEX_HOME is `C:\\…`, and the check that wanted a leading '/' refused every one.
  it('resolveCodexProfilePath on Windows takes a drive-letter folder and refuses a POSIX one', async () => {
    host.win32 = true
    try {
      const { resolveCodexProfilePath } = await loadModule()
      expect(resolveCodexProfilePath('Z:\\no\\such\\.codex-work')).toEqual({ error: 'NOT_FOUND' })
      expect(resolveCodexProfilePath('/Users/u/.codex-work')).toEqual({ error: 'INVALID_PATH' })
    } finally {
      host.win32 = false
    }
  })

  it('resolveCodexProfilePath rejects a path with control characters', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('/tmp/codex\nhome')).toEqual({ error: 'INVALID_PATH' })
  })

  it('resolveCodexProfilePath rejects a folder that does not exist', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath(join(home, 'nope'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath rejects a path that is a file, not a directory', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const file = join(home, 'not-a-dir')
    writeFileSync(file, '')
    expect(resolveCodexProfilePath(file)).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath accepts and resolves an existing absolute folder', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const folder = join(home, '.codex-work')
    mkdirSync(folder)
    expect(resolveCodexProfilePath(folder)).toEqual({ path: folder, label: '.codex-work' })
  })

  it('linkCodexProfile persists the resolved path on this machine', async () => {
    const { linkCodexProfile } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    expect(linkCodexProfile(folder)).toEqual({ path: folder, label: '.codex-linked' })
    const persisted = JSON.parse(readFileSync(join(dataDir, 'codex-profiles.json'), 'utf8'))
    expect(persisted).toEqual([folder])
  })

  // Windows cannot flush a folder (syncStateDirectory skips it) and has no mode bits to refuse.
  it.skipIf(process.platform === 'win32')('the list is written by the shared helper', async () => {
    const { linkCodexProfile } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    disk.events = []
    linkCodexProfile(folder)
    const renamed = disk.events.indexOf(`rename ${file}`)
    expect(renamed).toBeGreaterThanOrEqual(0)
    expect(disk.events.indexOf(`open ${dataDir}`, renamed)).toBeGreaterThan(renamed)

    chmodSync(file, 0o660)
    expect(() => linkCodexProfile(join(home, '.codex-linked'))).toThrow('state file is group/world writable')
    expect(statSync(file).mode & 0o777).toBe(0o660)
  })

  it('a torn profile list is set aside, not written over', async () => {
    const { linkCodexProfile } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    // What a reader saw while another process was writing it.
    writeFileSync(file, '["/a', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)

    expect(linkCodexProfile(folder)).toEqual({ path: folder, label: '.codex-linked' })

    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('["/a')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([folder])
    expect(warn).toHaveBeenCalledWith(
      '[state] codex-profiles.json could not be read (not valid JSON); kept as codex-profiles.json.unreadable, starting empty.')
  })

  it('a profile list that cannot be read for a moment is not written over', async () => {
    const { linkCodexProfile } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    const kept = join(home, '.codex-kept')
    const folder = join(home, '.codex-linked')
    mkdirSync(kept)
    mkdirSync(folder)
    writeFileSync(file, JSON.stringify([kept]), { mode: 0o600 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    disk.failRead = file
    try {
      expect(() => linkCodexProfile(folder)).toThrow('codex-profiles.json could not be read (EMFILE)')
    } finally { disk.failRead = '' }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([kept])
    expect(existsSync(`${file}.unreadable`)).toBe(false)
  })

  // Windows has no mode bits to refuse.
  it.skipIf(process.platform === 'win32')('a list another account could write is not set aside', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    writeFileSync(file, JSON.stringify([folder]))
    chmodSync(file, 0o664)
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])

    writeFileSync(file, '["/a')
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
    expect(existsSync(`${file}.unreadable`)).toBe(false)
    expect(() => linkCodexProfile(folder)).toThrow('state file is group/world writable')
    expect(readFileSync(file, 'utf8')).toBe('["/a')
  })

  it('linkCodexProfile refuses a folder that does not exist', async () => {
    const { linkCodexProfile } = await loadModule()
    expect(linkCodexProfile(join(home, 'ghost'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('listCodexProfiles returns a previously linked folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    // A link is a folder this machine knows (New Harness makes them).
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-linked' }])
  })

  it('listCodexProfiles drops a linked folder that has since vanished', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    rmSync(folder, { recursive: true, force: true })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })

  it('listCodexProfiles includes observedPaths without requiring them to be linked', async () => {
    const { listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-observed')
    mkdirSync(folder)
    expect(listCodexProfiles([folder], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-observed' }])
  })

  it('listCodexProfiles includes freshly discovered folders', async () => {
    const { listCodexProfiles } = await loadModule()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), '')
    expect(listCodexProfiles([], { home, environment: {} })).toEqual([
      { path: join(home, '.codex'), label: '.codex' },
    ])
  })

  it('listCodexProfiles dedupes linked, observed and discovered copies of the same folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.toml'), '')
    linkCodexProfile(folder)
    expect(listCodexProfiles([folder], { home, environment: {} })).toEqual([{ path: folder, label: '.codex' }])
  })

  it('listCodexProfiles sorts by label (case-insensitive), then by path', async () => {
    const { listCodexProfiles } = await loadModule()
    const b = join(home, '.codex-Beta')
    const a = join(home, '.codex-alpha')
    mkdirSync(a)
    mkdirSync(b)
    expect(listCodexProfiles([a, b], emptyDiscovery)).toEqual([
      { path: a, label: '.codex-alpha' },
      { path: b, label: '.codex-Beta' },
    ])
  })

  it('listCodexProfiles never throws when the state file is malformed', async () => {
    const { listCodexProfiles } = await loadModule()
    writeFileSync(join(dataDir, 'codex-profiles.json'), 'not json', { mode: 0o600 })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })

  // Windows has no mode bits: the data folder's place protects the list there.
  it.skipIf(process.platform === 'win32')('the linked homes are read and the list keeps its mode', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    writeFileSync(file, JSON.stringify(['/a', '/b']))
    chmodSync(file, 0o600)
    expect(readLinkedCodexHomes()).toEqual(['/a', '/b'])

    // The linker's reader makes this one 0o600.
    chmodSync(file, 0o640)
    expect(readLinkedCodexHomes()).toEqual(['/a', '/b'])
    expect(statSync(file).mode & 0o777).toBe(0o640)
  })

  it.skipIf(process.platform === 'win32')('a linked list another account could write names no home', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    writeFileSync(file, JSON.stringify(['/a']))
    for (const mode of [0o660, 0o606]) {
      chmodSync(file, mode)
      expect(readLinkedCodexHomes()).toEqual([])
      expect(statSync(file).mode & 0o777).toBe(mode)
    }
  })

  it.skipIf(process.platform === 'win32')('a link at the linked list names no home', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const elsewhere = join(home, 'elsewhere.json')
    writeFileSync(elsewhere, JSON.stringify(['/a']))
    chmodSync(elsewhere, 0o600)
    symlinkSync(elsewhere, join(dataDir, 'codex-profiles.json'))
    expect(readLinkedCodexHomes()).toEqual([])
  })

  it('a linked list that is not JSON names no home and stays where it is', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    writeFileSync(file, '["/a', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readLinkedCodexHomes()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('["/a')
    expect(existsSync(`${file}.unreadable`)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a missing linked list, or one over 1 MiB, names no home', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    expect(readLinkedCodexHomes()).toEqual([])
    writeFileSync(join(dataDir, 'codex-profiles.json'), JSON.stringify(['/a', 'x'.repeat(1024 * 1024)]), { mode: 0o600 })
    expect(readLinkedCodexHomes()).toEqual([])
  })

  it('a linked list names its first 256 homes', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const listed = Array.from({ length: 300 }, (_, i) => abs(`h${i}`))
    writeFileSync(join(dataDir, 'codex-profiles.json'), JSON.stringify(listed), { mode: 0o600 })
    expect(readLinkedCodexHomes()).toEqual(listed.slice(0, 256))
  })

  // The queue loads the home's config.toml: an entry no link could have written (resolveCodexProfilePath) names none.
  it('a linked list names only absolute homes of at most 4096 characters with no control character', async () => {
    const { readLinkedCodexHomes } = await loadModule()
    const longest = abs('x').padEnd(4096, 'x')
    const listed = [abs('a'), 'relative/b', abs('c\nd'), abs('e\x7f'), longest, `${longest}x`, abs('f')]
    writeFileSync(join(dataDir, 'codex-profiles.json'), JSON.stringify(listed), { mode: 0o600 })
    expect(readLinkedCodexHomes()).toEqual([abs('a'), longest, abs('f')])
  })

  /** As queueHome reads them: each home with its resolved sessions folder. */
  const listed = (...homes: string[]) => homes.map((home) => ({ home, sessions: resolve(home, 'sessions') }))

  it('the trusted homes are the own ones, each also by its real path, then the linked ones as stored, once, deepest first', async () => {
    const { trustedCodexHomes } = await loadModule()
    const real = (path: string) => path === '/o' ? '/private/o' : path === '/gone' ? null : path
    expect(trustedCodexHomes(() => ['/o'], () => 0, () => ['/l'], real)()).toEqual(listed('/private/o', '/o', '/l'))
    // Linked by its real path, and an own home whose real path cannot be read now.
    expect(trustedCodexHomes(() => ['/o', '/gone'], () => 0, () => ['/private/o', '/l'], real)())
      .toEqual(listed('/private/o', '/o', '/gone', '/l'))
  })

  // queueHome takes the first whose sessions folder holds the rollout: a home inside another's is the session's.
  it('a home inside another home\'s sessions folder comes before it, each sessions folder resolved', async () => {
    const { trustedCodexHomes } = await loadModule()
    expect(trustedCodexHomes(() => ['/h/a', '/h/x/../y'], () => 0, () => ['/h/a/sessions/b'], (path) => path)())
      .toEqual([...listed('/h/a/sessions/b', '/h/a'), { home: '/h/x/../y', sessions: resolve('/h/y/sessions') }])
  })

  // linkCodexProfile stores a profile by its real path: a linked home on a dead network volume never blocks a look.
  it('only the own homes are asked their real path, never a linked one', async () => {
    const { trustedCodexHomes } = await loadModule()
    const real = vi.fn((path: string) => path)
    trustedCodexHomes(() => ['/o'], () => 0, () => ['/l1', '/l2'], real)()
    expect(real.mock.calls).toEqual([['/o']])
  })

  it('the own homes are held 1 s, the linked list and the real paths 30 s', async () => {
    const { trustedCodexHomes, OWN_HOMES_MS, TRUSTED_HOMES_MS } = await loadModule()
    expect([OWN_HOMES_MS, TRUSTED_HOMES_MS]).toEqual([1_000, 30_000])
    let clock = 0
    let ownHomes = ['/o']
    const own = vi.fn(() => ownHomes)
    const read = vi.fn(() => ['/l'])
    const real = vi.fn((path: string) => path)
    const homes = trustedCodexHomes(own, () => clock, read, real)
    for (let call = 0; call < 100; call++) {
      clock = call * 9
      homes()
    }
    expect([own, read, real].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1])

    // An adopted home counts within the second.
    ownHomes = ['/o', '/adopted']
    clock = 1_000
    expect(homes()).toEqual(listed('/o', '/adopted', '/l'))
    expect([own, read, real].map((fn) => fn.mock.calls.length)).toEqual([2, 1, 2])
    clock = 1_999
    homes()
    expect(own).toHaveBeenCalledTimes(2)

    clock = 30_000
    homes()
    expect([own, read, real].map((fn) => fn.mock.calls.length)).toEqual([3, 2, 4])
  })
})
