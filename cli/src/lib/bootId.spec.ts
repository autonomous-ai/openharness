import { uptime } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BOOT_TOLERANCE_SEC, bootChanged, currentBootId, SYSTEM_BOOT_SOURCES, type BootSources } from './bootId.js'

/** Which boot of the machine this is, and whether a saved mark was written in an earlier one. */
const LINUX = 'd6c8c2f0-3a5e-4b8f-9f3e-1c2d3e4f5a6b'
const MAC = '901041CC-91D0-439E-9A41-8677710EEDC0'
const BOOTED = 1_790_000_000
const sources = (over: Partial<BootSources> = {}): BootSources => ({
  platform: 'darwin',
  linuxBootId: () => { throw new Error('ENOENT') },
  macosBootId: () => `${MAC}\n`,
  bootTimeSec: () => BOOTED,
  ...over,
})

describe('naming this boot', () => {
  it('by the kernel\'s id on Linux, and by kern.bootsessionuuid on macOS', () => {
    expect(currentBootId(sources({ platform: 'linux', linuxBootId: () => `${LINUX}\n` }))).toBe(`linux:${LINUX}`)
    expect(currentBootId(sources())).toBe(`macos:${MAC}`)
  })

  it('by the moment it began where no id can be read, or what is read is not one', () => {
    expect(currentBootId(sources({ macosBootId: () => { throw new Error('sysctl: not found') } }))).toBe(`time:${BOOTED}`)
    expect(currentBootId(sources({ macosBootId: () => 'kern.bootsessionuuid: unknown oid' }))).toBe(`time:${BOOTED}`)
    expect(currentBootId(sources({ platform: 'linux', linuxBootId: () => 'garbage' }))).toBe(`time:${BOOTED}`)
    // Never sysctl off macOS, whatever it would say.
    expect(currentBootId(sources({ platform: 'freebsd' }))).toBe(`time:${BOOTED}`)
  })

  it('reads this machine for real: an id on Linux and macOS, a moment elsewhere', () => {
    const mark = currentBootId(SYSTEM_BOOT_SOURCES)
    expect(mark).toMatch(process.platform === 'linux' ? /^linux:/ : process.platform === 'darwin' ? /^(macos|time):/ : /^time:/)
    expect(currentBootId()).toBe(mark)
    expect(Math.abs(SYSTEM_BOOT_SOURCES.bootTimeSec() - (Date.now() / 1000 - uptime()))).toBeLessThan(2)
  })
})

describe('whether the machine rebooted', () => {
  it('not when nothing was saved', () => {
    expect(bootChanged(null, `macos:${MAC}`, sources())).toBe(false)
  })

  it('by the ids on Linux and macOS, whatever the wall clock did meanwhile', () => {
    const stepped = sources({ bootTimeSec: () => BOOTED + 3 * 3600 })
    expect(bootChanged(`macos:${MAC}`, `macos:${MAC}`, stepped)).toBe(false)
    expect(bootChanged(`macos:${MAC}`, `macos:${LINUX}`, stepped)).toBe(true)
    expect(bootChanged(`linux:${LINUX}`, `linux:${LINUX}`, stepped)).toBe(false)
    expect(bootChanged(`linux:${LINUX}`, `linux:${MAC}`, stepped)).toBe(true)
  })

  it('not on a macOS id that cannot be read now: that is no evidence of a reboot', () => {
    expect(bootChanged(`macos:${MAC}`, `time:${BOOTED}`, sources())).toBe(false)
  })

  it('by the moment the boot began for a mark an older build wrote, once, with two minutes\' grace', () => {
    expect(bootChanged(`time:${BOOTED}`, `macos:${MAC}`, sources({ bootTimeSec: () => BOOTED + BOOT_TOLERANCE_SEC }))).toBe(false)
    expect(bootChanged(`time:${BOOTED}`, `macos:${MAC}`, sources({ bootTimeSec: () => BOOTED + BOOT_TOLERANCE_SEC + 1 }))).toBe(true)
    expect(bootChanged(String(BOOTED), `time:${BOOTED - 30}`, sources())).toBe(false)
    expect(bootChanged('time:1', `time:${BOOTED}`, sources())).toBe(true)
    expect(bootChanged('not a mark', `time:${BOOTED}`, sources())).toBe(true)
  })
})
