import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configuredPortOf, writeDaemonRecord } from './daemonRecord.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-record-'))
  dirs.push(dir)
  return dir
}

describe('configuredPortOf', () => {
  // A Harness Team account holds the configured port, so the daemon is given another, which `daemonPort` hands every command.
  it('finds a daemon by the port it was given, and by the one it was configured with', () => {
    const dir = dataDir()
    writeDaemonRecord(dir, 18473, 55332)
    expect(configuredPortOf(dir, 55332)).toBe(18473)
    expect(configuredPortOf(dir, 18473)).toBe(18473)
  })

  it('leaves a port no record names, a missing folder and other files alone', () => {
    const dir = dataDir()
    writeDaemonRecord(dir, 18473, 55332)
    writeFileSync(join(dir, 'daemon-token'), 'x')
    writeFileSync(join(dir, 'daemon-x.json'), '{"port":4000}')
    writeFileSync(join(dir, 'daemon-5000.json'), 'not json')
    expect(configuredPortOf(dir, 4000)).toBe(4000)
    expect(configuredPortOf(dir, 5000)).toBe(5000)
    expect(configuredPortOf(join(dir, 'gone'), 55332)).toBe(55332)
  })
})
