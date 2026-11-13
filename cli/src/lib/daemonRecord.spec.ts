import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configuredPortOf, readDaemonRecord, savedDaemonPort, writeDaemonRecord } from './daemonRecord.js'

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

describe('the daemon\'s record', () => {
  it('persists separate TCP port records per user and configured endpoint', () => {
    const a = dataDir(), b = dataDir()
    expect(savedDaemonPort(a, 18473)).toBe(18473)
    writeDaemonRecord(a, 18473, 24567)
    expect(savedDaemonPort(a, 18473)).toBe(24567)
    expect(savedDaemonPort(b, 18473)).toBe(18473)
    expect(savedDaemonPort(a, 18474)).toBe(18474)
    const file = join(a, 'daemon-18473.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 24567 })
    for (const body of ['broken', '{}', '{"port":-1}', '{"port":65536}', '{"port":"24567"}']) {
      writeFileSync(file, body)
      expect(savedDaemonPort(a, 18473)).toBe(18473)
    }
  })

  it('records the Windows pipe and the core\'s pid beside the port, and reads only a pipe name back', () => {
    const dir = dataDir()
    const pipe = `\\\\.\\pipe\\harness-${'a'.repeat(32)}`
    writeDaemonRecord(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(JSON.parse(readFileSync(join(dir, 'daemon-18473.json'), 'utf8'))).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe, pid: 4242 })
    expect(savedDaemonPort(dir, 18473)).toBe(24567)
    writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 24567, pipe: 'C:\\evil', pid: -1 }))
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24567, pipe: null, pid: null })
    writeDaemonRecord(dir, 18473, 24568)
    expect(readDaemonRecord(dir, 18473)).toEqual({ port: 24568, pipe: null, pid: null })
    expect(readDaemonRecord(dir, 18474)).toBeNull()
  })

  it('on Windows, reads back only a local Harness pipe, never a file or another computer\'s pipe', () => {
    const dir = dataDir()
    const id = 'b'.repeat(32)
    const pipe = `\\\\.\\pipe\\harness-${id}`
    writeDaemonRecord(dir, 18473, 24567, { pipe, pid: 4242 })
    expect(readDaemonRecord(dir, 18473, 'win32')).toEqual({ port: 24567, pipe, pid: 4242 })
    for (const other of [`C:\\x\\harness-${id}`, `\\\\host\\pipe\\harness-${id}`, `\\\\.\\pipe\\evilharness-${id}`]) {
      writeFileSync(join(dir, 'daemon-18473.json'), JSON.stringify({ port: 24567, pipe: other, pid: 4242 }))
      expect(readDaemonRecord(dir, 18473, 'win32')).toEqual({ port: 24567, pipe: null, pid: 4242 })
    }
  })
})
