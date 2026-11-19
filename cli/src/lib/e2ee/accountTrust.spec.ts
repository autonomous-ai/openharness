import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directorySyncSupported, StateFileUnreadable } from '../secureState.js'
import { keptAccountDirs, stashTrust, switchAccountTrust, unstashTrust } from './accountTrust.js'

// What reaches the disk, in order: a flush by the path its descriptor was opened on, a rename by its target.
const io = vi.hoisted(() => ({ events: [] as string[], opened: new Map<number, string>() }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      io.opened.set(fd, String(args[0]))
      return fd
    },
    fsyncSync: (fd: number) => {
      actual.fsyncSync(fd)
      io.events.push(`flush ${io.opened.get(fd)}`)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      io.events.push(`rename ${String(args[1])}`)
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      actual.rmSync(...args)
      io.events.push(`remove ${String(args[0])}`)
    },
  }
})

const A = '65f0a1b2c3d4e5f6a7b8c9d0', B = '65f0a1b2c3d4e5f6a7b8c9d1'
const web = (pub: string) => ({ identityPub: pub, label: pub, pairedAt: 1, role: 'web' })
const device = { identityPub: 'dev', label: 'wifi', pairedAt: 1, role: 'device' }
const group = { members: ['a'], removed: [] }
// What a reader saw mid-write.
const TORN = '[{"identityPub":"'

function e2e(): string {
  const dir = mkdtempSync(join(tmpdir(), 'account-trust-'))
  writeFileSync(join(dir, 'identity.json'), '{"pub":"me"}')
  return dir
}
// Every writer under the data folder makes its files 0600; a trust write refuses one another account could write.
const write = (dir: string, name: string, data: unknown): void =>
  writeFileSync(join(dir, name), JSON.stringify(data), { mode: 0o600 })
const read = (dir: string, name: string): unknown => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf-8')) : undefined
const bytes = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf-8')
function keptFor(dir: string, acct: string): string {
  const kept = join(dir, 'accounts', acct)
  mkdirSync(kept, { recursive: true })
  return kept
}

/** [copy]'s data, its place and its folder were flushed before [cut] reached the disk. */
function flushedBefore(copy: string, cut: string): void {
  const at = io.events.indexOf(cut)
  expect(at).toBeGreaterThan(-1)
  const before = io.events.slice(0, at)
  expect(before.some((event) => event.startsWith(`flush ${copy}.`) && event.endsWith('.tmp'))).toBe(true)
  expect(before).toContain(`rename ${copy}`)
  if (directorySyncSupported()) expect(before).toContain(`flush ${dirname(copy)}`)
}

describe('trust stores kept per account', () => {
  it('puts away one account\'s stores and brings back the other\'s, keeping the Wi-Fi device and the identity', () => {
    const dir = e2e()
    write(dir, 'paired.json', [web('a-web'), device])
    write(dir, 'group.json', { members: ['a'], removed: [] })
    write(dir, 'group-blocked.json', ['a-blocked'])
    write(dir, 'machinePeers.json', [{ machineId: 'ma', pub: 'a-box' }])

    switchAccountTrust(A, B, dir)
    expect(read(dir, 'paired.json')).toEqual([device])
    for (const name of ['group.json', 'group-blocked.json', 'machinePeers.json']) expect(read(dir, name)).toBeUndefined()
    expect(read(join(dir, 'accounts', A), 'paired.json')).toEqual([web('a-web')])
    expect(read(join(dir, 'accounts', A), 'group.json')).toEqual({ members: ['a'], removed: [] })

    // B makes its own, then A comes back as it was.
    write(dir, 'paired.json', [device, web('b-web')])
    write(dir, 'group.json', { members: ['b'], removed: [] })
    switchAccountTrust(B, A, dir)
    expect(read(dir, 'paired.json')).toEqual([device, web('a-web')])
    expect(read(dir, 'group.json')).toEqual({ members: ['a'], removed: [] })
    expect(read(dir, 'group-blocked.json')).toEqual(['a-blocked'])
    expect(read(dir, 'machinePeers.json')).toEqual([{ machineId: 'ma', pub: 'a-box' }])
    expect(read(join(dir, 'accounts', B), 'paired.json')).toEqual([web('b-web')])
    expect(read(join(dir, 'accounts', A), 'paired.json')).toBeUndefined()
    expect(read(dir, 'identity.json')).toEqual({ pub: 'me' })
  })

  it('a stash cut short after its copy keeps the keys in both places, and a second run finishes it', () => {
    const dir = e2e()
    // The copy was written, the live file not yet cut.
    mkdirSync(join(dir, 'accounts', A), { recursive: true })
    write(join(dir, 'accounts', A), 'paired.json', [web('a-web')])
    write(dir, 'paired.json', [web('a-web'), device])
    stashTrust(A, dir)
    expect(read(dir, 'paired.json')).toEqual([device])
    expect(read(join(dir, 'accounts', A), 'paired.json')).toEqual([web('a-web')])
    // Run again with nothing of A's left live: its copy stays as it is.
    stashTrust(A, dir)
    expect(read(join(dir, 'accounts', A), 'paired.json')).toEqual([web('a-web')])
  })

  it('an account never kept starts empty', () => {
    const dir = e2e()
    write(dir, 'paired.json', [device])
    unstashTrust(B, dir)
    expect(read(dir, 'paired.json')).toEqual([device])
    expect(read(dir, 'group.json')).toBeUndefined()
  })

  it('refuses an account id that is not one, before anything moves', () => {
    const dir = e2e()
    write(dir, 'paired.json', [web('a-web')])
    for (const bad of ['../x', '', 'a/b', 'x'.repeat(65)]) {
      expect(() => switchAccountTrust(A, bad, dir)).toThrow(/not an account id/)
      expect(() => switchAccountTrust(bad, A, dir)).toThrow(/not an account id/)
    }
    expect(read(dir, 'paired.json')).toEqual([web('a-web')])
    expect(existsSync(join(dir, 'accounts', A))).toBe(false)
  })

  it('the copy is flushed before the original is cut', () => {
    const dir = e2e()
    const kept = join(dir, 'accounts', A)
    write(dir, 'paired.json', [web('a-web'), device])
    io.events.length = 0
    stashTrust(A, dir)
    flushedBefore(join(kept, 'paired.json'), `rename ${join(dir, 'paired.json')}`)

    io.events.length = 0
    unstashTrust(A, dir)
    flushedBefore(join(dir, 'paired.json'), `remove ${join(kept, 'paired.json')}`)
  })

  it('a file at the old fixed temporary name is left alone', () => {
    const dir = e2e()
    const kept = keptFor(dir, A)
    const other = `paired.json.${process.pid}.tmp`
    for (const at of [dir, kept]) writeFileSync(join(at, other), 'another writer\'s')
    write(dir, 'paired.json', [web('a-web'), device])
    stashTrust(A, dir)
    unstashTrust(A, dir)
    for (const at of [dir, kept]) expect(bytes(at, other)).toBe('another writer\'s')
    expect(read(dir, 'paired.json')).toEqual([device, web('a-web')])
  })
})

describe('a paired set that cannot be read', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  // The whole files move whatever paired.json holds: left live, the account left behind's roster, blocks and pins went
  // on to the next one, and a switch back put an older block list in place of the newer one, trusting a blocked machine.
  it('a torn live paired.json is left as it is, and the whole files still go', () => {
    const dir = e2e()
    writeFileSync(join(dir, 'paired.json'), TORN)
    write(dir, 'group.json', group)
    write(dir, 'group-blocked.json', ['a-blocked'])
    expect(() => stashTrust(A, dir)).toThrow(StateFileUnreadable)
    expect(bytes(dir, 'paired.json')).toBe(TORN)
    expect(read(dir, 'group.json')).toBeUndefined()
    expect(read(join(dir, 'accounts', A), 'group.json')).toEqual(group)
    expect(read(join(dir, 'accounts', A), 'group-blocked.json')).toEqual(['a-blocked'])
  })

  it('a switch with a torn live paired.json still swaps the whole files both ways, then says so', () => {
    const dir = e2e()
    const keptB = keptFor(dir, B)
    write(keptB, 'group-blocked.json', ['b-blocked'])
    writeFileSync(join(dir, 'paired.json'), TORN)
    write(dir, 'group-blocked.json', ['a-blocked'])
    expect(() => switchAccountTrust(A, B, dir)).toThrow(StateFileUnreadable)
    expect(bytes(dir, 'paired.json')).toBe(TORN)
    expect(read(dir, 'group-blocked.json')).toEqual(['b-blocked'])
    expect(read(join(dir, 'accounts', A), 'group-blocked.json')).toEqual(['a-blocked'])
    expect(read(keptB, 'group-blocked.json')).toBeUndefined()
  })

  it('a torn kept copy is not written over by a stash, and the whole files still go', () => {
    const dir = e2e()
    const kept = keptFor(dir, A)
    writeFileSync(join(kept, 'paired.json'), TORN)
    write(dir, 'paired.json', [web('a-web'), device])
    write(dir, 'group.json', group)
    expect(() => stashTrust(A, dir)).toThrow(StateFileUnreadable)
    expect(bytes(kept, 'paired.json')).toBe(TORN)
    expect(read(dir, 'paired.json')).toEqual([web('a-web'), device])
    expect(read(dir, 'group.json')).toBeUndefined()
    expect(read(kept, 'group.json')).toEqual(group)
  })

  it('a torn paired.json is never written over by a return', () => {
    // Valid JSON that is not a list is no more a paired set than half of one.
    for (const torn of [TORN, '{}']) {
      const dir = e2e()
      const kept = keptFor(dir, A)
      write(kept, 'paired.json', [web('a-web')])
      write(kept, 'group.json', group)
      writeFileSync(join(dir, 'paired.json'), torn)
      expect(() => unstashTrust(A, dir)).toThrow(/^paired\.json cannot be read/)
      expect(bytes(dir, 'paired.json')).toBe(torn)
      expect(read(kept, 'paired.json')).toEqual([web('a-web')])
      expect(read(kept, 'group.json')).toBeUndefined()
      expect(read(dir, 'group.json')).toEqual(group)
    }
  })

  it('a torn kept copy is left, and the whole files still come back', () => {
    const dir = e2e()
    const kept = keptFor(dir, A)
    writeFileSync(join(kept, 'paired.json'), TORN)
    write(kept, 'group.json', group)
    write(dir, 'paired.json', [device])
    expect(() => unstashTrust(A, dir)).toThrow(StateFileUnreadable)
    expect(bytes(kept, 'paired.json')).toBe(TORN)
    expect(read(kept, 'group.json')).toBeUndefined()
    expect(read(dir, 'paired.json')).toEqual([device])
    expect(read(dir, 'group.json')).toEqual(group)
  })
})

describe('keptAccountDirs', () => {
  it('lists the folders kept per account, and nothing else', () => {
    const dir = e2e()
    expect(keptAccountDirs(dir)).toEqual([])
    for (const name of [B, A, 'not.an.account']) keptFor(dir, name)
    writeFileSync(join(dir, 'accounts', 'a-file'), '')
    expect(keptAccountDirs(dir).sort()).toEqual([join(dir, 'accounts', A), join(dir, 'accounts', B)])
  })

  it('lists at most 64', () => {
    const dir = e2e()
    for (let i = 0; i < 70; i++) keptFor(dir, `account-${i}`)
    expect(keptAccountDirs(dir)).toHaveLength(64)
  })

  // `harness status` lists them: a folder it cannot read ended it with a stack and the folder's full path.
  it('a folder it cannot list is none, said by its code alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = e2e()
    writeFileSync(join(dir, 'accounts'), '')
    try {
      expect(keptAccountDirs(dir)).toEqual([])
      expect(warn).toHaveBeenCalledWith('[state] the trust kept per account cannot be listed (ENOTDIR)')
    } finally {
      warn.mockRestore()
    }
  })
})
