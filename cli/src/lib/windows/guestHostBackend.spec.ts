import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guestHostHome, guestHostTask, waitForGuestHost } from './guestHostBackend.js'

const discovery = (instance: string, version: string, protocol: number, pid: number) => JSON.stringify({
  protocol, instance, endpoint: `\\\\.\\pipe\\harness-pty-${instance}`, pid, version,
  token: '0123456789abcdef0123456789abcdef01234567',
})

describe('a guest host', () => {
  it('lives under the guest tree and starts the task the setup task registered', () => {
    expect(guestHostHome('hg_0123456789ab')).toBe('C:\\ProgramData\\HarnessGuests\\hosts\\hg_0123456789ab')
    expect(guestHostTask('hg_0123456789ab')).toBe('\\Harness\\Guests\\hg_0123456789ab')
  })

  it('picks the newest discovery file the guest published', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guest-host-'))
    mkdirSync(join(home, 'run'))
    writeFileSync(join(home, 'run', 'pty-host-p2-0.0.1.json'), discovery('p2-0.0.1', '0.0.1', 2, 11))
    writeFileSync(join(home, 'run', 'pty-host-p2-9.9.9.json'), discovery('p2-9.9.9', '9.9.9', 2, 22))
    writeFileSync(join(home, 'run', 'other.json'), '{}')
    expect((await waitForGuestHost(home, { user: 'hg_x', waitMs: 0 }))?.instance).toBe('p2-9.9.9')
  })

  it('returns null when nothing is published in the window', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guest-host-empty-'))
    expect(await waitForGuestHost(home, { user: 'hg_x', waitMs: 0 })).toBeNull()
  })

  it('uses only files whose instance and protocol a host really writes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guest-host-bad-'))
    mkdirSync(join(home, 'run'))
    writeFileSync(join(home, 'run', 'pty-host-p2-9.9.9.json'), JSON.stringify({ instance: 'p2-1.0.0', protocol: 2, endpoint: 'x', pid: 1, version: '9.9.9', token: 'short' }))
    expect(await waitForGuestHost(home, { user: 'hg_x', waitMs: 0 })).toBeNull()
  })
})
