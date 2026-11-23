import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { shortSocketFolder } from '../lib/localSocket.js'
import { ensureDaemonToken } from '../lib/windows/pipeAuth.js'
import { DEVICES_SOCKET, devicesListenerPath, devicesTarget } from './listenerPath.js'
import { createDevicesProof, DEVICES_TOKEN_FILE, writeDevicesRecord } from './listenerPipe.js'

describe('devicesListenerPath', () => {
  const home = '/Users/me'

  it('the socket is devices.sock in the data folder', () => {
    expect(DEVICES_SOCKET).toBe('devices.sock')
    expect(devicesListenerPath('/Users/me/.harness', 'darwin', home)).toBe(join('/Users/me/.harness', 'devices.sock'))
  })

  it('a data folder too long for a socket gives the short folder under the home, the one socketPathIn gives', () => {
    const folder = `/${'d'.repeat(199)}`
    expect(devicesListenerPath(folder, 'linux', home)).toBe(join(shortSocketFolder(folder, home), 'devices.sock'))
  })

  it('null on Windows, whatever the folder', () => {
    expect(devicesListenerPath('C:\\Users\\me\\.harness', 'win32', home)).toBeNull()
    expect(devicesListenerPath('/Users/me/.harness', 'win32', home)).toBeNull()
  })

  it('null when the home is too long as well', () => {
    expect(devicesListenerPath(`/${'d'.repeat(199)}`, 'darwin', `/${'h'.repeat(120)}`)).toBeNull()
  })
})

describe('devicesTarget', () => {
  const home = '/Users/me'
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('off Windows is the devices socket, or nothing where there is none', async () => {
    expect(await devicesTarget('/Users/me/.harness', { platform: 'linux', home }))
      .toEqual({ socket: devicesListenerPath('/Users/me/.harness', 'linux', home) })
    expect(await devicesTarget(`/${'d'.repeat(199)}`, { platform: 'darwin', home: `/${'h'.repeat(120)}` })).toBeNull()
  })

  // The pipe is a path `<tmp>/harness-<32 hex>` here, which the record's reader takes off Windows.
  it('on Windows is the recorded pipe with its token, and nothing without the record or the token', async () => {
    const dir = mkdtempSync('/tmp/hn-target-')
    dirs.push(dir)
    const proof = createDevicesProof({ liveness: { alive: () => true } })
    const pipe = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    writeDevicesRecord(dir, { pipe, pid: process.pid })
    expect(await devicesTarget(dir, { platform: 'win32', proof })).toBeNull()
    const token = ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    expect(await devicesTarget(dir, { platform: 'win32', proof })).toEqual({ pipe, token })
    rmSync(join(dir, 'devices.json'))
    expect(await devicesTarget(dir, { platform: 'win32', proof })).toBeNull()
  })
})
