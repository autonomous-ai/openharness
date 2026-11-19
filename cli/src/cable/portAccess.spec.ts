import { describe, expect, it } from 'vitest'
import { NO_ACCESS, NO_ACCESS_YET, PortAccessError, portAccessProblem, type PortAccessDeps } from './portAccess.js'

const GROUP_FILE = 'root:x:0:\ndialout:x:20:bob\nuucp:x:986:\n'
const denied = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }

function deps(overrides: Partial<PortAccessDeps> & { gid?: number; mode?: number } = {}): PortAccessDeps {
  const { gid = 20, mode = 0o020660, ...rest } = overrides
  return {
    platform: 'linux',
    access: denied,
    stat: () => ({ gid, mode }),
    groupFile: () => GROUP_FILE,
    groups: () => [1000],
    user: 'u',
    ...rest,
  }
}

describe('a port the account cannot open', () => {
  it('names the group the account is not in, read from the device', () => {
    const dialout = portAccessProblem('/dev/ttyACM0', deps())
    expect(dialout).toBeInstanceOf(PortAccessError)
    expect(dialout).toMatchObject({ code: 'EACCES', problem: 'No access to the dial. Run: sudo usermod -aG dialout $USER, then log out and in.' })
    expect(dialout?.message).toBe(dialout?.problem)
    expect(portAccessProblem('/dev/ttyACM0', deps({ gid: 986 }))?.problem)
      .toBe('No access to the dial. Run: sudo usermod -aG uucp $USER, then log out and in.')
    expect(NO_ACCESS('uucp')).toBe('No access to the dial. Run: sudo usermod -aG uucp $USER, then log out and in.')
  })

  it('asks for a new login when the account is in the group but this login is not yet', () => {
    expect(portAccessProblem('/dev/ttyACM0', deps({ user: 'bob' }))?.problem).toBe('No access to the dial yet. Log out and in.')
    expect(NO_ACCESS_YET).toBe('No access to the dial yet. Log out and in.')
  })

  it.each<[string, Partial<PortAccessDeps> & { gid?: number; mode?: number }]>([
    ['the group may not read and write the port', { mode: 0o020640 }],
    ['no /etc/group line has the gid', { gid: 30 }],
    ['the group name is out of form', { gid: 40, groupFile: () => `${GROUP_FILE}9dial:x:40:\n` }],
    ['the group name could reach a shell', { gid: 40, groupFile: () => `${GROUP_FILE}di$(x):x:40:\n` }],
    ['this login already holds the group', { groups: () => [1000, 20] }],
    ['the open fails for another reason', { access: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }],
    ['this is not Linux', { platform: 'darwin' }],
    ['the port may be opened', { access: () => {} }],
    ['the device cannot be read', { stat: () => { throw new Error('EIO') } }],
    ['/etc/group cannot be read', { groupFile: () => { throw new Error('EACCES') } }],
  ])('gives no advice when %s', (_case, overrides) => {
    expect(portAccessProblem('/dev/ttyACM0', deps(overrides))).toBeNull()
  })
})
