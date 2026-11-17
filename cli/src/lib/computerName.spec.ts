import { describe, expect, it, vi } from 'vitest'

// The system source is tried through a fake `execFileSync`: no test here ever runs the real scutil.
const child = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: child.execFileSync }))

import { computerNameReader, SYSTEM_COMPUTER_NAME_SOURCES, type ComputerNameSources } from './computerName.js'

const HOSTNAME = 'MacBook-Pro.local'

/** Fake sources that count how often each is asked. */
function fake(platform: NodeJS.Platform, scutil: () => string, host = HOSTNAME) {
  const calls = { scutil: 0, hostname: 0 }
  const sources: ComputerNameSources = {
    platform,
    scutil: () => { calls.scutil++; return scutil() },
    hostname: () => { calls.hostname++; return host },
  }
  return { sources, calls }
}

const answering = (answer: string) => computerNameReader(fake('darwin', () => answer).sources)()

describe('the computer\'s name', () => {
  it('uses macOS\'s ComputerName, and asks once', () => {
    const { sources, calls } = fake('darwin', () => 'Diego’s Mac\n')
    const read = computerNameReader(sources)
    expect(read()).toBe('Diego’s Mac')
    expect(read()).toBe('Diego’s Mac')
    expect(calls).toEqual({ scutil: 1, hostname: 0 })
  })

  it('an empty answer gives the hostname', () => {
    expect(answering('  \n')).toBe(HOSTNAME)
  })

  it('an answer of control characters alone gives the hostname', () => {
    expect(answering('\u0007\u001b\n')).toBe(HOSTNAME)
  })

  it('a failure gives the hostname', () => {
    const { sources, calls } = fake('darwin', () => { throw new Error('exit 1') })
    const read = computerNameReader(sources)
    expect(read()).toBe(HOSTNAME)
    expect(read()).toBe(HOSTNAME)
    expect(calls).toEqual({ scutil: 1, hostname: 1 })
  })

  it('a timeout gives the hostname', () => {
    const { sources, calls } = fake('darwin', () => { throw Object.assign(new Error('spawnSync /usr/sbin/scutil ETIMEDOUT'), { code: 'ETIMEDOUT' }) })
    const read = computerNameReader(sources)
    expect(read()).toBe(HOSTNAME)
    expect(read()).toBe(HOSTNAME)
    expect(calls).toEqual({ scutil: 1, hostname: 1 })
  })

  it('on Linux and Windows it never asks scutil', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { sources, calls } = fake(platform, () => 'Diego’s Mac')
      expect(computerNameReader(sources)()).toBe(HOSTNAME)
      expect(calls.scutil).toBe(0)
    }
  })

  it('control characters go, and the name is cut at 80 UTF-16 units, never inside a pair', () => {
    expect(answering('Lab\u0000 Mac\u007f\t\n')).toBe('Lab Mac')
    expect(answering('é'.repeat(100))).toBe('é'.repeat(80))
    expect(answering(`${'a'.repeat(78)}🙂`)).toBe(`${'a'.repeat(78)}🙂`)
    expect(answering(`${'a'.repeat(79)}🙂`)).toBe('a'.repeat(79))
    const cut = answering(`${'a'.repeat(80)}🙂`)
    expect(cut).toBe('a'.repeat(80))
    expect(cut).not.toMatch(/[\uD800-\uDFFF]/)
  })

  it('a long hostname is cut the same way', () => {
    const { sources } = fake('linux', () => '', `${'h'.repeat(79)}🙂`)
    expect(computerNameReader(sources)()).toBe('h'.repeat(79))
  })

  // tmuxOnPath.ts learned 2 s is too short for a child process on a loaded Mac.
  it('the system source asks scutil by its full path, with a 5 s deadline and no stdin', () => {
    child.execFileSync.mockReturnValue('Diego’s Mac\n')
    expect(SYSTEM_COMPUTER_NAME_SOURCES.scutil()).toBe('Diego’s Mac\n')
    expect(child.execFileSync).toHaveBeenCalledWith('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  })
})
