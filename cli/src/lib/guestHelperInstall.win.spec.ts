import { describe, expect, it, vi } from 'vitest'
import { guestHelperStatus, installGuestHelper } from './guestHelperInstall.js'
import type { RunAdmin } from '../team/admin.js'

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const whoami = async () => ({ code: 0, stdout: `"HOST\\\\owner","${SID}"\n`, stderr: '' })

describe('installing guest sharing on Windows', () => {
  it('asks once, with the owner SID, the guest tree and the setup task', async () => {
    let script = ''
    const admin = vi.fn<RunAdmin>(async (build) => { script = build('C:\\\\stage').script; return { ok: true, stdout: '' } })
    const result = await installGuestHelper({ platform: 'win32', owner: 'owner', ownerHome: 'C:\\Users\\owner', runner: whoami, admin })
    expect(result).toEqual({ ok: true })
    expect(admin).toHaveBeenCalledTimes(1)
    expect(script).toContain("$OWNER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'")
    expect(script).toContain("$ROOT = 'C:\\ProgramData\\HarnessGuests'")
    expect(script).toContain('Harness Guests Setup')
    expect(script).toContain('HighestAvailable')
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
  it('is ready only with the current version and the setup task', async () => {
    expect(await guestHelperStatus({ platform: 'win32', read: read('1\n'), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'ready', version: 1 })
    expect(await guestHelperStatus({ platform: 'win32', read: read('1\n'), runner: async () => ({ code: 1, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'missing', version: 1 })
    expect(await guestHelperStatus({ platform: 'win32', read: read(null), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'missing', version: null })
    expect(await guestHelperStatus({ platform: 'win32', read: read('0\n'), runner: async () => ({ code: 0, stdout: '', stderr: '' }) }))
      .toEqual({ state: 'outdated', version: 0 })
  })
})
