// The daemon's question of who is calling over loopback TCP (lib/peerAccount.ts, audit W1), asked of real Windows: a
// connection this process made is this account's. Windows only; the Windows workflow runs it with src/lib/windows.
// Another account's connection cannot be made from one account's test run; that answer is pinned by the unit spec. The yes
// below also shows Windows gives both times the check compares: the process started before its connection was made.
import { spawn } from 'node:child_process'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { peerIsThisAccount, windowsPeerQuery } from '../peerAccount.js'
import { runPowershellAsync } from './powershell.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => void> = []

/** What Windows answered for [socket], word for word: the message of a failed case, so one run says which check refused. */
async function asked(socket: Socket): Promise<string> {
  const query = windowsPeerQuery(socket.remotePort!, socket.localPort!)
  const row = '$r = @(Get-NetTCPConnection -State Established -LocalPort ([int]$env:HARNESS_PEER_PORT) -ErrorAction SilentlyContinue); $r | Format-List LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess,CreationTime | Out-String; foreach ($x in $r) { (Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$x.OwningProcess)) | Format-List ProcessId,Name,CreationDate | Out-String }; "pid $PID current $([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"'
  const answer = await runPowershellAsync(query.script, query.inputs, 30_000)
  const facts = await runPowershellAsync(row, query.inputs, 30_000)
  return `query: ${answer.status} ${answer.stdout.trim()} ${answer.stderr.trim()}\nfacts: ${facts.stdout.trim()} ${facts.stderr.trim()}\ntest pid ${process.pid}`
}
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
    if (!await peerIsThisAccount(socket, 'win32')) expect.fail(await asked(socket))

    const accepted2 = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
    const gone = connect((server.address() as AddressInfo).port, '127.0.0.1')
    const socket2 = await accepted2
    cleanup.push(() => socket2.destroy())
    await new Promise<void>((resolve) => { gone.once('close', () => resolve()); gone.destroy() })
    expect(await peerIsThisAccount(socket2, 'win32')).toBe(false)
  }, 120_000)

  // The check takes only a process that started before its connection was made. A process that connects in its first
  // moments must still read as yes, whatever the two times' precision (Reed's review of #2605).
  it('says yes for a fresh process that connects at once', async () => {
    const server = createServer()
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const accepted = new Promise<Socket>((resolve) => { server.once('connection', resolve) })
    const port = (server.address() as AddressInfo).port
    const child = spawn(process.execPath, ['-e', `require('net').connect(${port}, '127.0.0.1'); setTimeout(() => {}, 20000)`], { stdio: 'ignore' })
    cleanup.push(() => child.kill())
    const socket = await accepted
    cleanup.push(() => socket.destroy())
    if (!await peerIsThisAccount(socket, 'win32')) expect.fail(await asked(socket))
  }, 120_000)
})
