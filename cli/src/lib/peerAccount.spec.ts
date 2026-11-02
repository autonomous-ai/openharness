import { createServer, connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { lsofShowsPeer, peerIsThisAccount, portHolderIsThisAccount, procNetListener, procNetOwner, WINDOWS_PEER_LOOKUPS, windowsPeerQuery, type WindowsPeerRun } from './peerAccount.js'

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

  // Audit W1 (docs/security/2026-11-02-team-account-windows.md): Windows answered yes without asking, so the Team account,
  // holding the port at boot, heard the credential and opened the daemon with it.
  describe('on Windows, by asking Windows who owns the calling end', () => {
    const socket = (over: Partial<Socket> = {}) =>
      ({ remoteAddress: '127.0.0.1', remotePort: 50_001, localAddress: '127.0.0.1', localPort: 18473, ...over }) as Socket
    const answering = (stdout: string, status: number | null = 0) => {
      const asked: Array<Record<string, string>> = []
      const run: WindowsPeerRun = async (_script, inputs) => { asked.push(inputs); return { status, stdout } }
      return { run, asked }
    }

    it('says yes only when the lookup found the connection and its process is this account\'s', async () => {
      const yes = answering('yes\r\n')
      expect(await peerIsThisAccount(socket(), 'win32', yes.run)).toBe(true)
      // The client's end, as Windows lists it: its own port local, the daemon's remote.
      expect(yes.asked).toEqual([{ HARNESS_PEER_PORT: '50001', HARNESS_OWN_PORT: '18473' }])
    })

    it('says no for another account, any other answer, a failure, or a lookup that never answered', async () => {
      for (const [stdout, status] of [['no', 0], ['', 0], ['yes yes', 0], ['yes', 1], ['yes', null]] as const) {
        expect(await peerIsThisAccount(socket({ remotePort: 50_002 + (status ?? 9) }), 'win32', answering(stdout, status).run), `${stdout}/${status}`).toBe(false)
      }
      const thrown: WindowsPeerRun = async () => { throw new Error('powershell.exe is not there') }
      expect(await peerIsThisAccount(socket({ remotePort: 50_020 }), 'win32', thrown)).toBe(false)
    })

    it('says no without asking for a caller off 127.0.0.1 at either end, or with no ports', async () => {
      const yes = answering('yes')
      for (const over of [{ remoteAddress: '127.0.0.2' }, { localAddress: '::1' }, { remotePort: undefined }, { localPort: undefined }] as Partial<Socket>[]) {
        expect(await peerIsThisAccount(socket(over), 'win32', yes.run)).toBe(false)
      }
      expect(yes.asked).toEqual([])
    })

    it('asks Windows by the connection\'s ports, given as inputs, and compares the owner by SID', () => {
      const query = windowsPeerQuery(50_001, 18473)
      expect(query.inputs).toEqual({ HARNESS_PEER_PORT: '50001', HARNESS_OWN_PORT: '18473' })
      expect(query.script).not.toMatch(/50001|18473/)
      expect(query.script).toContain('Get-NetTCPConnection')
      expect(query.script).toContain('GetOwnerSid')
      expect(query.script).toContain('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    })

    // Whoever heard the hook token could open connections without end, each a PowerShell in the owner's account for up to
    // 8 s (Luna's review of #2605). A few run at once; one past them is no.
    it('runs a few lookups at once and answers no past them, without asking', async () => {
      let asked = 0
      const finish: Array<() => void> = []
      const slow: WindowsPeerRun = () => { asked++; return new Promise((resolve) => { finish.push(() => resolve({ status: 0, stdout: 'yes' })) }) }
      const pending = Array.from({ length: WINDOWS_PEER_LOOKUPS }, (_, i) => peerIsThisAccount(socket({ remotePort: 51_000 + i }), 'win32', slow))
      expect(await peerIsThisAccount(socket({ remotePort: 51_100 }), 'win32', slow)).toBe(false)
      expect(asked).toBe(WINDOWS_PEER_LOOKUPS)
      for (const done of finish.splice(0)) done()
      expect(await Promise.all(pending)).toEqual(pending.map(() => true))
      expect(await peerIsThisAccount(socket({ remotePort: 51_101 }), 'win32', answering('yes').run)).toBe(true)
    })

    // Windows keeps naming a socket's creator after it exits when a child inherited the handle, and the id can go to one of
    // the owner's processes since: an account that heard the credential could wait for that and be read as the owner (Luna's
    // review of #2605). The process found must have started before the connection was made.
    it('takes the owning process only when it started before the connection was made: never a recycled process id', () => {
      const { script } = windowsPeerQuery(50_001, 18473)
      expect(script).toMatch(/\$process\.CreationDate -gt \$rows\[0\]\.CreationTime/)
      const creation = script.indexOf('CreationDate'), owner = script.indexOf('GetOwnerSid')
      expect(creation).toBeGreaterThan(-1)
      expect(creation).toBeLessThan(owner)
    })
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
