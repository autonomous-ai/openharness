import { createServer, connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { lsofShowsPeer, peerIsThisAccount, procNetOwner } from './peerAccount.js'

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
    const gone = { localPort: socket.localPort, remotePort: 1 } as unknown as Socket
    expect(await peerIsThisAccount(gone)).toBe(false)
  })

  it('says no for a socket with no peer port', async () => {
    expect(await peerIsThisAccount({} as unknown as Socket)).toBe(false)
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
  })

  it('counts only the client end in lsof output: the server end shows the same ports reversed', () => {
    expect(lsofShowsPeer('p1\nf3\nn127.0.0.1:50000->127.0.0.1:18473\n', 50000, 18473)).toBe(true)
    // What a daemon sees of its own accepted socket when the caller is another account.
    expect(lsofShowsPeer('p1\nf3\nn127.0.0.1:18473->127.0.0.1:50000\n', 50000, 18473)).toBe(false)
    expect(lsofShowsPeer('', 50000, 18473)).toBe(false)
  })
})
