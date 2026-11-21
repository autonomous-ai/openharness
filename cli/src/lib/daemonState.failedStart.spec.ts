import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { alreadyServing } from './localSocket.js'

let dataDir = ''

async function daemonState() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonState.js')
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-onerror-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
})

describe('failForegroundStart', () => {
  // `harness start --foreground` fails through it, and under launchd and systemd what it prints is the daemon's log,
  // which Export logs sends off the machine.
  it('says a failure by its kind, never its words, its stack or a path', async () => {
    const { failForegroundStart } = await daemonState()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exited = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)

    expect(() => failForegroundStart(alreadyServing('/Users/sentinel/daemon-1.sock'))).toThrow('exit 1')
    expect(() => failForegroundStart(new Error('could not read /Users/sentinel/notes'), 3)).toThrow('exit 3')

    expect(said.mock.calls).toEqual([
      ['Failed to start adapter: EADDRINUSE · another Harness daemon serves this data folder'],
      ['Failed to start adapter: Error'],
    ])
    expect(exited.mock.calls).toEqual([[1], [3]])
  })

  // A trust file that cannot be read is the person's to move aside: said by its own name and why, read off the error's
  // fields, never its message.
  it('says a trust file that cannot be read by its name and why', async () => {
    const { failForegroundStart } = await daemonState()
    const { StateFileUnreadable } = await import('./secureState.js')
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)

    expect(() => failForegroundStart(new StateFileUnreadable('paired.json', 'not valid JSON'))).toThrow('exit 1')

    expect(said.mock.calls).toEqual([['✗ paired.json cannot be read (not valid JSON)'], ['  harness status shows where it is']])
  })
})
