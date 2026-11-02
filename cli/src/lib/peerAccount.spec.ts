import { createServer, connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { lsofShowsPeer, peerIsThisAccount, portHolderIsThisAccount, procNetListener, procNetOwner } from './peerAccount.js'

describe('who is at the other end of a loopback connection', () => {
  const opened: Array<() => unknown> = []
  afterEach(() => { for (const close of opened.splice(0)) close() })

  const pair = async (): Promise<Socket> => {
    const server = createServer()
    opened.push(() => server.close())
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const accepted = new Promise<Socket>(resolve => { server.once('connection', resolve) })
    const client = connect((server.address() as AddressInfo).port, '127.0.0.1')
    opened.push(() => client.destroy())
    const socket = await accepted
    opened.push(() => socket.destroy())
    return socket
  }

  it('says yes for a process of this account, by the real lookup', async () => {
    expect(await peerIsThisAccount(await pair())).toBe(true)
  })

  it('says no once the caller has gone', async () => {
    const socket = await pair()
    const gone = { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort: socket.localPort, remotePort: 1 } as unknown as Socket
    expect(await peerIsThisAccount(gone)).toBe(false)
  })

  it('says no for a socket with no peer port', async () => {
    expect(await peerIsThisAccount({} as unknown as Socket)).toBe(false)
  })

  it('says no for a caller on another loopback address, even with the ports of a connection of this account', async () => {
    const socket = await pair()
    const other = { remoteAddress: '127.0.0.2', localAddress: socket.localAddress, remotePort: socket.remotePort, localPort: socket.localPort } as unknown as Socket
    expect(await peerIsThisAccount(other)).toBe(false)
    expect(await peerIsThisAccount({ ...other, remoteAddress: '127.0.0.1', localAddress: '127.0.0.3' } as unknown as Socket)).toBe(false)
    // The very same ports, from 127.0.0.1: the real connection of this account.
    expect(await peerIsThisAccount(socket)).toBe(true)
  })

  it('asks once per connection', async () => {
    const socket = await pair()
    expect(peerIsThisAccount(socket)).toBe(peerIsThisAccount(socket))
  })

  it('leaves Windows to its proven pipe', async () => {
    expect(await peerIsThisAccount({} as unknown as Socket, 'win32')).toBe(true)
  })

  it('reads the owner of the client end from /proc/net/tcp, not the server end', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:4849 0100007F:C000 01 00000000:00000000 00:00000000 00000000   501        0 1',
      '   1: 0100007F:C000 0100007F:4849 01 00000000:00000000 00:00000000 00000000  1002        0 2',
    ].join('\n')
    expect(procNetOwner(table, 0xC000, 0x4849)).toBe(1002)
    expect(procNetOwner(table, 0xC001, 0x4849)).toBeNull()
    // The same ports on another address are another connection.
    expect(procNetOwner(table.replace('0100007F:C000 0100007F:4849', '0200007F:C000 0100007F:4849'), 0xC000, 0x4849)).toBeNull()
  })

  it('reads the owner of a listener, by real lookup and from /proc/net/tcp', async () => {
    const server = createServer()
    opened.push(() => server.close())
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    expect(await portHolderIsThisAccount((server.address() as AddressInfo).port)).toBe(true)
    expect(await portHolderIsThisAccount(1, 'win32')).toBeNull()
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:C94F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 1',
      '   1: 0100007F:C950 0100007F:0050 01 00000000:00000000 00:00000000 00000000   501        0 2',
    ].join('\n')
    expect(procNetListener(table, 0xC94F)).toBe(1002)
    expect(procNetListener(table, 0xC950)).toBeNull()
    // Node's plain listen(port) is on `::`, dual-stack: it blocks 127.0.0.1 and shows only in /proc/net/tcp6.
    const row = (address: string) => `   0: ${address}:C94F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1003        0 3`
    for (const address of ['00000000000000000000000000000000', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F', '0000000000000000FFFF000000000000']) {
      expect(procNetListener(`header\n${row(address)}`, 0xC94F), address).toBe(1003)
    }
    // Another address's listener does not hold 127.0.0.1's port.
    expect(procNetListener(`header\n${row('0000000000000000FFFF00000200007F')}`, 0xC94F)).toBeNull()
  })

  it('counts only the client end in lsof output: the server end shows the same ports reversed', () => {
    expect(lsofShowsPeer('p1\nf3\nn127.0.0.1:50000->127.0.0.1:18473\n', 50000, 18473)).toBe(true)
    // What a daemon sees of its own accepted socket when the caller is another account.
    expect(lsofShowsPeer('p1\nf3\nn127.0.0.1:18473->127.0.0.1:50000\n', 50000, 18473)).toBe(false)
    expect(lsofShowsPeer('', 50000, 18473)).toBe(false)
  })
})
