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

describe('onError', () => {
  // `harness start --foreground` fails through it too, and under launchd and systemd what it prints is the daemon's
  // log, which Export logs sends off the machine.
  it('says a failure by its kind, never its words, its stack or a path', async () => {
    const { onError } = await daemonState()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exited = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`) }) as never)

    expect(() => onError(alreadyServing('/Users/sentinel/daemon-1.sock'))).toThrow('exit 1')
    expect(() => onError(new Error('could not read /Users/sentinel/notes'), 3)).toThrow('exit 3')

    expect(said.mock.calls).toEqual([
      ['Failed to start adapter: EADDRINUSE · another Harness daemon serves this data folder'],
      ['Failed to start adapter: Error'],
    ])
    expect(exited.mock.calls).toEqual([[1], [3]])
  })
})
