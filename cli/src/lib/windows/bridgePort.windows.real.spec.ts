// Who holds the connectors bridge's port (lib/peerAccount.ts portHolderIsThisAccount, task #2162), asked of real Windows: a
// listener this process opened is this account's, and a free port has no holder. Windows only; the Windows workflow runs it
// with src/lib/windows. Another account's listener cannot be made from one account's test run; that answer is pinned by the
// unit spec. The yes below also shows Windows gives both times the check compares: the process started before its listener.
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { portHolderIsThisAccount } from '../peerAccount.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

describe.runIf(WINDOWS)('who holds a listening port, asked of Windows', () => {
  it('says yes for a listener of this account, and nothing once the port is free', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    expect(await portHolderIsThisAccount(port, 'win32')).toBe(true)
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    expect(await portHolderIsThisAccount(port, 'win32')).toBeNull()
  }, 60_000)
})
