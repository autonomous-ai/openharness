import { createServer, connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { lsofShowsPeer, peerIsThisAccount, portHolderIsThisAccount, procNetListener, procNetOwner, WINDOWS_PEER_LOOKUPS, WINDOWS_PEER_MS, WINDOWS_PEER_QUEUE, windowsListenerQuery, windowsPeerQuery, type WindowsPeerRun } from './peerAccount.js'

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

    // Windows PowerShell's start and its CIM queries took over 8 s on the Windows ARM runner (the Windows run on #2605).
    it('gives a lookup long enough for a slow PC: Windows PowerShell and CIM on the ARM runner took over 8 s', () => {
      expect(WINDOWS_PEER_MS).toBeGreaterThanOrEqual(20_000)
    })

    it('asks Windows by the connection\'s ports, given as inputs, and compares the owner by SID', () => {
      const query = windowsPeerQuery(50_001, 18473)
      expect(query.inputs).toEqual({ HARNESS_PEER_PORT: '50001', HARNESS_OWN_PORT: '18473' })
      expect(query.script).not.toMatch(/50001|18473/)
      expect(query.script).toContain('Get-NetTCPConnection')
      expect(query.script).toContain('GetOwnerSid')
      expect(query.script).toContain('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    })

    /** Answers every lookup asked so far, and those that start as slots free, until none is left. */
    const drain = async (finish: Array<() => void>): Promise<void> => {
      for (;;) {
        await new Promise((resolve) => { setImmediate(resolve) })
        if (finish.length === 0) return
        for (const done of finish.splice(0)) done()
      }
    }
    const held = () => {
      let asked = 0
      const finish: Array<() => void> = []
      const run: WindowsPeerRun = () => { asked++; return new Promise((resolve) => { finish.push(() => resolve({ status: 0, stdout: 'yes' })) }) }
      return { run, finish, asked: () => asked }
    }

    // The owner's bridge asks once per new connection, and an agent may open several at start: past the four running, a
    // lookup waits its turn, and nobody is told "unknown address" for it (Reed's review of #2605).
    it('gives a burst of ten connections all their answer: past four running, they wait their turn', async () => {
      let running = 0, most = 0
      const run: WindowsPeerRun = async () => {
        running++
        most = Math.max(most, running)
        await new Promise((resolve) => { setTimeout(resolve, 5) })
        running--
        return { status: 0, stdout: 'yes' }
      }
      const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => peerIsThisAccount(socket({ remotePort: 51_000 + i }), 'win32', run)))
      expect(answers).toEqual(answers.map(() => true))
      expect(most).toBe(WINDOWS_PEER_LOOKUPS)
    })

    // Whoever heard the hook token could open connections without end, each a PowerShell in the owner's account for up to
    // 8 s (Luna's review of #2605): past the running ones and a bounded queue, the answer is no, without asking.
    it('answers no, without asking, once the running lookups and the queue are full', async () => {
      const slow = held()
      const pending = Array.from({ length: WINDOWS_PEER_LOOKUPS + WINDOWS_PEER_QUEUE }, (_, i) => peerIsThisAccount(socket({ remotePort: 51_100 + i }), 'win32', slow.run))
      expect(await peerIsThisAccount(socket({ remotePort: 51_300 }), 'win32', slow.run)).toBe(false)
      expect(slow.asked()).toBe(WINDOWS_PEER_LOOKUPS)
      await drain(slow.finish)
      expect(await Promise.all(pending)).toEqual(pending.map(() => true))
      expect(slow.asked()).toBe(WINDOWS_PEER_LOOKUPS + WINDOWS_PEER_QUEUE)
    })

    // A keep-alive client (an MCP client on the bridge) asks again on the same connection: a no for being busy must not
    // stick to it, and is not "another account" (Luna's review of #2605).
    it('keeps no busy refusal on the connection: the same socket is asked again once a slot frees', async () => {
      const slow = held()
      const pending = Array.from({ length: WINDOWS_PEER_LOOKUPS + WINDOWS_PEER_QUEUE }, (_, i) => peerIsThisAccount(socket({ remotePort: 52_000 + i }), 'win32', slow.run))
      const caller = socket({ remotePort: 52_300 })
      const warned: string[] = []
      const warn = console.warn
      console.warn = (line: string) => { warned.push(line) }
      try {
        expect(await peerIsThisAccount(caller, 'win32', slow.run)).toBe(false)
      } finally {
        console.warn = warn
      }
      expect(warned.join('\n')).toMatch(/busy/)
      expect(warned.join('\n')).not.toMatch(/not this account/)
      await drain(slow.finish)
      await Promise.all(pending)
      expect(await peerIsThisAccount(caller, 'win32', answering('yes').run)).toBe(true)
    })

    // Windows keeps naming a socket's creator after it exits when a child inherited the handle, and the id can go to one of
    // the owner's processes since: an account that heard the credential could wait for that and be read as the owner (Luna's
    // review of #2605). The process found must have started before the connection was made.
    it('takes the owning process only when it started before the connection was made: never a recycled process id', () => {
      const { script } = windowsPeerQuery(50_001, 18473)
      // Windows gives the connection's time to the second, the process's finer: the Windows run on #2605 read a process
      // started at 13:32:35 as after its connection of 13:32:35. Two seconds of slack, which a recycled id must also beat.
      expect(script).toMatch(/\$process\.CreationDate -gt \$rows\[0\]\.CreationTime\.AddSeconds\(2\)/)
      const creation = script.indexOf('CreationDate'), owner = script.indexOf('GetOwnerSid')
      expect(creation).toBeGreaterThan(-1)
      expect(creation).toBeLessThan(owner)
    })
  })

  // Reed's review of #2605: Windows answered null here, so the connectors bridge never moved off a port the Team account held
  // from boot, and the owner's agents kept sending their tool calls to that account (task #2162).
  describe('on Windows, who holds a listening port, by asking Windows', () => {
    const answering = (stdout: string, status: number | null = 0) => {
      const asked: Array<{ script: string; inputs: Record<string, string> }> = []
      const run: WindowsPeerRun = async (script, inputs) => { asked.push({ script, inputs }); return { status, stdout } }
      return { run, asked }
    }

    it('says no for another account\'s listener, yes for this account\'s, and nothing for a free port', async () => {
      expect(await portHolderIsThisAccount(51793, 'win32', answering('no\r\n').run)).toBe(false)
      expect(await portHolderIsThisAccount(51793, 'win32', answering('yes\r\n').run)).toBe(true)
      expect(await portHolderIsThisAccount(51793, 'win32', answering('none\r\n').run)).toBeNull()
    })

    it('says nothing when the lookup fails, times out, throws or answers anything else', async () => {
      for (const [stdout, status] of [['no', 1], ['yes', null], ['', 0], ['maybe', 0], ['yes\nno', 0]] as const) {
        expect(await portHolderIsThisAccount(51793, 'win32', answering(stdout, status).run), `${stdout}/${status}`).toBeNull()
      }
      expect(await portHolderIsThisAccount(51793, 'win32', () => Promise.reject(new Error('no PowerShell')))).toBeNull()
    })

    it('passes the port as an input, never in the script\'s text', async () => {
      const { run, asked } = answering('no')
      await portHolderIsThisAccount(51794, 'win32', run)
      expect(asked[0]!.inputs).toEqual({ HARNESS_LISTEN_PORT: '51794' })
      expect(asked[0]!.script).not.toContain('51794')
      expect(asked[0]!.script).toBe(windowsListenerQuery(51794).script)
    })

    it('counts a listener as this account\'s only by its process\'s SID, and only a process that started before it', () => {
      const { script } = windowsListenerQuery(51793)
      expect(script).toMatch(/Get-NetTCPConnection -State Listen -LocalPort \(\[int\]\$env:HARNESS_LISTEN_PORT\)/)
      expect(script).toMatch(/GetOwnerSid/)
      expect(script).toMatch(/WindowsIdentity\]::GetCurrent\(\)\.User\.Value/)
      expect(script).toMatch(/CreationDate -gt \$row\.CreationTime/)
    })

    // The Windows run on #2605: Windows gives a socket's time to the second and a process's finer, so a process that opened its
    // listener within the second it started read as started after it. Here that would move the bridge off its own port.
    it('allows two seconds for Windows\' whole-second listener time, as the peer check does', () => {
      expect(windowsListenerQuery(51793).script).toMatch(/\$process\.CreationDate -gt \$row\.CreationTime\.AddSeconds\(2\)/)
    })

    // Quinn 2's review of #2608: a listener of this account's on another address (::1, 127.0.0.2) answered yes, so the bridge
    // waited instead of moving off another account's 127.0.0.1. Only a listener that keeps 127.0.0.1's port from being bound counts.
    it('counts only the listeners that hold 127.0.0.1\'s port: on it, on any IPv4 address, or on any address dual-stack', () => {
      const { script } = windowsListenerQuery(51793)
      expect(script).toMatch(/Where-Object \{ \$_\.LocalAddress -in @\('127\.0\.0\.1', '0\.0\.0\.0', '::'\) \}/)
      // Filtered before anything is decided: none of them is `none`, never another address's owner.
      expect(script.indexOf("-in @('127.0.0.1'")).toBeLessThan(script.indexOf("'none'"))
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
