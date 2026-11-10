import { describe, expect, it, vi } from 'vitest'
import { guestHelperStatus, installGuestHelper } from './guestHelperInstall.js'
import { WINDOWS_GUEST_SETUP_VERSION } from './windows/guestRequests.js'
import type { RunAdmin } from './windows/elevated.js'

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const whoami = async () => ({ code: 0, stdout: `"HOST\\\\owner","${SID}"\n`, stderr: '' })

describe('installing guest sharing on Windows', () => {
  it('asks once, with the owner SID, the guest tree and the setup task', async () => {
    let script = ''
    const admin = vi.fn<RunAdmin>(async (run, ownerSid) => { script = run; expect(ownerSid).toBe(SID); return { ok: true, stdout: '' } })
    const result = await installGuestHelper({ platform: 'win32', owner: 'owner', ownerHome: 'C:\\Users\\owner', runner: whoami, admin })
    expect(result).toEqual({ ok: true })
    expect(admin).toHaveBeenCalledTimes(1)
    expect(script).toContain("$OWNER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'")
    expect(script).toContain("$ROOT = 'C:\\ProgramData\\HarnessGuests'")
    expect(script).toContain('Harness Guests Setup')
    expect(script).toContain('HighestAvailable')
    // What a guest installs its engine with is staged with the host: its Node runtime and npm.
    expect(script).toContain('$NODE_SRC = ')
    expect(script).toContain('node-')
  })

  it('reports a cancelled UAC prompt and refuses a missing profile or SID', async () => {
    const cancelled = vi.fn<RunAdmin>(async () => ({ ok: false, code: 'CANCELLED', message: 'cancelled' }))
    expect(await installGuestHelper({ platform: 'win32', owner: 'owner', ownerHome: 'C:\\Users\\owner', runner: whoami, admin: cancelled }))
      .toEqual({ ok: false, code: 'CANCELLED', message: 'cancelled' })
    expect(await installGuestHelper({ platform: 'win32', owner: 'owner', ownerHome: 'not-a-profile', runner: whoami, admin: cancelled }))
      .toMatchObject({ ok: false, code: 'FAILED' })
    expect(await installGuestHelper({ platform: 'win32', owner: 'owner', ownerHome: 'C:\\Users\\owner', runner: async () => ({ code: 1, stdout: '', stderr: '' }), admin: cancelled }))
      .toMatchObject({ ok: false, code: 'FAILED' })
  })
})

describe('the Windows helper state', () => {
  const read = (text: string | null) => () => text
  const current = String(WINDOWS_GUEST_SETUP_VERSION)
  it('is ready only with the current version and the setup task', async () => {
    expect(await guestHelperStatus({ platform: 'win32', read: read(`${current}\n`), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'ready', version: WINDOWS_GUEST_SETUP_VERSION })
    expect(await guestHelperStatus({ platform: 'win32', read: read(`${current}\n`), runner: async () => ({ code: 1, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'missing', version: WINDOWS_GUEST_SETUP_VERSION })
    expect(await guestHelperStatus({ platform: 'win32', read: read(null), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'missing', version: null })
    expect(await guestHelperStatus({ platform: 'win32', read: read('0\n'), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'outdated', version: 0 })
  })
})
