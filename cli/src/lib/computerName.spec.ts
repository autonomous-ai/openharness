import { describe, expect, it, vi } from 'vitest'

// The system source is tried through a fake `execFile`: no test here ever runs the real scutil.
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
const child = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: child.execFile }))

import { computerNameReader, SYSTEM_COMPUTER_NAME_SOURCES, type ComputerNameSources } from './computerName.js'

const HOSTNAME = 'MacBook-Pro.local'

/** Fake sources that count how often each is asked. */
function fake(platform: NodeJS.Platform, scutil: () => Promise<string>, host = HOSTNAME) {
  const calls = { scutil: 0, hostname: 0 }
  const sources: ComputerNameSources = {
    platform,
    scutil: () => { calls.scutil++; return scutil() },
    hostname: () => { calls.hostname++; return host },
  }
  return { sources, calls }
}

const answering = (answer: string) => computerNameReader(fake('darwin', async () => answer).sources)()

describe('the computer\'s name', () => {
  it('uses macOS\'s ComputerName, and asks once', async () => {
    const { sources, calls } = fake('darwin', async () => 'Diego’s Mac\n')
    const read = computerNameReader(sources)
    expect(await read()).toBe('Diego’s Mac')
    expect(await read()).toBe('Diego’s Mac')
    expect(calls).toEqual({ scutil: 1, hostname: 0 })
  })

  it('two asks while scutil is still answering run it once', async () => {
    let answer!: (name: string) => void
    const { sources, calls } = fake('darwin', () => new Promise((resolve) => { answer = resolve }))
    const read = computerNameReader(sources)
    const first = read()
    const second = read()
    answer('Diego’s Mac\n')
    expect(await Promise.all([first, second])).toEqual(['Diego’s Mac', 'Diego’s Mac'])
    expect(calls.scutil).toBe(1)
  })

  it('an empty answer gives the hostname', async () => {
    expect(await answering('  \n')).toBe(HOSTNAME)
  })

  it('an answer of control characters alone gives the hostname', async () => {
    expect(await answering('\u0007\u001b\n')).toBe(HOSTNAME)
  })

  it('a failure gives the hostname', async () => {
    const { sources, calls } = fake('darwin', async () => { throw new Error('exit 1') })
    const read = computerNameReader(sources)
    expect(await read()).toBe(HOSTNAME)
    expect(await read()).toBe(HOSTNAME)
    expect(calls).toEqual({ scutil: 1, hostname: 1 })
  })

  it('a timeout gives the hostname', async () => {
    const { sources, calls } = fake('darwin', async () => { throw Object.assign(new Error('Command failed: /usr/sbin/scutil'), { killed: true, signal: 'SIGTERM' }) })
    const read = computerNameReader(sources)
    expect(await read()).toBe(HOSTNAME)
    expect(await read()).toBe(HOSTNAME)
    expect(calls).toEqual({ scutil: 1, hostname: 1 })
  })

  it('on Linux and Windows it never asks scutil', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { sources, calls } = fake(platform, async () => 'Diego’s Mac')
      expect(await computerNameReader(sources)()).toBe(HOSTNAME)
      expect(calls.scutil).toBe(0)
    }
  })

  it('control characters go, and the name is cut at 80 UTF-16 units, never inside a pair', async () => {
    expect(await answering('Lab\u0000 Mac\u007f\t\n')).toBe('Lab Mac')
    expect(await answering('é'.repeat(100))).toBe('é'.repeat(80))
    expect(await answering(`${'a'.repeat(78)}🙂`)).toBe(`${'a'.repeat(78)}🙂`)
    expect(await answering(`${'a'.repeat(79)}🙂`)).toBe('a'.repeat(79))
    const cut = await answering(`${'a'.repeat(80)}🙂`)
    expect(cut).toBe('a'.repeat(80))
    expect(cut).not.toMatch(/[\uD800-\uDFFF]/)
  })

  it('a long hostname is cut the same way', async () => {
    const { sources } = fake('linux', async () => '', `${'h'.repeat(79)}🙂`)
    expect(await computerNameReader(sources)()).toBe('h'.repeat(79))
  })

  // The gateway and the devices process ask while they carry other traffic: a slow scutil must not stop them.
  it('the system source asks scutil by its full path without holding the process, with a 5 s deadline', async () => {
    let done!: ExecFileCallback
    child.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => { done = callback })
    const answer = SYSTEM_COMPUTER_NAME_SOURCES.scutil()
    expect(child.execFile).toHaveBeenCalledWith('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 5000,
    }, expect.any(Function))
    // The call came back while scutil was still running; its answer arrives later.
    done(null, 'Diego’s Mac\n', '')
    expect(await answer).toBe('Diego’s Mac\n')
  })

  it('the system source fails when scutil does', async () => {
    child.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(Object.assign(new Error('Command failed'), { killed: true }), '', 'scutil complaint')
    })
    await expect(SYSTEM_COMPUTER_NAME_SOURCES.scutil()).rejects.toThrow('Command failed')
  })
})
