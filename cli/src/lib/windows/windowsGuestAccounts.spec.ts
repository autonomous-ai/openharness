import { describe, expect, it, vi } from 'vitest'
import { createWindowsGuestAccounts } from './windowsGuestAccounts.js'

// The guests' accounts on Windows: the setup task does the privileged work, so this only speaks its contract
// (lib/windows/guestSetupClient.ts) and reads which guests have a host home. Never sudo, never a password here.
describe('a Windows guest\'s account, as a launch reads it', () => {
  const account = { user: 'hg_0123456789ab', home: 'C:\\Users\\hg_0123456789ab', workspace: 'C:\\Users\\hg_0123456789ab\\work' }

  it('makes the account through the setup task, and shares the owner\'s whole set as its own', async () => {
    const client = { ensureGuest: vi.fn(async () => account), setFolders: vi.fn(async () => {}), removeGuest: vi.fn(async () => {}) }
    const accounts = createWindowsGuestAccounts({ ownerHome: 'C:\\Users\\DELL', client })
    expect(await accounts.ensureGuest('kim@acme.io')).toEqual(account)
    expect(client.ensureGuest).toHaveBeenCalledWith('kim@acme.io')
    const folders = [{ path: 'C:\\Users\\DELL\\code', write: true }]
    await accounts.shareFolders(account.user, folders)
    expect(client.setFolders).toHaveBeenCalledWith(account.user, folders)
    await accounts.shareFolders(account.user, [])
    expect(client.setFolders).toHaveBeenLastCalledWith(account.user, [])
  })

  it('lists the guests that have a host home, and only those, as the sync reads them', () => {
    const accounts = createWindowsGuestAccounts({ ownerHome: 'C:\\Users\\DELL',
      client: { ensureGuest: vi.fn(), setFolders: vi.fn(), removeGuest: vi.fn() },
      hosts: () => ['hg_bbbbbbbbbbbb', 'DELL', 'hg_aaaaaaaaaaaa', 'hg_nothex', '.tmp'] })
    expect(accounts.guests()).toEqual(['hg_aaaaaaaaaaaa', 'hg_bbbbbbbbbbbb'])
    const none = createWindowsGuestAccounts({ ownerHome: 'C:\\Users\\DELL',
      client: { ensureGuest: vi.fn(), setFolders: vi.fn(), removeGuest: vi.fn() }, hosts: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } })
    // A tree that is not there yet is no guest, not an error: sharing may not be on.
    expect(none.guests()).toEqual([])
  })
})
