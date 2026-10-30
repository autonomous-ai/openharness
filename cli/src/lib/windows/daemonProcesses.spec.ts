import { describe, expect, it } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import { identifyDaemonProcess, judgeDaemonProcess, judgePidFileOwner } from './daemonProcesses.js'

// 2026-10-16T00:00:00Z as a FILETIME marker.
const at = (ms: number): string => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
const T = Date.parse('2026-10-16T00:00:00Z')
const MASTER_ARGV = ['C:\\n\\node.exe', 'C:\\h\\cli\\0.5.0\\cli.js', '__harnessd']
const row = (over: Partial<ProcessRow>): ProcessRow => ({
  pid: 500, parentPid: 4, executable: 'node.exe', startMarker: at(T), args: MASTER_ARGV.join(' '), nativeArgv: MASTER_ARGV, ...over,
})
const master = { role: 'master', claimedAtMs: T + 5_000 } as const

describe('the daemon\'s processes, in the process table', () => {
  it('knows the master by its command and by having started before it claimed the pid file', () => {
    expect(identifyDaemonProcess([row({})], 500, master)).toBe(at(T))
    expect(identifyDaemonProcess([row({ nativeArgv: ['node', 'cli.js', 'start', '-f'] })], 500, master)).toBe(at(T))
    expect(identifyDaemonProcess([row({ nativeArgv: ['node', 'cli.js', 'start', '--foreground'] })], 500, master)).toBe(at(T))
    expect(identifyDaemonProcess([row({ args: '' })], 500, master)).toBe(at(T))
  })

  it('refuses a pid that runs something else, started after the claim, is missing, or has no readable start', () => {
    expect(identifyDaemonProcess([row({ nativeArgv: ['notepad.exe'] })], 500, master)).toBeNull()
    expect(identifyDaemonProcess([row({ nativeArgv: ['node', 'cli.js', 'start'] })], 500, master)).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: at(T + 60_000) })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: 'garbage' })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: '' })], 500, master)).toBeNull()
    expect(identifyDaemonProcess([row({})], 501, master)).toBeNull()
  })

  it('reads only the kernel\'s argv, never a command line split on spaces', () => {
    // A prompt's text in the command line must not pose as the daemon's token.
    expect(identifyDaemonProcess([row({ nativeArgv: undefined })], 500, master)).toBeNull()
    const agent = row({ pid: 600, parentPid: 500, args: 'claude.exe "say __run"', nativeArgv: ['claude.exe', 'say __run'] })
    expect(identifyDaemonProcess([agent], 600, { role: 'core', parentPid: 500 })).toBeNull()
  })

  it('knows the core by its command and its parent, the master', () => {
    const core = row({ pid: 600, parentPid: 500, args: 'node.exe cli.js __run', nativeArgv: ['node.exe', 'cli.js', '__run'] })
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 500 })).toBe(at(T))
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 501 })).toBeNull()
    // The core is not the master, nor the master the core.
    expect(identifyDaemonProcess([core], 600, master)).toBeNull()
    expect(identifyDaemonProcess([row({ parentPid: 500 })], 500, { role: 'core', parentPid: 500 })).toBeNull()
  })

  it('needs what the CLI knows besides the pid: the argv alone would accept another daemon given the pid since', () => {
    // @ts-expect-error the master's claim carries when the pid file was written
    expect(identifyDaemonProcess([row({})], 500, { role: 'master' })).toBeNull()
    // @ts-expect-error the core's claim carries the master's pid
    expect(identifyDaemonProcess([row({ nativeArgv: ['node.exe', 'cli.js', '__run'] })], 500, { role: 'core' })).toBeNull()
  })

  it('tells a pid proven not the daemon\'s from one it cannot tell about', () => {
    expect(judgeDaemonProcess([row({})], 500, master)).toEqual({ verdict: 'is', startMarker: at(T) })
    // Proven not: gone from the table, another command, started after the claim, or a core with another parent.
    expect(judgeDaemonProcess([row({})], 501, master)).toEqual({ verdict: 'not' })
    expect(judgeDaemonProcess([row({ nativeArgv: ['notepad.exe'] })], 500, master)).toEqual({ verdict: 'not' })
    expect(judgeDaemonProcess([row({ startMarker: at(T + 60_000) })], 500, master)).toEqual({ verdict: 'not' })
    const core = row({ pid: 600, parentPid: 500, nativeArgv: ['node.exe', 'cli.js', '__run'] })
    expect(judgeDaemonProcess([core], 600, { role: 'core', parentPid: 501 })).toEqual({ verdict: 'not' })
    // Cannot tell: no kernel argv, no start marker, a marker it cannot read, or no claim time.
    expect(judgeDaemonProcess([row({ nativeArgv: undefined })], 500, master)).toEqual({ verdict: 'unknown' })
    expect(judgeDaemonProcess([row({ startMarker: '' })], 500, master)).toEqual({ verdict: 'unknown' })
    expect(judgeDaemonProcess([row({ startMarker: 'garbage' })], 500, master)).toEqual({ verdict: 'unknown' })
    expect(judgeDaemonProcess([row({})], 500, { role: 'master', claimedAtMs: Number.NaN })).toEqual({ verdict: 'unknown' })
  })

  it('knows a core no master runs, which claims the pid file itself, for Harness: never ended, never forgotten', () => {
    const CORE_ARGV = ['node.exe', 'cli.js', '__run']
    expect(judgePidFileOwner([row({})], 500, T + 5_000)).toEqual({ verdict: 'is', startMarker: at(T) })
    expect(judgePidFileOwner([row({ nativeArgv: CORE_ARGV })], 500, T + 5_000)).toEqual({ verdict: 'unknown' })
    // A core that started after the file was written was given the pid since; another command is not Harness.
    expect(judgePidFileOwner([row({ nativeArgv: CORE_ARGV, startMarker: at(T + 60_000) })], 500, T)).toEqual({ verdict: 'not' })
    expect(judgePidFileOwner([row({ nativeArgv: ['notepad.exe'] })], 500, T + 5_000)).toEqual({ verdict: 'not' })
    expect(judgePidFileOwner([], 500, T + 5_000)).toEqual({ verdict: 'not' })
  })

  it('decides by time first: a process that started after the claim is not the master, whatever its argv says', () => {
    const late = at(T + 60_000)
    const claim = { role: 'master', claimedAtMs: T } as const
    expect(judgeDaemonProcess([row({ startMarker: late, nativeArgv: undefined })], 500, claim)).toEqual({ verdict: 'not' })
    expect(judgeDaemonProcess([row({ startMarker: late, nativeArgv: ['node.exe'] })], 500, claim)).toEqual({ verdict: 'not' })
  })

  it('never proves a process not ours when its command line could not be read (the host sends just its executable)', () => {
    expect(judgeDaemonProcess([row({ nativeArgv: ['node.exe'] })], 500, master)).toEqual({ verdict: 'unknown' })
    expect(judgeDaemonProcess([row({ pid: 600, parentPid: 500, nativeArgv: ['node.exe'] })], 600, { role: 'core', parentPid: 501 })).toEqual({ verdict: 'unknown' })
    expect(judgePidFileOwner([row({ nativeArgv: ['node.exe'] })], 500, T + 5_000)).toEqual({ verdict: 'unknown' })
    // A different program's own name is a command line that was read.
    expect(judgeDaemonProcess([row({ nativeArgv: ['notepad.exe'] })], 500, master)).toEqual({ verdict: 'not' })
  })
})
