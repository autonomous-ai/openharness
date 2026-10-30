// G6 (docs/testing/windows-cli-e2e.md): in a container with no init, a stopped master stays a zombie of PID 1, and
// `kill -0` succeeds on a zombie, so `harness uninstall` waited on a daemon that was gone and removed nothing.
import { describe, expect, it } from 'vitest'
import { isAlive, processAlive } from './daemonState.js'

describe('whether a process is alive', () => {
  const stat = (state: string) => () => `4242 (node (harnessd) x) ${state} 1 4242 4242 0 -1`

  it('counts a zombie (or a dead entry) on Linux as gone, whatever its name holds', () => {
    const signalled = () => true
    expect(processAlive(4242, { platform: 'linux', signal: signalled, readStat: stat('Z') })).toBe(false)
    expect(processAlive(4242, { platform: 'linux', signal: signalled, readStat: stat('X') })).toBe(false)
    expect(processAlive(4242, { platform: 'linux', signal: signalled, readStat: stat('S') })).toBe(true)
    expect(processAlive(4242, { platform: 'linux', signal: signalled, readStat: stat('R') })).toBe(true)
  })

  it('trusts the signal where /proc cannot say, and elsewhere than Linux', () => {
    const unreadable = () => { throw new Error('ENOENT') }
    expect(processAlive(4242, { platform: 'linux', signal: () => true, readStat: unreadable })).toBe(true)
    expect(processAlive(4242, { platform: 'linux', signal: () => true, readStat: () => 'garbage' })).toBe(true)
    expect(processAlive(4242, { platform: 'darwin', signal: () => true, readStat: stat('Z') })).toBe(true)
    expect(processAlive(4242, { platform: 'linux', signal: () => false, readStat: stat('S') })).toBe(false)
  })

  it('reads this process as alive, and a pid nobody has as gone', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2 ** 22 + 12_345)).toBe(false)
  })
})
