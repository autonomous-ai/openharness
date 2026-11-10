import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { stashTrust, switchAccountTrust, unstashTrust } from './accountTrust.js'

const A = '65f0a1b2c3d4e5f6a7b8c9d0', B = '65f0a1b2c3d4e5f6a7b8c9d1'
const web = (pub: string) => ({ identityPub: pub, label: pub, pairedAt: 1, role: 'web' })
const device = { identityPub: 'dev', label: 'wifi', pairedAt: 1, role: 'device' }

function e2e(): string {
  const dir = mkdtempSync(join(tmpdir(), 'account-trust-'))
  writeFileSync(join(dir, 'identity.json'), '{"pub":"me"}')
  return dir
}
const write = (dir: string, name: string, data: unknown): void => writeFileSync(join(dir, name), JSON.stringify(data))
const read = (dir: string, name: string): unknown => existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf-8')) : undefined

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
})
