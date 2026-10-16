import { describe, expect, it } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import { identifyDaemonProcess } from './daemonProcesses.js'

// 2026-10-16T00:00:00Z as a FILETIME marker.
const at = (ms: number): string => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
const T = Date.parse('2026-10-16T00:00:00Z')
const row = (over: Partial<ProcessRow>): ProcessRow => ({
  pid: 500, parentPid: 4, executable: 'node.exe', startMarker: at(T), args: 'C:\\n\\node.exe C:\\h\\cli\\0.5.0\\cli.js __harnessd', ...over,
})

describe('the daemon\'s processes, in the process table', () => {
  it('knows the master by its command and by having started before it claimed the pid file', () => {
    expect(identifyDaemonProcess([row({})], 500, { role: 'master', claimedAtMs: T + 5_000 })).toBe(at(T))
    expect(identifyDaemonProcess([row({ args: 'node cli.js start -f' })], 500, { role: 'master' })).toBe(at(T))
    expect(identifyDaemonProcess([row({ nativeArgv: ['node.exe', 'cli.js', '__harnessd'], args: '' })], 500, { role: 'master' })).toBe(at(T))
  })

  it('refuses a pid that runs something else, started after the claim, is missing, or has no readable start', () => {
    expect(identifyDaemonProcess([row({ args: 'notepad.exe' })], 500, { role: 'master' })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: at(T + 60_000) })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({ startMarker: 'garbage' })], 500, { role: 'master', claimedAtMs: T })).toBeNull()
    expect(identifyDaemonProcess([row({})], 501, { role: 'master' })).toBeNull()
  })

  it('knows the core by its command and its parent, the master', () => {
    const core = row({ pid: 600, parentPid: 500, args: 'node.exe cli.js __run' })
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 500 })).toBe(at(T))
    expect(identifyDaemonProcess([core], 600, { role: 'core', parentPid: 501 })).toBeNull()
  })
})
