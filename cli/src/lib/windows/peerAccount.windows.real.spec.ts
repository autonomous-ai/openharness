// The daemon's question of who is calling over loopback TCP (lib/peerAccount.ts, audit W1), asked of real Windows: a
// connection this process made is this account's. Windows only; the Windows workflow runs it with src/lib/windows.
// Another account's connection cannot be made from one account's test run; that answer is pinned by the unit spec. The yes
// below also shows Windows gives both times the check compares: the process started before its connection was made.
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { peerIsThisAccount } from '../peerAccount.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

describe.runIf(WINDOWS)('who is calling, asked of Windows', () => {
  it('says yes for a connection of this account, and no once it has gone', async () => {
    const server = createServer()
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const accepted = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
    const client = connect((server.address() as AddressInfo).port, '127.0.0.1')
    cleanup.push(() => client.destroy())
    const socket = await accepted
    cleanup.push(() => socket.destroy())
    expect(await peerIsThisAccount(socket, 'win32')).toBe(true)

    const accepted2 = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
    const gone = connect((server.address() as AddressInfo).port, '127.0.0.1')
    const socket2 = await accepted2
    cleanup.push(() => socket2.destroy())
    await new Promise<void>((resolve) => { gone.once('close', () => resolve()); gone.destroy() })
    expect(await peerIsThisAccount(socket2, 'win32')).toBe(false)
  }, 30_000)
})
