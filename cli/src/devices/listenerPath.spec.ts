import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { shortSocketFolder } from '../lib/localSocket.js'
import { DEVICES_SOCKET, devicesListenerPath } from './listenerPath.js'

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
